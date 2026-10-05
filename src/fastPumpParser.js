// src/fastPumpParser.js
//
// Fast path for DETECTION_COMMITMENT="processed": read the copy wallet's
// Pump.fun bonding-curve trades straight out of the log lines the websocket
// notification already carries, instead of fetching the full transaction.
// (getTransaction can't return a transaction until it's *confirmed*, so the
// normal path can't act any earlier than that.)
//
// Pump.fun emits a TradeEvent for every buy/sell as a "Program data:
// <base64>" log line: an 8-byte discriminator, then the event fields. Trade
// detection reads only the first five fields — mint, sol_amount,
// token_amount, is_buy, user — which sit at fixed offsets and haven't changed
// since launch. decodePumpTradeDetails also reads the reserves and creator
// that follow (for the buy message's market cap / curve progress). Pump.fun
// appends new fields at the END of the event, which doesn't move any of
// these. (Checked against @pump-fun/pump-sdk's own encoder/decoder.)

const { PublicKey } = require('@solana/web3.js');

const PUMP_PROGRAM_ID = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
// sha256("event:TradeEvent")[0..8], from the Pump.fun IDL.
const TRADE_EVENT_DISCRIMINATOR = Buffer.from('bddb7fd34ee661ee', 'hex');
const MIN_EVENT_LEN = 8 + 32 + 8 + 8 + 1 + 32;
// Through `creator` (timestamp, 4 reserves, fee_recipient, fee_bps, fee, creator).
// Every TradeEvent since creator fees were added is at least this long.
const DETAIL_EVENT_LEN = MIN_EVENT_LEN + 8 + 8 * 4 + 32 + 8 + 8 + 32;

/**
 * Pump.fun trades by `walletAddress` in these logs:
 * [{ mint, solLamports: BigInt, tokenRaw: BigInt, isBuy }].
 * Returns null if the logs were truncated (can't be sure nothing was
 * missed — caller should fall back to the full-transaction path).
 */
function decodePumpTradesFromLogs(logs, walletAddress) {
  const trades = [];
  const ok = forEachTradeEvent(logs, (body) => {
    const user = new PublicKey(body.subarray(49, 81)).toBase58();
    if (user !== walletAddress) return;
    trades.push({
      mint: new PublicKey(body.subarray(0, 32)).toBase58(),
      solLamports: body.readBigUInt64LE(32),
      tokenRaw: body.readBigUInt64LE(40),
      isBuy: body[48] === 1
    });
  });
  return ok ? trades : null;
}

/**
 * The coin's state right after `walletAddress`'s last Pump.fun trade of
 * `mint` in these logs, or null if there is none (or the event is too old a
 * layout to carry these fields):
 * { solLamports, tokenRaw (the trade itself), virtualSolReserves,
 *   virtualTokenReserves, realSolReserves, realTokenReserves (all BigInt,
 *   raw units), creator (base58), solQuoted }.
 * Used on our OWN buy to get market cap / curve progress without any extra
 * network calls.
 */
function decodePumpTradeDetails(logs, walletAddress, mint) {
  let found = null;
  forEachTradeEvent(logs, (body) => {
    if (body.length < DETAIL_EVENT_LEN - 8) return;
    if (new PublicKey(body.subarray(49, 81)).toBase58() !== walletAddress) return;
    if (new PublicKey(body.subarray(0, 32)).toBase58() !== mint) return;
    let o = 81 + 8; // after user, skip timestamp
    const u64 = () => {
      const v = body.readBigUInt64LE(o);
      o += 8;
      return v;
    };
    const virtualSolReserves = u64();
    const virtualTokenReserves = u64();
    const realSolReserves = u64();
    const realTokenReserves = u64();
    o += 32 + 8 + 8; // fee_recipient, fee_basis_points, fee
    const creator = new PublicKey(body.subarray(o, o + 32)).toBase58();
    found = {
      solLamports: body.readBigUInt64LE(32),
      tokenRaw: body.readBigUInt64LE(40),
      virtualSolReserves,
      virtualTokenReserves,
      realSolReserves,
      realTokenReserves,
      creator,
      solQuoted: quotedInSol(body),
      quoteMint: quoteMintOf(body)
    };
  });
  return found;
}

const TOKEN_PROGRAMS = {
  TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA: 'spl-token',
  TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb: 'token-2022'
};

/**
 * Everything a Pump.fun buy of `mint` needs about the coin, taken from the
 * copy wallet's own trade record (its last Pump.fun trade of that coin in
 * these logs), so our buy can be built with NO lookups:
 * { mint, virtualTokenReserves, virtualSolReserves, realTokenReserves,
 *   realSolReserves (decimal strings, raw units, AFTER his trade), creator,
 *   mayhemMode, creatorFeeBps (string), tokenProgram ('spl-token' |
 *   'token-2022' | null if unclear), solQuoted }.
 * The token program is the one Pump.fun itself called to move his tokens.
 * Returns null if there is no such trade, or its record is an older layout
 * that the SDK can't fully read (then the bot looks the coin up instead).
 */
function decodePumpCurveHint(logs, walletAddress, mint) {
  let found = null;
  forEachTradeEvent(logs, (body, frame) => {
    if (body.length < DETAIL_EVENT_LEN - 8) return;
    if (new PublicKey(body.subarray(49, 81)).toBase58() !== walletAddress) return;
    if (new PublicKey(body.subarray(0, 32)).toBase58() !== mint) return;
    let d;
    try {
      const { PUMP_SDK } = require('@pump-fun/pump-sdk');
      d = PUMP_SDK.decodeTradeEventBc(body);
    } catch {
      found = null;
      return;
    }
    if (!d || typeof d.mayhemMode !== 'boolean') {
      found = null;
      return;
    }
    const programs = [...frame.calls].map((p) => TOKEN_PROGRAMS[p]).filter(Boolean);
    const quote = d.quoteMint ? d.quoteMint.toBase58() : null;
    const vSol = d.virtualSolReserves && !d.virtualSolReserves.isZero() ? d.virtualSolReserves : d.virtualQuoteReserves;
    found = {
      mint,
      virtualTokenReserves: d.virtualTokenReserves.toString(),
      virtualSolReserves: vSol ? vSol.toString() : '0',
      realTokenReserves: d.realTokenReserves.toString(),
      realSolReserves: d.realSolReserves.toString(),
      creator: d.creator.toBase58(),
      mayhemMode: d.mayhemMode,
      creatorFeeBps: d.creatorFeeBasisPoints ? d.creatorFeeBasisPoints.toString() : '0',
      tokenProgram: new Set(programs).size === 1 ? programs[0] : null,
      solQuoted: !quote || SOL_QUOTES.has(quote)
    };
  });
  return found;
}

const SOL_QUOTES = new Set([
  'So11111111111111111111111111111111111111112', // wrapped SOL
  '11111111111111111111111111111111' // unset (coins from before other quotes existed)
]);

/**
 * Is this coin priced in SOL? Pump.fun also has coins quoted in other tokens,
 * whose "SOL reserves" aren't SOL. The quote mint sits after variable-length
 * fields, so the SDK's own decoder reads it. true = SOL (or unknown: an
 * older event layout the SDK can't decode, from before other quotes existed).
 */
function quoteMintOf(body) {
  try {
    // Loaded lazily: only needed for the buy message, never for detection.
    const { PUMP_SDK } = require('@pump-fun/pump-sdk');
    const decoded = PUMP_SDK.decodeTradeEventBc(body);
    return decoded && decoded.quoteMint ? decoded.quoteMint.toBase58() : null;
  } catch {
    return null; // older layout, from before other quotes existed
  }
}

function quotedInSol(body) {
  const q = quoteMintOf(body);
  return !q || SOL_QUOTES.has(q);
}

/**
 * Calls onEvent(body) for every Pump.fun TradeEvent emitted by the Pump.fun
 * program itself (body = event bytes after the discriminator). Returns false
 * if the logs were truncated or missing.
 */
function forEachTradeEvent(logs, onEvent) {
  if (!Array.isArray(logs)) return false;
  // Program-invocation stack, to know who emitted each line. Each frame also
  // records the programs it called directly (for the coin's token program).
  const stack = [];

  for (const line of logs) {
    if (typeof line !== 'string') continue;
    if (line.startsWith('Log truncated')) return false;

    let m = /^Program (\w+) invoke \[\d+\]$/.exec(line);
    if (m) {
      if (stack.length) stack[stack.length - 1].calls.add(m[1]);
      stack.push({ program: m[1], calls: new Set() });
      continue;
    }
    m = /^Program (\w+) (success|failed)/.exec(line);
    if (m) {
      if (stack.length && stack[stack.length - 1].program === m[1]) stack.pop();
      continue;
    }

    // Only trust event data emitted by the Pump.fun program itself — any
    // program could print a line that merely looks like one.
    const top = stack[stack.length - 1];
    if (!line.startsWith('Program data: ') || !top || top.program !== PUMP_PROGRAM_ID) continue;

    let buf;
    try {
      buf = Buffer.from(line.slice('Program data: '.length), 'base64');
    } catch {
      continue;
    }
    if (buf.length < MIN_EVENT_LEN || !buf.subarray(0, 8).equals(TRADE_EVENT_DISCRIMINATOR)) continue;

    onEvent(buf.subarray(8), top);
  }
  return true;
}

/** Price in SOL per (UI) token of a swap, from raw amounts; null if either is zero. */
function swapPrice(solLamports, tokenRaw, decimals) {
  const sol = Number(solLamports) / 1e9;
  const tokens = Number(tokenRaw) / 10 ** decimals;
  return sol > 0 && tokens > 0 ? sol / tokens : null;
}

module.exports = { decodePumpTradesFromLogs, decodePumpTradeDetails, decodePumpCurveHint, swapPrice, PUMP_PROGRAM_ID, TRADE_EVENT_DISCRIMINATOR };
