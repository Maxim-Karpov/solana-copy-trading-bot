// src/leaderInfo.js
//
// Where each slot's leader is, roughly. Solana publishes which validator
// produces each slot well in advance (getSlotLeaders), and every validator's
// network address (getClusterNodes). The address is placed on a map with a
// free IP-location service (ip-api.com, batched and cached for a week in
// data/leader-locations.json), and compared with where this server is.
//
// Used for:
//   - measuring: each shred buy's timing line names its slot leader's city
//     and distance, and the summary splits the same-block rate by distance;
//   - LEADER_MAX_KM (optional): skip a buy when every slot it could land in
//     (his slot, plus MAX_SLOTS_BEHIND) belongs to a leader further away than
//     this. Such buys almost always arrive too late and are cancelled by the
//     slot guard, but still pay their priority fee.
//
// Locations come from the leader's public IP, so they're approximate (a
// city, sometimes wrong). A leader whose location isn't known is never a
// reason to skip.

const fs = require('fs');
const path = require('path');
const config = require('./config');
const rpcPool = require('./rpcPool');
const slotClock = require('./slotClock');
const { fetchJson } = require('./timeouts');
const { info, warn } = require('./logger');

const CACHE_FILE = path.join(__dirname, '..', 'data', 'leader-locations.json');
const GEO_MAX_AGE_MS = 7 * 24 * 3600_000;
const SCHEDULE_CHUNK = 5000; // most slots getSlotLeaders returns at once (~33 min)
const SCHEDULE_REFILL_LEFT = 1500; // fetch more when fewer than this many slots ahead are known
const NODES_REFRESH_MS = 3600_000;
const TICK_MS = 30_000;
const GEO_BATCH = 100; // ip-api.com: up to 100 addresses per batch request
const GEO_BATCH_GAP_MS = 4500; // and at most 15 batch requests a minute

const leaders = new Map(); // slot -> validator identity
let scheduleEnd = 0; // first slot not in `leaders`
let lastCurrent = 0; // the current slot at the last schedule check
const ipOf = new Map(); // identity -> ip
let nodesAt = 0;
let geo = {}; // ip -> { city, cc, lat, lon, at } | { failed: true, at }
let home = null; // { lat, lon, label }
let timer = null;
let busy = false;
let started = false;

function geoUrl() {
  return (process.env.LEADER_GEO_URL || 'http://ip-api.com').replace(/\/+$/, '');
}

function loadCache() {
  try {
    const data = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    if (data && typeof data === 'object') geo = data.ips || {};
    if (data && data.home && !config.LEADER_HOME) home = data.home;
  } catch {
    // no cache yet
  }
}

function saveCache() {
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify({ home, ips: geo }));
  } catch (err) {
    warn(`[Leaders] Couldn't save ${CACHE_FILE}: ${err.message}`);
  }
}

/** Great-circle distance in km. */
function km(a, b) {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(s)));
}

async function locateHome() {
  if (config.LEADER_HOME) {
    home = { ...config.LEADER_HOME, label: `${config.LEADER_HOME.lat}, ${config.LEADER_HOME.lon} (LEADER_HOME)` };
    return;
  }
  const res = await fetchJson(`${geoUrl()}/json/?fields=status,message,city,countryCode,lat,lon`, {}, 10_000);
  const d = res.data;
  if (!d || d.status !== 'success') throw new Error((d && d.message) || `HTTP ${res.status}`);
  home = { lat: d.lat, lon: d.lon, label: `${d.city}, ${d.countryCode}` };
  saveCache();
}

async function refreshSchedule() {
  const latest = slotClock.latestSlot();
  const current = typeof latest === 'number' ? latest : await rpcPool.withFailover((c) => c.getSlot('processed'), undefined, { priority: 'low' });
  lastCurrent = current;
  if (scheduleEnd - current > SCHEDULE_REFILL_LEFT) return;
  const start = Math.max(scheduleEnd, current - 50);
  const list = await rpcPool.withFailover((c) => c.getSlotLeaders(start, SCHEDULE_CHUNK), undefined, { priority: 'low' });
  list.forEach((pk, i) => leaders.set(start + i, typeof pk === 'string' ? pk : pk.toBase58()));
  scheduleEnd = start + list.length;
  // Forget slots more than ~an hour old.
  for (const s of leaders.keys()) {
    if (s < current - 10_000) leaders.delete(s);
    else break;
  }
}

async function refreshNodes() {
  if (Date.now() - nodesAt < NODES_REFRESH_MS && ipOf.size) return;
  const nodes = await rpcPool.withFailover((c) => c.getClusterNodes(), 30_000, { priority: 'low' });
  for (const n of nodes) {
    const addr = n.gossip || n.tpuQuic || n.tpu;
    if (!addr) continue;
    const ip = addr.replace(/^\[|\]?:\d+$/g, '').replace(/\]$/, '');
    ipOf.set(n.pubkey, ip);
  }
  nodesAt = Date.now();
}

/** Look up the location of every upcoming leader's IP not already known. */
async function refreshGeo(identities = new Set(leaders.values())) {
  const wanted = new Set();
  for (const id of new Set(identities)) {
    const ip = ipOf.get(id);
    if (!ip) continue;
    const g = geo[ip];
    if (!g || Date.now() - g.at > GEO_MAX_AGE_MS) wanted.add(ip);
  }
  const ips = [...wanted];
  for (let i = 0; i < ips.length; i += GEO_BATCH) {
    const batch = ips.slice(i, i + GEO_BATCH);
    const res = await fetchJson(
      `${geoUrl()}/batch?fields=status,query,city,countryCode,lat,lon`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(batch) },
      15_000
    );
    if (!Array.isArray(res.data)) throw new Error(`location lookup failed (HTTP ${res.status})`);
    const now = Date.now();
    for (const d of res.data) {
      if (!d || !d.query) continue;
      geo[d.query] =
        d.status === 'success' && d.city ? { city: d.city, cc: d.countryCode, lat: d.lat, lon: d.lon, at: now } : { failed: true, at: now };
    }
    saveCache();
    if (i + GEO_BATCH < ips.length) await new Promise((r) => setTimeout(r, GEO_BATCH_GAP_MS));
  }
  return ips.length;
}

async function tick(first = false) {
  if (busy) return;
  busy = true;
  try {
    if (!home) await locateHome();
    await refreshNodes();
    await refreshSchedule();
    const looked = await refreshGeo();
    if (first) {
      const ids = new Set(leaders.values());
      let placed = 0;
      for (const id of ids) if (locationOf(id)) placed += 1;
      info(
        `[Leaders] This server is in ${home.label}. Located ${placed} of the ${ids.size} validators leading the next ~${Math.max(
          1,
          Math.round(((scheduleEnd - lastCurrent) * 0.4) / 60)
        )} minutes${looked ? ` (${looked} looked up)` : ''}` +
          (config.LEADER_MAX_KM !== null ? `; buys are skipped when the leader is more than ${config.LEADER_MAX_KM} km away (LEADER_MAX_KM).` : '.')
      );
    }
  } catch (err) {
    warn(`[Leaders] ${first ? "Couldn't load" : "Couldn't refresh"} the leader schedule or locations (${err.message})${first ? '; leader locations are shown as unknown and never cause a skip' : ''}.`);
  } finally {
    busy = false;
  }
}

function start() {
  if (started || !config.LEADER_INFO) return;
  started = true;
  loadCache();
  tick(true);
  timer = setInterval(() => tick(false), TICK_MS);
  if (timer.unref) timer.unref();
}

function stop() {
  clearInterval(timer);
  timer = null;
}

function locationOf(identity) {
  const ip = identity && ipOf.get(identity);
  const g = ip && geo[ip];
  return g && !g.failed ? g : null;
}

/**
 * The leader of `slot`: { identity, city, cc, km } (city/cc/km null when its
 * location isn't known), or null when the schedule doesn't cover the slot.
 */
function leaderOf(slot) {
  const identity = leaders.get(slot);
  if (!identity) return null;
  const g = locationOf(identity);
  return {
    identity,
    city: g ? g.city : null,
    cc: g ? g.cc : null,
    km: g && home ? Math.round(km(home, g)) : null
  };
}

/** "Frankfurt am Main, DE (~12 km)" / "unknown location (Abc1…xyz9)" */
function describe(l) {
  if (!l) return 'leader not known';
  if (l.km === null) return `leader ${l.identity.slice(0, 4)}…${l.identity.slice(-4)} (location unknown)`;
  return `leader in ${l.city}, ${l.cc} (~${l.km.toLocaleString('en-US')} km)`;
}

/** Distance band for the summary. */
function band(l) {
  if (!l || l.km === null) return 'unknown';
  if (l.km <= 100) return '≤100 km';
  if (l.km <= 1500) return '100–1,500 km';
  return '>1,500 km';
}

/**
 * LEADER_MAX_KM: can a buy for his slot (landing at most `slotsAllowed`
 * slots later) reach a nearby leader? { ok, leader, why }.
 * ok=true unless every slot it could land in is known to be led from
 * further away than the limit.
 */
function reachable(hisSlot, slotsAllowed = 0) {
  const leader = typeof hisSlot === 'number' ? leaderOf(hisSlot) : null;
  if (config.LEADER_MAX_KM === null || typeof hisSlot !== 'number') return { ok: true, leader };
  let nearest = null;
  for (let s = hisSlot; s <= hisSlot + Math.max(0, slotsAllowed); s++) {
    const l = leaderOf(s);
    if (!l || l.km === null) return { ok: true, leader }; // unknown: don't skip
    if (l.km <= config.LEADER_MAX_KM) return { ok: true, leader };
    if (!nearest || l.km < nearest.km) nearest = l;
  }
  return {
    ok: false,
    leader,
    why: `the leader of his slot${slotsAllowed > 0 ? ` (and the next ${slotsAllowed})` : ''} is in ${nearest.city}, ${nearest.cc}, ~${nearest.km.toLocaleString('en-US')} km away (LEADER_MAX_KM=${config.LEADER_MAX_KM})`
  };
}

/** For tests: { home, leaders: { slot: identity }, places: { identity: { city, cc, lat, lon } } } */
function _setForTests({ home: h = null, leaders: ls = {}, places = {} } = {}) {
  home = h;
  leaders.clear();
  for (const [s, id] of Object.entries(ls)) leaders.set(Number(s), id);
  ipOf.clear();
  geo = {};
  let n = 0;
  for (const [id, p] of Object.entries(places)) {
    const ip = `10.0.0.${++n}`;
    ipOf.set(id, ip);
    geo[ip] = p ? { ...p, at: Date.now() } : { failed: true, at: Date.now() };
  }
}

/**
 * Where these validators are (for scripts/leaders.js): Map identity ->
 * { ip, city, cc, km } (city/cc/km null when not located) or null (no address). Uses and updates the same cache as the bot.
 */
async function locate(identities, { connection = null } = {}) {
  loadCache();
  if (!home) await locateHome();
  if (connection) {
    const nodes = await connection.getClusterNodes();
    for (const n of nodes) {
      const addr = n.gossip || n.tpuQuic || n.tpu;
      if (addr) ipOf.set(n.pubkey, addr.replace(/^\[|\]?:\d+$/g, '').replace(/\]$/, ''));
    }
    nodesAt = Date.now();
  } else {
    await refreshNodes();
  }
  await refreshGeo(identities);
  const out = new Map();
  for (const id of identities) {
    const ip = ipOf.get(id) || null;
    const g = locationOf(id);
    out.set(id, ip || g ? { ip, city: g ? g.city : null, cc: g ? g.cc : null, km: g ? Math.round(km(home, g)) : null } : null);
  }
  return out;
}

function homeLabel() {
  return home ? home.label : null;
}

module.exports = { start, stop, leaderOf, describe, band, reachable, km, locate, homeLabel, _setForTests };
