// src/feedRace.js
//
// With several shred sources running side by side (SHRED_SOURCE="shreder,
// helius-preprocessed"), which one reports each of the copy wallets'
// transactions first, and by how much. Times are taken the moment each
// source's message reaches the bot (same process, same clock), before any
// decoding, so the comparison is fair.
//
// One line per transaction:
//   [Race] 5Kx9…aB3d (slot 371234567): Shreder first, Helius +18.4 ms
// and a summary every USAGE_LOG_MIN minutes (and at shutdown).

const { performance } = require('perf_hooks');
const logger = require('./logger');

const LABELS = { shreder: 'Shreder', 'helius-preprocessed': 'Helius', 'jito-grpc': 'Jito gRPC' };
const SETTLE_MS = 10_000; // how long to wait for the slower source(s)
const KEEP = 5_000; // leads kept per source for the summary

function label(source) {
  return LABELS[source] || source;
}

function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function ms(x) {
  return x >= 100 ? `${Math.round(x)} ms` : `${x.toFixed(1)} ms`;
}

class FeedRace {
  constructor(sources, { log = (m) => logger.info(m), settleMs = SETTLE_MS } = {}) {
    this.sources = [...sources];
    this.log = log;
    this.settleMs = settleMs;
    this.pending = new Map(); // signature -> { slot, seen: Map(source -> time), timer }
    this.totals = this._empty();
    this.window = this._empty();
    this.windowSince = Date.now();
  }

  _empty() {
    return { both: 0, leads: new Map(this.sources.map((s) => [s, []])), wins: new Map(this.sources.map((s) => [s, 0])), only: new Map(this.sources.map((s) => [s, 0])) };
  }

  /** `source` delivered the copy wallet's transaction `signature` at `at` (performance.now()). */
  note(source, signature, at = performance.now(), slot = null) {
    if (!signature) return;
    let p = this.pending.get(signature);
    if (!p) {
      p = { slot, seen: new Map([[source, at]]), timer: null };
      this.pending.set(signature, p);
      p.timer = setTimeout(() => this._settle(signature), this.settleMs);
      if (p.timer.unref) p.timer.unref();
      return;
    }
    if (p.seen.has(source)) return; // a duplicate from the same source
    p.seen.set(source, at);
    if (p.slot === null && slot !== null) p.slot = slot;
    if (p.seen.size >= this.sources.length) {
      clearTimeout(p.timer);
      // Not in the way of the buy the first report started.
      setImmediate(() => this._settle(signature));
    }
  }

  _settle(signature) {
    const p = this.pending.get(signature);
    if (!p) return;
    this.pending.delete(signature);
    clearTimeout(p.timer);
    const order = [...p.seen.entries()].sort((a, b) => a[1] - b[1]);
    const [first, t1] = order[0];
    const short = `${signature.slice(0, 4)}…${signature.slice(-4)}`;
    const where = p.slot !== null && p.slot !== undefined ? ` (slot ${p.slot})` : '';
    if (order.length < 2) {
      for (const w of [this.totals, this.window]) w.only.set(first, (w.only.get(first) || 0) + 1);
      const missing = this.sources.filter((s) => s !== first).map(label).join(', ');
      this.log(`[Race] ${short}${where}: only ${label(first)} reported it (nothing from ${missing} within ${Math.round(this.settleMs / 1000)}s)`);
      return;
    }
    const lead = order[1][1] - t1;
    for (const w of [this.totals, this.window]) {
      w.both += 1;
      w.wins.set(first, (w.wins.get(first) || 0) + 1);
      const l = w.leads.get(first);
      l.push(lead);
      if (l.length > KEEP) l.shift();
    }
    const rest = order
      .slice(1)
      .map(([s, t]) => `${label(s)} +${ms(t - t1)}`)
      .join(', ');
    this.log(`[Race] ${short}${where}: ${label(first)} first, ${rest}`);
  }

  /** "Shreder first in 14 of 17 (median lead 21.3 ms), Helius first in 3 (median lead 2.1 ms); only Shreder: 1" */
  describe(w = this.totals) {
    if (!w.both && ![...w.only.values()].some(Boolean)) return 'no copy-wallet transactions yet';
    const parts = [];
    for (const s of this.sources) {
      const n = w.wins.get(s) || 0;
      const med = median(w.leads.get(s) || []);
      parts.push(`${label(s)} first in ${n} of ${w.both}${med !== null ? ` (median lead ${ms(med)}, best ${ms(Math.max(...w.leads.get(s)))})` : ''}`);
    }
    const only = this.sources.filter((s) => w.only.get(s)).map((s) => `only ${label(s)}: ${w.only.get(s)}`);
    return parts.join(', ') + (only.length ? `; ${only.join(', ')}` : '');
  }

  /** The summary line for the period since the last one; `final` = the whole run. */
  logSummary(final = false) {
    if (final) {
      for (const sig of [...this.pending.keys()]) this._settle(sig);
      this.log(`[Race] Whole run: ${this.describe(this.totals)}.`);
      return;
    }
    const minutes = Math.max(1, Math.round((Date.now() - this.windowSince) / 60_000));
    if (this.window.both || [...this.window.only.values()].some(Boolean)) {
      this.log(`[Race] Last ${minutes} min: ${this.describe(this.window)}.`);
    }
    this.window = this._empty();
    this.windowSince = Date.now();
  }

  stop() {
    for (const p of this.pending.values()) clearTimeout(p.timer);
  }
}

module.exports = { FeedRace, label, median };
