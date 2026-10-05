// src/pumpBuyRaw.js
//
// The SHRED_FAST_BUY Pump.fun buy, written straight into transaction bytes.
//
// The SDK route (Anchor's instruction builder, PublicKey objects, web3.js's
// message compiler, then Sender's tip swap, which reads the whole
// transaction back and compiles it again) takes about 2 ms when the code is
// hot and 10-20 ms when it isn't, and allocates enough to trigger garbage
// collection pauses. This writes the same bytes directly: the accounts come
// from a template the SDK itself produced (refreshed every practice build),
// the coin's own accounts are matched against the copy wallet's transaction
// by hashing (no curve maths), and the message is laid out in one buffer,
// signed with Node's native ed25519 and sent.
//
// The result is checked against the SDK route at startup (same inputs, same
// bytes); if they ever differ, e.g. after a Pump.fun upgrade, this switches
// itself off and the SDK route is used.

const crypto = require('crypto');
const { PublicKey } = require('@solana/web3.js');
const { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } = require('@solana/spl-token');
const bs58Mod = require('bs58');
const bs58 = bs58Mod.default || bs58Mod;
const { keyFor } = require('./fastSign');
const computeBudget = require('./computeBudget');

const PUMP = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P').toBuffer();
const ATA_PROGRAM = ASSOCIATED_TOKEN_PROGRAM_ID.toBuffer();
const TOKEN = TOKEN_PROGRAM_ID.toBuffer();
const TOKEN_2022 = TOKEN_2022_PROGRAM_ID.toBuffer();
const SYSTEM = Buffer.alloc(32); // 11111111111111111111111111111111
const COMPUTE_BUDGET = new PublicKey('ComputeBudget111111111111111111111111111111').toBuffer();
const PDA_MARKER = Buffer.from('ProgramDerivedAddress');
const CURVE_SEED = Buffer.from('bonding-curve');
const CURVE_V2_SEED = Buffer.from('bonding-curve-v2');
const BUY_EXACT_SOL_IN = Buffer.from('38fc74089edfcd5f', 'hex');
const BUY_DISC = Buffer.from('66063d1201daebea', 'hex');
const FAST_BUMPS = 16; // bumps tried when matching against his transaction

// Where each per-coin account sits in Pump.fun's buy instruction (checked
// against the SDK's own instruction whenever the template is made).
const ROLE = {
  feeRecipient: 1,
  mint: 2,
  bondingCurve: 3,
  associatedBondingCurve: 4,
  associatedUser: 5,
  user: 6,
  tokenProgram: 8,
  creatorVault: 9,
  bondingCurveV2: 16
};
const BUY_ACCOUNTS = 18;

let template = null; // { user: Buffer, accounts: [{ key, isSigner, isWritable }], data tail }
let disabled = null; // reason, once the self-check fails

const latin1 = (b) => b.toString('latin1');
/** 32 key bytes from base58 text, a PublicKey or bytes. */
const keyBytes = (k) => (typeof k === 'string' ? Buffer.from(bs58.decode(k)) : Buffer.isBuffer(k) ? k : k.toBuffer ? k.toBuffer() : Buffer.from(k));

// One-shot native sha256 (Node 21.7+), else the classic API.
const sha256 = typeof crypto.hash === 'function' ? (b) => crypto.hash('sha256', b, 'buffer') : (b) => crypto.createHash('sha256').update(b).digest();

/** seeds | bump | program | "ProgramDerivedAddress" in one buffer; returns it and where the bump goes. */
function pdaInput(seeds, program) {
  const buf = Buffer.concat([...seeds, Buffer.alloc(1), program, PDA_MARKER]);
  return { buf, at: seeds.reduce((n, x) => n + x.length, 0) };
}

/**
 * The PDA of each seed set (one per candidate, e.g. per token program) that
 * appears in `keySet` (latin1 strings), trying the usual bumps, highest
 * first. Returns { key, i } (which candidate) or null.
 */
function matchPda(candidates, program, keySet) {
  const inputs = candidates.map((seeds) => pdaInput(seeds, program));
  for (let bump = 255; bump > 255 - FAST_BUMPS; bump--) {
    for (let i = 0; i < inputs.length; i++) {
      inputs[i].buf[inputs[i].at] = bump;
      const h = sha256(inputs[i].buf);
      if (keySet.has(latin1(h))) return { key: h, i };
    }
  }
  return null;
}

// ---- off-curve test without decoding the point ----
// A 32-byte value is a valid ed25519 point if y < p and x^2 = (y^2 - 1) /
// (d y^2 + 1) has a root, i.e. if (y^2 - 1)(d y^2 + 1) is a square mod p
// (Jacobi symbol 0 or 1; the root x = 0 is only allowed with the sign bit
// clear). Same answer as web3.js's isOnCurve (noble's strict decoding), in
// a fraction of its time: no square root, no exponentiation.
const P = 2n ** 255n - 19n;
const D = 37095705934669439343138083508754565189542113879843219016388785533085940283555n;
const Y_MASK = (1n << 255n) - 1n;

function jacobi(a, n) {
  a %= n;
  let t = 1;
  while (a !== 0n) {
    while ((a & 1n) === 0n) {
      a >>= 1n;
      const r = n & 7n;
      if (r === 3n || r === 5n) t = -t;
    }
    const tmp = a;
    a = n;
    n = tmp;
    if ((a & 3n) === 3n && (n & 3n) === 3n) t = -t;
    a %= n;
  }
  return n === 1n ? t : 0;
}

function isOnCurve(bytes) {
  const v = BigInt(`0x${Buffer.from(bytes).reverse().toString('hex')}`); // little-endian
  const sign = v >> 255n;
  const y = v & Y_MASK;
  if (y >= P) return false; // not a canonical encoding: decoding fails
  const y2 = (y * y) % P;
  const u = (y2 - 1n + P) % P;
  const w = (D * y2 + 1n) % P;
  const j = jacobi((u * w) % P, P);
  if (j === -1) return false;
  if (j === 0) return sign === 0n; // x = 0
  return true;
}

/** findProgramAddressSync, with native hashing and the fast curve test. */
function derive(seeds, program) {
  const { buf, at } = pdaInput(seeds, program);
  for (let bump = 255; bump >= 0; bump--) {
    buf[at] = bump;
    const h = sha256(buf);
    if (!isOnCurve(h)) return h;
  }
  throw new Error('no program address found');
}

/**
 * Make the template from an instruction the SDK built for `user` (a
 * practice coin). Throws if its layout isn't the one this module writes.
 */
function setTemplate({ user, sdkBuyIx, mint, tokenProgram, creatorVault }) {
  const keys = sdkBuyIx.keys;
  const data = Buffer.from(sdkBuyIx.data);
  const fail = (why) => {
    throw new Error(`Pump.fun buy layout changed (${why})`);
  };
  if (!sdkBuyIx.programId.toBuffer().equals(PUMP)) fail('program');
  if (keys.length !== BUY_ACCOUNTS) fail(`${keys.length} accounts, expected ${BUY_ACCOUNTS}`);
  if (data.length !== 25 || !data.subarray(0, 8).equals(BUY_DISC)) fail('instruction data');
  const at = (i) => keys[i].pubkey.toBuffer();
  const userB = user.toBuffer();
  const mintB = mint.toBuffer();
  const curve = derive([CURVE_SEED, mintB], PUMP);
  const checks = [
    [ROLE.mint, mintB],
    [ROLE.user, userB],
    [ROLE.tokenProgram, tokenProgram.toBuffer()],
    [ROLE.creatorVault, creatorVault.toBuffer()],
    [ROLE.bondingCurve, curve],
    [ROLE.associatedBondingCurve, derive([curve, tokenProgram.toBuffer(), mintB], ATA_PROGRAM)],
    [ROLE.associatedUser, derive([userB, tokenProgram.toBuffer(), mintB], ATA_PROGRAM)],
    [ROLE.bondingCurveV2, derive([CURVE_V2_SEED, mintB], PUMP)]
  ];
  for (const [i, want] of checks) if (!at(i).equals(want)) fail(`account ${i}`);
  if (!keys[ROLE.user].isSigner) fail('signer');
  template = {
    user: userB,
    accounts: keys.map((k) => ({ key: k.pubkey.toBuffer(), isSigner: k.isSigner, isWritable: k.isWritable })),
    trackVolume: data[24]
  };
  return template;
}

function ready(user) {
  return !disabled && template !== null && (!user || template.user.equals(Buffer.isBuffer(user) ? user : user.toBuffer()));
}

/** The latin1 set of a transaction's keys (base58 strings). */
function keySetOf(txKeys) {
  const set = new Set();
  for (const k of txKeys || []) {
    try {
      set.add(latin1(Buffer.from(bs58.decode(k))));
    } catch {}
  }
  return set;
}

/**
 * The coin's own accounts, from the copy wallet's transaction where it has
 * them (hash match) and derived otherwise. Returns { ... } or { reason }.
 */
function coinAccounts(mintB, keySet, user, knownTokenProgram = null) {
  const c = matchPda([[CURVE_SEED, mintB]], PUMP, keySet);
  const curve = c ? c.key : derive([CURVE_SEED, mintB], PUMP);
  const programs = knownTokenProgram ? [knownTokenProgram] : [TOKEN, TOKEN_2022];
  const m = matchPda(programs.map((prog) => [curve, prog, mintB]), ATA_PROGRAM, keySet);
  let tokenProgram;
  let abc;
  if (m) {
    tokenProgram = programs[m.i];
    abc = m.key;
  } else {
    if (!knownTokenProgram) return { reason: "the coin's token program isn't clear from his transaction" };
    tokenProgram = knownTokenProgram;
    abc = derive([curve, tokenProgram, mintB], ATA_PROGRAM);
  }
  const v2 = matchPda([[CURVE_V2_SEED, mintB]], PUMP, keySet);
  const curveV2 = v2 ? v2.key : derive([CURVE_V2_SEED, mintB], PUMP);
  const associatedUser = derive([user, tokenProgram, mintB], ATA_PROGRAM);
  return { curve, abc, curveV2, tokenProgram, associatedUser };
}

/** Solana's compact-u16 length prefix. */
function writeCompact(buf, off, n) {
  while (n >= 0x80) {
    buf[off++] = (n & 0x7f) | 0x80;
    n >>= 7;
  }
  buf[off++] = n;
  return off;
}

/**
 * A v0 message (no lookup tables) for `instructions`
 * ([{ program: Buffer, keys: [{ key, isSigner, isWritable }], data: Buffer }]),
 * with the accounts ordered exactly as web3.js's compiler orders them.
 */
function compileV0(payer, instructions, blockhash) {
  const metas = new Map(); // latin1 -> { key, s, w }
  const meta = (key) => {
    const id = latin1(key);
    let m = metas.get(id);
    if (!m) {
      m = { key, s: false, w: false };
      metas.set(id, m);
    }
    return m;
  };
  const p = meta(payer);
  p.s = true;
  p.w = true;
  for (const ix of instructions) {
    meta(ix.program);
    for (const k of ix.keys) {
      const m = meta(k.key);
      m.s = m.s || k.isSigner;
      m.w = m.w || k.isWritable;
    }
  }
  const all = [...metas.values()];
  const ordered = [...all.filter((m) => m.s && m.w), ...all.filter((m) => m.s && !m.w), ...all.filter((m) => !m.s && m.w), ...all.filter((m) => !m.s && !m.w)];
  const index = new Map(ordered.map((m, i) => [latin1(m.key), i]));
  const numSigners = ordered.filter((m) => m.s).length;
  const readonlySigned = ordered.filter((m) => m.s && !m.w).length;
  const readonlyUnsigned = ordered.filter((m) => !m.s && !m.w).length;

  const buf = Buffer.alloc(1232);
  let off = 0;
  buf[off++] = 0x80; // v0
  buf[off++] = numSigners;
  buf[off++] = readonlySigned;
  buf[off++] = readonlyUnsigned;
  off = writeCompact(buf, off, ordered.length);
  for (const m of ordered) off += m.key.copy(buf, off);
  off += blockhash.copy(buf, off);
  off = writeCompact(buf, off, instructions.length);
  for (const ix of instructions) {
    buf[off++] = index.get(latin1(ix.program));
    off = writeCompact(buf, off, ix.keys.length);
    for (const k of ix.keys) buf[off++] = index.get(latin1(k.key));
    off = writeCompact(buf, off, ix.data.length);
    off += ix.data.copy(buf, off);
  }
  off = writeCompact(buf, off, 0); // no address lookup tables
  if (off > 1232 - 65) throw new Error('transaction too large');
  return Buffer.from(buf.subarray(0, off));
}

/**
 * A built, unsigned transaction with the parts of VersionedTransaction's
 * interface the bot uses: sign(), serialize(), signatures.
 */
class HandBuiltTx {
  constructor(message, { guardIxIndex = null } = {}) {
    this.messageBytes = message;
    this.signatures = [new Uint8Array(64)];
    this.handBuilt = true;
    if (guardIxIndex !== null) Object.defineProperty(this, 'guardIxIndex', { value: guardIxIndex, enumerable: false });
  }

  sign(keypair) {
    const sig = crypto.sign(null, this.messageBytes, keyFor(keypair));
    this.signatures[0] = sig;
    return this;
  }

  serialize() {
    const out = Buffer.alloc(1 + 64 + this.messageBytes.length);
    out[0] = 1;
    Buffer.from(this.signatures[0]).copy(out, 1);
    this.messageBytes.copy(out, 65);
    return out;
  }
}

const u32 = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
};
const u64 = (n) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
};

/**
 * The buy, as message bytes. Fees follow the SDK route exactly:
 *   - compute limit `limit` (learned, or the ceiling), price per unit so the
 *     total is the buy's priority fee; with Sender at least Sender's minimum;
 *   - the tip transfer to `tip.account` (Sender's or Jito's).
 * @returns { tx: HandBuiltTx } or { reason }
 */
function buildBuy({
  user, // PublicKey (the template's)
  mint, // base58
  txKeys, // his transaction's keys (base58)
  knownTokenProgram = null, // Buffer, when the coin was seen before
  creatorVault, // base58
  feeRecipients, // Buffer[] (non-mayhem fee recipients from Pump.fun's global)
  lamports, // bigint: SOL to spend
  minOut, // bigint: min_tokens_out
  fees, // { feeSol, ceiling, useSender }: the buy's priority fee and compute ceiling
  guardInstructions = [],
  tip, // { account: base58, lamports } or null
  blockhash // base58
}) {
  if (!ready(user)) return { reason: disabled || 'not prepared yet' };
  const userB = template.user;
  const mintB = Buffer.from(bs58.decode(mint));
  const acc = coinAccounts(mintB, keySetOf(txKeys), userB, knownTokenProgram);
  if (acc.reason) return acc;

  const keys = template.accounts.map((a) => ({ ...a }));
  const set = (role, key) => {
    keys[ROLE[role]].key = key;
  };
  set('feeRecipient', feeRecipients[Math.floor(Math.random() * feeRecipients.length)]);
  set('mint', mintB);
  set('bondingCurve', acc.curve);
  set('associatedBondingCurve', acc.abc);
  set('associatedUser', acc.associatedUser);
  set('tokenProgram', acc.tokenProgram);
  set('creatorVault', keyBytes(creatorVault));
  set('bondingCurveV2', acc.curveV2);
  const data = Buffer.alloc(25);
  BUY_EXACT_SOL_IN.copy(data, 0);
  data.writeBigUInt64LE(lamports, 8);
  data.writeBigUInt64LE(minOut, 16);
  data[24] = template.trackVolume;

  const plan = feePlan(fees, kindOf(guardInstructions, acc.tokenProgram));
  const { computeLimit, priceMicroLamports, priceFirst } = plan;
  const budget = [{ program: COMPUTE_BUDGET, keys: [], data: Buffer.concat([Buffer.from([2]), u32(computeLimit)]) }];
  if (priceMicroLamports !== null) {
    const price = { program: COMPUTE_BUDGET, keys: [], data: Buffer.concat([Buffer.from([3]), u64(priceMicroLamports)]) };
    if (priceFirst) budget.unshift(price);
    else budget.push(price);
  }
  const ixs = [...budget];
  const guardIxIndex = guardInstructions.length ? ixs.length : null;
  for (const g of guardInstructions) {
    ixs.push({ program: g.programId.toBuffer(), keys: g.keys.map((k) => ({ key: k.pubkey.toBuffer(), isSigner: k.isSigner, isWritable: k.isWritable })), data: Buffer.from(g.data) });
  }
  ixs.push({
    program: ATA_PROGRAM,
    keys: [
      { key: userB, isSigner: true, isWritable: true },
      { key: acc.associatedUser, isSigner: false, isWritable: true },
      { key: userB, isSigner: false, isWritable: false },
      { key: mintB, isSigner: false, isWritable: false },
      { key: SYSTEM, isSigner: false, isWritable: false },
      { key: acc.tokenProgram, isSigner: false, isWritable: false }
    ],
    data: Buffer.from([1]) // create idempotent
  });
  ixs.push({ program: PUMP, keys, data });
  if (tip && tip.lamports > 0) {
    ixs.push({
      program: SYSTEM,
      keys: [
        { key: userB, isSigner: true, isWritable: true },
        { key: keyBytes(tip.account), isSigner: false, isWritable: true }
      ],
      data: Buffer.concat([u32(2), u64(tip.lamports)])
    });
  }
  const message = compileV0(userB, ixs, keyBytes(blockhash));
  const tx = new HandBuiltTx(message, { guardIxIndex });
  tx.compute = { kind: plan.kind, limit: computeLimit, learned: plan.learned, feeSol: fees.feeSol };
  return { tx, tokenProgram: acc.tokenProgram.equals(TOKEN_2022) ? 'token-2022' : 'spl-token' };
}

/** computeBudget.kindOf's key for this buy (so learned limits are shared with the SDK route). */
function kindOf(guardInstructions, tokenProgram) {
  const programs = guardInstructions.map((g) => g.programId.toBase58().slice(0, 6));
  programs.push('AToken', '6EF8rr');
  return `buy|${programs.join('+')}|${tokenProgram.equals(TOKEN_2022) ? 't22' : 'spl'}|a${BUY_ACCOUNTS}`;
}

/**
 * Compute limit and price, exactly as the SDK route ends up with them:
 * tradeExecutor spreads the fee over the ceiling, computeBudget.fit lowers
 * the limit to the learned one (keeping the total), and Sender's preparation
 * raises the price to its minimum (or adds one, first, if there was none).
 */
function feePlan({ feeSol, ceiling, useSender }, kind) {
  let limit = ceiling;
  let price = feeSol > 0 ? BigInt(Math.ceil((feeSol * 1e9 * 1e6) / ceiling)) : null;
  const feeLamports = Math.round(feeSol * 1e9);
  const learnedLimit = computeBudget.estimate(kind, ceiling);
  let learned = false;
  if (learnedLimit && learnedLimit < ceiling) {
    limit = learnedLimit;
    learned = true;
    if (price !== null && feeLamports > 0) price = BigInt(Math.ceil((feeLamports * 1e6) / limit));
  }
  let priceFirst = false;
  if (useSender) {
    const wanted = BigInt(Math.ceil((feeSol * 1e9 * 1e6) / limit));
    if (price === null) {
      price = wanted;
      priceFirst = true;
    } else if (wanted > price) price = wanted;
  }
  return { computeLimit: limit, priceMicroLamports: price, priceFirst, kind, learned };
}

function disable(reason) {
  disabled = reason;
}

/** The current template (for the Rust fast path), or null. */
function getTemplate() {
  return template && !disabled ? template : null;
}

function status() {
  return { ready: template !== null && !disabled, disabled, user: template ? new PublicKey(template.user).toBase58() : null };
}

function _resetForTests() {
  template = null;
  disabled = null;
}

module.exports = { getTemplate, buildBuy, setTemplate, ready, disable, status, compileV0, HandBuiltTx, keySetOf, coinAccounts, derive, isOnCurve, ROLE, _resetForTests };
