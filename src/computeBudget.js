// src/computeBudget.js
//
// Compute-unit limits sized to what each kind of trade really uses.
//
// The priority fee is a fixed total spread over the compute-unit LIMIT, and
// transactions are ordered by fee per unit, so a limit close to real use
// buys an earlier place at no extra cost: 0.0015 SOL over 95,000 units is
// ~16 lamports a unit, over 300,000 only ~5.
//
// After each trade the bot reads how many units it actually used (from the
// confirmed transaction). They are remembered per KIND of trade: buy or
// sell, which programs it calls, which token standard the coin uses, and how
// many accounts the Pump.fun / PumpSwap instruction takes (cashback and
// other coin variants need extra ones, and more work). Once a kind has been
// seen MIN_SAMPLES times, its limit is the most any of its recent trades
// used plus a margin, never above PUMPFUN_COMPUTE_UNITS (the ceiling, and
// the limit used until a kind has been seen enough). A trade that runs out
// anyway raises its kind's limit straight away. Kept in
// data/compute-units.json between runs. AUTO_COMPUTE_UNITS="false" = off.

const fs = require('fs');
const path = require('path');
const config = require('./config');
const { warn } = require('./logger');

const FILE = path.join(__dirname, '..', 'data', 'compute-units.json');
const COMPUTE_BUDGET = 'ComputeBudget111111111111111111111111111111';
const SYSTEM = '11111111111111111111111111111111';
const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const PUMP = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const PUMP_AMM = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
const MIN_SAMPLES = 3;
const KEEP = 30; // recent trades remembered per kind
const MARGIN = 1.1; // +10%
const MARGIN_UNITS = 3000; // and a little more for small trades
const FLOOR = 20_000;

let kinds = null; // key -> { used: number[] }
const bySig = new Map(); // signature -> { key, limit }

function load() {
  if (kinds) return;
  kinds = new Map();
  try {
    const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    for (const [k, v] of Object.entries(data || {})) if (v && Array.isArray(v.used)) kinds.set(k, { used: v.used.filter((x) => x > 0).slice(-KEEP) });
  } catch {
    // none yet
  }
}

function save() {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(Object.fromEntries(kinds)));
  } catch (err) {
    warn(`[Compute] Couldn't save ${FILE}: ${err.message}`);
  }
}

function enabled() {
  return config.AUTO_COMPUTE_UNITS !== false;
}

const keyStr = (k) => (typeof k === 'string' ? k : k.toBase58());

/** What kind of trade this (unsigned, compiled) transaction is. */
function kindOf(tx, side) {
  const msg = tx.message;
  const keys = (msg.staticAccountKeys || msg.accountKeys || []).map(keyStr);
  const programs = [];
  let tradeAccounts = 0;
  for (const ix of msg.compiledInstructions || []) {
    const p = keys[ix.programIdIndex];
    if (!p || p === COMPUTE_BUDGET || p === SYSTEM) continue; // budget and tip
    programs.push(p.slice(0, 6));
    if (p === PUMP || p === PUMP_AMM) tradeAccounts = (ix.accountKeyIndexes || []).length;
  }
  const t22 = keys.includes(TOKEN_2022) ? 't22' : 'spl';
  return `${side}|${programs.join('+')}|${t22}|a${tradeAccounts}`;
}

/** The learned limit for this kind (never above `ceiling`), or null while it's still being learned. */
function estimate(key, ceiling) {
  if (!enabled()) return null;
  load();
  const k = kinds.get(key);
  if (!k || k.used.length < MIN_SAMPLES) return null;
  const most = Math.max(...k.used);
  return Math.max(FLOOR, Math.min(ceiling, Math.ceil(most * MARGIN) + MARGIN_UNITS));
}

/**
 * Rewrite the compute-unit limit (and the price per unit, so the TOTAL fee
 * stays `feeLamports`) of an unsigned transaction, in place.
 * Returns true if both instructions were found and changed.
 */
function setLimit(tx, limit, feeLamports) {
  const msg = tx.message;
  const keys = (msg.staticAccountKeys || msg.accountKeys || []).map(keyStr);
  let limitIx = null;
  let priceIx = null;
  for (const ix of msg.compiledInstructions || []) {
    if (keys[ix.programIdIndex] !== COMPUTE_BUDGET || !ix.data || !ix.data.length) continue;
    if (ix.data[0] === 2 && ix.data.length >= 5) limitIx = ix;
    if (ix.data[0] === 3 && ix.data.length >= 9) priceIx = ix;
  }
  if (!limitIx) return false;
  const lim = Buffer.from(limitIx.data);
  lim.writeUInt32LE(limit, 1);
  limitIx.data = Uint8Array.from(lim);
  if (priceIx && feeLamports > 0) {
    const price = BigInt(Math.ceil((feeLamports * 1e6) / limit)); // micro-lamports per unit
    const pr = Buffer.from(priceIx.data);
    pr.writeBigUInt64LE(price, 1);
    priceIx.data = Uint8Array.from(pr);
  }
  return true;
}

/** The compute-unit limit an unsigned transaction sets, or null. */
function limitOf(tx) {
  const msg = tx.message;
  const keys = (msg.staticAccountKeys || msg.accountKeys || []).map(keyStr);
  for (const ix of msg.compiledInstructions || []) {
    if (keys[ix.programIdIndex] === COMPUTE_BUDGET && ix.data && ix.data[0] === 2 && ix.data.length >= 5) {
      return Buffer.from(ix.data).readUInt32LE(1);
    }
  }
  return null;
}

/**
 * Size a freshly built transaction: if this kind of trade has been learned,
 * lower its limit to what it needs (the total fee unchanged).
 * Returns { kind, limit, learned }.
 */
function fit(tx, side, feeLamports) {
  const kind = kindOf(tx, side);
  const current = limitOf(tx);
  const learnedLimit = current ? estimate(kind, current) : null;
  if (learnedLimit && learnedLimit < current && setLimit(tx, learnedLimit, feeLamports)) {
    return { kind, limit: learnedLimit, learned: true };
  }
  return { kind, limit: current, learned: false };
}

/** Remember which kind a sent transaction was (to learn from its result). */
function remember(signature, key, limit, learned = false) {
  if (!signature || !key) return;
  bySig.set(signature, { key, limit, learned });
  if (bySig.size > 500) bySig.delete(bySig.keys().next().value);
}

/** A confirmed trade used `used` units: learn from it. */
function observe(signature, used) {
  const s = bySig.get(signature);
  if (!s || !(used > 0)) return;
  load();
  const k = kinds.get(s.key) || { used: [] };
  k.used.push(used);
  if (k.used.length > KEEP) k.used.shift();
  kinds.set(s.key, k);
  save();
}

/** A trade ran out of compute: its kind needs more from now on. */
function ranOut(signature) {
  const s = bySig.get(signature);
  if (!s) return;
  load();
  const k = kinds.get(s.key) || { used: [] };
  // As if a trade had used everything it was given and a bit more.
  k.used.push(Math.ceil((s.limit || 0) * 1.15));
  if (k.used.length > KEEP) k.used.shift();
  kinds.set(s.key, k);
  save();
}

function _resetForTests() {
  kinds = new Map();
  bySig.clear();
}

function wasLearned(signature) {
  const s = bySig.get(signature);
  return Boolean(s && s.learned);
}

/** Every learned limit, for the Rust fast path: { kind: limit }. */
function allEstimates(ceiling) {
  load();
  const out = {};
  for (const k of kinds.keys()) {
    const e = estimate(k, ceiling);
    if (e) out[k] = e;
  }
  return out;
}

module.exports = { allEstimates, kindOf, estimate, setLimit, limitOf, fit, remember, observe, ranOut, wasLearned, MIN_SAMPLES, _resetForTests };
