// src/timeouts.js
//
// Every network call the bot makes goes through a bounded timeout. Without
// one, a single request that never answers (a stuck TCP connection, an
// overloaded API) can stall whatever is awaiting it indefinitely — e.g. a
// stop-loss sell that never completes.

class TimeoutError extends Error {}

/**
 * Race a promise against a timer. Note the underlying operation isn't
 * cancelled (most SDKs don't support that); we just stop waiting for it.
 */
function withTimeout(promise, ms, label = 'operation') {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Node's built-in fetch (Node 18+) with an abort-based timeout. An optional
 * caller `signal` in options also aborts the request (e.g. on shutdown).
 */
async function fetchWithTimeout(url, options = {}, ms = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  const external = options.signal;
  const onExternalAbort = () => controller.abort();
  if (external) {
    if (external.aborted) controller.abort();
    else external.addEventListener('abort', onExternalAbort, { once: true });
  }
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err.name === 'AbortError' && !(external && external.aborted)) {
      throw new TimeoutError(`Request to ${new URL(url).host} timed out after ${ms}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
    if (external) external.removeEventListener('abort', onExternalAbort);
  }
}

/**
 * fetch + read the whole body, all under ONE timeout. fetchWithTimeout alone
 * only bounds the wait for response headers — a server that sends headers
 * and then stalls would hang a later res.json() forever. Returns
 * { ok, status, statusText, data (parsed JSON or null), text }.
 */
async function fetchJson(url, options = {}, ms = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  const external = options.signal;
  const onExternalAbort = () => controller.abort();
  if (external) {
    if (external.aborted) controller.abort();
    else external.addEventListener('abort', onExternalAbort, { once: true });
  }
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    const text = await res.text(); // aborted by the same signal if the body stalls
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      // not JSON (e.g. an HTML error page) — callers get `text`
    }
    return { ok: res.ok, status: res.status, statusText: res.statusText, data, text };
  } catch (err) {
    if (err.name === 'AbortError' && !(external && external.aborted)) {
      throw new TimeoutError(`Request to ${new URL(url).host} timed out after ${ms}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
    if (external) external.removeEventListener('abort', onExternalAbort);
  }
}

module.exports = { withTimeout, fetchWithTimeout, fetchJson, TimeoutError };
