#!/usr/bin/env node
// scripts/shreder-check.js — `npm run shreder-check`
//
// Is the Shreder decoded-shreds stream reachable from this server, and how
// busy / how quick is it? Connects to SHREDER_URL (from .env, or --url),
// subscribes, and for a few seconds counts what arrives. Run it on the
// server whose IP address Shreder whitelisted, as soon as the trial starts,
// before starting the bot.
//
//   npm run shreder-check                          # Pump.fun trades, 20 s (proves data flows)
//   npm run shreder-check -- --seconds 60
//   npm run shreder-check -- --copy                # only the COPY_WALLETs' transactions (what the bot gets)
//   npm run shreder-check -- --account <address>   # transactions mentioning this account
//   npm run shreder-check -- --url http://fra1.shreder.xyz:9991
//
// Changes nothing and sends no transactions.

const path = require('path');
const { performance } = require('perf_hooks');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');
const bs58Mod = require('bs58');
const bs58 = bs58Mod.default || bs58Mod;

const PUMP_FUN = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';

function args(argv) {
  const out = { seconds: 20, url: null, account: null, copy: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--seconds') out.seconds = Math.max(3, Number(argv[++i]) || 20);
    else if (a === '--url') out.url = argv[++i];
    else if (a === '--account') out.account = argv[++i];
    else if (a === '--copy') out.copy = true;
    else if (a === '-h' || a === '--help') out.help = true;
  }
  return out;
}

function target(url) {
  const m = /^(?:(https?|grpcs?):\/\/)?([^/:\s]+)(?::(\d+))?\/?$/.exec(String(url || '').trim());
  if (!m) throw new Error(`"${url}" isn't a valid address (expected e.g. http://fra1.shreder.xyz:9991)`);
  const scheme = (m[1] || '').toLowerCase();
  const port = m[3] ? Number(m[3]) : scheme === 'http' || scheme === 'grpc' ? 80 : 443;
  const secure = scheme === 'https' || scheme === 'grpcs' || (!scheme && port === 443);
  return { addr: `${m[2]}:${port}`, secure };
}

function pct(sorted, q) {
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

async function main() {
  const opt = args(process.argv.slice(2));
  if (opt.help) {
    console.log('Usage: npm run shreder-check -- [--seconds N] [--copy | --account <address>] [--url <SHREDER_URL>]');
    return 0;
  }
  const url = opt.url || (process.env.SHREDER_URL || '').trim();
  if (!url) {
    console.error('No Shreder address: set SHREDER_URL in .env (e.g. SHREDER_URL="http://fra1.shreder.xyz:9991") or pass --url.');
    return 1;
  }
  const { addr, secure } = target(url);
  const wallets = (process.env.COPY_WALLETS || process.env.COPY_WALLET || '').split(/[\s,;]+/).filter(Boolean);
  let filter;
  let what;
  if (opt.copy) {
    if (!wallets.length) {
      console.error('--copy needs COPY_WALLET(S) in .env.');
      return 1;
    }
    filter = { account_include: wallets, account_exclude: [], account_required: [] };
    what = `transactions mentioning your ${wallets.length} copy wallet(s)`;
  } else {
    const acc = opt.account || PUMP_FUN;
    filter = { account_include: [], account_exclude: [], account_required: [acc] };
    what = acc === PUMP_FUN ? 'Pump.fun transactions' : `transactions mentioning ${acc}`;
  }

  const def = protoLoader.loadSync(path.join(__dirname, '..', 'src', 'proto', 'shreder.proto'), { keepCase: true, longs: String, defaults: true, oneofs: true });
  const pkg = grpc.loadPackageDefinition(def).shredstream;
  const client = new pkg.ShrederService(addr, secure ? grpc.credentials.createSsl() : grpc.credentials.createInsecure(), {
    'grpc.max_receive_message_length': 64 * 1024 * 1024
  });

  console.log(`Connecting to Shreder at ${addr}${secure ? ' (TLS)' : ''} and subscribing to ${what} for ${opt.seconds}s...`);
  const t0 = performance.now();
  let connectedMs = null;
  let firstMs = null;
  let n = 0;
  const sigs = new Set();
  let dupes = 0;
  const transit = [];
  const slots = new Set();
  const examples = [];
  let failed = null;

  await new Promise((resolve) => {
    const call = client.SubscribeTransactions(new grpc.Metadata());
    const timer = setTimeout(() => {
      try {
        call.cancel();
      } catch {}
      resolve();
    }, opt.seconds * 1000);
    call.on('metadata', () => {
      if (connectedMs === null) connectedMs = performance.now() - t0;
    });
    call.on('data', (msg) => {
      const now = Date.now();
      if (firstMs === null) firstMs = performance.now() - t0;
      n += 1;
      const upd = msg.transaction || {};
      const tx = upd.transaction || {};
      const sig = tx.signatures && tx.signatures[0] ? bs58.encode(tx.signatures[0]) : null;
      if (sig) {
        if (sigs.has(sig)) dupes += 1;
        else if (sigs.size < 200_000) sigs.add(sig);
        if (examples.length < 3) examples.push(`${sig} (slot ${upd.slot})`);
      }
      if (upd.slot) slots.add(upd.slot);
      const c = msg.created_at;
      if (c && c.seconds !== undefined) {
        const sent = Number(c.seconds) * 1000 + (Number(c.nanos) || 0) / 1e6;
        if (sent > 0 && transit.length < 200_000) transit.push(now - sent);
      }
    });
    call.on('error', (err) => {
      if (err.code === grpc.status.CANCELLED) return;
      failed = err;
      clearTimeout(timer);
      resolve();
    });
    call.on('end', () => {
      clearTimeout(timer);
      resolve();
    });
    call.write({ transactions: { check: filter } });
  });
  client.close();

  if (failed) {
    console.error(`\nFAILED: ${failed.message}`);
    if (failed.code === grpc.status.UNAVAILABLE) {
      console.error(
        "Couldn't reach Shreder. Check: the trial has started; SHREDER_URL is the address they gave you; this server's public IPv4 is the one\n" +
          'you gave them (see it with: curl -4 -s https://ifconfig.me ; echo).'
      );
    } else if (failed.code === grpc.status.PERMISSION_DENIED || failed.code === grpc.status.UNAUTHENTICATED) {
      console.error("Shreder refused this server: is its public IPv4 whitelisted with them? (see it with: curl -4 -s https://ifconfig.me ; echo)");
    }
    return 1;
  }

  const secs = opt.seconds;
  console.log('');
  console.log(`Connected:        ${connectedMs !== null ? `yes, in ${Math.round(connectedMs)} ms` : n ? 'yes' : 'no reply from the server (no headers, no data)'}`);
  console.log(`Messages:         ${n} in ${secs}s (${(n / secs).toFixed(1)}/s), ${sigs.size} different transactions, ${dupes} repeat(s), ${slots.size} slot(s)`);
  if (firstMs !== null) console.log(`First message:    ${Math.round(firstMs)} ms after connecting`);
  if (transit.length) {
    const s = transit.sort((a, b) => a - b);
    console.log(
      `Shreder → here:   median ${pct(s, 0.5).toFixed(1)} ms, p90 ${pct(s, 0.9).toFixed(1)} ms, best ${s[0].toFixed(1)} ms ` +
        "(from Shreder's own timestamps: only as accurate as both clocks; check this server's with: timedatectl)"
    );
  }
  if (examples.length) console.log(`Examples:         ${examples.join('\n                  ')}`);
  if (!n) {
    console.log(
      opt.copy
        ? '\nNothing arrived: normal if your copy wallets made no trades in that time. Try without --copy to check that data flows at all.'
        : '\nNothing arrived. If "Connected" says yes, the subscription may not be enabled on the trial yet: ask Shreder.'
    );
  } else {
    console.log('\nShreder is working from this server. Next: set SHRED_SOURCE="shreder,helius-preprocessed" and SHREDER_URL in .env and start the bot.');
  }
  return n || connectedMs !== null ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err.message);
    process.exit(1);
  }
);
