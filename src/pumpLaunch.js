// src/pumpLaunch.js
//
// Launching a new coin on Pump.fun from Telegram (/launch): the parts that
// don't touch the rest of the bot.
//
//   parseLaunchCommand  - reads the /launch caption into name, ticker, dev buy,
//                         description and links (or says what's wrong)
//   uploadMetadata      - puts the image and metadata on IPFS through
//                         Pump.fun's upload endpoint (LAUNCH_IPFS_URL) and
//                         returns the metadata URI the coin points at
//   buildLaunchTx       - one transaction: create_v2 (the coin and its bonding
//                         curve) + your token account + the first (dev) buy,
//                         built with Pump.fun's own SDK
//
// Signing and sending stay in tradeExecutor.js (launchToken), so a launch goes
// out the same way as every other trade (Helius Sender or Jito). The coin's
// new mint keypair co-signs it.

const { PublicKey } = require('@solana/web3.js');
const BN = require('bn.js');
const { PUMP_SDK, getBuyTokenAmountFromSolAmount } = require('@pump-fun/pump-sdk');
const { assembleV0Tx } = require('./txAssemble');
const prewarm = require('./prewarm');

// Metaplex metadata limits (the create instruction fails on-chain past these).
const MAX_NAME = 32;
const MAX_SYMBOL = 10;
const MAX_URI = 200;
const MAX_DESCRIPTION = 1000;
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;

class LaunchInputError extends Error {}

function cleanUrl(v) {
  const s = String(v || '').trim();
  if (!s) return '';
  const withScheme = /^https?:\/\//i.test(s) ? s : `https://${s}`;
  try {
    const u = new URL(withScheme);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : '';
  } catch {
    return '';
  }
}

/**
 * The /launch caption:
 *
 *   /launch Name | TICKER | 0.5
 *   Any number of description lines
 *   x: https://x.com/...
 *   tg: https://t.me/...
 *   web: https://...
 *
 * The dev buy is optional (LAUNCH_DEFAULT_BUY_SOL when left out; 0 = launch
 * without buying). Returns the fields, or throws LaunchInputError with a
 * message meant for the user.
 */
function parseLaunchCommand(text, { defaultBuySol = 0 } = {}) {
  const lines = String(text || '').split(/\r?\n/);
  const first = lines.shift().replace(/^\/launch(@\S+)?/i, '').trim();
  if (!first) throw new LaunchInputError('Put the coin on the first line: /launch Name | TICKER | dev buy SOL');
  const parts = first.split('|').map((p) => p.trim());
  if (parts.length < 2 || parts.length > 3) throw new LaunchInputError('Use /launch Name | TICKER | dev buy SOL (separated by |).');
  const [name, rawSymbol, rawBuy] = parts;
  const symbol = rawSymbol.replace(/^\$/, '');
  if (!name) throw new LaunchInputError('The name is empty.');
  if (!symbol) throw new LaunchInputError('The ticker is empty.');
  if (Buffer.byteLength(name, 'utf8') > MAX_NAME) throw new LaunchInputError(`The name is too long (max ${MAX_NAME} bytes).`);
  if (Buffer.byteLength(symbol, 'utf8') > MAX_SYMBOL) throw new LaunchInputError(`The ticker is too long (max ${MAX_SYMBOL} bytes).`);

  let devBuySol = defaultBuySol;
  if (rawBuy !== undefined && rawBuy !== '') {
    const n = Number(rawBuy.replace(/\s*sol$/i, ''));
    if (!Number.isFinite(n) || n < 0) throw new LaunchInputError(`"${rawBuy}" isn't a SOL amount for the dev buy.`);
    devBuySol = n;
  }

  const links = { twitter: '', telegram: '', website: '' };
  let uri = '';
  const description = [];
  for (const line of lines) {
    const m = /^\s*(x|twitter|tg|telegram|web|website|site|uri)\s*:\s*(.+)$/i.exec(line);
    if (!m) {
      description.push(line);
      continue;
    }
    const key = m[1].toLowerCase();
    const url = cleanUrl(m[2]);
    if (!url) throw new LaunchInputError(`"${m[2].trim()}" isn't a link.`);
    if (key === 'x' || key === 'twitter') links.twitter = url;
    else if (key === 'tg' || key === 'telegram') links.telegram = url;
    else if (key === 'uri') uri = url;
    else links.website = url;
  }
  const desc = description.join('\n').trim();
  if (desc.length > MAX_DESCRIPTION) throw new LaunchInputError(`The description is too long (max ${MAX_DESCRIPTION} characters).`);
  if (uri && uri.length > MAX_URI) throw new LaunchInputError(`The metadata URI is too long (max ${MAX_URI} characters).`);
  return { name, symbol, devBuySol, description: desc, ...links, uri };
}

/**
 * Upload the image + metadata through Pump.fun's IPFS endpoint (the one its
 * own site uses). Returns the metadata URI. Needs Node 18+ (fetch, FormData).
 */
async function uploadMetadata({ url, image, name, symbol, description, twitter, telegram, website, timeoutMs = 30_000 }) {
  if (!image || !image.buffer || !image.buffer.length) throw new LaunchInputError('No image to upload.');
  if (image.buffer.length > MAX_IMAGE_BYTES) throw new LaunchInputError('The image is too large (max 15 MB).');
  const mime = image.mime || 'image/png';
  if (!IMAGE_TYPES.has(mime)) throw new LaunchInputError(`Images must be PNG, JPEG, GIF or WebP (got ${mime}).`);
  const form = new FormData();
  form.append('file', new Blob([image.buffer], { type: mime }), image.filename || 'image.png');
  form.append('name', name);
  form.append('symbol', symbol);
  form.append('description', description || '');
  if (twitter) form.append('twitter', twitter);
  if (telegram) form.append('telegram', telegram);
  if (website) form.append('website', website);
  form.append('showName', 'true');

  let res;
  try {
    res = await fetch(url, { method: 'POST', body: form, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    throw new Error(`Metadata upload failed (${err.name === 'TimeoutError' ? `no answer in ${timeoutMs / 1000}s` : err.message})`);
  }
  const text = await res.text();
  if (!res.ok) throw new Error(`Metadata upload failed: HTTP ${res.status} ${text.replace(/\s+/g, ' ').slice(0, 200)}`);
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Metadata upload answered with something that isn't JSON: ${text.slice(0, 200)}`);
  }
  const uri = data.metadataUri || data.uri || (data.metadata && data.metadata.uri);
  if (typeof uri !== 'string' || !/^https?:\/\//.test(uri)) throw new Error(`Metadata upload gave no metadata URI: ${text.slice(0, 200)}`);
  if (uri.length > MAX_URI) throw new Error(`Metadata URI is longer than ${MAX_URI} characters.`);
  return uri;
}

/**
 * The launch transaction, unsigned: create_v2 + token account + dev buy
 * (just create_v2 when devBuySol is 0). Also returns the tokens the dev buy
 * should get, for the log. The mint keypair must co-sign it.
 */
async function buildLaunchTx({ connection, user, mint, name, symbol, uri, devBuySol = 0, mayhemMode = false, tipSol = 0, computeUnitLimit, priorityFeeMicroLamports = 0, fetchGlobal, fetchFeeConfig }) {
  if (!(mint instanceof PublicKey)) throw new Error('mint must be a PublicKey');
  const global = prewarm.pumpGlobal() || (await fetchGlobal());
  if (global.createV2Enabled === false) throw new Error('Pump.fun has coin creation (create_v2) switched off right now.');

  let instructions;
  let tokens = new BN(0);
  if (devBuySol > 0) {
    const feeConfig = fetchFeeConfig ? await fetchFeeConfig().catch(() => null) : null;
    const lamports = new BN(Math.round(devBuySol * 1e9));
    // A brand-new curve: no curve and no supply yet, the SDK prices it from launch.
    tokens = getBuyTokenAmountFromSolAmount({ global, feeConfig, mintSupply: null, bondingCurve: null, amount: lamports });
    if (tokens.lten(0)) throw new LaunchInputError(`${devBuySol} SOL is too little for a dev buy.`);
    instructions = await PUMP_SDK.createV2AndBuyInstructions({ global, mint, name, symbol, uri, creator: user, user, amount: tokens, solAmount: lamports, mayhemMode });
  } else {
    instructions = [await PUMP_SDK.createV2Instruction({ mint, name, symbol, uri, creator: user, user, mayhemMode })];
  }
  const tx = await assembleV0Tx({ connection, payer: user, instructions, computeUnitLimit, priorityFeeMicroLamports, tipSol });
  return { tx, tokensRaw: tokens };
}

module.exports = { parseLaunchCommand, uploadMetadata, buildLaunchTx, LaunchInputError, cleanUrl, IMAGE_TYPES };
