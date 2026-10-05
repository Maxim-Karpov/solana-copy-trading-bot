// src/amounts.js
//
// Exact conversions between UI token amounts ("1234.567891") and raw integer
// amounts (1234567891n for a 6-decimal token), done with string/BigInt math.
//
// Plain JS numbers can't do this safely: large balances lose precision past
// 2^53, fractional amounts round the wrong way (asking to sell 1 raw unit
// more than you hold makes the whole transaction fail), and small values
// stringify as scientific notation ("1e-7"), which trade APIs reject.

/**
 * UI amount (string or number) -> raw BigInt. Extra decimal places beyond
 * `decimals` are truncated (rounded DOWN), so the result never exceeds the
 * amount described.
 */
function uiToRaw(ui, decimals) {
  if (typeof ui === 'bigint') throw new Error('uiToRaw expects a UI amount, not a raw BigInt');
  if (!Number.isInteger(decimals) || decimals < 0) {
    throw new Error(`Invalid token decimals: ${decimals}`);
  }

  let s = String(ui).trim();

  // Tolerate exponent-form strings left behind by older versions of this bot
  // (e.g. "1.2e-7"), by expanding them through Number once.
  if (/e/i.test(s)) {
    const n = Number(s);
    if (!Number.isFinite(n) || n < 0) throw new Error(`Invalid token amount "${ui}"`);
    s = n.toFixed(Math.min(decimals, 100));
    if (/e/i.test(s)) throw new Error(`Token amount "${ui}" is too large to represent exactly`);
  }

  if (!/^\d+(\.\d+)?$/.test(s)) {
    throw new Error(`Invalid token amount "${ui}"`);
  }

  const [intPart, fracPart = ''] = s.split('.');
  const frac = (fracPart + '0'.repeat(decimals)).slice(0, decimals);
  return BigInt(intPart + frac);
}

/** Raw BigInt -> exact UI decimal string, e.g. (10757565596n, 9) -> "10.757565596". */
function rawToUi(raw, decimals) {
  const neg = raw < 0n;
  const s = (neg ? -raw : raw).toString();
  if (decimals === 0) return (neg ? '-' : '') + s;
  const padded = s.padStart(decimals + 1, '0');
  const intPart = padded.slice(0, padded.length - decimals);
  const fracPart = padded.slice(padded.length - decimals);
  return (neg ? '-' : '') + intPart + '.' + fracPart;
}

/** raw * pct%, rounded down, with pct given to 2 decimal places of precision. */
function rawPercent(raw, pct) {
  const bps = BigInt(Math.round(Math.min(100, Math.max(0, pct)) * 100)); // hundredths of a percent
  return (raw * bps) / 10000n;
}

module.exports = { uiToRaw, rawToUi, rawPercent };
