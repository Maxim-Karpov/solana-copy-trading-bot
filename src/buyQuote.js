// src/buyQuote.js
//
// The direct buy builders already work out how many tokens a buy should get
// (they need it for the slippage limit). They attach that quote to the
// transaction they return, so MAX_ENTRY_PREMIUM_PCT can compare our price
// with the copy wallet's before anything is sent, at no extra cost. The same
// goes for the coin's market cap and creator (the instant buy filters).

const { info } = require('./logger');

/**
 * Attach the expected fill to a built buy transaction.
 * @param solIn     - SOL going into the swap (pool fees excluded where the builder knows them)
 * @param tokensOut - tokens expected out, in UI units
 */
function attachQuote(tx, { solIn, tokensOut }) {
  if (!tx || !(solIn > 0) || !(tokensOut > 0)) return tx;
  try {
    Object.defineProperty(tx, 'quote', {
      value: { solIn, tokensOut, priceSol: solIn / tokensOut },
      enumerable: false
    });
  } catch {}
  return tx;
}

/**
 * Attach what the builder learned about the coin while building (no extra
 * lookups): its market cap in SOL just before our buy, and its creator.
 * Used by the instant buy filters (MIN/MAX_MARKET_CAP_SOL, BLOCKED_CREATORS).
 */
function attachCoin(tx, { mcapSol = null, creator = null, capOnChain = false, creatorBlocked = false } = {}) {
  if (!tx) return tx;
  const coin = {
    mcapSol: Number.isFinite(mcapSol) && mcapSol > 0 ? mcapSol : null,
    creator: creator || null,
    // SHRED_FAST_BUY: MAX_MARKET_CAP_SOL is built into the buy (checked
    // on-chain when it runs), the creator only known by its vault.
    capOnChain: !!capOnChain,
    creatorBlocked: !!creatorBlocked
  };
  try {
    Object.defineProperty(tx, 'coin', { value: coin, enumerable: false });
  } catch {}
  return tx;
}

/** Thrown instead of sending a buy that an instant filter rules out. */
class CoinFilteredError extends Error {
  constructor(message, { setting, short }) {
    super(message);
    this.coinFiltered = true;
    this.setting = setting;
    this.short = short; // for Telegram
  }
}

/** Thrown instead of sending a buy whose price is too far above the copy wallet's. */
class EntryPriceTooHighError extends Error {
  constructor(message, { premiumPct, maxPct }) {
    super(message);
    this.entryPriceTooHigh = true;
    this.premiumPct = premiumPct;
    this.maxPct = maxPct;
  }
}

const fmtSol = (v) => (v >= 100 ? v.toFixed(0) : v.toFixed(1));

/** Does this coin filter need the market cap? */
function needsMcap(coinFilter) {
  return !!coinFilter && (coinFilter.minMcapSol != null || coinFilter.maxMcapSol != null);
}

/**
 * Instant buy filters (MIN/MAX_MARKET_CAP_SOL, BLOCKED_CREATORS), from what
 * the direct builder learned about the coin while building, so they add no
 * time. Throws CoinFilteredError. `tx` null = no direct build.
 */
function checkCoinFilters(tx, label, coinFilter, mint = '') {
  if (!coinFilter) return;
  const coin = (tx && tx.coin) || null;
  const blocked = coinFilter.blockedCreators;
  if (coin && coin.creatorBlocked) {
    throw new CoinFilteredError('its creator is in BLOCKED_CREATORS', { setting: 'BLOCKED_CREATORS', short: 'its creator is on your blocklist' });
  }
  if (blocked && blocked.size && coin && coin.creator && blocked.has(coin.creator)) {
    throw new CoinFilteredError(`its creator ${coin.creator} is in BLOCKED_CREATORS`, { setting: 'BLOCKED_CREATORS', short: 'its creator is on your blocklist' });
  }
  if (!needsMcap(coinFilter)) return;
  if (coin && coin.capOnChain) {
    info(`[tradeExecutor] Market cap limit (${coinFilter.maxMcapSol} SOL) is built into the buy and checked on-chain when it runs${mint ? ` for ${mint}` : ''}.`);
    return;
  }
  const mcap = coin ? coin.mcapSol : null;
  if (!(mcap > 0)) {
    throw new CoinFilteredError(
      `its market cap can't be read instantly (${tx ? `${label} build gives none` : 'no direct build for this coin'}), and a market-cap filter is on`,
      { setting: 'MIN/MAX_MARKET_CAP_SOL', short: "its market cap couldn't be read instantly" }
    );
  }
  const { minMcapSol: min, maxMcapSol: max } = coinFilter;
  if (max != null && mcap > max) {
    throw new CoinFilteredError(`market cap ${fmtSol(mcap)} SOL is above MAX_MARKET_CAP_SOL (${max})`, {
      setting: 'MAX_MARKET_CAP_SOL',
      short: `market cap ${fmtSol(mcap)} SOL is above your max (${max} SOL)`
    });
  }
  if (min != null && mcap < min) {
    throw new CoinFilteredError(`market cap ${fmtSol(mcap)} SOL is below MIN_MARKET_CAP_SOL (${min})`, {
      setting: 'MIN_MARKET_CAP_SOL',
      short: `market cap ${fmtSol(mcap)} SOL is below your min (${min} SOL)`
    });
  }
  info(`[tradeExecutor] Market cap ${fmtSol(mcap)} SOL is within your limits${mint ? ` for ${mint}` : ''}.`);
}

module.exports = { attachQuote, attachCoin, checkCoinFilters, needsMcap, EntryPriceTooHighError, CoinFilteredError };
