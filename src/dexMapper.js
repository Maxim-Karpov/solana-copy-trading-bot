// src/dexMapper.js
const config = require('./config');

/**
 * Which venue the copied trade ACTUALLY executed on, from txParser.js's DEX
 * labels (e.g. ['Pump.fun']). Ignores PREFERRED_DEX on purpose — this is
 * what the direct-swap paths (DIRECT_PUMPFUN_SWAP / DIRECT_RAYDIUM_SWAP) key
 * off, so they still work when PREFERRED_DEX is "auto".
 * Returns 'pumpfun', 'jupiter', 'meteora', 'raydium', or a sanitized label.
 */
function detectVenue(dexsArray) {
  if (!Array.isArray(dexsArray) || dexsArray.length === 0) {
    return null;
  }

  const lowered = dexsArray.map((d) => String(d).toLowerCase());

  // Pump.fun (bonding curve) and Pump.fun Amm (PumpSwap) => 'pumpfun'
  if (lowered.some((d) => d.startsWith('pump.fun'))) {
    return 'pumpfun';
  }
  // Raydium LaunchLab (launchpad bonding curve): the direct Raydium builder
  // handles it (SolanaPortal is still sent 'jupiter' for it, see mapDex).
  if (lowered.some((d) => d.includes('raydium launchpad'))) {
    return 'raydium';
  }
  // Jupiter-style: Fluxbeam, Orca Whirlpool
  if (lowered.some((d) => d.includes('fluxbeam') || d.includes('orca whirlpool'))) {
    return 'jupiter';
  }
  // Meteora pools
  if (lowered.some((d) => d.includes('meteora'))) {
    return 'meteora';
  }
  // Raydium AMM v4 / CPMM / CLMM
  if (lowered.some((d) => d.includes('raydium ammv4') || d.includes('raydium cpmm') || d.includes('raydium clmm'))) {
    return 'raydium';
  }

  // Fallback: take first, strip non-alphanumeric, lowercase
  return String(dexsArray[0]).replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
}

/**
 * The `dex` value sent to SolanaPortal. Respects the user's PREFERRED_DEX
 * setting if specified, otherwise the detected venue.
 */
function mapDex(dexsArray) {
  if (!Array.isArray(dexsArray) || dexsArray.length === 0) {
    return null;
  }
  if (config.PREFERRED_DEX !== 'none') {
    return config.PREFERRED_DEX;
  }
  // Unchanged for SolanaPortal: it has always been sent 'jupiter' for
  // Raydium LaunchLab trades.
  if (dexsArray.some((d) => String(d).toLowerCase().includes('raydium launchpad'))) return 'jupiter';
  return detectVenue(dexsArray);
}

/**
 * The exact pool type the copy wallet traded on, from its transaction's
 * program labels: 'pumpswap', 'pump-curve', 'launchlab', 'clmm', 'cpmm',
 * 'amm', or null. Lets the bot pick the matching direct builder at once.
 */
function detectPool(dexsArray) {
  if (!Array.isArray(dexsArray) || dexsArray.length === 0) return null;
  const lowered = dexsArray.map((d) => String(d).toLowerCase());
  const has = (s) => lowered.some((d) => d.includes(s));
  if (has('pump.fun amm')) return 'pumpswap';
  if (lowered.some((d) => d === 'pump.fun')) return 'pump-curve';
  if (has('raydium launchpad')) return 'launchlab';
  if (has('raydium clmm')) return 'clmm';
  if (has('raydium cpmm')) return 'cpmm';
  if (has('raydium ammv4')) return 'amm';
  return null;
}

module.exports = { mapDex, detectVenue, detectPool };
