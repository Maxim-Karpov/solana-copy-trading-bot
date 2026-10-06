// src/plainAccount.js
//
// TOKEN_ACCOUNT_MODE=plain: the buy's token account is made with the System
// program and the Token program directly, instead of the Associated Token
// Account (ATA) program.
//
// Why: the ATA program's "create idempotent" costs about 17,000 compute units
// (it looks the mint up, allocates, assigns, sets the immutable-owner
// extension and initialises the account, each as a nested call). Creating the
// account directly costs about 2,500. A buy's priority fee is spread over its
// compute limit, so 14,000 fewer units means about 17% more fee per unit at
// the same total fee, which is what the block ordering looks at.
//
// What it does NOT change: the account is an ordinary token account owned by
// the wallet (the wallet's balance reads, the account cleaner and every
// explorer see it like any other). Only its ADDRESS is different: it is made
// with createAccountWithSeed from the wallet and a seed taken from the coin's
// address, so the bot can always work the address out again (no address needs
// remembering). Pump.fun accepts any token account of the wallet as the
// buyer's account (snipers' transactions show the same: a created account that
// is not the ATA).
//
// One plain account per coin and builder: the create fails if the account is
// already there, so a coin the bot has already bought this way is bought again
// the usual way (ATA), and sells move whatever is in the second account over
// first (see sellSource). The Rust fast path uses its own seed, so the two
// can never collide.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { PublicKey, TransactionInstruction } = require('@solana/web3.js');
const { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } = require('@solana/spl-token');
const config = require('./config');
const { info, warn } = require('./logger');

const SYSTEM = new PublicKey('11111111111111111111111111111111');
const CLASSIC_LEN = 165; // a token account with no extensions
const SEED_LEN = 32;
const RENT_PER_BYTE = 6960; // lamports per byte for rent exemption: 3,480 x 2 years
const RENT_BASE_BYTES = 128;
const MARKERS_FILE = path.join(__dirname, '../data/plain-mints.json');
const MAX_MARKERS = 3000;

// Which builder made the account: the Node bot and the Rust fast path use
// different seeds (shifted by one character) so their accounts never clash.
const SEED_SHIFT = { node: 0, rust: 1 };

let t22Len = null; // Token-2022 token account length, learned from the wallet's own accounts
let markers = null; // mint -> ms when a plain account was last made for it (this builder)

const enabled = () => config.TOKEN_ACCOUNT_MODE === 'plain';

/** The seed for a coin: 32 characters of its address (a valid UTF-8 seed, at most 32 bytes). */
function seedFor(mint, builder = 'node') {
  const s = String(mint);
  const from = SEED_SHIFT[builder] || 0;
  return s.slice(from, from + SEED_LEN);
}

/** Pubkey.createWithSeed: sha256(base | seed | owner). Returns 32 bytes. */
function addressBytes(userBytes, seed, ownerBytes) {
  return crypto.createHash('sha256').update(userBytes).update(Buffer.from(seed, 'utf8')).update(ownerBytes).digest();
}

/** The plain account's address for (wallet, coin, token program, builder). */
function addressFor(user, mint, program, builder = 'node') {
  return new PublicKey(addressBytes(user.toBuffer(), seedFor(mint, builder), program.toBuffer()));
}

/** Rent-exempt deposit for a token account of `len` bytes. */
const lamportsFor = (len) => (RENT_BASE_BYTES + len) * RENT_PER_BYTE;

/** Token account length for the program, or null while unknown (Token-2022 until learned). */
function accountLen(program) {
  const p = Buffer.isBuffer(program) ? program : program.toBuffer();
  if (p.equals(TOKEN_PROGRAM_ID.toBuffer())) return CLASSIC_LEN;
  if (p.equals(TOKEN_2022_PROGRAM_ID.toBuffer())) return t22Len || config.TOKEN_2022_ACCOUNT_BYTES || null;
  return null;
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

function loadMarkers() {
  if (markers) return markers;
  markers = new Map();
  try {
    const raw = JSON.parse(fs.readFileSync(MARKERS_FILE, 'utf8'));
    for (const [m, v] of Object.entries(raw)) markers.set(m, v && typeof v === 'object' ? v : { at: Number(v) || 0, builder: 'node' });
  } catch {
    // none yet
  }
  return markers;
}

function saveMarkers() {
  try {
    fs.mkdirSync(path.dirname(MARKERS_FILE), { recursive: true });
    fs.writeFileSync(MARKERS_FILE, JSON.stringify(Object.fromEntries(markers)));
  } catch (err) {
    warn(`[plainAccount] Couldn't save ${MARKERS_FILE} (${err.message}).`);
  }
}

/** Has a plain account been made for this coin by this builder ('node' or 'rust')? */
function marked(mint, builder = 'node') {
  const m = loadMarkers().get(String(mint));
  return !!m && m.builder === builder;
}

/** Where a coin's tokens are most likely to be, for a sell built before the account could be read: the plain account's address, or null (the ATA). */
function guess(user, mint, program) {
  const m = loadMarkers().get(String(mint));
  return m ? addressFor(user, mint, program, m.builder) : null;
}

/** Has the bot ever used plain accounts (so sells elsewhere must look for them)? */
function everUsed() {
  return enabled() || loadMarkers().size > 0;
}

/** Remember that a buy that creates the coin's plain account was sent. */
function noteBuy(mint, builder = 'node') {
  const m = loadMarkers();
  m.set(String(mint), { at: Date.now(), builder });
  while (m.size > MAX_MARKERS) m.delete(m.keys().next().value);
  saveMarkers();
}

/**
 * The raw instructions that create (and initialise) the plain account, in the
 * shape pumpBuyRaw writes: { program: Buffer, keys: [{ key, isSigner, isWritable }], data: Buffer }.
 */
function createInstructions({ userBytes, mint, programBytes, builder = 'node' }) {
  const len = accountLen(programBytes);
  if (!len) return null;
  const seed = seedFor(mint, builder);
  const address = addressBytes(userBytes, seed, programBytes);
  const mintBytes = new PublicKey(mint).toBuffer();
  const sysCreate = {
    program: SYSTEM.toBuffer(),
    keys: [
      { key: userBytes, isSigner: true, isWritable: true },
      { key: address, isSigner: false, isWritable: true }
    ],
    // CreateAccountWithSeed: 3 | base | seed (u64 length + bytes) | lamports | space | owner
    data: Buffer.concat([u32(3), userBytes, u64(Buffer.byteLength(seed)), Buffer.from(seed, 'utf8'), u64(lamportsFor(len)), u64(len), programBytes])
  };
  const ixs = [sysCreate];
  const is22 = programBytes.equals(TOKEN_2022_PROGRAM_ID.toBuffer());
  if (is22) {
    // The same account layout the ATA program makes (it always sets this).
    ixs.push({ program: programBytes, keys: [{ key: address, isSigner: false, isWritable: true }], data: Buffer.from([22]) });
  }
  ixs.push({
    program: programBytes,
    keys: [
      { key: address, isSigner: false, isWritable: true },
      { key: mintBytes, isSigner: false, isWritable: false }
    ],
    data: Buffer.concat([Buffer.from([18]), userBytes]) // InitializeAccount3 (owner in the data)
  });
  return { address, ixs, len };
}

/**
 * The plain account for this buy, or null when the usual ATA is to be used
 * (the mode is off, the coin was bought this way before, or the account
 * length isn't known yet).
 * @returns { address: Buffer, ixs, len, kindPrograms: string[] } | null
 */
function plan({ userBytes, mint, programBytes, builder = 'node' }) {
  if (!enabled() || marked(mint, builder)) return null;
  const made = createInstructions({ userBytes, mint, programBytes, builder });
  if (!made) return null;
  const is22 = programBytes.equals(TOKEN_2022_PROGRAM_ID.toBuffer());
  return { ...made, kindPrograms: is22 ? ['Tokenz', 'Tokenz'] : ['Tokenk'] };
}

/** The same raw instructions as web3.js TransactionInstructions. */
function toWeb3(ixs) {
  return ixs.map(
    (ix) =>
      new TransactionInstruction({
        programId: new PublicKey(ix.program),
        keys: ix.keys.map((k) => ({ pubkey: new PublicKey(k.key), isSigner: k.isSigner, isWritable: k.isWritable })),
        data: ix.data
      })
  );
}

/**
 * Learn the Token-2022 token account length from the wallet's own Token-2022
 * accounts (made by the ATA program, so the same layout a plain one needs).
 * Used until it is known: the ATA route.
 */
async function learnLength(connection, owner) {
  if (t22Len) return t22Len;
  try {
    const resp = await connection.getTokenAccountsByOwner(owner, { programId: TOKEN_2022_PROGRAM_ID }, { encoding: 'base64' });
    const counts = new Map();
    for (const a of resp.value.slice(0, 50)) {
      const len = a.account.data.length;
      if (len >= CLASSIC_LEN) counts.set(len, (counts.get(len) || 0) + 1);
    }
    if (counts.size) {
      t22Len = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
      info(`[plainAccount] Token-2022 token accounts are ${t22Len} bytes: plain accounts will be used for Token-2022 coins too.`);
    }
  } catch (err) {
    warn(`[plainAccount] Couldn't read the wallet's Token-2022 accounts (${err.message}).`);
  }
  return t22Len;
}

/** Start learning the length (now, then every few minutes until known). Plain mode only. */
function startLearning(connection, owner) {
  if (!enabled() || t22Len || config.TOKEN_2022_ACCOUNT_BYTES) return;
  learnLength(connection, owner).catch(() => {});
  const t = setInterval(() => {
    if (t22Len) return clearInterval(t);
    learnLength(connection, owner).catch(() => {});
  }, 5 * 60 * 1000);
  if (t.unref) t.unref();
}

/** Every address the coin's tokens could be in: the ATA, then the plain accounts. */
function holders(user, mint, program) {
  const mintPk = new PublicKey(mint);
  return [
    { address: getAssociatedTokenAddressSync(mintPk, user, true, program), kind: 'ata' },
    { address: addressFor(user, mint, program, 'node'), kind: 'plain' },
    { address: addressFor(user, mint, program, 'rust'), kind: 'plain' }
  ];
}

/** Token amount of an account's data (null when it isn't a token account). */
function amountOf(info) {
  return info && info.data && info.data.length >= 72 ? Buffer.from(info.data).readBigUInt64LE(64) : null;
}

/**
 * Which account a sell should take the tokens from, given the holders'
 * account data (same order as holders()).
 * @returns { from: address of the account the sell uses, move: [{ address, raw }] tokens to move into it first }
 */
function sellSource(heldList, infos) {
  const filled = [];
  heldList.forEach((h, i) => {
    const raw = amountOf(infos[i]);
    if (raw && raw > 0n) filled.push({ ...h, raw });
  });
  if (!filled.length) return { from: heldList[0].address, move: [], found: false };
  if (filled.length === 1) return { from: filled[0].address, move: [], found: true };
  // More than one account holds tokens (a second buy of the coin used the ATA): collect them in the ATA, or else the biggest.
  const target = filled.find((f) => f.kind === 'ata') || filled.sort((a, b) => (a.raw < b.raw ? 1 : -1))[0];
  return { from: target.address, move: filled.filter((f) => f !== target).map((f) => ({ address: f.address, raw: f.raw })), found: true };
}

/** TransferChecked instructions that move `moves` into `to`. */
function moveInstructions({ user, mint, program, decimals, to, moves }) {
  const mintPk = new PublicKey(mint);
  return moves.map((m) => {
    const data = Buffer.concat([Buffer.from([12]), u64(m.raw), Buffer.from([decimals])]);
    return new TransactionInstruction({
      programId: program,
      keys: [
        { pubkey: m.address, isSigner: false, isWritable: true },
        { pubkey: mintPk, isSigner: false, isWritable: false },
        { pubkey: to, isSigner: false, isWritable: true },
        { pubkey: user, isSigner: true, isWritable: false }
      ],
      data
    });
  });
}

/** Idempotent ATA creation (for a sell that moves tokens into an ATA that doesn't exist yet). */
function createAtaInstruction(user, mint, program) {
  const mintPk = new PublicKey(mint);
  const ata = getAssociatedTokenAddressSync(mintPk, user, true, program);
  return new TransactionInstruction({
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: user, isSigner: true, isWritable: true },
      { pubkey: ata, isSigner: false, isWritable: true },
      { pubkey: user, isSigner: false, isWritable: false },
      { pubkey: mintPk, isSigner: false, isWritable: false },
      { pubkey: SYSTEM, isSigner: false, isWritable: false },
      { pubkey: program, isSigner: false, isWritable: false }
    ],
    data: Buffer.from([1])
  });
}

function _resetForTests() {
  t22Len = null;
  markers = new Map();
}
function _setT22Len(n) {
  t22Len = n;
}

module.exports = {
  enabled,
  seedFor,
  addressFor,
  addressBytes,
  lamportsFor,
  accountLen,
  marked,
  guess,
  everUsed,
  noteBuy,
  createInstructions,
  plan,
  toWeb3,
  learnLength,
  startLearning,
  holders,
  amountOf,
  sellSource,
  moveInstructions,
  createAtaInstruction,
  _resetForTests,
  _setT22Len,
  CLASSIC_LEN
};
