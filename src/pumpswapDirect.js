// src/pumpswapDirect.js
//
// Builds PumpSwap (Pump.fun's own AMM, where coins trade after their bonding
// curve completes) buy/sell transactions directly, using Pump.fun's official
// SDK (@pump-fun/pump-swap-sdk). Only the coin's canonical SOL pool (the one
// Pump.fun migrates every graduated coin into) is used; anything else is
// rejected with UnsupportedPumpSwapTradeError so the caller falls back.
//
// ONE RPC round trip: the SDK's own state read makes three in a row (config
// and pool, then the mint and the pool's token accounts, then ours), each one
// also waiting its turn in the rate limiter. For the canonical pool every
// address is known up front (the pool is derived from the mint, and its token
// accounts and ours are standard associated accounts), so they are all read in
// one getMultipleAccounts call and the same state object is built from them.
// Anything that doesn't line up (a pool vault at a different address, a
// missing account) falls back to the SDK's own read. The blockhash comes from
// PREWARM.

const { PublicKey } = require('@solana/web3.js');
const { NATIVE_MINT, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, MintLayout, AccountLayout, getAssociatedTokenAddressSync } = require('@solana/spl-token');
const BN = require('bn.js');
const { OnlinePumpAmmSdk, PUMP_AMM_SDK, canonicalPumpPoolPda, buyQuoteInput, GLOBAL_CONFIG_PDA, PUMP_AMM_FEE_CONFIG_PDA } = require('@pump-fun/pump-swap-sdk');
const { assembleV0Tx } = require('./txAssemble');
const { uiToRaw } = require('./amounts');
const { attachQuote, attachCoin } = require('./buyQuote');
const plainAccount = require('./plainAccount');

class UnsupportedPumpSwapTradeError extends Error {}

// One SDK per connection: creating one parses the SDK's IDLs (tens of ms of CPU).
const onlineSdks = new WeakMap();
function onlineSdkFor(connection) {
  let sdk = onlineSdks.get(connection);
  if (!sdk) {
    sdk = new OnlinePumpAmmSdk(connection);
    onlineSdks.set(connection, sdk);
  }
  return sdk;
}

/** The SDK's swapSolanaState, in one round trip. Throws if anything is unexpected (the caller falls back). */
async function fastPoolState(connection, user, mint) {
  const baseMint = new PublicKey(mint);
  const poolKey = canonicalPumpPoolPda(baseMint);
  const ata = (m, owner, prog) => getAssociatedTokenAddressSync(m, owner, true, prog);
  const keys = [
    GLOBAL_CONFIG_PDA, PUMP_AMM_FEE_CONFIG_PDA, poolKey, baseMint,
    ata(baseMint, poolKey, TOKEN_PROGRAM_ID), ata(baseMint, poolKey, TOKEN_2022_PROGRAM_ID), ata(NATIVE_MINT, poolKey, TOKEN_PROGRAM_ID),
    ata(baseMint, user, TOKEN_PROGRAM_ID), ata(baseMint, user, TOKEN_2022_PROGRAM_ID), ata(NATIVE_MINT, user, TOKEN_PROGRAM_ID)
  ];
  const infos = await connection.getMultipleAccountsInfo(keys);
  const [globalInfo, feeInfo, poolInfo, mintInfo, vaultLegacy, vault22, quoteVault, userLegacy, user22, userQuote] = infos;
  if (!globalInfo || !poolInfo || !mintInfo || !quoteVault) throw new Error('an account is missing');
  const pool = PUMP_AMM_SDK.decodePool(poolInfo);
  if (!pool.baseMint.equals(baseMint)) throw new Error('pool is for another mint');
  if (!pool.quoteMint.equals(NATIVE_MINT)) return { pool, notSol: true };
  const baseTokenProgram = mintInfo.owner;
  const is22 = baseTokenProgram.equals(TOKEN_2022_PROGRAM_ID);
  if (!is22 && !baseTokenProgram.equals(TOKEN_PROGRAM_ID)) throw new Error('unknown token program');
  const baseVaultKey = keys[is22 ? 5 : 4];
  if (!pool.poolBaseTokenAccount.equals(baseVaultKey) || !pool.poolQuoteTokenAccount.equals(keys[6])) throw new Error('pool vaults are not the standard accounts');
  const baseVault = is22 ? vault22 : vaultLegacy;
  if (!baseVault) throw new Error('pool vault missing');
  return {
    globalConfig: PUMP_AMM_SDK.decodeGlobalConfig(globalInfo),
    feeConfig: feeInfo ? PUMP_AMM_SDK.decodeFeeConfig(feeInfo) : null,
    poolKey,
    poolAccountInfo: poolInfo,
    pool,
    poolBaseAmount: new BN(AccountLayout.decode(baseVault.data).amount.toString()),
    poolQuoteAmount: new BN(AccountLayout.decode(quoteVault.data).amount.toString()),
    baseTokenProgram,
    quoteTokenProgram: TOKEN_PROGRAM_ID,
    baseMint,
    baseMintAccount: MintLayout.decode(mintInfo.data),
    user,
    userBaseTokenAccount: keys[is22 ? 8 : 7],
    userQuoteTokenAccount: keys[9],
    userBaseAccountInfo: is22 ? user22 : userLegacy,
    userQuoteAccountInfo: userQuote
  };
}

async function poolState(connection, user, mint) {
  if (typeof connection.getMultipleAccountsInfo === 'function') {
    try {
      const fast = await fastPoolState(connection, user, mint);
      if (fast.notSol) throw new UnsupportedPumpSwapTradeError(`${mint}'s PumpSwap pool is not paired with SOL`);
      return fast;
    } catch (err) {
      if (err instanceof UnsupportedPumpSwapTradeError) throw err;
      // fall through to the SDK's own (slower) read
    }
  }
  const poolKey = canonicalPumpPoolPda(new PublicKey(mint));
  let state;
  try {
    state = await onlineSdkFor(connection).swapSolanaState(poolKey, user);
  } catch (err) {
    throw new UnsupportedPumpSwapTradeError(`no PumpSwap pool for ${mint} (${err.message})`);
  }
  if (!state || !state.pool) throw new UnsupportedPumpSwapTradeError(`no PumpSwap pool for ${mint}`);
  if (!state.pool.quoteMint.equals(NATIVE_MINT)) {
    throw new UnsupportedPumpSwapTradeError(`${mint}'s PumpSwap pool is not paired with SOL`);
  }
  return state;
}

function labelled(tx) {
  try {
    Object.defineProperty(tx, 'routeLabel', { value: 'PumpSwap', enumerable: false });
  } catch {}
  return tx;
}

/** The buy's expected fill (fees excluded), same maths as the SDK's own quote. Best effort. */
function expectedFill(state, lamports, slippagePct) {
  try {
    const { pool } = state;
    const q = buyQuoteInput({
      quote: lamports,
      slippage: slippagePct,
      baseReserve: state.poolBaseAmount,
      quoteReserve: state.poolQuoteAmount,
      virtualQuoteReserves: pool.virtualQuoteReserves,
      baseMintAccount: state.baseMintAccount,
      baseMint: state.baseMint,
      coinCreator: pool.coinCreator,
      creator: pool.creator,
      feeConfig: state.feeConfig,
      globalConfig: state.globalConfig,
      quoteMint: pool.quoteMint,
      isMayhemMode: pool.isMayhemMode,
      creatorFeeBps: pool.creatorFeeBps
    });
    return {
      solIn: Number(q.internalQuoteWithoutFees.toString()) / 1e9,
      tokensOut: Number(q.base.toString()) / 10 ** state.baseMintAccount.decimals
    };
  } catch {
    return {};
  }
}

/** Market cap in SOL (pool price x supply) and the coin's creator, for the instant buy filters. Best effort. */
function coinInfo(state) {
  const out = { mcapSol: null, creator: null };
  try {
    const pool = state.pool || {};
    const c = pool.coinCreator || pool.creator;
    if (c && !c.equals(PublicKey.default)) out.creator = c.toBase58();
  } catch {}
  try {
    const base = BigInt(state.poolBaseAmount.toString());
    const vq = state.pool && state.pool.virtualQuoteReserves ? BigInt(state.pool.virtualQuoteReserves.toString()) : 0n;
    const quote = BigInt(state.poolQuoteAmount.toString()) + vq;
    const supply = BigInt(state.baseMintAccount.supply.toString());
    if (base > 0n) out.mcapSol = Number((quote * supply) / base) / 1e9;
  } catch {}
  return out;
}

/** Unsigned buy: spend `solAmount` SOL on `mint` in its PumpSwap pool. */
async function buildPumpSwapBuyTx({ connection, user, mint, solAmount, slippagePct, tipSol = 0, computeUnitLimit = 300_000, priorityFeeMicroLamports = 0, guardInstructions = [] }) {
  const state = await poolState(connection, user, mint);
  const lamports = new BN(Math.round(solAmount * 1e9));
  if (lamports.lten(0)) throw new UnsupportedPumpSwapTradeError('buy amount rounds to zero');
  // Slippage in percent (the SDK's convention, same as config.SLIPPAGE).
  const instructions = await PUMP_AMM_SDK.buyQuoteInput(state, lamports, slippagePct);
  const tx = labelled(await assembleV0Tx({ connection, payer: user, instructions, computeUnitLimit, priorityFeeMicroLamports, tipSol, guardInstructions }));
  attachQuote(tx, expectedFill(state, lamports, slippagePct));
  attachCoin(tx, coinInfo(state));
  return tx;
}

/** Unsigned sell: sell `tokenAmountUi` of `mint` for SOL in its PumpSwap pool. */
/** Instructions that move a coin's tokens from plain accounts into the ATA (none if there are none). */
async function plainPrelude(connection, user, mint, state) {
  const program = state.baseTokenProgram;
  if (!program) return [];
  const list = plainAccount.holders(user, mint, program);
  const infos = await connection.getMultipleAccountsInfo(list.map((h) => h.address));
  const moves = [];
  list.forEach((h, i) => {
    const raw = plainAccount.amountOf(infos[i]);
    if (h.kind === 'plain' && raw && raw > 0n) moves.push({ address: h.address, raw });
  });
  if (!moves.length) return [];
  const pre = [];
  if (!infos[0]) pre.push(plainAccount.createAtaInstruction(user, mint, program));
  pre.push(...plainAccount.moveInstructions({ user, mint, program, decimals: state.baseMintAccount.decimals, to: list[0].address, moves }));
  return pre;
}

async function buildPumpSwapSellTx({ connection, user, mint, tokenAmountUi, slippagePct, tipSol = 0, computeUnitLimit = 300_000, priorityFeeMicroLamports = 0 }) {
  const state = await poolState(connection, user, mint);
  const raw = uiToRaw(tokenAmountUi, state.baseMintAccount.decimals);
  if (raw <= 0n) throw new UnsupportedPumpSwapTradeError(`sell amount for ${mint} rounds to zero`);
  let instructions = await PUMP_AMM_SDK.sellBaseInput(state, new BN(raw.toString()), slippagePct);
  // TOKEN_ACCOUNT_MODE=plain: tokens bought into a plain account are moved into the ATA first (the pool sells from there).
  if (plainAccount.everUsed()) {
    const pre = await plainPrelude(connection, user, mint, state);
    if (pre.length) instructions = [...pre, ...instructions];
  }
  return labelled(await assembleV0Tx({ connection, payer: user, instructions, computeUnitLimit, priorityFeeMicroLamports, tipSol }));
}

module.exports = { fastPoolState, buildPumpSwapBuyTx, buildPumpSwapSellTx, UnsupportedPumpSwapTradeError };
