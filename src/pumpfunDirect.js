// src/pumpfunDirect.js
//
// Builds Pump.fun bonding-curve buy/sell transactions directly against the
// on-chain program, using Pump.fun's own official SDK (@pump-fun/pump-sdk)
// instead of routing through SolanaPortal's trade-building API. This cuts
// one network hop (portal API call) out of the buy/sell path for the DEX
// you copy-trade most.
//
// Scope: SOL-paired bonding-curve coins, on either token program: classic
// SPL Token or Token-2022 (newer Pump.fun coins are created as Token-2022).
// Which one a coin uses is read from its mint account, in parallel with the
// global-config fetch so it adds no time. Anything else (non-SOL-quoted
// coins, a mint owned by some other program, an already-migrated/complete
// curve) is detected up front and rejected with UnsupportedPumpfunTradeError,
// so the caller can fall back to SolanaPortal rather than risk assembling a
// malformed transaction.
//
// This module only *builds* the transaction — signing and submission stay
// in tradeExecutor.js, alongside the existing Jito-send path, so both the
// direct and SolanaPortal paths share one signing/sending code path.

require('./pdaCache'); // remember program-derived addresses (see pdaCache.js)
const { PublicKey, TransactionInstruction } = require('@solana/web3.js');
const { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, NATIVE_MINT, getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction } = require('@solana/spl-token');
const BN = require('bn.js');
const {
  PUMP_SDK,
  OnlinePumpSdk,
  getBuyTokenAmountFromSolAmount,
  getSellSolAmountFromTokenAmount,
  bondingCurvePda,
  creatorVaultPda
} = require('@pump-fun/pump-sdk');
const prewarm = require('./prewarm');
const { assembleV0Tx } = require('./txAssemble');
const { attachQuote, attachCoin } = require('./buyQuote');
const { uiToRaw } = require('./amounts');
const { info } = require('./logger');
const quoteTokens = require('./quoteTokens');
const config = require('./config');

class UnsupportedPumpfunTradeError extends Error {}

function solToLamportsBN(sol) {
  return new BN(Math.round(sol * 1e9));
}

// mint -> { program, supply, decimals }. Read once per coin: the token
// program and decimals never change, and Pump.fun coins have a fixed supply.
const mintCache = new Map();

/**
 * The coin's token program (classic SPL Token or Token-2022), supply and
 * decimals, all from one read of its mint account. Both programs share the
 * same base layout: supply = u64 at byte 36, decimals = u8 at byte 44.
 */
async function mintDetails(connection, mintPk) {
  const key = mintPk.toBase58();
  if (mintCache.has(key)) return mintCache.get(key);
  const acc = await connection.getAccountInfo(mintPk, 'confirmed');
  return parseMint(acc, key);
}

/** { program, supply, decimals } from a mint account (cached per coin). */
function parseMint(acc, key) {
  if (mintCache.has(key)) return mintCache.get(key);
  if (!acc) throw new UnsupportedPumpfunTradeError(`${key}: coin account not found`);
  let program;
  if (acc.owner.equals(TOKEN_PROGRAM_ID)) program = TOKEN_PROGRAM_ID;
  else if (acc.owner.equals(TOKEN_2022_PROGRAM_ID)) program = TOKEN_2022_PROGRAM_ID;
  else throw new UnsupportedPumpfunTradeError(`${key} is owned by an unexpected program (${acc.owner.toBase58()})`);
  const data = Buffer.from(acc.data || []);
  if (data.length < 45) throw new UnsupportedPumpfunTradeError(`${key}: coin account is too short to be a token mint`);
  const details = { program, supply: new BN(data.readBigUInt64LE(36).toString()), decimals: data.readUInt8(44) };
  mintCache.set(key, details);
  return details;
}

// Pump.fun's online SDK, one per connection. Creating one sets up the SDK's
// programs from their (large) IDLs, which took 20-30 ms of CPU, far more on
// a 1-vCPU server, every time a trade was built.
const onlineSdks = new WeakMap();
function onlineSdkFor(connection) {
  let sdk = onlineSdks.get(connection);
  if (!sdk) {
    sdk = new OnlinePumpSdk(connection);
    onlineSdks.set(connection, sdk);
  }
  return sdk;
}

// ---- one-lookup trade state (PREWARM) ----

/** Pump.fun's global config: the warm copy if there is one, else fetched now. */
function globalConfig(onlineSdk) {
  const warm = prewarm.pumpGlobal();
  return warm ? Promise.resolve(warm) : onlineSdk.fetchGlobal();
}

function isSolQuote(quoteMint) {
  return !quoteMint || quoteMint.equals(PublicKey.default) || quoteMint.equals(NATIVE_MINT);
}

/**
 * Everything a buy or sell needs about this coin and wallet, in ONE call:
 * its bonding curve, your token account, and (for a coin not seen before)
 * its mint account. Your token account's address depends on the coin's token
 * program, so for a new coin both possible addresses are asked for and the
 * mint account says which one is real.
 */
async function curveState(connection, mintPk, user) {
  const key = mintPk.toBase58();
  const curvePk = bondingCurvePda(mintPk);
  const known = mintCache.get(key);
  let curveAcc;
  let userAcc;
  let mintInfo = known;
  if (known) {
    [curveAcc, userAcc] = await connection.getMultipleAccountsInfo([curvePk, getAssociatedTokenAddressSync(mintPk, user, true, known.program)]);
  } else {
    let mintAcc;
    let ataClassic;
    let ata2022;
    [curveAcc, mintAcc, ataClassic, ata2022] = await connection.getMultipleAccountsInfo([
      curvePk,
      mintPk,
      getAssociatedTokenAddressSync(mintPk, user, true, TOKEN_PROGRAM_ID),
      getAssociatedTokenAddressSync(mintPk, user, true, TOKEN_2022_PROGRAM_ID)
    ]);
    mintInfo = parseMint(mintAcc, key);
    userAcc = mintInfo.program.equals(TOKEN_2022_PROGRAM_ID) ? ata2022 : ataClassic;
  }
  if (!curveAcc) throw new Error(`Bonding curve account not found for mint: ${key}`);
  const bondingCurve = PUMP_SDK.decodeBondingCurve(curveAcc);
  const sol = isSolQuote(bondingCurve.quoteMint);
  let quoteTokenProgram = TOKEN_PROGRAM_ID;
  if (!sol) {
    // Paired to another token: which token program it uses (from QUOTE_TOKENS'
    // reserve if listed, else read once and remembered).
    const q = bondingCurve.quoteMint.toBase58();
    quoteTokens.noteQuoteMint(q);
    const t = quoteTokens.get(q);
    quoteTokenProgram = t && t.program ? t.program : await quoteProgramOf(connection, bondingCurve.quoteMint);
  }
  return {
    mintInfo,
    bondingCurveAccountInfo: curveAcc,
    bondingCurve,
    associatedUserAccountInfo: userAcc || null,
    quoteMint: sol ? NATIVE_MINT : bondingCurve.quoteMint,
    quoteTokenProgram
  };
}

const quotePrograms = new Map(); // quote mint -> its token program
async function quoteProgramOf(connection, quoteMint) {
  const key = quoteMint.toBase58();
  if (quotePrograms.has(key)) return quotePrograms.get(key);
  const acc = await connection.getAccountInfo(quoteMint, 'confirmed');
  if (!acc) throw new UnsupportedPumpfunTradeError(`quote token ${key} not found`);
  const program = acc.owner.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
  quotePrograms.set(key, program);
  return program;
}

// ---- zero-lookup buys (curve hint from the copy wallet's trade record) ----

// The hint describes the curve right after his buy; much older than this and
// enough else may have traded that a fresh lookup is worth its time.
const HINT_MAX_AGE_MS = 3000;
const PUMP_DECIMALS = 6; // every Pump.fun coin

/**
 * The same state curveState() returns, built from the copy wallet's Pump.fun
 * trade record instead of a lookup: { st } or { reason } (why it can't be
 * used; the caller then looks the coin up). Your token account is created in
 * the same transaction if needed (an idempotent create: harmless if it
 * already exists), so it doesn't need checking either.
 */
function stateFromHint(hint, mintPk) {
  const key = mintPk.toBase58();
  if (!hint || hint.mint !== key) return { reason: 'no trade record for this coin' };
  if (typeof hint.at === 'number' && Date.now() - hint.at > HINT_MAX_AGE_MS) return { reason: 'his trade record is over 3s old' };
  if (!hint.solQuoted) return { reason: 'not SOL-paired' };
  const known = mintCache.get(key);
  let program = known ? known.program : null;
  if (!program && hint.tokenProgram === 'spl-token') program = TOKEN_PROGRAM_ID;
  if (!program && hint.tokenProgram === 'token-2022') program = TOKEN_2022_PROGRAM_ID;
  if (!program) return { reason: "the coin's token program isn't clear from his trade" };
  // Mayhem-mode coins don't have the standard supply, which the fee tier
  // depends on: use the hint only once the real supply is known.
  if (hint.mayhemMode && !known) return { reason: 'mayhem-mode coin seen for the first time' };
  let bondingCurve;
  try {
    const vT = new BN(hint.virtualTokenReserves);
    const vQ = new BN(hint.virtualSolReserves);
    const rT = new BN(hint.realTokenReserves);
    if (vT.isZero() || vQ.isZero()) return { reason: 'his trade record has no reserves' };
    bondingCurve = {
      virtualTokenReserves: vT,
      virtualQuoteReserves: vQ,
      realTokenReserves: rT,
      realQuoteReserves: new BN(hint.realSolReserves),
      tokenTotalSupply: known ? known.supply : null,
      complete: rT.isZero(), // his buy took the last tokens: the coin is graduating
      creator: new PublicKey(hint.creator),
      isMayhemMode: !!hint.mayhemMode,
      isCashbackCoin: false, // only matters for sells, which still look the coin up
      quoteMint: PublicKey.default,
      creatorFeeBps: new BN(hint.creatorFeeBps || '0')
    };
  } catch (err) {
    return { reason: `unreadable trade record (${err.message})` };
  }
  const mintInfo = known || { program, supply: null, decimals: PUMP_DECIMALS };
  return {
    st: {
      mintInfo,
      bondingCurveAccountInfo: null,
      bondingCurve,
      associatedUserAccountInfo: null, // -> idempotent create in the same tx
      quoteMint: NATIVE_MINT,
      quoteTokenProgram: TOKEN_PROGRAM_ID
    }
  };
}

// ---- SHRED_FAST_BUY: buys built from the shred stream with no lookup ----

const BUY_EXACT_SOL_IN = Buffer.from('38fc74089edfcd5f', 'hex'); // same accounts and argument layout as `buy`
const BUY_DISC = '66063d1201daebea';
const PLACEHOLDER_CREATOR = PublicKey.default; // replaced by the real creator vault below

function bigSqrt(n) {
  if (n < 2n) return n;
  let x = BigInt(Math.floor(Math.sqrt(Number(n))));
  for (let i = 0; i < 6; i++) x = (x + n / x) >> 1n;
  while (x * x > n) x -= 1n;
  while ((x + 1n) * (x + 1n) <= n) x += 1n;
  return x;
}

/** Highest total (protocol + creator) fee rate any tier charges, in bps: the safe side for a minimum. */
function worstFeeBps(global) {
  const fc = feeConfigCache.value;
  let worst = 0;
  for (const t of (fc && fc.feeTiers) || []) {
    const f = t.fees || {};
    worst = Math.max(worst, Number(f.protocolFeeBps || 0) + Number(f.creatorFeeBps || 0));
  }
  if (!worst) worst = Number(global.feeBasisPoints || 0) + Number(global.creatorFeeBasisPoints || 0);
  return worst || 125;
}

/**
 * Tokens `lamports` would buy if the curve stood at `maxMcapSol` (fees taken
 * off as the program does, our own price impact included). Pump.fun curves
 * keep virtual SOL x virtual tokens constant, so a market cap fixes the
 * reserves: mcap = vSol^2 x supply / k. Used as min_tokens_out, so the buy
 * fails on-chain if the coin is any dearer than that market cap.
 */
function minTokensAtMcap(global, lamports, maxMcapSol) {
  const vS0 = BigInt(global.initialVirtualSolReserves.toString());
  const vT0 = BigInt(global.initialVirtualTokenReserves.toString());
  const supply = BigInt(global.tokenTotalSupply.toString());
  const k = vS0 * vT0;
  const mcapLamports = BigInt(Math.floor(maxMcapSol * 1e9));
  const vS = bigSqrt((mcapLamports * k) / supply);
  if (vS <= 0n) return 0n;
  const vT = k / vS;
  const feeBps = BigInt(worstFeeBps(global));
  const net = (BigInt(lamports) * 10000n) / (10000n + feeBps);
  if (net <= 1n) return 0n;
  return ((net - 1n) * vT) / (vS + net - 1n);
}

/** Which token program the coin uses, from the curve's token account in his transaction. */
function tokenProgramFromKeys(mintPk, keySet) {
  const known = mintCache.get(mintPk.toBase58());
  if (known) return known.program;
  const curve = bondingCurvePda(mintPk);
  const classic = keySet.has(getAssociatedTokenAddressSync(mintPk, curve, true, TOKEN_PROGRAM_ID).toBase58());
  const t22 = keySet.has(getAssociatedTokenAddressSync(mintPk, curve, true, TOKEN_2022_PROGRAM_ID).toBase58());
  if (classic === t22) return null; // neither, or (impossibly) both
  return classic ? TOKEN_PROGRAM_ID : TOKEN_2022_PROGRAM_ID;
}

/** Is it a mayhem-mode coin? From the fee recipient his buy used: true / false / null (can't tell). */
function mayhemFromKeys(global, keySet) {
  const list = (a, b) => [a, ...(b || [])].filter(Boolean).map((k) => k.toBase58());
  if (list(global.reservedFeeRecipient, global.reservedFeeRecipients).some((k) => keySet.has(k))) return true;
  if (list(global.feeRecipient, global.feeRecipients).some((k) => keySet.has(k))) return false;
  return null;
}

/**
 * A Pump.fun buy built from the copy wallet's shred transaction alone:
 * buy_exact_sol_in, spending exactly the SOL, with min_tokens_out set from
 * MAX_MARKET_CAP_SOL. Returns { tx } or { reason } (then the normal build).
 */
async function buildFastBuy({ connection, user, mintPk, solAmount, fastHint, maxMcapSol, minMcapSol, blockedCreators, tipSol, computeUnitLimit, priorityFeeMicroLamports, guardInstructions }) {
  const global = prewarm.pumpGlobal();
  if (!global || !prewarm.blockhash()) return { reason: "Pump.fun's config or a blockhash isn't warm" };
  if (!(maxMcapSol > 0)) return { reason: 'MAX_MARKET_CAP_SOL is not set' };
  if (minMcapSol !== null && minMcapSol !== undefined) return { reason: 'MIN_MARKET_CAP_SOL needs the lookup' };
  if (!fastHint || fastHint.mint !== mintPk.toBase58()) return { reason: 'no shred data for this coin' };
  if (!fastHint.creatorVault) return { reason: "the coin's creator account isn't known yet (router still being learned)" };
  // Built as a SOL buy: on a curve paired to another token it would fail on-chain.
  const quoteSeen = quoteTokens.mentionsQuoteMint(fastHint.txKeys);
  if (quoteSeen) return { reason: `his transaction involves ${quoteTokens.label(quoteSeen)}: the coin may be paired to it, which needs the lookup` };
  const keySet = new Set(fastHint.txKeys || []);
  const tokenProgram = tokenProgramFromKeys(mintPk, keySet);
  if (!tokenProgram) return { reason: "the coin's token program isn't clear from his transaction" };
  const mayhem = mayhemFromKeys(global, keySet);
  if (mayhem !== false) return { reason: mayhem ? 'mayhem-mode coin (non-standard supply)' : "can't tell from his transaction whether it's a mayhem-mode coin" };

  const lamports = BigInt(Math.round(solAmount * 1e9));
  const minOut = minTokensAtMcap(global, lamports, maxMcapSol);
  if (minOut <= 0n) return { reason: 'buy too small to set a minimum' };

  const [ataIx, buyIx] = await PUMP_SDK.buyInstructions({
    global,
    bondingCurveAccountInfo: null,
    bondingCurve: { creator: PLACEHOLDER_CREATOR, isMayhemMode: false },
    associatedUserAccountInfo: null, // idempotent create
    mint: mintPk,
    user,
    amount: new BN(minOut.toString()),
    solAmount: new BN(lamports.toString()),
    slippage: 0,
    tokenProgram
  });
  // Turn the SDK's `buy` into buy_exact_sol_in (identical accounts and
  // argument layout), with the real creator vault from his transaction.
  const placeholderVault = creatorVaultPda(PLACEHOLDER_CREATOR);
  if (!buyIx || Buffer.from(buyIx.data).subarray(0, 8).toString('hex') !== BUY_DISC || !buyIx.keys[9] || !buyIx.keys[9].pubkey.equals(placeholderVault)) {
    return { reason: 'unexpected Pump.fun instruction layout' };
  }
  const data = Buffer.from(buyIx.data);
  BUY_EXACT_SOL_IN.copy(data, 0);
  data.writeBigUInt64LE(lamports, 8); // spendable_sol_in
  data.writeBigUInt64LE(minOut, 16); // min_tokens_out
  const keys = buyIx.keys.map((k, i) => (i === 9 ? { ...k, pubkey: new PublicKey(fastHint.creatorVault) } : k));
  const fastIx = new TransactionInstruction({ programId: buyIx.programId, keys, data });

  const tx = await assembleV0Tx({ connection, payer: user, instructions: [ataIx, fastIx], computeUnitLimit, priorityFeeMicroLamports, tipSol, guardInstructions });
  let creatorBlocked = false;
  if (blockedCreators && blockedCreators.size) {
    for (const c of blockedCreators) {
      if (creatorVaultPda(new PublicKey(c)).toBase58() === fastHint.creatorVault) creatorBlocked = true;
    }
  }
  attachCoin(tx, { capOnChain: true, creatorBlocked });
  tx.builtFrom = `no lookup (SHRED_FAST_BUY: exact ${solAmount} SOL, at least ${(Number(minOut) / 1e6).toFixed(0)} tokens = market cap ${maxMcapSol} SOL)`;
  return { tx };
}

/** Re-read the fee schedule now (prewarm.js: at startup, then every few minutes). */
function warmFeeConfig(connection) {
  return currentFeeConfig(onlineSdkFor(connection), { force: true });
}

async function mintTokenProgram(connection, mintPk) {
  return (await mintDetails(connection, mintPk)).program;
}

// Pump.fun's fee schedule (fees by market cap). It changes rarely, so it is
// fetched at most every 10 minutes, alongside the other lookups (no added
// time). If it can't be read, the base fee rate from the global config is
// used instead; the slippage margin absorbs the small difference.
const FEE_CONFIG_TTL_MS = 10 * 60 * 1000;
let feeConfigCache = { value: null, at: 0 };

async function currentFeeConfig(onlineSdk, { force = false } = {}) {
  if (!force && feeConfigCache.value && Date.now() - feeConfigCache.at < FEE_CONFIG_TTL_MS) return feeConfigCache.value;
  try {
    const value = await onlineSdk.fetchFeeConfig();
    feeConfigCache = { value, at: Date.now() };
    return value;
  } catch {
    return feeConfigCache.value; // stale is better than none
  }
}

function _resetForTests() {
  mintCache.clear();
  feeConfigCache = { value: null, at: 0 };
}

/** Real supply when known, else the standard Pump.fun supply. */
function supplyOrDefault(details, global) {
  return details.supply && !details.supply.isZero() ? details.supply : global.tokenTotalSupply;
}

const PUMP_TOKEN_MINT = 'pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn';

function assertSupportedCurve(bondingCurve, quoteMint, quoteTokenProgram, mint) {
  if (!quoteMint.equals(NATIVE_MINT)) {
    const q = quoteMint.toBase58();
    const { isStockToken, stockLabel } = require('./stockTokens');
    const name = q === PUMP_TOKEN_MINT ? 'the PUMP token' : isStockToken(q) ? `${stockLabel(q)} (a stock token)` : `token ${q}`;
    throw new UnsupportedPumpfunTradeError(
      `${mint} is paired to ${name} instead of SOL; to buy coins paired to it, add ${q} to QUOTE_TOKENS`
    );
  }
  if (!quoteTokenProgram.equals(TOKEN_PROGRAM_ID)) {
    throw new UnsupportedPumpfunTradeError(`${mint} uses an unexpected quote token program`);
  }
  if (bondingCurve.complete) {
    const e = new UnsupportedPumpfunTradeError(`${mint} bonding curve is complete (graduated to PumpSwap)`);
    e.graduated = true;
    throw e;
  }
}

/**
 * Build an unsigned buy transaction.
 * @param solAmount   - SOL to spend (plain number, e.g. 0.05)
 * @param slippagePct - percent, e.g. 20 for 20% (same convention as config.SLIPPAGE)
 */
async function buildPumpfunBuyTx({
  connection,
  user,
  mint,
  solAmount,
  slippagePct,
  tipSol = 0,
  computeUnitLimit = 200_000,
  priorityFeeMicroLamports = 0,
  curveHint = null,
  guardInstructions = [],
  fastHint = null,
  maxMcapSol = null,
  minMcapSol = null,
  blockedCreators = null
}) {
  const mintPk = new PublicKey(mint);
  const onlineSdk = onlineSdkFor(connection);

  if (fastHint) {
    const fast = await buildFastBuy({ connection, user, mintPk, solAmount, fastHint, maxMcapSol, minMcapSol, blockedCreators, tipSol, computeUnitLimit, priorityFeeMicroLamports, guardInstructions });
    if (fast.tx) return fast.tx;
    info(`[pumpfunDirect] Not building ${mint} without a lookup (${fast.reason}); looking the coin up.`);
  }

  // With the copy wallet's trade record (processed feed) and PREWARM's
  // global config, fee schedule and blockhash: no network calls at all.
  // Otherwise one round trip: the curve, token account and (new coin) mint.
  const hinted = curveHint ? stateFromHint(curveHint, mintPk) : null;
  if (hinted && !hinted.st) info(`[pumpfunDirect] Not building ${mint} from the copy wallet's trade record (${hinted.reason}); looking the coin up.`);
  const stateNow = hinted && hinted.st ? Promise.resolve(hinted.st) : curveState(connection, mintPk, user);
  const [global, st, feeConfig] = await Promise.all([globalConfig(onlineSdk), stateNow, currentFeeConfig(onlineSdk)]);
  const { mintInfo, quoteMint, quoteTokenProgram, bondingCurveAccountInfo, bondingCurve, associatedUserAccountInfo } = st;
  const tokenProgram = mintInfo.program;

  if (!quoteMint.equals(NATIVE_MINT) && quoteTokens.get(quoteMint)) {
    return buildQuoteBuy({ connection, user, mintPk, solAmount, slippagePct, global, feeConfig, st, tipSol, computeUnitLimit, priorityFeeMicroLamports, guardInstructions });
  }
  assertSupportedCurve(bondingCurve, quoteMint, quoteTokenProgram, mint);

  const solAmountLamports = solToLamportsBN(solAmount);

  // How many tokens our SOL buys at the curve's CURRENT price. mintSupply
  // must not be null: the SDK then prices the buy as if the coin had just
  // launched, asks for far too many tokens, and once the price is more than
  // about 2x its launch price the buy fails with "too much SOL required"
  // whatever SLIPPAGE is set to.
  const tokenAmount = getBuyTokenAmountFromSolAmount({
    global,
    feeConfig,
    mintSupply: supplyOrDefault(mintInfo, global),
    bondingCurve,
    amount: solAmountLamports,
    quoteMint
  });

  if (tokenAmount.lten(0)) {
    throw new UnsupportedPumpfunTradeError(`Computed zero token amount for ${mint} — curve may be nearly exhausted`);
  }

  const instructions = await PUMP_SDK.buyInstructions({
    global,
    bondingCurveAccountInfo,
    bondingCurve,
    associatedUserAccountInfo,
    mint: mintPk,
    user,
    amount: tokenAmount,
    solAmount: solAmountLamports,
    slippage: slippagePct,
    tokenProgram
  });

  const tx = await assembleV0Tx({ connection, payer: user, instructions, computeUnitLimit, priorityFeeMicroLamports, tipSol, guardInstructions });
  if (hinted && hinted.st) tx.builtFrom = "from the copy wallet's trade record, no lookups";
  // Market cap just before our buy (price x supply, as Pump.fun computes it)
  // and the creator, for the instant buy filters.
  try {
    const supply = supplyOrDefault(mintInfo, global);
    const vQ0 = bondingCurve.virtualQuoteReserves;
    const vT0 = bondingCurve.virtualTokenReserves;
    attachCoin(tx, {
      mcapSol: vQ0 && vT0 && !vT0.isZero() ? Number(vQ0.mul(supply).div(vT0).toString()) / 1e9 : null,
      creator: bondingCurve.creator ? bondingCurve.creator.toBase58() : null
    });
  } catch {}
  // Expected fill, fees excluded (the same basis as the copy wallet's price
  // read from its Pump.fun trade record), for MAX_ENTRY_PREMIUM_PCT.
  const vT = bondingCurve.virtualTokenReserves;
  const vQ = bondingCurve.virtualQuoteReserves;
  if (vT && vQ && vT.gt(tokenAmount)) {
    const netLamports = tokenAmount.mul(vQ).div(vT.sub(tokenAmount)).addn(1);
    attachQuote(tx, { solIn: Number(netLamports.toString()) / 1e9, tokensOut: Number(tokenAmount.toString()) / 10 ** mintInfo.decimals });
  }
  return tx;
}

/**
 * Build an unsigned sell transaction.
 * @param tokenAmountUi - tokens to sell, in UI units (e.g. "1234.56")
 * @param slippagePct   - percent, e.g. 20 for 20%
 */
async function buildPumpfunSellTx({
  connection,
  user,
  mint,
  tokenAmountUi,
  slippagePct,
  tipSol = 0,
  computeUnitLimit = 200_000,
  priorityFeeMicroLamports = 0
}) {
  const mintPk = new PublicKey(mint);
  const onlineSdk = onlineSdkFor(connection);

  const [global, st, feeConfig] = await Promise.all([globalConfig(onlineSdk), curveState(connection, mintPk, user), currentFeeConfig(onlineSdk)]);
  const { mintInfo, quoteMint, quoteTokenProgram, bondingCurveAccountInfo, bondingCurve } = st;
  const tokenProgram = mintInfo.program;

  if (!quoteMint.equals(NATIVE_MINT) && !bondingCurve.complete) {
    return buildQuoteSell({ connection, user, mintPk, tokenAmountUi, slippagePct, global, feeConfig, st, tipSol, computeUnitLimit, priorityFeeMicroLamports });
  }
  assertSupportedCurve(bondingCurve, quoteMint, quoteTokenProgram, mint);

  // Exact string->BigInt conversion: float math here can round up by one raw
  // unit, i.e. try to sell slightly more than we hold, failing the tx.
  const rawAmount = uiToRaw(tokenAmountUi, mintInfo.decimals);
  if (rawAmount <= 0n) {
    throw new UnsupportedPumpfunTradeError(`Sell amount for ${mint} rounds to zero raw tokens`);
  }
  const amount = new BN(rawAmount.toString());

  const solAmount = getSellSolAmountFromTokenAmount({
    global,
    feeConfig,
    mintSupply: supplyOrDefault(mintInfo, global),
    bondingCurve,
    amount
  });

  const instructions = await PUMP_SDK.sellInstructions({
    global,
    bondingCurveAccountInfo,
    bondingCurve,
    mint: mintPk,
    user,
    amount,
    solAmount,
    slippage: slippagePct,
    tokenProgram,
    mayhemMode: bondingCurve.isMayhemMode || false,
    cashback: bondingCurve.isCashbackCoin || false
  });

  return assembleV0Tx({ connection, payer: user, instructions, computeUnitLimit, priorityFeeMicroLamports, tipSol });
}

// ---- coins paired to another token (QUOTE_TOKENS) ----

const BUY_V2_DISC = 'b817ee6167c5d33d';
const BUY_EXACT_QUOTE_IN_V2 = Buffer.from('c2ab1c46684d5b2f', 'hex'); // same accounts and argument layout as buy_v2

/**
 * Compute budget for a trade on a token-paired curve (token transfers and
 * more accounts than a SOL trade), with the priority fee per unit lowered so
 * the TOTAL fee stays what it would have been.
 */
function quoteBudget(computeUnitLimit, priorityFeeMicroLamports) {
  const units = Math.max(computeUnitLimit, config.QUOTE_COMPUTE_UNITS);
  const price = priorityFeeMicroLamports ? Math.ceil((priorityFeeMicroLamports * computeUnitLimit) / units) : 0;
  return { units, price };
}

function fmtRaw(raw, decimals) {
  return (Number(raw) / 10 ** (decimals || 0)).toLocaleString('en-US', { maximumFractionDigits: 4 });
}

/**
 * A buy of a coin paired to a QUOTE_TOKENS token, paid from the reserve:
 * buy_exact_quote_in_v2 spending the token worth `solAmount` SOL (at its
 * current price), at least (100 - slippage)% of the tokens the curve gives.
 */
async function buildQuoteBuy({ connection, user, mintPk, solAmount, slippagePct, global, feeConfig, st, tipSol, computeUnitLimit, priorityFeeMicroLamports, guardInstructions }) {
  const { mintInfo, quoteMint, bondingCurve, associatedUserAccountInfo } = st;
  const mint = mintPk.toBase58();
  const q = quoteMint.toBase58();
  const t = quoteTokens.get(q);
  const name = t.label;
  if (bondingCurve.complete) {
    const e = new UnsupportedPumpfunTradeError(`${mint} bonding curve is complete (graduated to PumpSwap)`);
    e.graduated = true;
    throw e;
  }
  if (!t.program) throw new UnsupportedPumpfunTradeError(`${mint} is paired to ${name}, which isn't ready (its token account couldn't be read)`);
  const lpr = quoteTokens.lamportsPerRaw(q);
  if (!lpr) throw new UnsupportedPumpfunTradeError(`${mint} is paired to ${name}, whose price isn't known yet (Jupiter)`);
  const spendRaw = BigInt(Math.floor((solAmount * 1e9) / lpr));
  if (spendRaw <= 0n) throw new UnsupportedPumpfunTradeError(`${solAmount} SOL is less than one unit of ${name}`);
  const free = quoteTokens.available(q);
  if (free === null || free < spendRaw) {
    quoteTokens.afterTrade(q); // re-read the balance and top the reserve up
    throw new UnsupportedPumpfunTradeError(
      `${mint} is paired to ${name}: the reserve has ${free === null ? 'an unknown amount' : fmtRaw(free, t.decimals)} free, ` +
        `${fmtRaw(spendRaw, t.decimals)} needed for ${solAmount} SOL (topping it up)`
    );
  }

  const tokenProgram = mintInfo.program;
  const spend = new BN(spendRaw.toString());
  const tokens = getBuyTokenAmountFromSolAmount({ global, feeConfig, mintSupply: supplyOrDefault(mintInfo, global), bondingCurve, amount: spend, quoteMint });
  if (tokens.lten(0)) throw new UnsupportedPumpfunTradeError(`Computed zero token amount for ${mint} — curve may be nearly exhausted`);
  const minOut = tokens.muln(Math.max(0, Math.round((100 - slippagePct) * 100))).divn(10000);

  const associatedUser = getAssociatedTokenAddressSync(mintPk, user, true, tokenProgram);
  const ixs = [];
  if (!associatedUserAccountInfo) ixs.push(createAssociatedTokenAccountIdempotentInstruction(user, associatedUser, user, mintPk, tokenProgram));
  const v2 = await PUMP_SDK.buyV2Instruction({
    global,
    mint: mintPk,
    creator: bondingCurve.creator,
    user,
    associatedUser,
    amount: tokens,
    quoteAmount: spend,
    slippage: 0,
    tokenProgram,
    quoteMint,
    quoteTokenProgram: t.program,
    mayhemMode: bondingCurve.isMayhemMode || false
  });
  if (!v2 || Buffer.from(v2.data).subarray(0, 8).toString('hex') !== BUY_V2_DISC || v2.keys.length !== 27) {
    throw new UnsupportedPumpfunTradeError('unexpected Pump.fun buy_v2 instruction layout');
  }
  // buy_v2 -> buy_exact_quote_in_v2 (identical accounts and argument layout).
  const data = Buffer.from(v2.data);
  BUY_EXACT_QUOTE_IN_V2.copy(data, 0);
  data.writeBigUInt64LE(spendRaw, 8); // spendable_quote_in
  data.writeBigUInt64LE(BigInt(minOut.toString()), 16); // min_tokens_out
  ixs.push(new TransactionInstruction({ programId: v2.programId, keys: v2.keys, data }));

  const budget = quoteBudget(computeUnitLimit, priorityFeeMicroLamports);
  const tx = await assembleV0Tx({ connection, payer: user, instructions: ixs, computeUnitLimit: budget.units, priorityFeeMicroLamports: budget.price, tipSol, guardInstructions });
  // Set aside what this buy spends; tradeExecutor releases it once sent (or not).
  quoteTokens.reserve(q, spendRaw);
  tx.quoteTrade = { quoteMint: q, label: name, lamportsPerRaw: lpr, spendRaw };
  tx.builtFrom = `from the ${name} reserve: ${fmtRaw(spendRaw, t.decimals)} ${name} ≈ ${solAmount} SOL`;
  try {
    const supply = supplyOrDefault(mintInfo, global);
    const vQ = bondingCurve.virtualQuoteReserves;
    const vT = bondingCurve.virtualTokenReserves;
    const mcapRaw = vQ && vT && !vT.isZero() ? Number(vQ.mul(supply).div(vT).toString()) : null;
    attachCoin(tx, { mcapSol: mcapRaw !== null ? (mcapRaw * lpr) / 1e9 : null, creator: bondingCurve.creator ? bondingCurve.creator.toBase58() : null });
  } catch {}
  return tx;
}

/** A sell of a coin paired to another token: sell_v2, paid out in that token. */
async function buildQuoteSell({ connection, user, mintPk, tokenAmountUi, slippagePct, global, feeConfig, st, tipSol, computeUnitLimit, priorityFeeMicroLamports }) {
  const { mintInfo, quoteMint, quoteTokenProgram, bondingCurveAccountInfo, bondingCurve } = st;
  const mint = mintPk.toBase58();
  const q = quoteMint.toBase58();
  const tokenProgram = mintInfo.program;
  const rawAmount = uiToRaw(tokenAmountUi, mintInfo.decimals);
  if (rawAmount <= 0n) throw new UnsupportedPumpfunTradeError(`Sell amount for ${mint} rounds to zero raw tokens`);
  const amount = new BN(rawAmount.toString());
  const quoteOut = getSellSolAmountFromTokenAmount({ global, feeConfig, mintSupply: supplyOrDefault(mintInfo, global), bondingCurve, amount });
  const ixs = [
    // Where the proceeds go (exists already if the reserve was used; idempotent).
    createAssociatedTokenAccountIdempotentInstruction(user, getAssociatedTokenAddressSync(quoteMint, user, true, quoteTokenProgram), user, quoteMint, quoteTokenProgram),
    ...(await PUMP_SDK.sellV2Instructions({ global, bondingCurveAccountInfo, bondingCurve, mint: mintPk, user, amount, quoteAmount: quoteOut, slippage: slippagePct, tokenProgram, quoteTokenProgram }))
  ];
  const budget = quoteBudget(computeUnitLimit, priorityFeeMicroLamports);
  const tx = await assembleV0Tx({ connection, payer: user, instructions: ixs, computeUnitLimit: budget.units, priorityFeeMicroLamports: budget.price, tipSol });
  tx.quoteTrade = { quoteMint: q, label: quoteTokens.label(q), lamportsPerRaw: quoteTokens.lamportsPerRaw(q) };
  return tx;
}

/**
 * Build (and sign with a throwaway key) a buy that is never sent, so the
 * code a real copy buy runs is already compiled and hot: the first build
 * after a quiet spell otherwise takes several times longer. Uses only warm
 * data (PREWARM), so it makes no network calls. Returns the time it took (ms),
 * or null if something isn't warm (then it doesn't run).
 */
async function warmUpBuild(connection) {
  // Only with everything warm: a practice build must never touch the network.
  if (!prewarm.blockhash() || !prewarm.pumpGlobal() || !feeConfigCache.value) return null;
  const { Keypair } = require('@solana/web3.js');
  const user = Keypair.generate();
  const mint = Keypair.generate().publicKey;
  const t0 = Date.now();
  const tx = await buildPumpfunBuyTx({
    connection,
    user: user.publicKey,
    mint: mint.toBase58(),
    solAmount: 0.01,
    slippagePct: 20,
    tipSol: 0.001,
    priorityFeeMicroLamports: 1000,
    curveHint: {
      mint: mint.toBase58(),
      virtualTokenReserves: '949246395862678',
      virtualSolReserves: '33911111117',
      realTokenReserves: '669346395862678',
      realSolReserves: '3911111117',
      creator: Keypair.generate().publicKey.toBase58(),
      mayhemMode: false,
      creatorFeeBps: '0',
      tokenProgram: 'token-2022',
      solQuoted: true,
      at: Date.now()
    }
  });
  if (typeof tx.sign === 'function') require('./fastSign').signTx(tx, user); // warms the signing path too
  tx.serialize();
  return Date.now() - t0;
}

module.exports = { buildQuoteBuy, quoteBudget, minTokensAtMcap, buildPumpfunBuyTx, buildPumpfunSellTx, UnsupportedPumpfunTradeError, mintTokenProgram, mintDetails, warmFeeConfig, warmUpBuild, onlineSdkFor, curveState, stateFromHint, _resetForTests };
