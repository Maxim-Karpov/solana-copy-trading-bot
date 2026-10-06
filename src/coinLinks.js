// src/coinLinks.js
//
// A coin's website, X/Twitter and Telegram, as the creator filed them. Every
// token has an on-chain metadata account (Metaplex) holding a link to a small
// JSON file; Pump.fun coins put their socials in it. Read AFTER a buy, in the
// background, only for the Telegram message and the log: nothing waits on it,
// and any failure just leaves the line out.
//
// The link in the metadata is chosen by the coin's creator, so it is treated
// as hostile: https only, no IP addresses or internal names, the name must not
// resolve to a private/loopback/link-local address (a creator could otherwise
// point it at this server's own metadata service), no redirects, a size cap,
// a short timeout. The links it contains are shown as plain text, never opened.

const dns = require('dns').promises;
const net = require('net');
const { PublicKey } = require('@solana/web3.js');
const { metadataPda } = require('@pump-fun/pump-swap-sdk');

const FETCH_TIMEOUT_MS = 1500;
const MAX_BYTES = 20_000;

/** The metadata account's `uri` field (Metaplex layout: key, update authority, mint, name, symbol, uri). */
function parseUri(data) {
  try {
    let o = 1 + 32 + 32;
    const str = () => {
      const len = data.readUInt32LE(o);
      if (len > 400) throw new Error('too long');
      const s = data.subarray(o + 4, o + 4 + len).toString('utf8');
      o += 4 + len;
      return s;
    };
    str(); // name
    str(); // symbol
    return str().replace(/\0+$/, '').trim();
  } catch {
    return null;
  }
}

/** Token-2022 coins keep their metadata inside the mint itself (TokenMetadata extension, type 19): its `uri`. */
function parseMintUri(data) {
  try {
    if (data.length <= 166 || data[165] !== 1) return null; // not a Token-2022 mint with extensions
    for (let at = 166; at + 4 <= data.length; ) {
      const type = data.readUInt16LE(at);
      const len = data.readUInt16LE(at + 2);
      if (type === 19) {
        const v = data.subarray(at + 4, at + 4 + len);
        let o = 64; // update authority + mint
        const str = () => {
          const l = v.readUInt32LE(o);
          if (l > 400) throw new Error('too long');
          const t = v.subarray(o + 4, o + 4 + l).toString('utf8');
          o += 4 + l;
          return t;
        };
        str(); // name
        str(); // symbol
        return str().replace(/\0+$/, '').trim();
      }
      at += 4 + len;
    }
  } catch {
    return null;
  }
  return null;
}

function privateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v = ip.toLowerCase();
  if (v.startsWith('::ffff:')) return privateAddress(v.slice(7));
  return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe8') || v.startsWith('fe9') || v.startsWith('fea') || v.startsWith('feb');
}

/** Why this URL must not be fetched from the server (a sentence), or null if it may be. */
async function unsafeReason(urlStr, lookup = dns.lookup) {
  let u;
  try { u = new URL(urlStr); } catch { return 'not a valid web address'; }
  if (u.protocol !== 'https:') return `only https is fetched (this is ${u.protocol.replace(':', '')})`;
  if (u.username || u.password) return 'the address contains a user name or password';
  if (u.port && u.port !== '443') return `unusual port ${u.port}`;
  const host = u.hostname;
  if (net.isIP(host) || host.startsWith('[')) return 'the address is a raw IP address, not a name';
  if (!host.includes('.') || /\.(local|internal|localhost|lan)$/i.test(host)) return `"${host}" looks like an internal name`;
  try {
    const addrs = await lookup(host, { all: true });
    if (!addrs.length) return `"${host}" didn't resolve`;
    const bad = addrs.find((a) => privateAddress(a.address));
    if (bad) return `"${host}" resolves to a private/internal address (${bad.address})`;
  } catch (err) {
    return `"${host}" couldn't be looked up (${err.code || err.message})`;
  }
  return null;
}

/** Is it safe to fetch this URL from the server? */
async function safeToFetch(urlStr, lookup = dns.lookup) {
  return (await unsafeReason(urlStr, lookup)) === null;
}

/** Keep only plain http(s) links, trimmed and of sane length. */
function cleanLink(v) {
  if (typeof v !== 'string') return null;
  const s = v.replace(/[\u0000-\u001f\u007f\s]+/g, '').slice(0, 200);
  return /^https?:\/\/[^\/]+\.[^\/]+/i.test(s) ? s : null;
}

/** { website, twitter, telegram } (each a string or null), or null if nothing could be read. */
async function readLinks(mint, { fetchImpl = globalThis.fetch, lookup, getInfo } = {}) {
  const mintPk = new PublicKey(mint);
  const get = getInfo || ((pk) => require('./rpcPool').withFailover((c) => c.getAccountInfo(pk), undefined, { priority: 'low' }));
  let uri = null;
  const info = await get(metadataPda(mintPk));
  if (info) uri = parseUri(Buffer.from(info.data));
  if (!uri) {
    // No Metaplex account: a Token-2022 coin carries its metadata in the mint itself.
    const mintInfo = await get(mintPk);
    if (mintInfo) uri = parseMintUri(Buffer.from(mintInfo.data));
  }
  if (!uri) return null;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    let url = uri;
    for (let hop = 0; hop < 3; hop++) {
      if (!(await safeToFetch(url, lookup))) return null; // checked again on every redirect
      const res = await fetchImpl(url, { signal: ctl.signal, redirect: 'manual', headers: { accept: 'application/json' } });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers && res.headers.get && res.headers.get('location');
        if (!loc) return null;
        url = new URL(loc, url).toString();
        continue;
      }
      if (!res.ok) return null;
      const text = (await res.text()).slice(0, MAX_BYTES);
      const j = JSON.parse(text);
      const out = {
        website: cleanLink(j.website) || cleanLink(j.external_url),
        twitter: cleanLink(j.twitter) || cleanLink(j.extensions && j.extensions.twitter),
        telegram: cleanLink(j.telegram) || cleanLink(j.extensions && j.extensions.telegram)
      };
      return out.website || out.twitter || out.telegram ? out : { website: null, twitter: null, telegram: null };
    }
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const SITE_TIMEOUT_MS = 2000;
const SITE_MAX_BYTES = 400_000;

/**
 * Does the coin's website show the coin's own address? true / false, or null if the
 * page couldn't be read. The link may be to this very coin's address (a Pump.fun
 * page): that counts as 'link'. A page built by scripts can show the address
 * without it being in the HTML we fetch, so false is "not found", not "absent".
 */
async function siteMentions(website, mint, { fetchImpl = globalThis.fetch, lookup, trace = () => {} } = {}) {
  if (website.includes(mint)) return 'link';
  let url = website;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), SITE_TIMEOUT_MS);
  try {
    for (let hop = 0; hop < 3; hop++) {
      const why = await unsafeReason(url, lookup); // checked again on every redirect
      if (why) { trace({ step: 'refused', url, why }); return null; }
      const res = await fetchImpl(url, { signal: ctl.signal, redirect: 'manual', headers: { accept: 'text/html,*/*;q=0.5', 'user-agent': 'Mozilla/5.0 (compatible; coin-check)' } });
      trace({ step: 'fetched', url, status: res.status });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers && res.headers.get && res.headers.get('location');
        if (!loc) return null;
        url = new URL(loc, url).toString();
        continue;
      }
      if (!res.ok) return null;
      const text = (await res.text()).slice(0, SITE_MAX_BYTES);
      trace({ step: 'read', bytes: text.length });
      return text.includes(mint) ? 'page' : false;
    }
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { siteMentions, readLinks, parseUri, parseMintUri, safeToFetch, unsafeReason, cleanLink, privateAddress };
