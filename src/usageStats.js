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
  return { since: Date.now(), rpc: {}, rpcRefused: 0, wsMessages: 0, wsBytes: 0, wsSkipped: 0, wsNoise: 0, wsKinds: {}, wallets: {} };
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

/**
 * Websocket data by copy wallet, to see which wallets cost the credits.
 * kind: 'own' (signed by the wallet: a trade or transfer), 'others' (someone
 * else's transaction that merely mentions it: spam, airdrops, other bots),
 * 'failed', or 'duplicate'.
 */
function countWallet(wallet, bytes, kind) {
  for (const s of [period, total]) {
    const w = s.wallets[wallet] || (s.wallets[wallet] = { msgs: 0, bytes: 0, own: 0, others: 0, activity: 0, failed: 0, duplicate: 0 });
    w.msgs += 1;
    w.bytes += bytes;
    if (kind in w) w[kind] += 1;
  }
}

/** "By wallet" lines for the heaviest wallets, or '' when nothing was attributed. */
function walletSummary(s, top = 6) {
  const entries = Object.entries(s.wallets).sort((a, b) => b[1].bytes - a[1].bytes);
  if (!entries.length) return '';
  const mins = Math.max((Date.now() - s.since) / 60000, 1 / 60);
  const sum = entries.reduce((n, [, w]) => n + w.bytes, 0) || 1;
  const short = (a) => `${a.slice(0, 4)}…${a.slice(-4)}`;
  const parts = entries.slice(0, top).map(([a, w]) => {
    const mb = w.bytes / 1e6;
    const perDay = Math.round((mb * CREDITS_PER_WS_MB / mins) * 60 * 24).toLocaleString('en-GB');
    const what = [
      w.own ? `${w.own} signed by it` : '',
      w.others ? `${w.others} signed by others` : '',
      w.activity ? `${w.activity} transactions` : '',
      w.failed ? `${w.failed} failed` : '',
      w.duplicate ? `${w.duplicate} duplicate` : ''
    ].filter(Boolean).join(', ');
    return `${short(a)} ${mb.toFixed(2)} MB (${Math.round((w.bytes / sum) * 100)}%, ~${perDay} credits/day): ${what}`;
  });
  return `websocket by wallet: ${parts.join('; ')}${entries.length > top ? `; and ${entries.length - top} more` : ''}.`;
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
  const w = walletSummary(period);
  if (w) info(`[Usage] Last ${Math.max(1, Math.round((Date.now() - period.since) / 60000))} min, ${w}`);
  period = fresh();
}
function logTotal() {
  info(`[Usage] Whole run, ${summary(total)}`);
  const w = walletSummary(total);
  if (w) info(`[Usage] Whole run, ${w}`);
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

module.exports = { countWallet, walletSummary, countRpc, countRefused, countWs, countSkipped, countSkippedNoise, countWsKind, logPeriod, logTotal, start, stop, summary, _totals: () => total };
