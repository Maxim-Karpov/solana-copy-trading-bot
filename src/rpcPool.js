// src/rpcPool.js
//
// Optional multi-endpoint RPC failover. Off by default: with no
// SOLANA_RPC_FALLBACKS configured, every function here is a zero-overhead
// passthrough to a single Connection against config.SOLANA_RPC — identical
// behavior to before this module existed.
//
// Set SOLANA_RPC_FALLBACKS to a comma-separated list of additional RPC HTTP
// URLs to enable failover. Suitable providers (all offer a plain HTTP RPC
// endpoint on a free/low tier): Helius, QuickNode, Triton, Chainstack, Ankr,
// or as a last resort the public https://api.mainnet-beta.solana.com
// endpoint — low rate limits and no reliable websocket support, so it's
// fine as a rarely-used HTTP fallback but a poor choice for SOLANA_RPC
// itself or for the trade-detection websocket feed.
const { Connection } = require('@solana/web3.js');
const config = require('./config');
const { warn, info, redactUrl } = require('./logger');
const { withTimeout } = require('./timeouts');
const { createLimiter } = require('./rateLimiter');
const usageStats = require('./usageStats');

// Stay under the RPC plan's requests-per-second limit (see rateLimiter.js).
const limiter = createLimiter(config.RPC_MAX_RPS);
let last429WarnAt = 0;

// Upper bound on any single RPC call made through withFailover(), so one
// hung request can't stall a confirmation check or balance lookup forever.
const RPC_CALL_TIMEOUT_MS = 15000;

function deriveWsUrl(httpUrl) {
  if (httpUrl.startsWith('https://')) return 'wss://' + httpUrl.slice('https://'.length);
  if (httpUrl.startsWith('http://')) return 'ws://' + httpUrl.slice('http://'.length);
  return null;
}

// Endpoint list: primary (SOLANA_RPC) first, then any configured fallbacks,
// in the order given. Each Connection is created lazily on first use.
const endpoints = [config.SOLANA_RPC, ...(config.SOLANA_RPC_FALLBACKS || [])].map((httpUrl) => ({
  httpUrl,
  wsUrl: httpUrl === config.SOLANA_RPC ? config.SOLANA_WS : deriveWsUrl(httpUrl),
  connection: null
}));

let currentIndex = 0;

function current() {
  return endpoints[currentIndex];
}

/** The live Connection for whichever endpoint is currently active. */
/** Count every HTTP request a connection makes, by method, for the [Usage] log line. */
function countRequests(conn) {
  if (typeof conn._rpcRequest === 'function') {
    const orig = conn._rpcRequest;
    conn._rpcRequest = function (method, args) {
      usageStats.countRpc(method);
      return orig.call(this, method, args);
    };
  }
  if (typeof conn._rpcBatchRequest === 'function') {
    const origBatch = conn._rpcBatchRequest;
    conn._rpcBatchRequest = function (requests) {
      for (const r of requests || []) usageStats.countRpc(r && r.methodName ? r.methodName : 'batch');
      return origBatch.call(this, requests);
    };
  }
  return conn;
}

/**
 * The live Connection for whichever endpoint is currently active. Reads
 * default to 'confirmed'; the direct trade builders ask for 'processed', so
 * a quote already includes trades only just made (the copy wallet's own
 * buy, in processed detection mode) instead of a state ~1s old.
 */
function getConnection(commitment = 'confirmed') {
  const ep = current();
  if (!ep.connections) ep.connections = {};
  if (!ep.connections[commitment]) {
    // disableRetryOnRateLimit: when the provider says "too many requests",
    // the library would otherwise silently retry up to 5 times per call,
    // multiplying the load exactly when it's already too high. The bot's
    // own logic decides what's worth retrying.
    ep.connections[commitment] = countRequests(new Connection(ep.httpUrl, { commitment, disableRetryOnRateLimit: true }));
  }
  if (commitment === 'confirmed') ep.connection = ep.connections.confirmed;
  return ep.connections[commitment];
}

/** The websocket URL for whichever endpoint is currently active. */
function getWsUrl() {
  return current().wsUrl;
}

/** The HTTP RPC URL for whichever endpoint is currently active. */
function getHttpUrl() {
  return current().httpUrl;
}

function hasFallbacks() {
  return endpoints.length > 1;
}

/**
 * Move to the next configured endpoint (wraps around). No-op if only one
 * endpoint is configured. Returns true if it actually switched.
 */
function rotate() {
  if (endpoints.length <= 1) return false;
  const prevUrl = current().httpUrl;
  currentIndex = (currentIndex + 1) % endpoints.length;
  warn(`[RpcPool] Rotating RPC endpoint: ${redactUrl(prevUrl)} -> ${redactUrl(current().httpUrl)}`);
  return true;
}

/**
 * Run `asyncFn(connection)` against the current endpoint. On failure, and
 * only if other endpoints are configured, rotate through them and retry
 * once per endpoint before giving up and throwing the last error. With no
 * fallbacks configured this is equivalent to `asyncFn(getConnection())`.
 */
async function withFailover(asyncFn, timeoutMs = RPC_CALL_TIMEOUT_MS, { priority = 'high' } = {}) {
  let lastErr;
  const attempts = endpoints.length;
  for (let i = 0; i < attempts; i++) {
    await limiter.acquire(priority);
    try {
      return await withTimeout(Promise.resolve().then(() => asyncFn(getConnection())), timeoutMs, 'RPC call');
    } catch (err) {
      lastErr = err;
      const refused = /\b429\b|Too Many Requests/i.test(err && err.message);
      if (refused) usageStats.countRefused();
      if (refused && Date.now() - last429WarnAt > 30_000) {
        last429WarnAt = Date.now();
        warn(
          `[RpcPool] Your RPC provider is refusing calls: too many requests per second for your plan ` +
            `(RPC_MAX_RPS is ${config.RPC_MAX_RPS || 'unlimited'}). Lower RPC_MAX_RPS, or use a plan with a higher limit.`
        );
      }
      if (i < attempts - 1) {
        warn(`[RpcPool] Call failed on ${redactUrl(current().httpUrl)} (${err.message}); trying next endpoint...`);
        rotate();
      }
    }
  }
  throw lastErr;
}

if (hasFallbacks()) {
  info(`[RpcPool] RPC failover enabled with ${endpoints.length} endpoints (primary: ${redactUrl(endpoints[0].httpUrl)}).`);
}

module.exports = { getConnection, getWsUrl, getHttpUrl, hasFallbacks, rotate, withFailover };
