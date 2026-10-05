// src/tieredBuy.js
//
// Support for TRADE_TYPE="TIERED": instead of a single fixed BUY_AMOUNT (SAFE)
// or exactly mirroring the copied wallet's SOL size (EXACT), spend a
// configurable SOL amount depending on which "bucket" the copied wallet's
// buy size falls into.
//
// Config is supplied via the TIER_BUY_CONFIG env var as a JSON array, e.g.:
//   [{"maxSol":0.5,"buyAmount":0.05},{"maxSol":2,"buyAmount":0.15},{"maxSol":null,"buyAmount":0.3}]
//
// Each tier's `maxSol` is an EXCLUSIVE upper bound on the copied wallet's SOL
// buy size (in SOL) for that tier; the tier whose `buyAmount` we use is spent
// on our own buy. Exactly one tier must have `maxSol: null`, meaning "this
// tier catches anything not covered by a lower tier" — it must be the
// highest tier. Tiers do not need to be given in sorted order in the env
// var; they are sorted here.

/**
 * Parse and validate the TIER_BUY_CONFIG JSON string into a sorted array of tiers.
 * Throws a descriptive Error if the config is malformed.
 */
function parseTierConfig(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`TIER_BUY_CONFIG is not valid JSON: ${err.message}`);
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error('TIER_BUY_CONFIG must be a non-empty JSON array.');
  }

  parsed.forEach((tier, i) => {
    if (typeof tier !== 'object' || tier === null) {
      throw new Error(`TIER_BUY_CONFIG[${i}] must be an object like {"maxSol":0.5,"buyAmount":0.05}.`);
    }
    if (typeof tier.buyAmount !== 'number' || !(tier.buyAmount > 0)) {
      throw new Error(`TIER_BUY_CONFIG[${i}].buyAmount must be a positive number.`);
    }
    if (tier.maxSol !== null && !(typeof tier.maxSol === 'number' && tier.maxSol > 0)) {
      throw new Error(`TIER_BUY_CONFIG[${i}].maxSol must be a positive number, or null for the catch-all top tier.`);
    }
  });

  // Sort ascending by maxSol, with the null (uncapped) tier forced to the end.
  const sorted = [...parsed].sort((a, b) => {
    if (a.maxSol === null) return 1;
    if (b.maxSol === null) return -1;
    return a.maxSol - b.maxSol;
  });

  const nullTiers = sorted.filter((t) => t.maxSol === null);
  if (nullTiers.length !== 1) {
    throw new Error('TIER_BUY_CONFIG must contain exactly one tier with "maxSol": null (the catch-all top tier).');
  }
  if (sorted[sorted.length - 1].maxSol !== null) {
    // Defensive; the sort above should already guarantee this.
    throw new Error('The tier with "maxSol": null must be the highest tier.');
  }

  return sorted;
}

/**
 * Given the copied wallet's SOL buy size, return the SOL amount *we* should
 * spend, based on the first (lowest) tier whose maxSol exceeds it — or the
 * null catch-all tier if none does.
 */
function computeTieredBuyAmount(copyAmountSol, tiers) {
  for (const tier of tiers) {
    if (tier.maxSol === null || copyAmountSol < tier.maxSol) {
      return tier.buyAmount;
    }
  }
  // Unreachable: the last tier always has maxSol === null.
  return tiers[tiers.length - 1].buyAmount;
}

module.exports = { parseTierConfig, computeTieredBuyAmount };
