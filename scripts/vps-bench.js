#!/usr/bin/env node
// scripts/vps-bench.js — `npm run vps-bench`
//
// How fast is this server for the bot? Measures the two things that matter:
//   1. CPU: signing speed (what a buy does) and a single-core speed score,
//      with the spread between the typical and the worst runs (jitter).
//   2. Network: time to reach Helius Sender and your RPC (connect, TLS, a
//      full request on a warm connection), typical and worst of 40 tries.
// Run it on each server you want to compare and put the numbers side by
// side. Sends no transactions and changes nothing. Keys in URLs are never printed.
//
//   npm run vps-bench
//   npm run vps-bench -- --url https://some-host/ping      # add any address to test

const path = require('path');
const os = require('os');
const https = require('https');
const http = require('http');
const crypto = require('crypto');
const { performance } = require('perf_hooks');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]; };
const fmt = (ms) => (ms < 1 ? `${(ms * 1000).toFixed(0)} µs` : `${ms.toFixed(ms < 10 ? 2 : 1)} ms`);
const redact = (u) => u.replace(/(api-key=)[^&]+/i, '$1…').replace(/\/\/([^/@]+)@/, '//…@').replace(/(\/v2\/|\/rpc\/|\/)([A-Za-z0-9_-]{24,})(\/?$)/, '$1…$3');

function cpu() {
  const cpus = os.cpus();
  console.log(`CPU: ${cpus[0].model.trim()} × ${cpus.length}, ${(os.totalmem() / 2 ** 30).toFixed(1)} GB RAM, load ${os.loadavg()[0].toFixed(2)}`);
  // 1. ed25519 signing (a buy signs one transaction)
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  const msg = crypto.randomBytes(400);
  for (let i = 0; i < 2000; i++) crypto.sign(null, msg, privateKey);
  const runs = [];
  for (let r = 0; r < 30; r++) {
    const t = performance.now();
    for (let i = 0; i < 500; i++) crypto.sign(null, msg, privateKey);
    runs.push((performance.now() - t) / 500);
  }
  console.log(`Signing one transaction: typical ${fmt(pct(runs, 50))}, worst ${fmt(Math.max(...runs))} (30 batches of 500)`);
  // 2. single-core integer/float work (higher score = faster); spread = jitter
  const scores = [];
  for (let r = 0; r < 15; r++) {
    const t = performance.now();
    let x = 0;
    for (let i = 1; i < 6_000_000; i++) x = (x + Math.sqrt(i) * (i % 7)) % 1e9;
    scores.push(1000 / (performance.now() - t));
    if (x < 0) console.log(x);
  }
  console.log(`Single-core speed score: ${pct(scores, 50).toFixed(2)} (higher is faster); slowest run was ${(100 * (1 - Math.min(...scores) / pct(scores, 50))).toFixed(0)}% slower than typical`);
}

function probe(urlStr) {
  return new Promise((resolve) => {
    const u = new URL(urlStr);
    const mod = u.protocol === 'https:' ? https : http;
    const agent = new mod.Agent({ keepAlive: true, maxSockets: 1 });
    const t0 = performance.now();
    let tConn = 0, tTls = 0;
    const warm = [];
    const hit = (first) => new Promise((res) => {
      const t = performance.now();
      const req = mod.request(u, { agent, method: 'GET', headers: { 'user-agent': 'vps-bench' } }, (r) => { r.resume(); r.on('end', () => res({ ms: performance.now() - t, status: r.statusCode })); });
      if (first) {
        req.on('socket', (s) => {
          s.on('connect', () => { tConn = performance.now() - t0; });
          s.on('secureConnect', () => { tTls = performance.now() - t0; });
        });
      }
      req.setTimeout(4000, () => { req.destroy(); res(null); });
      req.on('error', () => res(null));
      req.end();
    });
    (async () => {
      const f = await hit(true);
      if (!f) { agent.destroy(); return resolve(null); }
      for (let i = 0; i < 40; i++) { const r = await hit(false); if (r) warm.push(r.ms); await new Promise((x) => setTimeout(x, 40)); }
      agent.destroy();
      resolve({ connect: tConn, tls: tTls ? tTls - tConn : null, first: f.ms, status: f.status, warm });
    })();
  });
}

(async () => {
  console.log('--- CPU ---');
  cpu();
  console.log('\n--- Network (each: connection, TLS, then 40 requests on the warm connection) ---');
  const targets = [];
  const sender = process.env.SENDER_ENDPOINT || 'http://fra-sender.helius-rpc.com/fast';
  try { const u = new URL(sender); u.pathname = '/ping'; u.search = ''; targets.push(['Helius Sender (' + u.hostname + ')', u.toString()]); } catch {}
  if (process.env.SOLANA_RPC) targets.push(['Your RPC', process.env.SOLANA_RPC]);
  const extra = process.argv.indexOf('--url');
  if (extra > -1 && process.argv[extra + 1]) targets.push(['Extra', process.argv[extra + 1]]);
  for (const [name, url] of targets) {
    const r = await probe(url);
    if (!r) { console.log(`${name} [${redact(url)}]: unreachable`); continue; }
    console.log(
      `${name} [${redact(url)}]: connect ${fmt(r.connect)}${r.tls !== null ? `, TLS ${fmt(r.tls)}` : ''}; warm request typical ${fmt(pct(r.warm, 50))}, ` +
        `95th ${fmt(pct(r.warm, 95))}, worst ${fmt(Math.max(...r.warm))}`
    );
  }
  console.log('\nHow to read it: the warm-request time is the round trip a buy pays to reach Sender (the lower and steadier, the better).');
  console.log('A big gap between "typical" and "worst" means a noisy server (shared CPU or network): that, not raw speed, is what costs landings.');
})();
