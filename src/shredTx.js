// src/shredTx.js
//
// Reads the transactions out of a ShredStream "entries" message: the bincode
// serialization of Vec<solana_entry::Entry>, where each Entry is
//   num_hashes: u64 LE, hash: [u8; 32], transactions: Vec<VersionedTransaction>
// (bincode Vec = u64 LE length, then the items). Each VersionedTransaction is
// in Solana's normal wire format, so its length is only known by walking it.
//
// The stream carries every transaction on Solana, so this is built to be
// cheap: a message that doesn't contain the copy wallet's 32-byte address
// anywhere is skipped with one native Buffer.indexOf, and only messages that
// do are walked. Nothing here makes network calls.

const bs58Mod = require('bs58');
const bs58 = bs58Mod.default || bs58Mod;

class ShredParseError extends Error {}

/** Solana "compact-u16" (short_vec length): 1-3 bytes, 7 bits each. */
function readCompactU16(buf, off) {
  let value = 0;
  let size = 0;
  for (;;) {
    if (off + size >= buf.length) throw new ShredParseError('truncated length prefix');
    const byte = buf[off + size];
    value |= (byte & 0x7f) << (size * 7);
    size += 1;
    if ((byte & 0x80) === 0) break;
    if (size >= 3) throw new ShredParseError('bad length prefix');
  }
  return { value, size };
}

function need(buf, off, n) {
  if (off + n > buf.length) throw new ShredParseError('truncated transaction');
}

/**
 * Parse one wire-format transaction starting at `off`.
 * Legacy, v0 and v1 (SIMD-0385) transactions.
 * Returns { tx, end } where tx = {
 *   signature (base58 of the first signature), numSigners, version ('legacy' | 0 | 1),
 *   staticKeys: Buffer[] (32 bytes each), instructions: [{ programIdIndex, accounts: number[], data: Buffer }],
 *   lookups: [{ key: Buffer, writable: number[], readonly: number[] }]
 * }
 */
function parseTransaction(buf, off) {
  need(buf, off, 1);
  if (buf[off] === V1_PREFIX) return parseV1(buf, off);
  const start = off;
  const sigs = readCompactU16(buf, off);
  off += sigs.size;
  need(buf, off, sigs.value * 64);
  const firstSig = sigs.value > 0 ? buf.subarray(off, off + 64) : null;
  off += sigs.value * 64;

  need(buf, off, 1);
  let version = 'legacy';
  if (buf[off] & 0x80) {
    version = buf[off] & 0x7f;
    off += 1;
    if (version !== 0) throw new ShredParseError(`unsupported transaction version ${version}`);
  }
  need(buf, off, 3);
  const numSigners = buf[off];
  off += 3; // header: required signatures, readonly signed, readonly unsigned

  const nKeys = readCompactU16(buf, off);
  off += nKeys.size;
  need(buf, off, nKeys.value * 32);
  const staticKeys = [];
  for (let i = 0; i < nKeys.value; i++) staticKeys.push(buf.subarray(off + i * 32, off + i * 32 + 32));
  off += nKeys.value * 32;

  need(buf, off, 32);
  off += 32; // recent blockhash

  const nIx = readCompactU16(buf, off);
  off += nIx.size;
  const instructions = [];
  for (let i = 0; i < nIx.value; i++) {
    need(buf, off, 1);
    const programIdIndex = buf[off];
    off += 1;
    const nAcc = readCompactU16(buf, off);
    off += nAcc.size;
    need(buf, off, nAcc.value);
    const accounts = Array.from(buf.subarray(off, off + nAcc.value));
    off += nAcc.value;
    const nData = readCompactU16(buf, off);
    off += nData.size;
    need(buf, off, nData.value);
    const data = buf.subarray(off, off + nData.value);
    off += nData.value;
    instructions.push({ programIdIndex, accounts, data });
  }

  const lookups = [];
  if (version === 0) {
    const nLookups = readCompactU16(buf, off);
    off += nLookups.size;
    for (let i = 0; i < nLookups.value; i++) {
      need(buf, off, 32);
      const key = buf.subarray(off, off + 32);
      off += 32;
      const nW = readCompactU16(buf, off);
      off += nW.size;
      need(buf, off, nW.value);
      const writable = Array.from(buf.subarray(off, off + nW.value));
      off += nW.value;
      const nR = readCompactU16(buf, off);
      off += nR.size;
      need(buf, off, nR.value);
      const readonly = Array.from(buf.subarray(off, off + nR.value));
      off += nR.value;
      lookups.push({ key, writable, readonly });
    }
  }

  return {
    tx: {
      signature: firstSig ? bs58.encode(firstSig) : null,
      numSigners,
      version,
      staticKeys,
      instructions,
      lookups,
      size: off - start
    },
    end: off
  };
}

// Transaction v1 (SIMD-0385, on mainnet since September 2026). Message
// first, signatures at the end, no address lookup tables:
//   0x81 | header (3) | config mask u32 | blockhash (32) | #instructions u8 |
//   #addresses u8 | addresses (32 each) | config values (by mask) |
//   instruction headers (program index u8, #accounts u8, data length u16) |
//   each instruction's account indexes then data | signatures (64 each,
//   as many as the header's required signatures, no length prefix).
// Layout from Anza's solana-message crate (versions/v1/message.rs).
const V1_PREFIX = 0x81;
const CFG_PRIORITY_FEE = 0b11; // u64
const CFG_COMPUTE_UNIT_LIMIT = 0b100; // u32
const CFG_LOADED_ACCOUNTS_DATA_SIZE = 0b1000; // u32
const CFG_HEAP_SIZE = 0b10000; // u32
const CFG_KNOWN = CFG_PRIORITY_FEE | CFG_COMPUTE_UNIT_LIMIT | CFG_LOADED_ACCOUNTS_DATA_SIZE | CFG_HEAP_SIZE;

function parseV1(buf, off) {
  const start = off;
  need(buf, off, 1 + 3 + 4 + 32 + 2);
  off += 1; // version prefix
  const numSigners = buf[off];
  off += 3;
  const mask = buf.readUInt32LE(off);
  off += 4;
  if (mask & ~CFG_KNOWN) throw new ShredParseError(`v1 transaction with unknown config bits (${mask})`);
  const pf = mask & CFG_PRIORITY_FEE;
  if (pf !== 0 && pf !== CFG_PRIORITY_FEE) throw new ShredParseError('v1 transaction with a malformed priority fee mask');
  off += 32; // blockhash
  const nIx = buf[off];
  const nAddr = buf[off + 1];
  off += 2;
  need(buf, off, nAddr * 32);
  const staticKeys = [];
  for (let i = 0; i < nAddr; i++) staticKeys.push(buf.subarray(off + i * 32, off + i * 32 + 32));
  off += nAddr * 32;
  const cfgLen = (pf ? 8 : 0) + (mask & CFG_COMPUTE_UNIT_LIMIT ? 4 : 0) + (mask & CFG_LOADED_ACCOUNTS_DATA_SIZE ? 4 : 0) + (mask & CFG_HEAP_SIZE ? 4 : 0);
  need(buf, off, cfgLen);
  off += cfgLen;
  need(buf, off, nIx * 4);
  const headers = [];
  for (let i = 0; i < nIx; i++) {
    headers.push({ programIdIndex: buf[off], nAcc: buf[off + 1], dataLen: buf.readUInt16LE(off + 2) });
    off += 4;
  }
  const instructions = [];
  for (const h of headers) {
    need(buf, off, h.nAcc + h.dataLen);
    const accounts = Array.from(buf.subarray(off, off + h.nAcc));
    off += h.nAcc;
    const data = buf.subarray(off, off + h.dataLen);
    off += h.dataLen;
    instructions.push({ programIdIndex: h.programIdIndex, accounts, data });
  }
  need(buf, off, numSigners * 64);
  const firstSig = numSigners > 0 ? buf.subarray(off, off + 64) : null;
  off += numSigners * 64;
  return {
    tx: {
      signature: firstSig ? bs58.encode(firstSig) : null,
      numSigners,
      version: 1,
      staticKeys,
      instructions,
      lookups: [],
      size: off - start
    },
    end: off
  };
}

/**
 * The transactions in a ShredStream entries message that are SIGNED by
 * `signerBytes` (a 32-byte Buffer). Messages that don't contain those bytes
 * at all are skipped without parsing. Returns [] for nothing relevant.
 */
function signedTransactions(entriesBuf, signerBytes) {
  // One signer (Buffer) or several (Buffer[]): transactions signed by any.
  const signers = Array.isArray(signerBytes) ? signerBytes : [signerBytes];
  if (!entriesBuf || !signers.some((b) => entriesBuf.indexOf(b) !== -1)) return [];
  const out = [];
  let off = 0;
  need(entriesBuf, off, 8);
  const nEntries = Number(entriesBuf.readBigUInt64LE(off));
  off += 8;
  for (let e = 0; e < nEntries; e++) {
    need(entriesBuf, off, 8 + 32 + 8);
    off += 8 + 32; // num_hashes, hash
    const nTx = Number(entriesBuf.readBigUInt64LE(off));
    off += 8;
    for (let t = 0; t < nTx; t++) {
      const { tx, end } = parseTransaction(entriesBuf, off);
      off = end;
      for (let s = 0; s < tx.numSigners && s < tx.staticKeys.length; s++) {
        if (signers.some((b) => tx.staticKeys[s].equals(b))) {
          out.push(tx);
          break;
        }
      }
    }
  }
  return out;
}

/**
 * All of a transaction's account keys as base58 strings, in Solana's order:
 * static keys, then every lookup table's writable entries, then every lookup
 * table's read-only entries. `tables` maps a table address (base58) to its
 * address list (base58[]); returns null if a needed table is missing or too
 * short (the caller fetches it and retries).
 */
function resolveKeys(tx, tables) {
  const keys = tx.staticKeys.map((k) => bs58.encode(k));
  if (!tx.lookups.length) return keys;
  const readonly = [];
  for (const l of tx.lookups) {
    const addrs = tables.get(bs58.encode(l.key));
    if (!addrs) return null;
    for (const i of l.writable) {
      if (i >= addrs.length) return null;
      keys.push(addrs[i]);
    }
    for (const i of l.readonly) {
      if (i >= addrs.length) return null;
      readonly.push(addrs[i]);
    }
  }
  return keys.concat(readonly);
}

/**
 * A transaction already decoded by the provider (Shreder's protobuf
 * Transaction: signatures, message { header, account_keys, instructions,
 * versioned, address_table_lookups, config }) in the same shape
 * parseTransaction returns. Field names as proto-loader gives them with
 * keepCase (snake_case); bytes as Buffers.
 */
function fromDecoded(t) {
  const m = t && t.message;
  if (!m || !m.header) throw new ShredParseError('transaction without a message');
  const buf = (x) => (Buffer.isBuffer(x) ? x : Buffer.from(x || []));
  const staticKeys = (m.account_keys || []).map(buf);
  for (const k of staticKeys) if (k.length !== 32) throw new ShredParseError(`account key of ${k.length} bytes`);
  let size = staticKeys.length * 32;
  const instructions = (m.instructions || []).map((ix) => {
    const data = buf(ix.data);
    const accounts = Array.from(buf(ix.accounts));
    size += 2 + accounts.length + data.length;
    return { programIdIndex: Number(ix.program_id_index) || 0, accounts, data };
  });
  const lookups = (m.address_table_lookups || []).map((l) => {
    const key = buf(l.account_key);
    if (key.length !== 32) throw new ShredParseError(`lookup table key of ${key.length} bytes`);
    return { key, writable: Array.from(buf(l.writable_indexes)), readonly: Array.from(buf(l.readonly_indexes)) };
  });
  const sigs = (t.signatures || []).map(buf);
  const first = sigs[0];
  return {
    signature: first && first.length === 64 ? bs58.encode(first) : null,
    numSigners: Number(m.header.num_required_signatures) || 0,
    version: m.config ? 1 : m.versioned ? 0 : 'legacy',
    staticKeys,
    instructions,
    lookups,
    size: size + sigs.length * 64
  };
}

module.exports = { parseTransaction, signedTransactions, resolveKeys, fromDecoded, readCompactU16, ShredParseError };
