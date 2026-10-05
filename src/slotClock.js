// src/slotClock.js
//
// When each slot started, as seen from this server (the websocket feed's
// slotSubscribe: one small notification per slot, ~2.5 a second). Used to
// measure how far into the copy wallet's slot we saw his trade and sent
// ours: a buy sent late in his slot can't make his block, however fast the
// bot is, which tells "too slow" apart from "too late to start with".

const MAX_SLOTS = 3000; // ~20 minutes
const SLOT_MS = 400; // target slot time, for estimates

const starts = new Map(); // slot -> ms timestamp (first notification)
let latest = null; // { slot, at }

function record(slot, at = Date.now()) {
  if (typeof slot !== 'number' || starts.has(slot)) return;
  starts.set(slot, at);
  if (!latest || slot > latest.slot) latest = { slot, at };
  if (starts.size > MAX_SLOTS) starts.delete(starts.keys().next().value);
}

/**
 * { at, estimated } for when `slot` started, or null if nothing is known
 * nearby. Exact when its own notification arrived; otherwise estimated from
 * the nearest known slot (within 10 slots) at 400 ms a slot.
 */
function startOf(slot) {
  if (starts.has(slot)) return { at: starts.get(slot), estimated: false };
  for (let d = 1; d <= 10; d++) {
    if (starts.has(slot - d)) return { at: starts.get(slot - d) + d * SLOT_MS, estimated: true };
    if (starts.has(slot + d)) return { at: starts.get(slot + d) - d * SLOT_MS, estimated: true };
  }
  return null;
}

/** ms from the start of `slot` to `t`, or null if unknown. */
function msInto(slot, t) {
  const s = startOf(slot);
  return s ? t - s.at : null;
}

function hasData() {
  return starts.size > 0;
}

function _resetForTests() {
  starts.clear();
  latest = null;
}

/** The newest slot seen, or null. */
function latestSlot() {
  return latest ? latest.slot : null;
}

module.exports = { record, startOf, msInto, hasData, latestSlot, SLOT_MS, _resetForTests };
