// src/coinInfo.js
//
// A quick snapshot of a coin, taken right after one of our buys confirms,
// for the Telegram buy message and the logs:
//
//   - market cap (USD, plus SOL on the bonding curve)
//   - bonding-curve progress (standard Pump.fun coins only)
//   - how much of the supply the coin's creator still holds
//   - how much the top 10 holders own
//
// This runs AFTER the buy, in the background, and never touches the trading
// path: nothing here is awaited before a buy or sell is sent. Every piece is
// optional. If a lookup fails or is slow, that line is left out of the
// message rather than holding anything up.
//
// Market cap and curve progress come for free from Pump.fun's TradeEvent in
// our own buy transaction (already fetched to measure the fill). The holder
// figures cost 3-4 RPC calls: token supply, largest holders, their owners,
// and (if the creator isn't among the largest) the creator's balance.

const { PublicKey } = require('@solana/web3.js');
const rpcPool = require('./rpcPool');
const { getSolUsd } = require('./priceChecker');
const { withTimeout } = require('./timeouts');
const tokenTax = require('./tokenTax');
const coinLinks = require('./coinLinks');
const { warn } = require('./logger');

// Standard Pump.fun coins: 1,000,000,000 tokens (6 decimals), of which
// 793,100,000 are sold along the bonding curve before it completes.
const PUMP_STANDARD_SUPPLY_RAW = 1_000_000_000n * 1_000_000n;
const PUMP_CURVE_TOKENS_RAW = 793_100_000n * 1_000_000n;
const SNAPSHOT_TIMEOUT_MS = 2500;
const LOW = { priority: 'low' }; // background lookups: trading calls go first

/** Share as a percentage (number) of part/whole, both BigInt. */
function pct(part, whole) {
  if (!(whole > 0n)) return null;
  return Number((part * 1_000_000n) / whole) / 10_000;
}

/** Wallet (not program) owner? PDAs — bonding curves, AMM pools, lockers — are off the ed25519 curve. */
function isWalletOwner(owner) {
  try {
    return PublicKey.isOnCurve(new PublicKey(owner).toBytes());
  } catch {
    return false;
  }
}

/** Market cap and curve progress from our buy's TradeEvent (no network calls). */
function fromTradeEvent(ev, supplyRaw) {
  if (!ev || ev.solQuoted === false || !(ev.virtualTokenReserves > 0n) || !(ev.virtualSolReserves > 0n)) return {};
  const supply = supplyRaw && supplyRaw > 0n ? supplyRaw : PUMP_STANDARD_SUPPLY_RAW;
  // Same formula as the Pump.fun SDK's bondingCurveMarketCap: price x supply.
  const mcapLamports = (ev.virtualSolReserves * supply) / ev.virtualTokenReserves;
  const out = { mcapSol: Number(mcapLamports) / 1e9 };
  if (supply === PUMP_STANDARD_SUPPLY_RAW && ev.realTokenReserves <= PUMP_CURVE_TOKENS_RAW) {
    out.curvePct = 100 - (pct(ev.realTokenReserves, PUMP_CURVE_TOKENS_RAW) ?? 100);
  }
  return out;
}

/** Holder figures: { top10Pct, creatorPct, supplyRaw } (each may be null). */
async function holderStats(mint, creator) {
  const mintPk = new PublicKey(mint);
  const creatorBalance = creator
    ? rpcPool
        .withFailover((c) => c.getParsedTokenAccountsByOwner(new PublicKey(creator), { mint: mintPk }), undefined, LOW)
        .then((r) => r.value.reduce((sum, a) => sum + BigInt(a.account.data.parsed.info.tokenAmount.amount), 0n))
        .catch(() => null)
    : Promise.resolve(null);

  const [supplyResp, largestResp] = await Promise.all([
    rpcPool.withFailover((c) => c.getTokenSupply(mintPk), undefined, LOW),
    rpcPool.withFailover((c) => c.getTokenLargestAccounts(mintPk), undefined, LOW)
  ]);
  const supplyRaw = BigInt(supplyResp.value.amount);
  const largest = largestResp.value || [];

  // Owners of the largest token accounts, so program-owned ones (the bonding
  // curve's own stock, AMM pool vaults) aren't counted as "holders".
  const infos = largest.length
    ? (await rpcPool.withFailover((c) => c.getMultipleParsedAccounts(largest.map((a) => new PublicKey(a.address))), undefined, LOW)).value
    : [];
  const holders = [];
  largest.forEach((acc, i) => {
    const info = infos[i];
    const owner = info && info.data && info.data.parsed && info.data.parsed.info && info.data.parsed.info.owner;
    if (owner && isWalletOwner(owner)) holders.push({ owner, amount: BigInt(acc.amount) });
  });

  const top10 = holders.slice(0, 10).reduce((sum, h) => sum + h.amount, 0n);
  const creatorRaw = await creatorBalance;

  return {
    supplyRaw,
    top10Pct: pct(top10, supplyRaw),
    creatorPct: creatorRaw === null ? null : pct(creatorRaw, supplyRaw)
  };
}

/**
 * Snapshot for a coin we just bought. Never throws; missing pieces are null.
 * @param mint       - token mint
 * @param pumpEvent  - decodePumpTradeDetails() of our own buy, or null
 * @param priceData  - DexScreener price for the coin, or null
 * @returns { mcapUsd, mcapSol, curvePct, creatorPct, top10Pct }
 */
async function snapshot({ mint, pumpEvent = null, priceData = null }) {
  const out = { mcapUsd: null, mcapSol: null, curvePct: null, creatorPct: null, top10Pct: null, taxPct: null, links: null };
  const work = (async () => {
    const holdersP = holderStats(mint, pumpEvent && pumpEvent.creator).catch((err) => {
      warn(`[coinInfo] Holder lookup for ${mint} failed: ${err.message}`);
      return null;
    });
    const solUsdP = pumpEvent ? getSolUsd().catch(() => null) : Promise.resolve(null);
    // Transfer tax: usually already looked up before the buy (cached).
    // Shown as soon as the metadata is read; the website check is added when it's done.
    const linksP = coinLinks.readLinks(mint).then((l) => {
      out.links = l;
      if (l && l.website) {
        return coinLinks.siteMentions(l.website, mint).then((r) => { l.siteMentions = r; }, () => {}).then(() => l);
      }
      return l;
    }).catch(() => null);
    const taxP = tokenTax.getTransferFeePct(mint, { priority: 'low' }).catch(() => null);

    // Market cap / curve from our own trade: ready at once (assuming the
    // standard Pump.fun supply until the real supply comes back below), so
    // they're in the message even if the holder lookups are slow.
    const applyCurve = (supplyRaw, solUsd) => {
      const curve = fromTradeEvent(pumpEvent, supplyRaw);
      out.mcapSol = curve.mcapSol ?? null;
      out.curvePct = curve.curvePct ?? null;
      out.mcapUsd = out.mcapSol !== null && solUsd ? out.mcapSol * solUsd : null;
      // Not on the bonding curve (PumpSwap, Raydium, ...): DexScreener's figure.
      if (out.mcapUsd === null && priceData && priceData.marketCapUsd) out.mcapUsd = priceData.marketCapUsd;
    };
    applyCurve(null, null);
    const solUsd = await solUsdP;
    applyCurve(null, solUsd);

    const holders = await holdersP;
    if (holders) {
      Object.assign(out, { creatorPct: holders.creatorPct, top10Pct: holders.top10Pct });
      applyCurve(holders.supplyRaw, solUsd);
    }
    out.taxPct = await taxP;
    await linksP;
  })();
  work.catch(() => {}); // if it finishes after the timeout, nobody's listening
  try {
    await withTimeout(work, SNAPSHOT_TIMEOUT_MS, 'Coin snapshot');
  } catch (err) {
    warn(`[coinInfo] ${err.message} for ${mint}; sending what's ready.`);
  }
  return { ...out, links: out.links ? { ...out.links } : null }; // a copy: late results mustn't change what was already reported
}

function fmtUsd(v) {
  if (v >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(1)}k`;
  return `$${v.toFixed(0)}`;
}

function fmtPct(v) {
  return `${v < 10 ? v.toFixed(1) : v.toFixed(0)}%`;
}

/** Human-readable lines for a snapshot (empty array if nothing is known). */
function describe(snap) {
  if (!snap) return [];
  const lines = [];
  const first = [];
  if (snap.mcapUsd !== null) {
    first.push(`MC: ${fmtUsd(snap.mcapUsd)}${snap.mcapSol !== null ? ` (${snap.mcapSol.toFixed(1)} SOL)` : ''}`);
  } else if (snap.mcapSol !== null) {
    first.push(`MC: ${snap.mcapSol.toFixed(1)} SOL`);
  }
  if (snap.curvePct !== null) first.push(`Curve: ${fmtPct(snap.curvePct)}`);
  if (first.length) lines.push(first.join(' · '));
  const second = [];
  if (snap.creatorPct !== null) second.push(`Creator holds ${fmtPct(snap.creatorPct)}`);
  if (snap.top10Pct !== null) second.push(`Top 10: ${fmtPct(snap.top10Pct)}`);
  if (second.length) lines.push(second.join(' · '));
  if (snap.links) {
    const l = snap.links;
    const found = [l.website && `Web: ${l.website}`, l.twitter && `X: ${l.twitter}`, l.telegram && `TG: ${l.telegram}`].filter(Boolean);
    const site = l.siteMentions === 'link' ? "the website link is this coin's own address page" : l.siteMentions === 'page' ? "the website shows this coin's address ✅" : l.siteMentions === false ? "the website does NOT show this coin's address (scripted sites may still)" : null;
    lines.push(found.length ? `Links (set by the creator, unverified):\n${found.join('\n')}${site ? `\n${site}` : ''}` : 'Links: none filed (no website, X or Telegram)');
  }
  if (snap.taxPct > 0) lines.push(`⚠️ Tax: ${fmtPct(snap.taxPct)} on every buy/sell (transfer fee)`);
  return lines;
}

module.exports = { snapshot, describe, fromTradeEvent, PUMP_STANDARD_SUPPLY_RAW, PUMP_CURVE_TOKENS_RAW };
