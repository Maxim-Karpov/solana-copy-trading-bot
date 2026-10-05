// src/priceChecker.js
//
// Token prices from DexScreener's free public API (no key, no signup). Pairs
// are tagged by DEX, so this covers Pump.fun (bonding-curve pairs *and*
// post-graduation PumpSwap pairs) and Raydium alike — a token is covered
// through its whole lifecycle, not just after it migrates.
//
// Uses the batch endpoint GET /tokens/v1/solana/{addr1,addr2,...}, which
// takes up to 30 token addresses per request and returns a JSON array of
// pairs (each requested token as `baseToken`). The polling loop prices every
// open position with ONE request per 30 positions per tick, instead of one
// request per position — so holding more positions doesn't multiply calls
// toward DexScreener's rate limit.
const { error } = require('./logger');
const { fetchJson } = require('./timeouts');

const DEXSCREENER_TOKENS_URL = 'https://api.dexscreener.com/tokens/v1/solana/';
const MAX_ADDRESSES_PER_REQUEST = 30;
// Abort a price request if DexScreener doesn't answer (headers AND body)
// within this window, so one slow request can't stall a polling tick.
const PRICE_FETCH_TIMEOUT_MS = 8000;

const WSOL_MINT = 'So11111111111111111111111111111111111111112';

function liquidityUsd(pair) {
  return pair && pair.liquidity && typeof pair.liquidity.usd === 'number' ? pair.liquidity.usd : 0;
}

function toPrice(pair) {
  const priceInUsd = parseFloat(pair.priceUsd);
  if (!Number.isFinite(priceInUsd) || priceInUsd <= 0) return null;
  // priceNative is only "price in SOL" when the pair is quoted against SOL.
  const priceInSol = pair.quoteToken && pair.quoteToken.address === WSOL_MINT ? parseFloat(pair.priceNative) : null;
  const mc = Number(pair.marketCap ?? pair.fdv);
  return {
    priceInSol: Number.isFinite(priceInSol) ? priceInSol : null,
    priceInUsd,
    marketCapUsd: Number.isFinite(mc) && mc > 0 ? mc : null
  };
}

async function fetchChunk(mints) {
  const url = DEXSCREENER_TOKENS_URL + mints.join(',');
  const res = await fetchJson(url, { method: 'GET', headers: { Accept: 'application/json' } }, PRICE_FETCH_TIMEOUT_MS);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}${res.status === 429 ? ' (rate limited)' : ''}: ${res.text.slice(0, 120)}`);
  }
  const data = res.data;
  // Documented shape is a bare array; tolerate the older { pairs: [...] } shape too.
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.pairs)) return data.pairs;
  return [];
}

/**
 * Prices for many mints at once. Returns a Map of mint -> { priceInUsd,
 * priceInSol }; a mint with no indexed pair yet (e.g. brand new) or whose
 * request failed is simply absent from the map.
 */
async function getPrices(mints) {
  const unique = [...new Set(mints)];
  const out = new Map();
  const chunks = [];
  for (let i = 0; i < unique.length; i += MAX_ADDRESSES_PER_REQUEST) {
    chunks.push(unique.slice(i, i + MAX_ADDRESSES_PER_REQUEST));
  }

  await Promise.all(
    chunks.map(async (chunk) => {
      let pairs;
      try {
        pairs = await fetchChunk(chunk);
      } catch (err) {
        error(`[priceChecker] Price request for ${chunk.length} token(s) failed: ${err.message}`);
        return;
      }
      const wanted = new Set(chunk);
      const best = new Map(); // mint -> most liquid pair where it is the BASE token
      for (const p of pairs) {
        if (!p || (p.chainId && p.chainId !== 'solana')) continue;
        // A pair's priceUsd is the price of its base token — a pair that
        // only has our mint as the quote token would give the wrong price.
        const mint = p.baseToken && p.baseToken.address;
        if (!wanted.has(mint)) continue;
        const cur = best.get(mint);
        if (!cur || liquidityUsd(p) > liquidityUsd(cur)) best.set(mint, p);
      }
      for (const [mint, pair] of best) {
        const price = toPrice(pair);
        if (price) out.set(mint, price);
      }
    })
  );
  return out;
}

/** Price for a single mint, or null if unavailable. */
async function getPriceOnChain(mint) {
  const prices = await getPrices([mint]);
  return prices.get(mint) || null;
}

// SOL's own USD price, cached for a minute (only used for display).
const SOL_USD_CACHE_MS = 60_000;
let solUsdCache = { value: null, at: 0 };

/** SOL price in USD, or null if unavailable. */
async function getSolUsd() {
  if (solUsdCache.value && Date.now() - solUsdCache.at < SOL_USD_CACHE_MS) return solUsdCache.value;
  const p = await getPriceOnChain(WSOL_MINT);
  if (p && p.priceInUsd > 0) solUsdCache = { value: p.priceInUsd, at: Date.now() };
  return solUsdCache.value; // a stale value beats none
}

/** Sleep for ms milliseconds. */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { getPrices, getPriceOnChain, getSolUsd, sleep, MAX_ADDRESSES_PER_REQUEST };
