// src/logger.js

function timestamp() {
  return new Date().toISOString();
}

function info(...args) {
  console.log(`[${timestamp()}] [INFO]`, ...args);
}

function warn(...args) {
  console.log(`[${timestamp()}] [WARN]`, ...args);
}

function error(...args) {
  console.log(`[${timestamp()}] [ERROR]`, ...args);
}

/**
 * An RPC URL safe to print: API keys hidden, whether they're in the query
 * (?api-key=...) or in the path (as some providers do).
 */
function redactUrl(url) {
  try {
    const u = new URL(url);
    for (const k of [...u.searchParams.keys()]) u.searchParams.set(k, '***');
    u.pathname = u.pathname
      .split('/')
      .map((seg) => (seg.length >= 16 ? '***' : seg))
      .join('/');
    if (u.username || u.password) {
      u.username = '***';
      u.password = '';
    }
    return u.toString().replace(/%2A%2A%2A/g, '***');
  } catch {
    return '(hidden)';
  }
}

module.exports = { info, warn, error, redactUrl };
