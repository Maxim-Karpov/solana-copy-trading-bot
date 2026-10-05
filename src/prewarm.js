// src/prewarm.js
//
// PREWARM (default on): keeps what every direct trade needs, but which
// rarely changes, fetched in the background, so building a buy or sell
// waits on as few network round trips as possible:
//   - a recent blockhash (refreshed every 20s; a blockhash stays valid for
//     about a minute, and the bot's trades land within seconds),
//   - Pump.fun's global config (refreshed every 60s),
//   - Pump.fun's fee schedule (refreshed every 5 min).
// With these warm, a direct Pump.fun buy needs a single lookup (the coin's
// curve and your token account, in one call), or none at all when it copies
// a buy seen in the processed feed: the copy wallet's trade record already
// says where the coin's curve stands.
//
// Background refreshes go through the rate limiter at low priority, so they
// never delay a trade's own calls. Cost: about 3 calls a minute (~6k Helius
// credits a day). Anything not warm yet is simply fetched on demand.

const config = require('./config');
const rpcPool = require('./rpcPool');
const { info, warn } = require('./logger');

const BLOCKHASH_REFRESH_MS = 15_000; // also keeps the RPC connection open (it closes after 19 s idle)
const BLOCKHASH_MAX_AGE_MS = 45_000; // older than this: fetch a new one on demand
const GLOBAL_REFRESH_MS = 60_000;
const GLOBAL_MAX_AGE_MS = 5 * 60_000;
const FEE_CONFIG_REFRESH_MS = 5 * 60_000; // pumpfunDirect.js keeps it up to 10 min
// A never-sent practice build keeps the buy code compiled and hot between
// trades (Node drops compiled code that sits unused). ~10 ms of CPU each.
const WARM_UP_BUILD_MS = 30_000;

const state = {
  blockhash: null, // { value, at }
  pumpGlobal: null, // { value, at }
  timers: [],
  started: false,
  failures: 0
};

async function refreshBlockhash() {
  // On the connection the trade builders use: every 15 s keeps it open
  // (idle ones close after 19 s), so a sell doesn't start by reconnecting.
  const res = await rpcPool.withFailover(() => rpcPool.getConnection('processed').getLatestBlockhash('confirmed'), 10_000, { priority: 'low' });
  state.blockhash = { value: res.blockhash, at: Date.now() };
}

async function refreshPumpGlobal() {
  const { onlineSdkFor } = require('./pumpfunDirect');
  const value = await rpcPool.withFailover((c) => onlineSdkFor(c).fetchGlobal(), 10_000, { priority: 'low' });
  state.pumpGlobal = { value, at: Date.now() };
}

function every(ms, fn, label) {
  const run = () =>
    fn().catch((err) => {
      state.failures += 1;
      // Nothing breaks: trades fetch what they need themselves meanwhile.
      if (state.failures === 1 || state.failures % 20 === 0) warn(`[Prewarm] Couldn't refresh ${label}: ${err.message} (trades fetch it themselves meanwhile).`);
    });
  const t = setInterval(run, ms);
  if (t.unref) t.unref();
  state.timers.push(t);
  return run();
}

/** Start the background refreshes (no-op if PREWARM=false or already started). */
async function start() {
  if (state.started || !config.PREWARM) return;
  state.started = true;
  const jobs = [every(BLOCKHASH_REFRESH_MS, refreshBlockhash, 'the blockhash')];
  if (config.DIRECT_PUMPFUN_SWAP) {
    jobs.push(every(GLOBAL_REFRESH_MS, refreshPumpGlobal, "Pump.fun's config"));
    // The fee schedule lives in pumpfunDirect.js's own cache; re-read it
    // well before that cache expires, so a trade never has to.
    const pf = require('./pumpfunDirect');
    jobs.push(
      every(
        FEE_CONFIG_REFRESH_MS,
        () => rpcPool.withFailover((c) => pf.warmFeeConfig(c), 10_000, { priority: 'low' }),
        "Pump.fun's fee schedule"
      )
    );
  }
  await Promise.all(jobs);
  let warmMs = null;
  if (config.DIRECT_PUMPFUN_SWAP) {
    const pf = require('./pumpfunDirect');
    const practice = async () => {
      const ms = await pf.warmUpBuild(rpcPool.getConnection('processed')); // null: not warm, skipped
      if (ms !== null) warmMs = ms;
      // SHRED_FAST_BUY's hand-built buy: refresh its template, keep it hot,
      // and check it still matches the SDK's transaction.
      await require('./tradeExecutor').practiceHandBuilt().catch((err) => warn(`[Prewarm] Hand-built buy check failed: ${err.message}`));
    };
    // A few at startup (the compiler needs several runs to optimise the
    // code); the last one is what a warm build costs. Then one every 30 s.
    for (let i = 0; i < 4; i++) await practice().catch(() => {});
    await every(WARM_UP_BUILD_MS, practice, 'the practice build');
  }
  info(
    `[Prewarm] Ready: recent blockhash${config.DIRECT_PUMPFUN_SWAP ? " and Pump.fun's config" : ''} kept warm in the background, ` +
      'so a direct buy needs one lookup (none when copying a buy from the processed feed).' +
      (warmMs !== null ? ` Practice build (never sent): ${warmMs} ms.` : '')
  );
}

function stop() {
  for (const t of state.timers) clearInterval(t);
  state.timers = [];
  state.started = false;
}

/** A recent blockhash if one is warm, else null (the caller fetches one). */
function blockhash() {
  const b = state.blockhash;
  return b && Date.now() - b.at < BLOCKHASH_MAX_AGE_MS ? b.value : null;
}

/** How long ago the current blockhash was fetched (ms), or null. */
function blockhashAgeMs() {
  const b = state.blockhash;
  return b ? Date.now() - b.at : null;
}

/** Pump.fun's global config if warm, else null. */
function pumpGlobal() {
  const g = state.pumpGlobal;
  return g && Date.now() - g.at < GLOBAL_MAX_AGE_MS ? g.value : null;
}

/** For tests: put values in place as if refreshed just now. */
function _setForTests({ blockhash: bh, pumpGlobal: pg } = {}) {
  state.blockhash = bh === undefined ? state.blockhash : bh === null ? null : { value: bh, at: Date.now() };
  state.pumpGlobal = pg === undefined ? state.pumpGlobal : pg === null ? null : { value: pg, at: Date.now() };
}

module.exports = { start, stop, blockhash, blockhashAgeMs, pumpGlobal, _setForTests };
