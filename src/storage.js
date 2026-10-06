// src/storage.js
//
// Flat-file position store: data/positions.json, written synchronously.
// Two safety properties matter here:
//   - Writes are atomic (write a temp file, then rename over the real one),
//     so a crash or power cut mid-write can never leave a half-written file.
//   - A file that exists but can't be parsed is an ERROR, not "no positions".
//     Silently starting from empty would forget every open position and then
//     overwrite the file on the next buy.
//
// Speed: the bot is the only writer, so the data is read once and kept in
// memory; every change rewrites only what positions.json holds, which is the
// OPEN positions. Closed ones move to data/positions-closed.jsonl (one JSON
// line each, appended) a few minutes after they close, and coins the copy
// wallets have exited go to data/exited-mints.txt (one per line, appended).
// Before, every save re-read and rewrote the whole history, blocking the bot
// for longer the longer it had been trading.
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const getTimestamp = require('../utils/getTimestamp');

const filePath = path.join(__dirname, '../data/positions.json');
const tmpPath = filePath + '.tmp';
const archivePath = path.join(path.dirname(filePath), 'positions-closed.jsonl');
const exitedPath = path.join(path.dirname(filePath), 'exited-mints.txt');
const pendingBuysPath = path.join(path.dirname(filePath), 'pending-buys.json');
// Closed positions stay in positions.json this long (the PnL is filled in
// just after a close) before moving to the archive.
const ARCHIVE_AFTER_MS = 5 * 60 * 1000;

let cache = null; // the positions.json object, once read
let exitedCache = null; // exited mints, in order (Set keeps insertion order)

class StorageCorruptError extends Error {}

/** Read the entire JSON from disk. Missing file -> { positions: [] }. */
function readData() {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    if (err.code === 'ENOENT') return { positions: [] };
    throw err;
  }
  let json;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new StorageCorruptError(
      `${filePath} is not valid JSON (${err.message}). Fix it by hand, or delete it to start fresh ` +
        `(deleting it makes the bot forget any positions it still has open).`
    );
  }
  if (!json || typeof json !== 'object' || !Array.isArray(json.positions)) {
    throw new StorageCorruptError(`${filePath} does not contain a { "positions": [...] } object.`);
  }
  return json;
}

/** The data, read from disk the first time. */
function load() {
  if (!cache) cache = readData();
  return cache;
}

/** Atomically write the entire data object back to disk. */
function writeData(data) {
  cache = data;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
  // On Windows the swap can briefly fail if something else (an editor, an
  // antivirus scan) has the file open; retry for up to ~1s. Never happens on Linux.
  for (let attempt = 1; ; attempt++) {
    try {
      fs.renameSync(tmpPath, filePath);
      return;
    } catch (err) {
      if (attempt >= 20 || !['EPERM', 'EACCES', 'EBUSY'].includes(err.code)) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
}

/**
 * Ensure data/positions.json exists and is readable (throws if corrupt), then
 * move closed positions and exited coins out of it (older versions kept
 * everything in this one file).
 */
function initStorage() {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  cache = null;
  exitedCache = null;
  if (!fs.existsSync(filePath)) {
    writeData({ positions: [] });
    return;
  }
  const data = readData(); // throws StorageCorruptError with instructions if unreadable
  cache = data;
  let changed = false;
  if (Array.isArray(data.exitedMints)) {
    const old = data.exitedMints;
    delete data.exitedMints;
    const have = new Set(getExitedMints());
    const add = old.filter((m) => typeof m === 'string' && !have.has(m));
    if (add.length) fs.appendFileSync(exitedPath, add.join('\n') + '\n', 'utf-8');
    exitedCache = null;
    changed = true;
  }
  if (archiveClosed(0, { write: false }) > 0) changed = true;
  if (changed) writeData(data);
}

/**
 * Move positions closed at least `olderThanMs` ago to the archive file.
 * Returns how many moved.
 */
function archiveClosed(olderThanMs = ARCHIVE_AFTER_MS, { write = true } = {}) {
  const data = load();
  const now = Date.now();
  const keep = [];
  const move = [];
  for (const p of data.positions) {
    if (p.status !== 'closed') {
      keep.push(p);
      continue;
    }
    const at = Date.parse(p.closed_at || '');
    if (olderThanMs > 0 && Number.isFinite(at) && now - at < olderThanMs) keep.push(p);
    else move.push(p);
  }
  if (!move.length) return 0;
  // Archive first: a crash in between leaves a duplicate line, never a loss.
  fs.appendFileSync(archivePath, move.map((p) => JSON.stringify(p)).join('\n') + '\n', 'utf-8');
  data.positions = keep;
  if (write) writeData(data);
  return move.length;
}

/** Closed positions from the archive file (unreadable lines skipped). */
function readArchive() {
  let raw = '';
  try {
    raw = fs.readFileSync(archivePath, 'utf-8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {}
  }
  return out;
}

/**
 * Add a new open position. Any extra fields passed in are stored as-is.
 * Numeric fields use `??` (not `||`) so a legitimate 0 — e.g.
 * TRAILING_STOP_ACTIVATION=0 — is kept rather than turned into null.
 */
function addPosition(positionData) {
  const data = load();

  const newPosition = {
    id: uuidv4(),
    time: getTimestamp(),
    ...positionData,
    status: 'active',
    // Remaining cost basis in SOL (actual SOL spent incl. fees/tip when
    // measurable) — reduced proportionally by partial sells (STIERED).
    cost_basis_sol: positionData.cost_basis_sol ?? positionData.buy_amount,
    current_price: positionData.current_price ?? positionData.entry_price,
    parent_signature: positionData.parent_signature ?? null,
    stop_loss_pct: positionData.stop_loss_pct ?? null,
    take_profit_pct: positionData.take_profit_pct ?? null,

    // Trailing Stop Loss fields
    highest_price: positionData.highest_price ?? positionData.entry_price, // highest price reached
    trailing_stop_price: null,                                              // current trailing stop price
    trailing_stop_activated: false,                                         // whether trailing stop is active
    trailing_stop_distance: positionData.trailing_stop_distance ?? null,
    trailing_stop_activation: positionData.trailing_stop_activation ?? null
  };

  data.positions.push(newPosition);
  writeData(data);
  return newPosition;
}

/** Return all positions (active + closed, archived ones included). */
function getAllPositions() {
  const archived = readArchive();
  const ids = new Set(load().positions.map((p) => p.id));
  return [...archived.filter((p) => !ids.has(p.id)), ...load().positions];
}

/** Return only active positions (status === 'active'). */
function getActivePositions() {
  return load().positions.filter((p) => p.status === 'active');
}

/**
 * Update a position by ID (e.g. { current_price: 0.0000025 } or { status: 'closed' }).
 * Throws an error if the ID is not found.
 */
function updatePosition(id, updates) {
  const data = load();
  const idx = data.positions.findIndex((p) => p.id === id);
  if (idx === -1) {
    throw new Error(`Position with id ${id} not found`);
  }
  data.positions[idx] = { ...data.positions[idx], ...updates };
  writeData(data);
  return data.positions[idx];
}

/**
 * Apply several partial updates in a single read+write pass instead of one
 * read+write per position. `entries` is an array of { id, updates }.
 * Unknown ids are silently skipped (e.g. a position was closed/removed by
 * another code path earlier in the same tick).
 */
function updatePositionsBatch(entries) {
  if (!entries || entries.length === 0) return;

  const data = load();
  const idxById = new Map(data.positions.map((p, idx) => [p.id, idx]));

  for (const { id, updates } of entries) {
    const idx = idxById.get(id);
    if (idx === undefined) continue;
    data.positions[idx] = { ...data.positions[idx], ...updates };
  }

  writeData(data);
}

/**
 * Coins the copy wallets have exited (see SKIP_REBUYS), one per line in
 * data/exited-mints.txt so the list survives restarts. Appending a line is
 * all an exit costs; the file is trimmed to the newest EXITED_MINTS_CAP
 * entries at startup.
 */
const EXITED_MINTS_CAP = 5000;

function getExitedMints() {
  if (exitedCache) return [...exitedCache];
  let raw = '';
  try {
    raw = fs.readFileSync(exitedPath, 'utf-8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  exitedCache = new Set(raw.split('\n').map((l) => l.trim()).filter(Boolean));
  if (exitedCache.size > EXITED_MINTS_CAP) {
    exitedCache = new Set([...exitedCache].slice(-EXITED_MINTS_CAP));
    const tmp = exitedPath + '.tmp';
    fs.writeFileSync(tmp, [...exitedCache].join('\n') + '\n', 'utf-8');
    fs.renameSync(tmp, exitedPath);
  }
  return [...exitedCache];
}

function addExitedMint(mint) {
  if (!exitedCache) getExitedMints();
  if (exitedCache.has(mint)) return;
  exitedCache.add(mint);
  fs.appendFileSync(exitedPath, mint + '\n', 'utf-8');
}

/** Whether new buys are paused (see /pause in Telegram). Survives restarts. */
function getPaused() {
  return load().paused === true;
}

function setPaused(paused) {
  const data = load();
  data.paused = Boolean(paused);
  writeData(data);
}

/** The DCA_SELLING mode chosen in Telegram ('instant' | 'even' | 'left'), or null if none was. Survives restarts. */
function getDcaMode() {
  const m = load().dcaMode;
  return m === 'instant' || m === 'even' || m === 'left' ? m : null;
}

function setDcaMode(mode) {
  const data = load();
  data.dcaMode = mode;
  writeData(data);
}

// ---- buys sent but not yet recorded as positions ----
// If the bot stops between sending a buy and saving its position, the tokens
// are in the wallet with nothing tracking them. Each sent buy is noted here
// (one small file, written after the send) and dropped once its position is
// saved or the buy is known to have failed; whatever is left at the next
// start (or sweep) is checked on-chain and recovered.
let pendingBuysCache = null;

function pendingBuys() {
  if (!pendingBuysCache) {
    try {
      const list = JSON.parse(fs.readFileSync(pendingBuysPath, 'utf-8'));
      pendingBuysCache = Array.isArray(list) ? list : [];
    } catch {
      pendingBuysCache = [];
    }
  }
  return pendingBuysCache;
}

function writePendingBuys() {
  const tmp = pendingBuysPath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(pendingBuysCache), 'utf-8');
  fs.renameSync(tmp, pendingBuysPath);
}

function addPendingBuy(rec) {
  const list = pendingBuys();
  if (list.some((r) => r.signature === rec.signature)) return;
  list.push(rec);
  if (list.length > 200) list.shift();
  writePendingBuys();
}

function removePendingBuy(signature) {
  const list = pendingBuys();
  const i = list.findIndex((r) => r.signature === signature);
  if (i === -1) return;
  list.splice(i, 1);
  writePendingBuys();
}

function getPendingBuys() {
  return pendingBuys().slice();
}

module.exports = {
  addPendingBuy,
  removePendingBuy,
  getPendingBuys,
  initStorage,
  getPaused,
  setPaused,
  getDcaMode,
  setDcaMode,
  getExitedMints,
  addExitedMint,
  addPosition,
  getAllPositions,
  getActivePositions,
  updatePosition,
  updatePositionsBatch,
  archiveClosed,
  StorageCorruptError,
  filePath,
  archivePath,
  exitedPath
};
