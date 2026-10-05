// src/pumpswapDirect.js
//
// Builds PumpSwap (Pump.fun's own AMM, where coins trade after their bonding
// curve completes) buy/sell transactions directly, using Pump.fun's official
// SDK (@pump-fun/pump-swap-sdk). Only the coin's canonical SOL pool (the one
// Pump.fun migrates every graduated coin into) is used; anything else is
// rejected with UnsupportedPumpSwapTradeError so the caller falls back.
//
// Costs two RPC round trips (pool + config, then token accounts), plus the
// blockhash.

const { PublicKey } = require('@solana/web3.js');
const { NATIVE_MINT } = require('@solana/spl-token');
const BN = require('bn.js');
const { OnlinePumpAmmSdk, PUMP_AMM_SDK, canonicalPumpPoolPda, buyQuoteInput } = require('@pump-fun/pump-swap-sdk');
const { assembleV0Tx } = require('./txAssemble');
const { uiToRaw } = require('./amounts');
const { attachQuote, attachCoin } = require('./buyQuote');

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

async function poolState(connection, user, mint) {
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
async function buildPumpSwapSellTx({ connection, user, mint, tokenAmountUi, slippagePct, tipSol = 0, computeUnitLimit = 300_000, priorityFeeMicroLamports = 0 }) {
  const state = await poolState(connection, user, mint);
  const raw = uiToRaw(tokenAmountUi, state.baseMintAccount.decimals);
  if (raw <= 0n) throw new UnsupportedPumpSwapTradeError(`sell amount for ${mint} rounds to zero`);
  const instructions = await PUMP_AMM_SDK.sellBaseInput(state, new BN(raw.toString()), slippagePct);
  return labelled(await assembleV0Tx({ connection, payer: user, instructions, computeUnitLimit, priorityFeeMicroLamports, tipSol }));
}

module.exports = { buildPumpSwapBuyTx, buildPumpSwapSellTx, UnsupportedPumpSwapTradeError };
