// src/rateLimiter.js
//
// Keeps the bot's RPC calls under your RPC plan's requests-per-second limit
// (RPC_MAX_RPS), so the provider doesn't start refusing calls ("429 Too Many
// Requests") at the moment a trade needs them.
//
// Calls are spaced EVENLY: at RPC_MAX_RPS=8, one call every 125 ms, never
// several at the same instant. Providers such as Helius count in slices
// shorter than a second, so a burst of 8 calls in the same millisecond can
// be refused even though it's under "10 per second". (Spacing also means no
// one-second window can ever hold more than RPC_MAX_RPS calls.)
//
// Two priorities: "high" (anything on the trading path: reading the copy
// wallet's trades, buying, selling, confirming) always goes first; "low"
// (background work: coin info lookups, token-account cleanup, balance
// checks) only uses spare capacity.

function createLimiter(maxPerSecond) {
  const unlimited = !(maxPerSecond > 0);
  const gapMs = unlimited ? 0 : 1000 / maxPerSecond; // RPC_MAX_RPS=0.5: one call every 2 s
  let nextAt = 0; // earliest time the next call may start
  const queues = { high: [], low: [] };
  let timer = null;

  function pump() {
    timer = null;
    const now = Date.now();
    if (now >= nextAt && (queues.high.length || queues.low.length)) {
      const next = queues.high.length ? queues.high.shift() : queues.low.shift();
      nextAt = Math.max(now, nextAt) + gapMs;
      next();
    }
    if (queues.high.length || queues.low.length) {
      // Not unref'd: it only exists while calls are waiting, and those must run.
      timer = setTimeout(pump, Math.max(1, Math.ceil(nextAt - Date.now())));
    }
  }

  /** Resolves when this call may go out. */
  function acquire(priority = 'high') {
    if (unlimited) return Promise.resolve();
    return new Promise((resolve) => {
      (priority === 'low' ? queues.low : queues.high).push(resolve);
      if (!timer) pump();
    });
  }

  function pending() {
    return queues.high.length + queues.low.length;
  }

  return { acquire, pending };
}

module.exports = { createLimiter };
