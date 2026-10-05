// src/quoteTokens.js
//
// QUOTE_TOKENS: buy Pump.fun coins whose bonding curve is paired to a token
// other than SOL (the PUMP token, a stock token, ...), in the copy wallet's
// block like any other buy.
//
// How: the bot keeps a reserve of each listed token (QUOTE_TOKEN_RESERVE_SOL
// worth, topped up through Jupiter), and a copy buy spends from it directly
// (Pump.fun's buy_exact_quote_in_v2): one instruction, no swap at buy time,
// so it is as fast as a SOL buy and the slot guard works the same. A sell
// pays out in that token, which refills the reserve. Swapping SOL into the
// token at buy time instead would add a second swap (PUMP's liquidity is on
// Orca, for instance) and its lookups to the race.
//
// Amounts are valued in SOL at the token's current price (from Jupiter,
// refreshed every minute): what a buy spends, and what a sell returns, so
// positions, exposure and PnL stay in SOL. The reserve itself moves with the
// token's price while you hold it.

const { PublicKey } = require('@solana/web3.js');
const { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync } = require('@solana/spl-token');
const config = require('./config');
const rpcPool = require('./rpcPool');
const { info, warn } = require('./logger');

const PRICE_REFRESH_MS = 60_000;
const PRICE_MAX_AGE_MS = 5 * 60_000; // older than this: don't trade on it
const BALANCE_REFRESH_MS = 60_000;
const PRICE_PROBE_SOL = 0.1; // the SOL amount priced through Jupiter

// Quote mints Pump.fun curves are known to use. A coin bought "without a
// lookup" (SHRED_FAST_BUY) is always built as a SOL buy, so if the copy
// wallet's transaction mentions one of these, the bot looks the coin up
// instead (a SOL buy on such a curve would fail and still cost its fee).
// Grows as the bot sees new ones.
const PUMP_TOKEN_MINT = 'pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn';
const knownQuoteMints = new Set([
  PUMP_TOKEN_MINT,
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'BMKdM4yUxX12moFqVk195k7coMbaybd4RUKCUdm7D1Sk',
  ...(config.QUOTE_TOKENS || [])
]);

// mint -> { mint, label, program, decimals, lamportsPerRaw, priceAt,
//           balanceRaw, balanceAt, reservedRaw, topUp }
const tokens = new Map();
let deps = null; // { send(tx) -> signature, confirm(sig) -> { confirmed } , buildJupiterBuy }
let timers = [];

function label(mint) {
  if (mint === PUMP_TOKEN_MINT) return 'PUMP';
  try {
    const { isStockToken, stockLabel } = require('./stockTokens');
    if (isStockToken(mint)) return stockLabel(mint);
  } catch {}
  return `${mint.slice(0, 4)}…${mint.slice(-4)}`;
}

function noteQuoteMint(mint) {
  if (mint && !knownQuoteMints.has(mint)) {
    knownQuoteMints.add(mint);
    if (knownQuoteMints.size > 500) knownQuoteMints.delete(knownQuoteMints.values().next().value);
  }
}

/** Does this list of accounts (his transaction) mention a known non-SOL quote mint? */
function mentionsQuoteMint(keys) {
  for (const k of keys || []) if (knownQuoteMints.has(k)) return k;
  try {
    const { isStockToken } = require('./stockTokens');
    for (const k of keys || []) if (isStockToken(k)) return k;
  } catch {}
  return null;
}

function enabled() {
  return Array.isArray(config.QUOTE_TOKENS) && config.QUOTE_TOKENS.length > 0;
}

function get(mint) {
  return tokens.get(typeof mint === 'string' ? mint : mint.toBase58()) || null;
}

/** SOL (lamports) per raw unit of the token, or null if unknown / too old. */
function lamportsPerRaw(mint) {
  const t = get(mint);
  if (!t || !(t.lamportsPerRaw > 0) || Date.now() - t.priceAt > PRICE_MAX_AGE_MS) return null;
  return t.lamportsPerRaw;
}

/** Raw units held and not set aside for a buy in flight (null: unknown). */
function available(mint) {
  const t = get(mint);
  if (!t || t.balanceRaw === null) return null;
  const free = t.balanceRaw - t.reservedRaw;
  return free > 0n ? free : 0n;
}

/** Set aside `raw` for a buy being built (released by release()). */
function reserve(mint, raw) {
  const t = get(mint);
  if (t) t.reservedRaw += BigInt(raw);
}

function release(mint, raw, { spent = false } = {}) {
  const t = get(mint);
  if (!t) return;
  t.reservedRaw -= BigInt(raw);
  if (t.reservedRaw < 0n) t.reservedRaw = 0n;
  if (spent && t.balanceRaw !== null) {
    t.balanceRaw -= BigInt(raw);
    if (t.balanceRaw < 0n) t.balanceRaw = 0n;
  }
}

function valueSol(t, raw) {
  return t.lamportsPerRaw > 0 ? (Number(raw) * t.lamportsPerRaw) / 1e9 : null;
}

async function readMint(t) {
  const acc = await rpcPool.withFailover((c) => c.getAccountInfo(new PublicKey(t.mint)), undefined, { priority: 'low' });
  if (!acc) throw new Error('mint account not found');
  if (acc.owner.equals(TOKEN_PROGRAM_ID)) t.program = TOKEN_PROGRAM_ID;
  else if (acc.owner.equals(TOKEN_2022_PROGRAM_ID)) t.program = TOKEN_2022_PROGRAM_ID;
  else throw new Error(`owned by an unexpected program (${acc.owner.toBase58()})`);
  t.decimals = Buffer.from(acc.data).readUInt8(44);
}

async function refreshBalance(mintOrT) {
  const t = typeof mintOrT === 'object' && mintOrT && mintOrT.mint ? mintOrT : get(mintOrT);
  if (!t || !t.program) return;
  const owner = new PublicKey(config.PUBLIC_KEY);
  const ata = getAssociatedTokenAddressSync(new PublicKey(t.mint), owner, true, t.program);
  try {
    const acc = await rpcPool.withFailover((c) => c.getAccountInfo(ata, 'confirmed'), undefined, { priority: 'low' });
    t.balanceRaw = acc && acc.data && acc.data.length >= 72 ? Buffer.from(acc.data).readBigUInt64LE(64) : 0n;
    t.balanceAt = Date.now();
  } catch (err) {
    warn(`[QuoteTokens] Couldn't read your ${t.label} balance (${err.message}).`);
  }
}

async function refreshPrice(t) {
  if (!deps || !deps.priceProbe) return;
  try {
    const outRaw = await deps.priceProbe(t.mint, PRICE_PROBE_SOL);
    if (outRaw > 0n) {
      t.lamportsPerRaw = (PRICE_PROBE_SOL * 1e9) / Number(outRaw);
      t.priceAt = Date.now();
    }
  } catch (err) {
    warn(`[QuoteTokens] Couldn't price ${t.label} through Jupiter (${err.message}); ${t.priceAt ? 'keeping the last price for now' : 'its coins are not bought until it can be priced'}.`);
  }
}

/** Buy more of the token when the reserve is below half its target. */
async function maybeTopUp(t, why = '') {
  if (!deps || !deps.buyWithSol || t.topUp || !(t.lamportsPerRaw > 0) || t.balanceRaw === null) return;
  const target = config.QUOTE_TOKEN_RESERVE_SOL;
  const have = valueSol(t, t.balanceRaw) || 0;
  if (have >= target / 2) return;
  const spend = Math.max(0, target - have);
  if (spend < 0.001) return;
  t.topUp = (async () => {
    info(`[QuoteTokens] ${t.label} reserve is worth ~${have.toFixed(3)} SOL (target ${target}); buying ~${spend.toFixed(3)} SOL of it via Jupiter${why ? ` (${why})` : ''}.`);
    try {
      const sig = await deps.buyWithSol(t.mint, spend);
      info(`[QuoteTokens] Bought ${t.label} for the reserve: https://solscan.io/tx/${sig}`);
    } catch (err) {
      warn(`[QuoteTokens] Couldn't top up the ${t.label} reserve (${err.message}).`);
    } finally {
      await refreshBalance(t);
      t.topUp = null;
    }
  })();
  await t.topUp;
}

function describe(t) {
  const v = t.balanceRaw !== null ? valueSol(t, t.balanceRaw) : null;
  const held = t.balanceRaw !== null && t.decimals !== null ? (Number(t.balanceRaw) / 10 ** t.decimals).toLocaleString('en-US', { maximumFractionDigits: 2 }) : '?';
  return `${t.label}: ${held} held${v !== null ? ` (~${v.toFixed(3)} SOL)` : ''}`;
}

/**
 * Start: read each listed token, its price and your balance, top up the
 * reserves, and keep price and balance fresh.
 * @param d.priceProbe(mint, sol) -> raw units `sol` SOL buys (Jupiter)
 * @param d.buyWithSol(mint, sol) -> signature of a confirmed buy
 */
async function start(d) {
  if (!enabled()) return;
  deps = d;
  for (const mint of config.QUOTE_TOKENS) {
    if (!tokens.has(mint)) {
      tokens.set(mint, { mint, label: label(mint), program: null, decimals: null, lamportsPerRaw: null, priceAt: 0, balanceRaw: null, balanceAt: 0, reservedRaw: 0n, topUp: null });
    }
  }
  await Promise.all(
    [...tokens.values()].map(async (t) => {
      try {
        await readMint(t);
      } catch (err) {
        warn(`[QuoteTokens] ${t.mint} can't be used (${err.message}); coins paired to it are skipped.`);
        return;
      }
      await Promise.all([refreshPrice(t), refreshBalance(t)]);
      info(`[QuoteTokens] ${describe(t)}; reserve target ${config.QUOTE_TOKEN_RESERVE_SOL} SOL.`);
      await maybeTopUp(t, 'startup');
    })
  );
  timers.push(setInterval(() => tokens.forEach((t) => t.program && refreshPrice(t)), PRICE_REFRESH_MS));
  timers.push(setInterval(() => tokens.forEach((t) => t.program && refreshBalance(t).then(() => maybeTopUp(t))), BALANCE_REFRESH_MS));
  for (const tm of timers) if (tm.unref) tm.unref();
}

/** After a trade in a quote-paired coin: re-read the balance, top up if low. */
function afterTrade(mint) {
  const t = get(mint);
  if (!t) return;
  refreshBalance(t)
    .then(() => maybeTopUp(t, 'after a trade'))
    .catch(() => {});
}

function stop() {
  for (const tm of timers) clearInterval(tm);
  timers = [];
}

/** For tests. */
function _setForTests(mint, state) {
  if (state === null) {
    tokens.delete(mint);
    return;
  }
  tokens.set(mint, { mint, label: label(mint), program: TOKEN_PROGRAM_ID, decimals: 6, lamportsPerRaw: null, priceAt: Date.now(), balanceRaw: 0n, balanceAt: Date.now(), reservedRaw: 0n, topUp: null, ...state });
}

module.exports = {
  enabled,
  get,
  lamportsPerRaw,
  available,
  reserve,
  release,
  afterTrade,
  start,
  stop,
  noteQuoteMint,
  mentionsQuoteMint,
  label,
  PUMP_TOKEN_MINT,
  _setForTests
};
