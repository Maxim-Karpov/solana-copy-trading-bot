// src/dcaSell.js
//
// DCA_SELLING: how a position bought with INSTANT_SELL on is sold.
//
//   instant   the whole position at once (the usual instant sell)
//   even      DCA_FIRST_PCT % of it at once, then the rest in DCA_SLICES equal parts
//   left      DCA_FIRST_PCT % at once, then DCA_LEFT_PCT % of what is left each time;
//             the last slice sells whatever remains, so nothing is left behind
//
// The slices are spread evenly over DCA_SECONDS and go out through Jito with
// DCA_TIP and DCA_PRIORITY_FEE_SOL (cheap on purpose; see index.js for the
// runner). This file only holds the arithmetic and the mode setting.

const config = require('./config');

const MODES = ['instant', 'even', 'left'];

/** The mode in force: 'instant' | 'even' | 'left'. */
function mode() {
  return MODES.includes(config.DCA_SELLING) ? config.DCA_SELLING : 'instant';
}

/** Whether positions are sold in parts (needs INSTANT_SELL). */
function active() {
  return mode() !== 'instant' && config.INSTANT_SELL === true;
}

function setMode(m) {
  const key = String(m || '').trim().toLowerCase().replace(/^dca[_\s-]*/, '');
  if (!MODES.includes(key)) return false;
  config.DCA_SELLING = key;
  return true;
}

function label(m = mode()) {
  return m === 'even' ? 'DCA_even' : m === 'left' ? 'DCA_left' : 'instant';
}

/** Share (%) of the position the first, immediate sell takes. */
function firstPct() {
  return config.DCA_FIRST_PCT;
}

/**
 * Share (%) of what is CURRENTLY held that slice `index` (1-based, of `total`)
 * sells. even: 1/(slices left), so every slice is the same size and the last
 * takes all that is left. left: DCA_LEFT_PCT % each time, the last takes the rest.
 */
function slicePct(m, index, total, leftPct = config.DCA_LEFT_PCT) {
  if (index >= total) return 100;
  if (m === 'left') return leftPct;
  return 100 / (total - index + 1);
}

/** Milliseconds from the start to slice `index` (1-based): evenly spread, the last at DCA_SECONDS. */
function offsetMs(index, total = config.DCA_SLICES, seconds = config.DCA_SECONDS) {
  return Math.round((index * seconds * 1000) / total);
}

/** The whole plan as percentages of the ORIGINAL amount (for logs and tests). */
function plan(m = mode(), total = config.DCA_SLICES, first = config.DCA_FIRST_PCT, leftPct = config.DCA_LEFT_PCT) {
  const parts = [first];
  let left = 100 - first;
  for (let i = 1; i <= total; i++) {
    const p = (left * slicePct(m, i, total, leftPct)) / 100;
    parts.push(p);
    left -= p;
  }
  return parts;
}

module.exports = { MODES, mode, active, setMode, label, firstPct, slicePct, offsetMs, plan };
