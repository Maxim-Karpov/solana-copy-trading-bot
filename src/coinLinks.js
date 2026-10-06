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
const rpcPool = require('./rpcPool');

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

function privateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v = ip.toLowerCase();
  if (v.startsWith('::ffff:')) return privateAddress(v.slice(7));
  return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe8') || v.startsWith('fe9') || v.startsWith('fea') || v.startsWith('feb');
}

/** Is it safe to fetch this URL from the server? */
async function safeToFetch(urlStr, lookup = dns.lookup) {
  let u;
  try { u = new URL(urlStr); } catch { return false; }
  if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443')) return false;
  const host = u.hostname;
  if (!host.includes('.') || net.isIP(host) || host.startsWith('[') || /\.(local|internal|localhost|lan)$/i.test(host)) return false;
  try {
    const addrs = await lookup(host, { all: true });
    return addrs.length > 0 && addrs.every((a) => !privateAddress(a.address));
  } catch {
    return false;
  }
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
  const info = await (getInfo ? getInfo(metadataPda(mintPk)) : rpcPool.withFailover((c) => c.getAccountInfo(metadataPda(mintPk)), undefined, { priority: 'low' }));
  if (!info) return null;
  const uri = parseUri(Buffer.from(info.data));
  if (!uri || !(await safeToFetch(uri, lookup))) return null;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetchImpl(uri, { signal: ctl.signal, redirect: 'manual', headers: { accept: 'application/json' } });
    if (!res.ok) return null;
    const text = (await res.text()).slice(0, MAX_BYTES);
    const j = JSON.parse(text);
    const out = {
      website: cleanLink(j.website) || cleanLink(j.external_url),
      twitter: cleanLink(j.twitter) || cleanLink(j.extensions && j.extensions.twitter),
      telegram: cleanLink(j.telegram) || cleanLink(j.extensions && j.extensions.telegram)
    };
    return out.website || out.twitter || out.telegram ? out : { website: null, twitter: null, telegram: null };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { readLinks, parseUri, safeToFetch, cleanLink, privateAddress };
