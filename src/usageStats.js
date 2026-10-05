// src/usageStats.js
//
// Counts what the bot asks of your RPC provider, so you can see where your
// credits go: RPC calls by method, and how much data the trade-detection
// websocket received. Logged every USAGE_LOG_MIN minutes (default 10; 0 = only
// at shutdown) and when the bot stops.
//
// The credit figure is an ESTIMATE using Helius's published prices
// (1 credit per ordinary RPC call, ~20 credits per MB of websocket data).
// Your provider's dashboard is the real bill.

const { info } = require('./logger');

const CREDITS_PER_CALL = 1;
const CREDITS_PER_WS_MB = 20;

function fresh() {
  return { since: Date.now(), rpc: {}, rpcRefused: 0, wsMessages: 0, wsBytes: 0, wsSkipped: 0, wsNoise: 0, wsKinds: {} };
}
let period = fresh();
let total = fresh();

function countRpc(method) {
  period.rpc[method] = (period.rpc[method] || 0) + 1;
  total.rpc[method] = (total.rpc[method] || 0) + 1;
}
function countRefused() {
  period.rpcRefused += 1;
  total.rpcRefused += 1;
}
function countWs(bytes) {
  period.wsMessages += 1;
  total.wsMessages += 1;
  period.wsBytes += bytes;
  total.wsBytes += bytes;
}
function countSkipped() {
  period.wsSkipped += 1;
  total.wsSkipped += 1;
}

/** Websocket messages dropped before any work: 'failed' transactions, 'duplicate's, 'other' messages. */
function countWsKind(kind) {
  period.wsKinds[kind] = (period.wsKinds[kind] || 0) + 1;
  total.wsKinds[kind] = (total.wsKinds[kind] || 0) + 1;
}

function countSkippedNoise() {
  period.wsNoise += 1;
  total.wsNoise += 1;
}

function summary(s) {
  const mins = Math.max((Date.now() - s.since) / 60000, 1 / 60);
  const calls = Object.values(s.rpc).reduce((a, b) => a + b, 0);
  const mb = s.wsBytes / 1e6;
  const credits = calls * CREDITS_PER_CALL + mb * CREDITS_PER_WS_MB;
  const top = Object.entries(s.rpc)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([m, n]) => `${m} ${n}`)
    .join(', ');
  const perDay = (credits / mins) * 60 * 24;
  return (
    `${mins < 1 ? `${Math.round(mins * 60)}s` : `${mins.toFixed(0)} min`}: ` +
    `RPC calls ${calls}${top ? ` (${top})` : ''}${s.rpcRefused ? `, refused ${s.rpcRefused}` : ''}; ` +
    `websocket ${s.wsMessages} messages, ${mb.toFixed(2)} MB` +
    `${(() => {
      const parts = [
        s.wsKinds.failed ? `${s.wsKinds.failed} failed transactions` : '',
        s.wsKinds.duplicate ? `${s.wsKinds.duplicate} duplicates` : '',
        s.wsKinds.other ? `${s.wsKinds.other} other` : '',
        s.wsSkipped ? `${s.wsSkipped} non-token` : '',
        s.wsNoise ? `${s.wsNoise} signed by others` : ''
      ].filter(Boolean);
      return parts.length ? ` (not looked up: ${parts.join(', ')})` : '';
    })()}. ` +
    `~${Math.round(credits)} credits (RPC ~${calls}, websocket ~${Math.round(mb * CREDITS_PER_WS_MB)}), ` +
    `about ${Math.round(perDay).toLocaleString('en-GB')} a day at this rate.`
  );
}

function logPeriod() {
  info(`[Usage] Last ${summary(period)}`);
  period = fresh();
}
function logTotal() {
  info(`[Usage] Whole run, ${summary(total)}`);
}

let timer = null;
function start(minutes) {
  if (!(minutes > 0) || timer) return;
  timer = setInterval(logPeriod, minutes * 60000);
  if (timer.unref) timer.unref();
}
function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { countRpc, countRefused, countWs, countSkipped, countSkippedNoise, countWsKind, logPeriod, logTotal, start, stop, summary, _totals: () => total };
