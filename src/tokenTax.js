// src/tokenTax.js
//
// "Tax" on Solana coins: the only way a token can charge a fee on every
// buy/sell is a Token-2022 *transfer fee* set by its creator (there are no
// custom tax contracts as on BNB/Ethereum). This reads a coin's transfer fee
// so the bot can skip coins taxed above MAX_TOKEN_TAX_PCT and show the tax in
// the buy message.
//
// One RPC call per coin (cached), with a short timeout.

const { PublicKey } = require('@solana/web3.js');
const rpcPool = require('./rpcPool');

const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const LOOKUP_TIMEOUT_MS = 1500;
const cache = new Map(); // mint -> pct (number)

/**
 * The coin's transfer fee as a percentage (0 if it has none). Uses the
 * higher of the current and scheduled fee, so a fee about to rise counts.
 * Throws if the lookup fails (caller decides what to do).
 */
async function getTransferFeePct(mint, { priority = 'high' } = {}) {
  if (cache.has(mint)) return cache.get(mint);
  const resp = await rpcPool.withFailover((c) => c.getParsedAccountInfo(new PublicKey(mint)), LOOKUP_TIMEOUT_MS, { priority });
  const acc = resp && resp.value;
  if (!acc) throw new Error('coin account not found');
  let pct = 0;
  const owner = acc.owner && (acc.owner.toBase58 ? acc.owner.toBase58() : String(acc.owner));
  if (owner === TOKEN_2022) {
    const info = acc.data && acc.data.parsed && acc.data.parsed.info;
    const ext = ((info && info.extensions) || []).find((e) => e.extension === 'transferFeeConfig');
    if (ext && ext.state) {
      const bps = [ext.state.olderTransferFee, ext.state.newerTransferFee]
        .map((f) => Number(f && f.transferFeeBasisPoints) || 0);
      pct = Math.max(...bps) / 100;
    }
  }
  cache.set(mint, pct);
  return pct;
}

/** Cached value if already looked up, else undefined (no network call). */
function cachedTransferFeePct(mint) {
  return cache.get(mint);
}

module.exports = { getTransferFeePct, cachedTransferFeePct };
