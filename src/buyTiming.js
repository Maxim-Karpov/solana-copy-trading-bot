// src/buyTiming.js
//
// For buys copied early from the shred stream: how long each step took, how
// far into the copy wallet's slot we saw his trade and sent ours, and where
// ours landed. Keeps a running same-block rate for the run, so changes to
// fees, tips, compute budget or the server can be judged by results.

const slotClock = require('./slotClock');
const leaderInfo = require('./leaderInfo');

// Times from the Rust fast path have fractions of a millisecond.
const fmt = (x) => (typeof x === 'number' && !Number.isInteger(x) ? (x < 10 ? x.toFixed(2) : x.toFixed(1)) : x);

const rnd = (x) => (typeof x === 'number' ? Math.round(x) : x);

const runs = []; // { outcome, sentInto, seenToSentMs, band }
let skippedFar = 0; // buys not sent: the slot leader was too far (LEADER_MAX_KM)

const median = (xs) => {
  const v = xs.filter((x) => typeof x === 'number').sort((a, b) => a - b);
  return v.length ? v[Math.floor(v.length / 2)] : null;
};

/**
 * Record one shred buy and return the log line describing it.
 * @param r.outcome  - 'same' (in his block) | 'late' (later slot; cancelled by
 *                     the slot guard or landed late) | 'failed' (in his block
 *                     but failed, e.g. slippage) | 'unknown' (never confirmed)
 * @param r.hisSlot, r.ourSlot - slots (ourSlot may be null)
 * @param r.seenAt   - when the bot received his transaction
 * @param r.decideAt - when the bot started building
 * @param r.timing   - { buildMs, sendMs, sentAt } from tradeExecutor
 * @param r.leader   - leaderInfo.leaderOf(hisSlot), or null
 * @param r.marks    - performance.now() at each step: { t0, parsed, keys, tablesFetched, emit, handler, decide }
 */
function record({ mint, outcome, hisSlot, ourSlot, seenAt, decideAt, timing, failure = '', leader = null, marks = null }) {
  const sentAt = timing && timing.sentAt;
  const seenInto = typeof hisSlot === 'number' && seenAt ? rnd(slotClock.msInto(hisSlot, seenAt)) : null;
  const sentInto = typeof hisSlot === 'number' && sentAt ? rnd(slotClock.msInto(hisSlot, sentAt)) : null;
  const est = typeof hisSlot === 'number' && slotClock.startOf(hisSlot) && slotClock.startOf(hisSlot).estimated;
  const seenToSentMs = sentAt && seenAt ? sentAt - seenAt : null;
  runs.push({ outcome, sentInto, seenToSentMs, band: leaderInfo.band(leader) });
  if (runs.length > 1000) runs.shift(); // the summary covers the last 1000

  const parts = [];
  if (seenInto !== null) {
    parts.push(`his trade reached the bot ${seenInto} ms into his slot${est ? ' (estimated)' : ''}, ours went out at ${sentInto} ms`);
  }
  if (seenToSentMs !== null) {
    const steps = [];
    const split = decidingSteps(marks);
    if (split) steps.push(split);
    else if (decideAt && seenAt) steps.push(`deciding ${decideAt - seenAt}`);
    if (timing && typeof timing.buildMs === 'number') steps.push(`building ${fmt(timing.buildMs)}`);
    parts.push(`${fmt(seenToSentMs)} ms from seeing to sending (${steps.join('; ')} ms; Sender answered in ${fmt(timing.sendMs)} ms)`);
  }
  if (leader) parts.push(leaderInfo.describe(leader));
  const result =
    outcome === 'same'
      ? 'landed in his block'
      : outcome === 'failed'
        ? `landed in his block but failed${failure ? ` (${failure})` : ''}`
        : outcome === 'late'
          ? `${typeof ourSlot === 'number' && typeof hisSlot === 'number' ? `${ourSlot - hisSlot} slot(s)` : 'too'} late`
          : 'never confirmed';
  return `[Timing] ${mint.slice(0, 4)}…${mint.slice(-4)}: ${parts.join('; ')}; ${result}. ${summary()}`;
}

const ms = (x) => (x < 10 ? x.toFixed(1) : String(Math.round(x)));

/**
 * "deciding 54 = reading his tx 41 (fetched a lookup table), handing over 9,
 * checks 4" from the step marks, or null.
 */
function decidingSteps(m) {
  if (!m || typeof m.t0 !== 'number' || typeof m.decide !== 'number') return null;
  const gap = (a, b) => (typeof a === 'number' && typeof b === 'number' ? Math.max(0, b - a) : null);
  const read = gap(m.t0, m.keys);
  const find = gap(m.keys, m.classified);
  const hand = typeof m.classified === 'number' ? gap(m.classified, m.handler) : gap(m.keys, m.handler);
  const checks = gap(m.handler, m.decide);
  const parts = [];
  if (read !== null) parts.push(`reading his tx ${ms(read)}${m.tablesFetched ? ' (had to fetch a lookup table)' : ''}`);
  if (find !== null) parts.push(`finding the coin ${ms(find)}`);
  if (hand !== null) parts.push(`handing over ${ms(hand)}`);
  if (checks !== null) parts.push(`checks ${ms(checks)}`);
  return `deciding ${ms(m.decide - m.t0)}${parts.length ? ` = ${parts.join(', ')}` : ''}`;
}

/** "In his block this run: 3 of 6 (50%) · …" */
function summary() {
  const n = runs.length;
  if (!n) return '';
  const inBlock = runs.filter((r) => r.outcome === 'same' || r.outcome === 'failed');
  const late = runs.filter((r) => r.outcome === 'late');
  const pct = Math.round((100 * inBlock.length) / n);
  let s = `In his block this run: ${inBlock.length} of ${n} (${pct}%)`;
  const m = median(runs.map((r) => r.seenToSentMs));
  if (m !== null) s += `; median seeing→sending ${fmt(m)} ms`;
  const mIn = median(inBlock.map((r) => r.sentInto));
  const mLate = median(late.map((r) => r.sentInto));
  if (mIn !== null && mLate !== null) s += `; sent at median ${mIn} ms into his slot when we made it, ${mLate} ms when we didn't`;
  // Same-block rate by how far away the slot's leader was.
  const bands = new Map();
  for (const r of runs) {
    if (!r.band || r.band === 'unknown') continue;
    const b = bands.get(r.band) || { n: 0, inBlock: 0 };
    b.n += 1;
    if (r.outcome === 'same' || r.outcome === 'failed') b.inBlock += 1;
    bands.set(r.band, b);
  }
  if (bands.size) {
    const order = ['≤100 km', '100–1,500 km', '>1,500 km'];
    s += `; by leader distance: ${order.filter((k) => bands.has(k)).map((k) => `${k} ${bands.get(k).inBlock}/${bands.get(k).n}`).join(', ')}`;
  }
  if (skippedFar) s += `; ${skippedFar} skipped (leader too far)`;
  return s + '.';
}

const rehearsals = []; // seen -> ready-to-send, ms (PAUSED_REHEARSAL)

/**
 * A buy rehearsed while paused (built and signed, not sent): the same timing
 * line as a real buy, up to the moment it would have gone out.
 * @param r.result - { buildMs, signMs, readyAt, label } from buyToken({ dryRun })
 */
function rehearsal({ mint, hisSlot, seenAt, decideAt, result, marks = null, leader = null }) {
  const readyAt = result && result.readyAt;
  const parts = [];
  const seenInto = typeof hisSlot === 'number' && seenAt ? rnd(slotClock.msInto(hisSlot, seenAt)) : null;
  const readyInto = typeof hisSlot === 'number' && readyAt ? rnd(slotClock.msInto(hisSlot, readyAt)) : null;
  const est = typeof hisSlot === 'number' && slotClock.startOf(hisSlot) && slotClock.startOf(hisSlot).estimated;
  if (seenInto !== null) parts.push(`his trade reached the bot ${seenInto} ms into his slot${est ? ' (estimated)' : ''}, ours was ready to send at ${readyInto} ms`);
  const total = readyAt && seenAt ? readyAt - seenAt : null;
  if (total !== null) {
    rehearsals.push(total);
    if (rehearsals.length > 1000) rehearsals.shift();
    const steps = [];
    const split = decidingSteps(marks);
    if (split) steps.push(split);
    else if (decideAt && seenAt) steps.push(`deciding ${decideAt - seenAt}`);
    if (typeof result.buildMs === 'number') steps.push(`building ${fmt(result.buildMs)}`);
    if (typeof result.signMs === 'number') steps.push(`signing ${fmt(result.signMs)}`);
    parts.push(`${fmt(total)} ms from seeing to ready-to-send (${steps.join('; ')} ms)`);
  }
  if (leader) parts.push(leaderInfo.describe(leader));
  const m = median(rehearsals);
  return (
    `[Timing] REHEARSAL (paused, not sent) ${mint.slice(0, 4)}…${mint.slice(-4)}: ${parts.join('; ')}.` +
    (m !== null ? ` Rehearsals this run: ${rehearsals.length}; median seeing→ready ${fmt(m)} ms.` : '')
  );
}

/** A buy not sent because its slot leader was too far away (LEADER_MAX_KM). */
function noteSkipped() {
  skippedFar += 1;
}

function _resetForTests() {
  runs.length = 0;
  rehearsals.length = 0;
  skippedFar = 0;
}

module.exports = { record, rehearsal, summary, noteSkipped, _resetForTests };
