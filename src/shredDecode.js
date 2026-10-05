// src/shredDecode.js
//
// Turns one of the copy wallet's transactions, as seen in the shred stream
// (before execution: no balances, no logs, no result), into buy/sell intents.
//
//   - Direct Pump.fun curve and PumpSwap instructions are decoded from their
//     published layouts (buy, buy_exact_sol_in, sell; buy, buy_exact_quote_in,
//     sell). The amounts are what the copy wallet ASKED for: exact for
//     buy_exact_* (SOL in), an upper bound for plain `buy` (max SOL cost).
//   - Router programs (trading terminals and bots, e.g. the one the streamer
//     uses) call Pump.fun from inside their own instruction, whose format
//     isn't public. Those are LEARNED from the copy wallet's confirmed trades
//     (the normal feed): which instruction (program + its first data byte)
//     is a buy, and where in its data the SOL amount sits. The first byte,
//     not an 8-byte Anchor discriminator: many routers (e.g. the streamer's)
//     use a 1-byte instruction tag followed straight away by the amount, so
//     their first 8 bytes change from trade to trade. After two matching
//     confirmed buys the router is trusted; until then its trades are left
//     to the normal feed. The coin is found from the accounts: the mint is
//     the account whose Pump.fun bonding-curve (or PumpSwap pool) address is
//     also in the transaction.

require('./pdaCache'); // remember program-derived addresses (see pdaCache.js)
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const { PublicKey } = require('@solana/web3.js');
const { bondingCurvePda } = require('@pump-fun/pump-sdk');
const { canonicalPumpPoolPda } = require('@pump-fun/pump-swap-sdk');

const PUMP = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const PUMP_AMM = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
const WSOL = 'So11111111111111111111111111111111111111112';

// Anchor discriminators, from the programs' IDLs (shipped in the Pump SDKs).
const DISC = {
  buy: '66063d1201daebea', // same name, same discriminator in both programs
  sell: '33e685a4017f83ad',
  buyExactSolIn: '38fc74089edfcd5f',
  buyExactQuoteIn: 'c62e1552b4d9e870'
};

// Programs that are never a router (plumbing found in most transactions).
const NOT_ROUTERS = new Set([
  PUMP,
  PUMP_AMM,
  '11111111111111111111111111111111',
  'ComputeBudget111111111111111111111111111111',
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
  'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',
  'Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo'
]);

const u64 = (data, off) => (data.length >= off + 8 ? data.readBigUInt64LE(off) : null);

// ---- coin detection for router transactions (cached PDA derivations) ----
const pdaCache = new Map(); // `${kind}:${key}` -> pda base58
function cachedPda(kind, key) {
  const id = `${kind}:${key}`;
  let v = pdaCache.get(id);
  if (v === undefined) {
    try {
      const pk = new PublicKey(key);
      v = (kind === 'curve' ? bondingCurvePda(pk) : canonicalPumpPoolPda(pk)).toBase58();
    } catch {
      v = null;
    }
    pdaCache.set(id, v);
    if (pdaCache.size > 20000) pdaCache.delete(pdaCache.keys().next().value);
  }
  return v;
}

// The bonding curve of a candidate mint, by hash alone. A program-derived
// address is sha256(seeds, bump, program, "ProgramDerivedAddress"); the
// slow part of deriving one properly (~0.2-0.5 ms) is checking each bump's
// hash against the ed25519 curve. Here the question is only "is this
// candidate's curve address among the transaction's accounts?", and a hash
// that matches one of them can only be that address, so the curve check is
// skipped: a few microseconds per try instead of a fraction of a millisecond.
// Bumps are tried from 255 down; nearly every curve uses one of the top few.
const CURVE_SEED = Buffer.from('bonding-curve');
const PDA_MARKER = Buffer.from('ProgramDerivedAddress');
const PUMP_BYTES = new PublicKey(PUMP).toBuffer();
const FAST_BUMPS = 8; // 255..248: all but 1 in 256 curves
const bs58Mod = require('bs58');
const bs58 = bs58Mod.default || bs58Mod;
function bytesOf(key) {
  try {
    const b = Buffer.from(bs58.decode(key));
    return b.length === 32 ? b : null;
  } catch {
    return null;
  }
}
function fastCurveMatch(candidates, keyBytes) {
  const bytes = candidates.map(bytesOf);
  for (let bump = 255; bump > 255 - FAST_BUMPS; bump--) {
    const b = Buffer.from([bump]);
    for (let i = 0; i < candidates.length; i++) {
      if (!bytes[i]) continue;
      const h = crypto.createHash('sha256').update(CURVE_SEED).update(bytes[i]).update(b).update(PUMP_BYTES).update(PDA_MARKER).digest();
      if (keyBytes.has(h.toString('latin1'))) {
        // Remember it, as a full derivation would have.
        pdaCache.set(`curve:${candidates[i]}`, bs58.encode(h));
        return candidates[i];
      }
    }
  }
  return null;
}

/** { mint, pool } for a router transaction that reaches Pump.fun or PumpSwap, else null. */
function findPumpCoin(keys, copyWallet) {
  const set = new Set(keys);
  const candidates = keys.filter((k) => k !== copyWallet && !NOT_ROUTERS.has(k) && k !== WSOL);
  // Most Pump.fun mints end in "pump": try those first.
  candidates.sort((a, b) => (b.endsWith('pump') ? 1 : 0) - (a.endsWith('pump') ? 1 : 0));
  if (set.has(PUMP)) {
    // Coins seen before are remembered; otherwise the fast hash match, and
    // only if that finds nothing (a curve with an unusually low bump), the
    // full derivation.
    for (const k of candidates) {
      const known = pdaCache.get(`curve:${k}`);
      if (known && set.has(known)) return { mint: k, pool: 'pump-curve' };
    }
    const keyBytes = new Set();
    for (const k of keys) {
      const b = bytesOf(k);
      if (b) keyBytes.add(b.toString('latin1'));
    }
    const fast = fastCurveMatch(candidates, keyBytes);
    if (fast) return { mint: fast, pool: 'pump-curve' };
    for (const k of candidates) {
      const pda = cachedPda('curve', k);
      if (pda && set.has(pda)) return { mint: k, pool: 'pump-curve' };
    }
  }
  if (set.has(PUMP_AMM)) {
    for (const k of candidates) {
      const pda = cachedPda('pool', k);
      if (pda && set.has(pda)) return { mint: k, pool: 'pumpswap' };
    }
  }
  return null;
}

// ---- router learning ----
const MIN_OBSERVATIONS = 2;
// Confirmed amount / router amount: the router's figure may include its own
// fee (e.g. 3 SOL in, 2.97 to Pump.fun) and the confirmed one Pump.fun's fee.
const RATIO_MIN = 0.94;
const RATIO_MAX = 1.03;

/** A stored router record in the current shape (older files kept an intersected offset list). */
function upgrade(v) {
  const r = { buys: 0, sells: 0, matchedBuys: 0, hits: {}, ratios: {} };
  if (!v) return r;
  r.buys = v.buys || 0;
  r.sells = v.sells || 0;
  r.matchedBuys = typeof v.matchedBuys === 'number' ? v.matchedBuys : null; // null: unknown (older file)
  if (v.vaultHits) {
    r.vaultHits = v.vaultHits;
    r.vaultObs = v.vaultObs || 0;
  }
  if (v.hits && typeof v.hits === 'object') {
    r.hits = v.hits;
    r.ratios = v.ratios && !Array.isArray(v.ratios) ? v.ratios : {};
  } else if (Array.isArray(v.offsets) && v.offsets.length) {
    // Old format: every kept offset matched every buy.
    for (const off of v.offsets) {
      r.hits[off] = r.buys;
      r.ratios[off] = Array.isArray(v.ratios) ? v.ratios : [];
    }
  } else {
    // Old format whose offsets were wiped out by one odd trade: start afresh
    // (buys AND sells: sells alone would look like a sell-only instruction).
    r.buys = 0;
    r.sells = 0;
  }
  return r;
}

class RouterLearner {
  constructor(file = null) {
    this.file = file;
    this.routers = new Map(); // `${program}:${tag}` -> { buys, sells, hits: { offset: votes }, ratios: { offset: number[] } }
    this._load();
  }

  _load() {
    if (!this.file || !fs.existsSync(this.file)) return;
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const [k, v] of Object.entries(data.routers || {})) this.routers.set(k, upgrade(v));
    } catch {
      // A broken file only means relearning; never stop the bot over it.
    }
  }

  _save() {
    if (!this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify({ routers: Object.fromEntries(this.routers) }, null, 2));
    } catch {}
  }

  /**
   * A confirmed trade (from the normal feed) whose shred-stream transaction
   * held this router instruction. For buys, every data offset whose u64
   * matches the SOL amount gets a vote. The offset with the most votes is
   * where the amount sits; an odd trade (another variant of the
   * instruction) costs that offset nothing, so one oddity can't wipe out
   * what was learned. Returns the router's status after the update.
   */
  observe({ program, disc, data }, side, solAbs) {
    const key = `${program}:${disc}`;
    const r = this.routers.get(key) || upgrade(null);
    if (side === 'sell') {
      r.sells += 1;
    } else if (side === 'buy' && solAbs > 0) {
      const lamports = solAbs * 1e9;
      let matched = false;
      for (let off = 1; off + 8 <= data.length; off++) {
        const v = Number(data.readBigUInt64LE(off));
        if (v <= 0) continue;
        const ratio = lamports / v;
        if (ratio < RATIO_MIN || ratio > RATIO_MAX) continue;
        r.hits[off] = (r.hits[off] || 0) + 1;
        r.ratios[off] = [...(r.ratios[off] || []), ratio].slice(-20);
        matched = true;
      }
      r.buys += 1;
      // Buys whose amount isn't in the data at all are another variant of the
      // instruction (e.g. "buy this many tokens"); they don't count against
      // the position the other buys agree on.
      if (matched) r.matchedBuys = (r.matchedBuys === null ? 0 : r.matchedBuys) + 1;
    }
    this.routers.set(key, r);
    this._save();
    return this.status(program, disc);
  }

  /** The offset where the SOL amount sits, once at least 2 buys (and half of those that contain the amount) agree; else null. */
  bestOffset(program, disc) {
    const r = this.routers.get(`${program}:${disc}`);
    if (!r) return null;
    let best = null;
    for (const [off, n] of Object.entries(r.hits)) {
      if (best === null || n > r.hits[best] || (n === r.hits[best] && Number(off) < Number(best))) best = off;
    }
    if (best === null) return null;
    const n = r.hits[best];
    const counted = r.matchedBuys === null ? n : r.matchedBuys;
    return n >= MIN_OBSERVATIONS && n * 2 >= counted ? Number(best) : null;
  }

  /** 'buy' | 'sell' | 'mixed' (same instruction for both; needs the holdings check) | null (not learned). */
  status(program, disc) {
    const r = this.routers.get(`${program}:${disc}`);
    if (!r) return null;
    const buyReady = this.bestOffset(program, disc) !== null;
    if (buyReady && r.sells === 0) return 'buy';
    if (buyReady && r.sells > 0) return 'mixed';
    // Sell-only only once the same program's buys are known to use ANOTHER
    // instruction: many routers use one instruction for both, and taking its
    // buys for sells would trigger early exits.
    if (r.sells >= MIN_OBSERVATIONS && r.buys === 0 && this._hasOtherBuy(program, disc)) return 'sell';
    return null;
  }

  _hasOtherBuy(program, disc) {
    for (const key of this.routers.keys()) {
      if (!key.startsWith(`${program}:`) || key === `${program}:${disc}`) continue;
      if (this.bestOffset(program, key.slice(program.length + 1)) !== null) return true;
    }
    return false;
  }

  /** SOL amount (as the confirmed feed would report it) for a learned buy instruction. */
  buyLamports(program, disc, data) {
    const off = this.bestOffset(program, disc);
    if (off === null) return null;
    const r = this.routers.get(`${program}:${disc}`);
    const v = u64(data, off);
    if (v === null || v <= 0n) return null;
    const ratios = [...(r.ratios[off] || [])].sort((a, b) => a - b);
    const ratio = ratios.length ? ratios[Math.floor(ratios.length / 2)] : 1;
    return BigInt(Math.round(Number(v) * ratio));
  }

  /**
   * A confirmed buy whose creator (from Pump.fun's trade record) is known:
   * the position(s) in this router instruction's accounts that hold the
   * coin's creator vault get a vote. Lets a buy be built straight from the
   * shreds without looking the coin up (SHRED_FAST_BUY).
   */
  observeVault(program, disc, accountKeys, vault) {
    const key = `${program}:${disc}`;
    const r = this.routers.get(key);
    if (!r || !Array.isArray(accountKeys)) return;
    r.vaultObs = (r.vaultObs || 0) + 1;
    r.vaultHits = r.vaultHits || {};
    accountKeys.forEach((k, i) => {
      if (k === vault) r.vaultHits[i] = (r.vaultHits[i] || 0) + 1;
    });
    this._save();
  }

  /** Index of the creator vault in this instruction's accounts, once 2 buys (and half) agree; else null. */
  vaultIndex(program, disc) {
    const r = this.routers.get(`${program}:${disc}`);
    if (!r || !r.vaultHits) return null;
    let best = null;
    for (const [i, n] of Object.entries(r.vaultHits)) if (best === null || n > r.vaultHits[best]) best = i;
    if (best === null) return null;
    const n = r.vaultHits[best];
    return n >= MIN_OBSERVATIONS && n * 2 >= r.vaultObs ? Number(best) : null;
  }

  describe(program, disc) {
    const r = this.routers.get(`${program}:${disc}`);
    if (!r) return 'not seen';
    const best = Math.max(0, ...Object.values(r.hits));
    const counted = r.matchedBuys === null ? r.buys : r.matchedBuys;
    return `${r.buys} buy(s), ${r.sells} sell(s) seen` + (r.buys ? `; amount at the same place in ${best} of the ${counted} buy(s) that contain it` : '');
  }
}

/**
 * The copy wallet's buy/sell intents in one transaction.
 * @param keys      - all account keys, base58 (resolveKeys)
 * @param learner   - RouterLearner
 * @param isHeld    - (mint) => boolean|null: does the copy wallet already hold it (null = unknown)
 * Returns { intents: [{ side, mint, pool, solLamports, tokenRaw, approx, via }], routerIxs: [...] }
 *   routerIxs: router instructions seen (for learning), with the coin if found.
 */
function classify(tx, keys, copyWallet, { learner = null, isHeld = () => null } = {}) {
  const intents = [];
  const routerIxs = [];
  let coin; // found lazily (PDA derivations) for router transactions only

  for (const ix of tx.instructions) {
    const program = keys[ix.programIdIndex];
    const acc = (i) => (ix.accounts[i] !== undefined ? keys[ix.accounts[i]] : undefined);
    const data = ix.data;
    const disc = data.length >= 8 ? data.subarray(0, 8).toString('hex') : '';

    if (program === PUMP) {
      if (acc(6) !== copyWallet || !acc(2)) continue;
      const mint = acc(2);
      // creator_vault is account 9 of Pump.fun's buy / buy_exact_sol_in.
      if (disc === DISC.buyExactSolIn) {
        intents.push({ side: 'buy', mint, pool: 'pump-curve', solLamports: u64(data, 8), tokenRaw: u64(data, 16), approx: false, via: 'Pump.fun', creatorVault: acc(9) || null });
      } else if (disc === DISC.buy) {
        // Exact tokens out; SOL is only bounded by max_sol_cost.
        intents.push({ side: 'buy', mint, pool: 'pump-curve', solLamports: u64(data, 16), tokenRaw: u64(data, 8), approx: true, via: 'Pump.fun', creatorVault: acc(9) || null });
      } else if (disc === DISC.sell) {
        intents.push({ side: 'sell', mint, pool: 'pump-curve', solLamports: u64(data, 16), tokenRaw: u64(data, 8), approx: true, via: 'Pump.fun' });
      }
      continue;
    }

    if (program === PUMP_AMM) {
      if (acc(1) !== copyWallet || !acc(3) || acc(4) !== WSOL) continue; // only SOL-quoted pools
      const mint = acc(3);
      if (disc === DISC.buyExactQuoteIn) {
        intents.push({ side: 'buy', mint, pool: 'pumpswap', solLamports: u64(data, 8), tokenRaw: u64(data, 16), approx: false, via: 'PumpSwap' });
      } else if (disc === DISC.buy) {
        intents.push({ side: 'buy', mint, pool: 'pumpswap', solLamports: u64(data, 16), tokenRaw: u64(data, 8), approx: true, via: 'PumpSwap' });
      } else if (disc === DISC.sell) {
        intents.push({ side: 'sell', mint, pool: 'pumpswap', solLamports: u64(data, 16), tokenRaw: u64(data, 8), approx: true, via: 'PumpSwap' });
      }
      continue;
    }

    if (NOT_ROUTERS.has(program) || data.length < 9) continue; // a tag and at least one u64
    if (coin === undefined) coin = findPumpCoin(keys, copyWallet);
    if (!coin) continue; // doesn't reach Pump.fun or PumpSwap
    const tag = data.subarray(0, 1).toString('hex');
    const accountKeys = ix.accounts.map((i) => keys[i]);
    const ixInfo = { program, disc: tag, data: Buffer.from(data), mint: coin.mint, pool: coin.pool, accountKeys };
    routerIxs.push(ixInfo);
    if (!learner) continue;

    const status = learner.status(program, tag);
    const held = isHeld(coin.mint);
    const via = `router ${program.slice(0, 6)}…`;
    if ((status === 'buy' || status === 'mixed') && held === false) {
      const lamports = learner.buyLamports(program, tag, data);
      if (lamports !== null) {
        // The coin's creator vault, where this router's buys keep it (learned).
        const vi = learner.vaultIndex(program, tag);
        const creatorVault = vi !== null && accountKeys[vi] ? accountKeys[vi] : null;
        intents.push({ side: 'buy', mint: coin.mint, pool: coin.pool, solLamports: lamports, tokenRaw: null, approx: true, via, creatorVault });
      }
    } else if (status === 'sell') {
      intents.push({ side: 'sell', mint: coin.mint, pool: coin.pool, solLamports: null, tokenRaw: null, approx: true, via });
    }
  }
  return { intents, routerIxs };
}

/**
 * Run the coin search a few times on made-up accounts, so the first real
 * router buy doesn't pay for Node compiling this code (~8 ms on the first
 * call, ~0.5 ms after).
 */
function warmUp(rounds = 50) {
  const crypto2 = require('crypto');
  const rnd = () => bs58.encode(crypto2.randomBytes(32));
  for (let r = 0; r < rounds; r++) {
    const keys = [rnd(), ...Array.from({ length: 40 }, rnd), PUMP];
    findPumpCoin(keys, keys[0]);
  }
}

module.exports = { classify, findPumpCoin, warmUp, RouterLearner, DISC, PUMP, PUMP_AMM, WSOL };
