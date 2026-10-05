#!/usr/bin/env node
// scripts/leaders.js — `npm run leaders`
//
// Which of your past copy buys made the copy wallet's block, and where that
// block's leader was. Reads your wallet's recent transactions from your RPC
// (SOLANA_RPC in .env), matches each buy to the copy wallet's buy of the same
// coin just before it, finds who led his slot (from the block's fee reward),
// and places that validator on a map the same way the bot does (LEADER_INFO).
//
//   npm run leaders                          # PUBLIC_KEY vs COPY_WALLET from .env
//   npm run leaders -- --limit 1000          # look further back (default 300 transactions)
//   npm run leaders -- --wallet <yours> --copy <his>[,<his2>]
//   npm run leaders -- --no-ping             # skip pinging the leaders
//   npm run leaders -- --ping <validator>[,<validator2>...]
//        just locate and ping these: identity or vote account addresses, or IPs
//
// Ping times are measured from where the script runs (run it on the bot's
// server). Many validators don't answer ping: those show "no ping reply".
//
// Buys cancelled by the slot guard (MAX_SLOTS_BEHIND) count as late. Only
// buys that can be matched to a copy wallet's buy are shown.

const crypto = require('crypto');
const bs58Mod = require('bs58');
const bs58 = bs58Mod.default || bs58Mod;

const LIGHTHOUSE = 'L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95';
const QUOTE_MINTS = new Set([
  'So11111111111111111111111111111111111111112',
  'pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn',
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
]);
const MATCH_WINDOW_SEC = 15; // his buy must be at most this long before ours
const disc = (name) => crypto.createHash('sha256').update(`global:${name}`).digest().subarray(0, 8).toString('hex');
const BUY_DISCS = new Set(['buy', 'buy_exact_sol_in', 'buy_v2', 'buy_exact_quote_in_v2', 'buy_exact_quote_in'].map(disc));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function retry(fn, what) {
  let wait = 500;
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i >= 5) throw new Error(`${what}: ${err.message}`);
      await sleep(wait);
      wait *= 2;
    }
  }
}

/** Run fn over items, `n` at a time. */
async function pool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    })
  );
  return out;
}

async function signatures(conn, address, { limit = Infinity, until = null } = {}) {
  const { PublicKey } = require('@solana/web3.js');
  const pk = new PublicKey(address);
  const all = [];
  let before;
  while (all.length < limit) {
    const want = Math.min(1000, limit - all.length);
    const page = await retry(() => conn.getSignaturesForAddress(pk, { before, limit: want }), 'signatures');
    if (!page.length) break;
    all.push(...page);
    const last = page[page.length - 1];
    before = last.signature;
    if (until !== null && typeof last.blockTime === 'number' && last.blockTime < until) break;
    if (page.length < want) break; // no older ones
  }
  return all;
}

const keyOf = (k) => (typeof k === 'string' ? k : k.pubkey ? (typeof k.pubkey === 'string' ? k.pubkey : k.pubkey.toBase58()) : k.toBase58());

/** What a parsed transaction did for `owner`: token changes by mint, accounts, failing program. */
function summarize(tx, owner) {
  const keys = tx.transaction.message.accountKeys.map(keyOf);
  const deltas = new Map();
  const add = (list, sign) => {
    for (const b of list || []) {
      if (b.owner !== owner) continue;
      const v = BigInt(b.uiTokenAmount.amount) * BigInt(sign);
      deltas.set(b.mint, (deltas.get(b.mint) || 0n) + v);
    }
  };
  add(tx.meta && tx.meta.postTokenBalances, 1);
  add(tx.meta && tx.meta.preTokenBalances, -1);
  const err = tx.meta ? tx.meta.err : null;
  let failedProgram = null;
  if (err && err.InstructionError) {
    const ix = tx.transaction.message.instructions[err.InstructionError[0]];
    if (ix) failedProgram = keyOf(ix.programId);
  }
  // A buy instruction anywhere at the top level (Pump.fun / PumpSwap names).
  let buyIx = false;
  for (const ix of tx.transaction.message.instructions) {
    if (typeof ix.data !== 'string') continue;
    try {
      const d = Buffer.from(bs58.decode(ix.data));
      if (d.length >= 8 && BUY_DISCS.has(d.subarray(0, 8).toString('hex'))) buyIx = true;
    } catch {}
  }
  let bought = null;
  for (const [mint, d] of deltas) if (d > 0n && !QUOTE_MINTS.has(mint)) bought = mint;
  return { slot: tx.slot, time: tx.blockTime, err, failedProgram, keys, bought, buyIx };
}

/**
 * The analysis, given a connection. Returns { rows, unmatched, examined }.
 * rows: { time, mint, wallet, hisSlot, ourSlot, outcome, leader }
 */
async function analyse({ conn, wallet, copyWallets, limit = 300, log = () => {} }) {
  const parse = (sig) =>
    retry(() => conn.getParsedTransaction(sig, { maxSupportedTransactionVersion: 1, commitment: 'confirmed' }), `transaction ${sig}`);

  log(`Reading your last ${limit} transactions...`);
  const ours = await signatures(conn, wallet, { limit });
  const ourTx = (await pool(ours, 4, (s) => parse(s.signature))).map((tx, i) => (tx ? { sig: ours[i].signature, ...summarize(tx, wallet) } : null)).filter(Boolean);
  // Buys: tokens came in, or a failed transaction that was a buy.
  const attempts = ourTx.filter((t) => (!t.err && t.bought) || (t.err && (t.buyIx || t.failedProgram === LIGHTHOUSE)));
  if (!attempts.length) return { rows: [], unmatched: 0, examined: ourTx.length };
  const times = attempts.map((t) => t.time).filter((x) => typeof x === 'number');
  const earliest = Math.min(...times);

  // His buys shortly before any of ours.
  const near = (t) => times.some((ot) => t !== null && t <= ot + 1 && t >= ot - MATCH_WINDOW_SEC);
  const his = []; // { mint, slot, time, wallet }
  for (const cw of copyWallets) {
    log(`Reading ${cw.slice(0, 4)}…${cw.slice(-4)}'s transactions back to your earliest buy...`);
    const sigs = (await signatures(conn, cw, { limit: 50_000, until: earliest - MATCH_WINDOW_SEC })).filter((s) => !s.err && near(s.blockTime));
    const txs = await pool(sigs, 4, (s) => parse(s.signature));
    for (const tx of txs) {
      if (!tx) continue;
      const s = summarize(tx, cw);
      if (!s.err && s.bought) his.push({ mint: s.bought, slot: s.slot, time: s.time, wallet: cw });
    }
  }

  const rows = [];
  let unmatched = 0;
  for (const t of attempts) {
    const mints = t.bought ? [t.bought] : t.keys;
    let best = null;
    for (const h of his) {
      if (!mints.includes(h.mint) || h.slot > t.slot || t.time - h.time > MATCH_WINDOW_SEC) continue;
      if (!best || h.slot > best.slot) best = h;
    }
    if (!best) {
      unmatched += 1;
      continue;
    }
    let outcome;
    if (!t.err) outcome = t.slot === best.slot ? 'same' : 'late';
    else if (t.failedProgram === LIGHTHOUSE) outcome = 'late (cancelled)';
    else outcome = t.slot === best.slot ? 'failed in his block' : 'failed late';
    rows.push({ time: t.time, mint: best.mint, wallet: best.wallet, hisSlot: best.slot, ourSlot: t.slot, outcome, sig: t.sig });
  }

  // Who led each of his slots: the validator paid that block's fees.
  const slots = [...new Set(rows.map((r) => r.hisSlot))];
  log(`Looking up the leaders of ${slots.length} slot(s)...`);
  const leaderOfSlot = new Map();
  await pool(slots, 4, async (slot) => {
    const block = await retry(
      () => conn.getBlock(slot, { transactionDetails: 'none', rewards: true, maxSupportedTransactionVersion: 1, commitment: 'confirmed' }),
      `block ${slot}`
    ).catch(() => null);
    const fee = block && (block.rewards || []).find((r) => /^fee$/i.test(r.rewardType || ''));
    leaderOfSlot.set(slot, fee ? fee.pubkey : null);
  });
  for (const r of rows) r.leader = leaderOfSlot.get(r.hisSlot) || null;
  return { rows, unmatched, examined: ourTx.length };
}

const PING_BANDS = ['≤5 ms', '5–20 ms', '20–80 ms', '>80 ms', 'no ping reply', 'not pinged'];
function pingBand(ms) {
  if (ms === undefined) return 'not pinged';
  if (ms === null) return 'no ping reply';
  if (ms <= 5) return '≤5 ms';
  if (ms <= 20) return '5–20 ms';
  if (ms <= 80) return '20–80 ms';
  return '>80 ms';
}

function report({ rows, unmatched, examined }, places, homeLabel) {
  const leaderInfo = require('../src/leaderInfo');
  const lines = [];
  const inBlock = (r) => r.outcome === 'same' || r.outcome === 'failed in his block';
  lines.push(`${examined} transaction(s) read; ${rows.length} copy buy(s) matched to the copy wallet${unmatched ? `, ${unmatched} not matched (no buy of that coin by him just before)` : ''}.`);
  if (homeLabel) lines.push(`Distances are from this server (${homeLabel}).`);
  lines.push('');
  const multi = new Set(rows.map((r) => r.wallet)).size > 1;
  for (const r of [...rows].sort((a, b) => a.time - b.time)) {
    const p = r.leader ? places.get(r.leader) : null;
    const where = !r.leader
      ? 'leader unknown'
      : p && p.city
        ? `${p.city}, ${p.cc} (~${p.km.toLocaleString('en-US')} km)`
        : `${r.leader.slice(0, 4)}…${r.leader.slice(-4)} (location unknown)`;
    const pingText = !p || p.ping === undefined ? '' : p.ping === null ? ', no ping reply' : `, ping ${p.ping} ms`;
    const when = r.time ? new Date(r.time * 1000).toISOString().replace('T', ' ').slice(0, 19) : '?';
    const behind = r.ourSlot - r.hisSlot;
    lines.push(
      `${when}  ${r.mint.slice(0, 4)}…${r.mint.slice(-4)}${multi ? ` (copied ${r.wallet.slice(0, 4)}…)` : ''}  his slot ${r.hisSlot}  ours ${r.outcome.startsWith('late (cancelled') ? 'cancelled' : `+${behind}`}  ` +
        `${(inBlock(r) ? 'IN BLOCK' : r.outcome.toUpperCase()).padEnd(18)} ${where}${pingText}`
    );
  }
  if (!rows.length) return lines.join('\n');

  const n = rows.length;
  const ok = rows.filter(inBlock).length;
  lines.push('');
  lines.push(`In his block: ${ok} of ${n} (${Math.round((100 * ok) / n)}%).`);
  const bands = new Map();
  const cities = new Map();
  const pings = new Map();
  let pinged = false;
  for (const r of rows) {
    const p = r.leader ? places.get(r.leader) : null;
    const band = leaderInfo.band(p && p.city ? { km: p.km } : null);
    const city = p && p.city ? `${p.city}, ${p.cc}` : 'unknown';
    if (p && p.ping !== undefined) pinged = true;
    const pb = pingBand(p ? p.ping : undefined);
    for (const [m, k] of [[bands, band], [cities, city], [pings, pb]]) {
      const v = m.get(k) || { n: 0, ok: 0 };
      v.n += 1;
      if (inBlock(r)) v.ok += 1;
      m.set(k, v);
    }
  }
  const fmt = ([k, v]) => `  ${k.padEnd(28)} ${v.ok}/${v.n} (${Math.round((100 * v.ok) / v.n)}%)`;
  lines.push('By leader distance:');
  for (const k of ['≤100 km', '100–1,500 km', '>1,500 km', 'unknown']) if (bands.has(k)) lines.push(fmt([k, bands.get(k)]));
  if (pinged) {
    lines.push('By ping from this server:');
    for (const k of PING_BANDS) if (pings.has(k)) lines.push(fmt([k, pings.get(k)]));
  }
  lines.push('By leader city:');
  for (const e of [...cities.entries()].sort((a, b) => b[1].n - a[1].n)) lines.push(fmt(e));
  return lines.join('\n');
}

const IP_RE = /^(\d{1,3}\.){3}\d{1,3}$|^[0-9a-f:]+:[0-9a-f:]*$/i;

/**
 * --ping: which validator identity each input means. A vote account is
 * mapped to its validator's identity; an IP is kept as is.
 * Returns [{ input, identity|null, ip|null, note }].
 */
async function resolveInputs(conn, inputs) {
  const out = [];
  let votes = null;
  for (const input of inputs) {
    if (IP_RE.test(input)) {
      out.push({ input, identity: null, ip: input, note: '' });
      continue;
    }
    if (!votes) {
      const v = await retry(() => conn.getVoteAccounts(), 'vote accounts');
      votes = new Map([...v.current, ...v.delinquent].map((a) => [a.votePubkey, a.nodePubkey]));
    }
    const identity = votes.get(input) || input;
    out.push({ input, identity, ip: null, note: votes.has(input) ? `vote account of ${identity}` : '' });
  }
  return out;
}

async function pingMode(conn, inputs, leaderInfo) {
  const { ping, isAvailable } = require('../src/ping');
  const list = await resolveInputs(conn, inputs);
  const ids = list.filter((x) => x.identity).map((x) => x.identity);
  let places = new Map();
  if (ids.length) {
    console.log(`Looking up ${ids.length} validator(s)...`);
    try {
      places = await leaderInfo.locate(ids, { connection: conn });
    } catch (err) {
      console.log(`Couldn't look up validator locations (${err.message}).`);
    }
  }
  if (leaderInfo.homeLabel()) console.log(`Distances and pings are from this server (${leaderInfo.homeLabel()}).`);
  console.log('');
  await pool(list, 10, async (x) => {
    const p = x.identity ? places.get(x.identity) : null;
    x.ip = x.ip || (p && p.ip) || null;
    x.place = p;
    x.ms = x.ip ? await ping(x.ip, { count: 5 }) : undefined;
  });
  for (const x of list) {
    const where = x.place && x.place.city ? `${x.place.city}, ${x.place.cc} (~${x.place.km.toLocaleString('en-US')} km)` : x.identity && !x.ip ? 'not found in the network right now' : 'location unknown';
    const pingText = !x.ip ? '' : !isAvailable() ? '' : x.ms === null ? '; no ping reply' : `; ping ${x.ms} ms`;
    console.log(`${x.input}${x.note ? ` (${x.note})` : ''}: ${where}${x.ip ? `; IP ${x.ip}` : ''}${pingText}`);
  }
  if (!isAvailable()) console.log('\n`ping` is not installed here (sudo apt install iputils-ping); ping times not shown.');
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (name) => {
    const i = args.indexOf(`--${name}`);
    return i !== -1 ? args[i + 1] : null;
  };
  // .env is read for SOLANA_RPC, PUBLIC_KEY and COPY_WALLET.
  const config = require('../src/config');
  const { Connection } = require('@solana/web3.js');
  const leaderInfo = require('../src/leaderInfo');
  const wallet = opt('wallet') || config.PUBLIC_KEY;
  const copyWallets = (opt('copy') || '').split(',').map((s) => s.trim()).filter(Boolean);
  const copy = copyWallets.length ? copyWallets : config.COPY_WALLETS;
  const limit = Math.max(1, Math.min(5000, Number(opt('limit')) || 300));
  const conn = new Connection(config.SOLANA_RPC, 'confirmed');

  if (opt('ping')) {
    await pingMode(conn, opt('ping').split(',').map((x) => x.trim()).filter(Boolean), leaderInfo);
    process.exit(0);
  }

  console.log(`Your wallet ${wallet}; copy wallet(s) ${copy.join(', ')}.`);
  const result = await analyse({ conn, wallet, copyWallets: copy, limit, log: (m) => console.log(m) });
  let places = new Map();
  const ids = [...new Set(result.rows.map((r) => r.leader).filter(Boolean))];
  if (ids.length) {
    console.log(`Locating ${ids.length} validator(s)...`);
    try {
      places = await leaderInfo.locate(ids, { connection: conn });
    } catch (err) {
      console.log(`Couldn't look up validator locations (${err.message}); showing them as unknown.`);
    }
    // Round trip from this server to each leader (the fastest of 3 pings).
    if (!args.includes('--no-ping')) {
      const { ping, isAvailable } = require('../src/ping');
      const withIp = ids.filter((id) => places.get(id) && places.get(id).ip);
      console.log(`Pinging ${withIp.length} validator(s)...`);
      await pool(withIp, 10, async (id) => {
        places.get(id).ping = await ping(places.get(id).ip);
      });
      if (!isAvailable()) {
        console.log('`ping` is not installed here (sudo apt install iputils-ping); ping times not shown.');
        for (const id of withIp) delete places.get(id).ping;
      }
    }
  }
  console.log('');
  console.log(report(result, places, leaderInfo.homeLabel()));
  process.exit(0);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`Failed: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { analyse, report, summarize, resolveInputs };
