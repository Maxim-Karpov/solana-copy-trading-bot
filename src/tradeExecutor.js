// src/tradeExecutor.js
//
// Builds buy/sell transactions (via SolanaPortal's API, or directly on-chain
// for Pump.fun / Raydium when DIRECT_*_SWAP is enabled), signs them with the
// bot wallet, and submits them through Jito, or through Helius Sender when
// SEND_VIA="sender" (see heliusSender.js). Returns the transaction
// signature — callers are responsible for confirming it landed.

// Import bs58 in a way that works with both CommonJS and ES exports
let bs58;
{
  const imported = require('bs58');
  bs58 = imported.default ? imported.default : imported;
}

const { Keypair, PublicKey, VersionedTransaction } = require('@solana/web3.js');
const config = require('./config');
const { signTx } = require('./fastSign');
const quoteTokens = require('./quoteTokens');

// Trades in coins paired to another token (QUOTE_TOKENS): which token, and
// its SOL price when built, per signature, so the bot can value what was
// spent or received in SOL.
const quoteTrades = new Map();
function rememberQuoteTrade(signature, qt) {
  if (!signature || !qt) return;
  quoteTrades.set(signature, { quoteMint: qt.quoteMint, label: qt.label, lamportsPerRaw: qt.lamportsPerRaw || null });
  if (quoteTrades.size > 500) quoteTrades.delete(quoteTrades.keys().next().value);
}
/** { quoteMint, label, lamportsPerRaw } for one of our quote-token trades, or null. */
function quoteTradeOf(signature) {
  return quoteTrades.get(signature) || null;
}
const rpcPool = require('./rpcPool');
const computeBudget = require('./computeBudget');
const { info, warn } = require('./logger');
const { withTimeout, fetchJson } = require('./timeouts');
const pumpRoute = require('./pumpRoute');
const { buildRaydiumBuyTx, buildRaydiumSellTx, UnsupportedRaydiumTradeError } = require('./raydiumDirect');
const { prepareForSender, sendViaSender, startKeepAlive } = require('./heliusSender');
const { buildJupiterBuyTx, buildJupiterSellTx } = require('./jupiterSwap');
const { EntryPriceTooHighError, CoinFilteredError, checkCoinFilters, needsMcap } = require('./buyQuote');
const slotGuardMod = require('./slotGuard');
const SLOT_MS = 400; // Solana's target slot time

const PORTAL_TIMEOUT_MS = 10000;
// After SolanaPortal's SERVER fails (5xx, Cloudflare 52x, unreachable), skip
// it for this long and build with Jupiter straight away (JUPITER_FALLBACK).
const PORTAL_DOWN_SKIP_MS = 2 * 60 * 1000;
const portalDown = { until: 0, at: 0, reason: '' };
// A coin a direct builder can't handle (no standard Raydium pool, migrated
// curve, ...) isn't retried with that builder for this long.
const DIRECT_UNSUPPORTED_SKIP_MS = 10 * 60 * 1000;
const directUnsupported = new Map(); // `${label}:${mint}` -> { until, reason }
const JITO_TIMEOUT_MS = 10000;
const DIRECT_BUILD_TIMEOUT_MS = 8000;
// Compute-unit limits the direct builders set (used to turn PRIORITY_FEE_SOL
// into a per-unit price).
const PUMPFUN_CU_LIMIT = config.PUMPFUN_COMPUTE_UNITS; // curve or PumpSwap (default 300,000; a PumpSwap swap also wraps/unwraps SOL)
const RAYDIUM_CU_LIMIT = 400_000; // CLMM swaps that cross ticks need more than the standard pools

const USE_SENDER = config.SEND_VIA === 'sender';
if (USE_SENDER) startKeepAlive();

/**
 * Priority fee (SOL) for a trade: buys pay BUY_PRIORITY_FEE_SOL, or
 * BUY_PRIORITY_FEE_PCT of the amount when that is more; sells PRIORITY_FEE_SOL.
 */
function priorityFeeSol(side, amountSol = 0) {
  if (side !== 'buy') return config.PRIORITY_FEE_SOL;
  const pct = config.BUY_PRIORITY_FEE_PCT ? (Number(amountSol) || 0) * (config.BUY_PRIORITY_FEE_PCT / 100) : 0;
  return Math.max(config.BUY_PRIORITY_FEE_SOL, pct);
}

/** Tip to put on a transaction we build or request: Sender's when sending via Sender. */
function effectiveTip(tip) {
  return USE_SENDER ? config.SENDER_TIP : tip;
}

// Decode the private key and build the Keypair once at startup instead of on
// every buy/sell call.
const walletKeypair = Keypair.fromSecretKey(bs58.decode(config.PRIVATE_KEY));
const walletPublicKey = new PublicKey(config.PUBLIC_KEY);

// Connection for building direct on-chain swaps. Routed through rpcPool so
// it follows whichever RPC endpoint is currently active if
// SOLANA_RPC_FALLBACKS is set.
function getDirectConnection() {
  // 'processed': quote from the freshest pool state, so a price move that
  // just happened (often the copy wallet's own buy) is already priced in.
  return rpcPool.getConnection('processed');
}

/**
 * Thrown when we can't tell whether a transaction reached the network: the
 * request to Jito failed at the connection level or timed out, so it may
 * have been forwarded before the failure. Carries the transaction's
 * signature (known before sending) so the caller can check whether it
 * landed rather than blindly sending a second, duplicate transaction.
 */
class AmbiguousSendError extends Error {
  constructor(message, txSignature) {
    super(message);
    this.txSignature = txSignature;
  }
}

/**
 * Sign an already-built (unsigned) VersionedTransaction and submit it: via
 * Helius Sender when SEND_VIA="sender" and the transaction can be converted
 * for it, otherwise via Jito.
 */
function prepareAndSign(tx, { feeSol = config.PRIORITY_FEE_SOL } = {}) {
  let viaSender = false;
  if (USE_SENDER) {
    const prep = prepareForSender(tx, {
      tipLamports: config.SENDER_TIP * 1e9,
      priorityFeeLamports: feeSol * 1e9
    });
    if (prep.ok) {
      viaSender = true;
      tx = prep.tx;
    } else {
      warn(`[tradeExecutor] Can't send this transaction via Helius Sender (${prep.reason}); sending via Jito instead.`);
    }
  }

  signTx(tx, walletKeypair);
  // A transaction's signature is its id — known before we send it.
  const txSignature = bs58.encode(tx.signatures[0]);
  return { tx, viaSender, txSignature };
}

async function signAndSendTx(tx, opts = {}) {
  const prepared = prepareAndSign(tx, opts);
  tx = prepared.tx;
  const { viaSender, txSignature } = prepared;

  if (viaSender) {
    const raw = Buffer.from(tx.serialize());
    try {
      return await sendViaSender(raw.toString('base64'));
    } catch (err) {
      if (err.ambiguous) throw new AmbiguousSendError(err.message, txSignature);
      if (err.rateLimited) return sendViaRpcFallback(raw, txSignature);
      throw err;
    }
  }
  return sendSignedTxViaJito(bs58.encode(tx.serialize()), txSignature);
}

/**
 * Sender refused it (429): the same signed transaction through the regular
 * RPC instead (on paid Helius plans it goes out over staked connections).
 * Its Sender tip is still paid if it lands; that's cheaper than a lost trade.
 */
async function sendViaRpcFallback(raw, txSignature) {
  warn(`[tradeExecutor] Helius Sender is rate-limiting; sending ${txSignature.slice(0, 8)}… through your RPC instead.`);
  try {
    return await rpcPool.withFailover((c) => c.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 }));
  } catch (err) {
    // The request may have reached the RPC before failing: follow it by signature.
    throw new AmbiguousSendError(`RPC send after Sender's 429 failed (${err.message})`, txSignature);
  }
}

/** Submit an already-signed, bs58-encoded transaction via Jito. */
async function sendSignedTxViaJito(signedTxBs58, txSignature) {
  const jitoPayload = {
    jsonrpc: '2.0',
    id: 1,
    method: 'sendTransaction',
    params: [signedTxBs58]
  };

  let res;
  try {
    res = await fetchJson(
      config.JITO_ENGINE,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(jitoPayload)
      },
      JITO_TIMEOUT_MS
    );
  } catch (err) {
    throw new AmbiguousSendError(`Jito sendTransaction outcome unknown (${err.message})`, txSignature);
  }

  // Jito answered: an error status or error body is a definite rejection.
  if (!res.ok) {
    throw new Error(`Jito sendTransaction failed: ${res.status} ${res.statusText} | ${res.text.slice(0, 300)}`);
  }
  if (!res.data || !res.data.result) {
    throw new Error(`Jito did not return a result: ${res.text.slice(0, 300)}`);
  }
  return res.data.result;
}

/**
 * Sign & send a SolanaPortal-built transaction (Jito, or Helius Sender).
 * @param base64Txn  - base64-encoded VersionedTransaction from SolanaPortal
 * @returns          - signature string
 */
async function signAndSendPortalTx(base64Txn, opts = {}) {
  const txBuffer = Buffer.from(base64Txn, 'base64');
  const tx = VersionedTransaction.deserialize(txBuffer);
  return signAndSendTx(tx, opts);
}

/**
 * A short, readable reason for a SolanaPortal failure. Their errors from
 * Cloudflare come back as whole HTML pages; nobody needs those in a log line
 * or a Telegram message.
 */
function describePortalError(status, text = '') {
  const body = String(text || '');
  const html = /^\s*<(!doctype|html)/i.test(body) || /<html[\s>]/i.test(body);
  const cloudflare = {
    520: 'unknown error on their server',
    521: 'their server is down',
    522: 'their server timed out',
    523: 'their server is unreachable',
    524: 'their server took too long to answer',
    525: 'secure connection to their server failed',
    526: 'their server has an invalid security certificate'
  };
  if (cloudflare[status]) {
    return `SolanaPortal's own server is failing (Cloudflare ${status}: ${cloudflare[status]}). ` +
      'This is on their side, not your bot or settings; trades through SolanaPortal will fail until they fix it.';
  }
  if (status >= 500) return `SolanaPortal is having server problems (HTTP ${status}); try again shortly.`;
  if (html) {
    const title = /<title>([^<]{1,120})<\/title>/i.exec(body);
    return title ? `web page "${title[1].trim()}" instead of a transaction` : 'a web page instead of a transaction';
  }
  return body.slice(0, 300);
}

/**
 * Call SolanaPortal trading endpoint to get a VersionedTransaction (base64).
 * @param params  - { wallet_address, action, dex, mint, amount, slippage, tip, type }
 * @returns       - base64-encoded VersionedTransaction
 */
async function getPortalTxn(params) {
  const url = 'https://api.solanaportal.io/api/trading';
  let res;
  try {
    res = await fetchJson(
      url,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params)
      },
      PORTAL_TIMEOUT_MS
    );
  } catch (err) {
    const e = new Error(`SolanaPortal unreachable (${err.message})`);
    e.portalDown = true;
    throw e;
  }
  if (!res.ok) {
    const e = new Error(`SolanaPortal responded ${res.status}${res.statusText ? ` ${res.statusText}` : ''}: ${describePortalError(res.status, res.text)}`);
    e.portalDown = res.status >= 500; // their server, not this request
    throw e;
  }
  if (typeof res.data !== 'string') {
    throw new Error(`SolanaPortal returned an unexpected response: ${describePortalError(res.status, res.text)}`);
  }
  return res.data; // base64 VersionedTransaction
}

/**
 * Try to BUILD a direct on-chain transaction for this trade. Returns the
 * unsigned tx, or null if the direct path doesn't apply or can't build it
 * (in which case the caller uses SolanaPortal).
 *
 * Only building is allowed to fall back. Once a transaction has been
 * submitted, a send error is NOT retried through SolanaPortal here: a
 * timeout or dropped connection after the request went out could mean the
 * first transaction is actually landing, and sending a second one would
 * double the buy (or sell). The caller confirms and retries instead.
 */
/** Where a trade goes when it isn't built directly, for log lines. */
function nextRouteText(side) {
  const portal = config.USE_SOLANAPORTAL[side];
  const jup = config.JUPITER_FALLBACK[side];
  if (portal) return jup ? 'using SolanaPortal (Jupiter as backup)' : 'using SolanaPortal';
  return jup ? `using Jupiter (SolanaPortal is off for ${side}s)` : `no other route is switched on for ${side}s`;
}

// Why the last direct build of a coin didn't happen (for a clear skip message).
const lastDirectMiss = new Map(); // mint -> reason
function noteDirectMiss(mint, reason) {
  lastDirectMiss.set(mint, reason);
  if (lastDirectMiss.size > 200) lastDirectMiss.delete(lastDirectMiss.keys().next().value);
}

async function tryBuildDirect(side, { mint, amountSol, amountTokens, slippage, tip, venue, pool, curveHint = null, guardInstructions = null, fastHint = null, coinFilter = null }) {
  let builder = null;
  let isUnsupported = null;
  let label = null;

  // The copy wallet's own transaction says which program it traded on
  // (`pool`: 'pump-curve', 'pumpswap', 'launchlab', 'clmm', ...), so the
  // matching builder is used straight away rather than tried in turn.
  if (config.DIRECT_PUMPFUN_SWAP && venue === 'pumpfun') {
    builder = (args) => pumpRoute.buildPumpTx(side, args, pool);
    isUnsupported = pumpRoute.isUnsupported;
    label = 'Pump.fun';
  } else if (config.DIRECT_RAYDIUM_SWAP && venue === 'raydium') {
    builder = side === 'buy' ? buildRaydiumBuyTx : buildRaydiumSellTx;
    isUnsupported = (err) => err instanceof UnsupportedRaydiumTradeError;
    label = 'Raydium';
  }
  if (!builder) {
    if (venue === 'pumpfun' || venue === 'raydium') {
      const setting = venue === 'pumpfun' ? 'DIRECT_PUMPFUN_SWAP' : 'DIRECT_RAYDIUM_SWAP';
      info(`[tradeExecutor] ${setting} is off, so this ${venue === 'pumpfun' ? 'Pump.fun' : 'Raydium'} ${side} is ${nextRouteText(side)}.`);
      noteDirectMiss(mint, `${setting} is off`);
    } else {
      noteDirectMiss(mint, `it trades on ${venue || 'a venue'} the bot can't build directly`);
    }
    return null;
  }

  const cacheKey = `${label}:${mint}`;
  const known = directUnsupported.get(cacheKey);
  if (known && Date.now() < known.until) {
    info(`[tradeExecutor] Direct ${label} not possible for ${mint} (${known.reason}, checked earlier); ${nextRouteText(side)}.`);
    noteDirectMiss(mint, known.reason);
    return null;
  }

  try {
    info(`[tradeExecutor] Building direct ${label} ${side.toUpperCase()} (bypassing SolanaPortal)...`);
    const args = {
      connection: getDirectConnection(),
      user: walletPublicKey,
      mint,
      slippagePct: slippage,
      tipSol: effectiveTip(tip)
    };
    const cuLimit = label === 'Pump.fun' ? PUMPFUN_CU_LIMIT : RAYDIUM_CU_LIMIT;
    args.computeUnitLimit = cuLimit;
    const feeSol = priorityFeeSol(side, amountSol);
    if (feeSol > 0) {
      // Total fee in lamports spread over the compute-unit limit, in micro-lamports per unit.
      args.priorityFeeMicroLamports = Math.ceil((feeSol * 1e9 * 1e6) / cuLimit);
    }
    if (side === 'buy') {
      args.solAmount = amountSol;
      if (curveHint && label === 'Pump.fun') args.curveHint = curveHint;
      if (fastHint && label === 'Pump.fun') {
        args.fastHint = fastHint;
        args.maxMcapSol = coinFilter ? coinFilter.maxMcapSol : null;
        args.minMcapSol = coinFilter ? coinFilter.minMcapSol : null;
        args.blockedCreators = coinFilter ? coinFilter.blockedCreators : null;
      }
      if (guardInstructions && guardInstructions.length) args.guardInstructions = guardInstructions;
    } else args.tokenAmountUi = amountTokens;
    const tx = await withTimeout(builder(args), DIRECT_BUILD_TIMEOUT_MS, `Direct ${label} build`);
    // AUTO_COMPUTE_UNITS: the limit this kind of trade really needs.
    const fitted = computeBudget.fit(tx, side, Math.round(feeSol * 1e9));
    tx.compute = { ...fitted, feeSol };
    return { tx, label: tx.routeLabel || (label === 'Pump.fun' ? 'Pump.fun curve' : label), builtFrom: tx.builtFrom || null }; // e.g. PumpSwap, Raydium LaunchLab
  } catch (err) {
    const unsupported = isUnsupported(err);
    const reason = unsupported ? err.message : `error: ${err.message}`;
    if (unsupported) {
      directUnsupported.set(cacheKey, { until: Date.now() + DIRECT_UNSUPPORTED_SKIP_MS, reason: err.message.replace(` for ${mint}`, '').slice(0, 100) });
      if (directUnsupported.size > 500) directUnsupported.delete(directUnsupported.keys().next().value);
    }
    warn(`[tradeExecutor] Direct ${label} ${side} unavailable for ${mint} (${reason}); ${nextRouteText(side)}.`);
    noteDirectMiss(mint, reason.replace(`${mint} `, 'it ').replace(` for ${mint}`, ''));
    return null;
  }
}

/**
 * SolanaPortal builds the trade (unless USE_SOLANAPORTAL=false); if it CAN'T
 * (down, timeout, refusal) and JUPITER_FALLBACK is on, Jupiter builds it
 * instead. With SolanaPortal off, Jupiter (if on) builds it straight away. Only building falls
 * back: nothing has been signed or sent when SolanaPortal fails, so there's
 * no risk of a double trade. Once a transaction is sent, send errors go to
 * the caller as usual.
 */
async function sendViaPortalOrJupiter(side, portalParams, buildJupiter) {
  const SIDE = side.toUpperCase();
  const sendOpts = { feeSol: priorityFeeSol(side, portalParams && portalParams.amount) };
  const portalOn = config.USE_SOLANAPORTAL[side];
  const jupiterOn = config.JUPITER_FALLBACK[side];
  if (!portalOn) {
    if (!jupiterOn) {
      throw new Error(
        `No route for this ${side}: the direct builders can't handle this coin, and neither SolanaPortal ` +
          `(USE_SOLANAPORTAL) nor Jupiter (JUPITER_FALLBACK) is switched on for ${side}s`
      );
    }
    const tJup = Date.now();
    const built = await buildJupiter().catch((err) => {
      throw new Error(`Jupiter couldn't build the ${side} (${err.message}); SolanaPortal is off for ${side}s`);
    });
    const builtMs = Date.now() - tJup;
    const signature = await signAndSendTx(built.tx, sendOpts);
    info(`[tradeExecutor] ${SIDE} txn sent via Jupiter (route: ${built.route}; built in ${builtMs}ms; SolanaPortal is off for ${side}s): https://solscan.io/tx/${signature}`);
    return signature;
  }
  let portalBase64;
  const tPortal = Date.now();
  try {
    if (jupiterOn && Date.now() < portalDown.until) {
      // SolanaPortal's server failed moments ago: don't spend another
      // round-trip finding out it still does, go straight to Jupiter.
      const e = new Error(`SolanaPortal skipped: its server failed ${Math.round((Date.now() - portalDown.at) / 1000)}s ago (${portalDown.reason})`);
      e.skipped = true;
      throw e;
    }
    portalBase64 = await getPortalTxn(portalParams);
    portalDown.until = 0;
  } catch (portalErr) {
    if (!jupiterOn) throw portalErr;
    if (portalErr.portalDown) {
      portalDown.at = Date.now();
      portalDown.until = Date.now() + PORTAL_DOWN_SKIP_MS;
      portalDown.reason = portalErr.message.slice(0, 120);
    }
    if (portalErr.skipped) {
      info(`[tradeExecutor] ${portalErr.message}; building the ${side} with Jupiter (SolanaPortal is retried after ${PORTAL_DOWN_SKIP_MS / 1000}s).`);
    } else {
      warn(`[tradeExecutor] SolanaPortal couldn't build the ${side} after ${Date.now() - tPortal}ms (${portalErr.message}); trying Jupiter instead...`);
    }
    let built;
    const tJup = Date.now();
    try {
      built = await buildJupiter();
    } catch (jupErr) {
      throw new Error(`SolanaPortal failed (${portalErr.message}) and the Jupiter backup failed too (${jupErr.message})`);
    }
    const builtMs = Date.now() - tJup;
    const signature = await signAndSendTx(built.tx, sendOpts);
    info(`[tradeExecutor] ${SIDE} txn sent via Jupiter backup (route: ${built.route}; built in ${builtMs}ms): https://solscan.io/tx/${signature}`);
    return signature;
  }
  const builtMs = Date.now() - tPortal;
  const signature = await signAndSendPortalTx(portalBase64, sendOpts);
  info(`[tradeExecutor] ${SIDE} txn sent via SolanaPortal (built in ${builtMs}ms): https://solscan.io/tx/${signature}`);
  return signature;
}

/**
 * Buy a token. Returns the signature string.
 * @param mint        - token mint address
 * @param amountSol   - SOL amount to spend
 * @param slippage    - percent
 * @param tip         - SOL tip for Jito
 * @param dex         - value sent to SolanaPortal ('pumpfun', 'auto', etc.)
 * @param venue       - where the copied trade actually executed; selects the
 *                      direct-swap path (defaults to `dex`)
 */
/**
 * MAX_ENTRY_PREMIUM_PCT: refuse a built buy whose expected price per token is
 * more than the allowed premium above the copy wallet's. Uses the quote the
 * builder already computed, so it costs nothing. Throws EntryPriceTooHighError.
 */
function checkEntryPrice(tx, label, priceCheck) {
  if (!priceCheck) return;
  const quote = tx && tx.quote;
  if (!quote || !(quote.priceSol > 0)) {
    info(`[tradeExecutor] MAX_ENTRY_PREMIUM_PCT: ${label} gives no quote to check against; buying without the price check.`);
    return;
  }
  const premiumPct = (quote.priceSol / priceCheck.copyPriceSol - 1) * 100;
  const text = `${premiumPct >= 0 ? '+' : ''}${premiumPct.toFixed(1)}% vs the copy wallet's price (max ${priceCheck.maxPct}%)`;
  if (premiumPct > priceCheck.maxPct) {
    throw new EntryPriceTooHighError(`price is ${text}`, { premiumPct, maxPct: priceCheck.maxPct });
  }
  info(`[tradeExecutor] Entry price check passed: ${text}.`);
}

// signature -> { buildMs, sendMs, sentAt }: how long the bot's own steps
// took for a recent buy (index.js reports it with the result).
const buyTimings = new Map();
function rememberTiming(signature, t) {
  buyTimings.set(signature, t);
  if (buyTimings.size > 200) buyTimings.delete(buyTimings.keys().next().value);
}
function buyTiming(signature) {
  return buyTimings.get(signature) || null;
}

/**
 * @param priceCheck - optional { copyPriceSol, maxPct } (MAX_ENTRY_PREMIUM_PCT);
 *                     only direct builds can be checked.
 * @param curveHint  - optional: the coin's curve from the copy wallet's
 *                     Pump.fun trade record (processed feed), so a direct
 *                     Pump.fun buy needs no lookups.
 * @param coinFilter - optional { minMcapSol, maxMcapSol, blockedCreators }
 *                     (instant buy filters); checked before anything is sent.
 * @param slotGuard  - optional { maxSlot, seenAt, slotsAllowed }
 *                     (MAX_SLOTS_BEHIND): the buy is cancelled on-chain if it
 *                     lands after maxSlot, and not sent at all if it's
 *                     already clearly too late.
 */
async function buyToken({ mint, amountSol, slippage, tip, dex, venue, pool = null, priceCheck = null, curveHint = null, coinFilter = null, slotGuard = null, fastHint = null, dryRun = false }) {
  const route = venue || dex;
  info(
    `[tradeExecutor] ${dryRun ? 'Rehearsing (paused: built and signed, NOT sent) a' : 'Placing'} BUY order: mint=${mint}, amountSol=${amountSol}, ` +
      `dex=${dex}, venue=${route}, slippage=${slippage}%, tip=${effectiveTip(tip)} SOL via ${USE_SENDER ? 'Helius Sender' : 'Jito'}, ` +
      `priority fee=${+priorityFeeSol('buy', amountSol).toFixed(6)} SOL ` +
      `(${Math.round((priorityFeeSol('buy', amountSol) * 1e9) / PUMPFUN_CU_LIMIT)} lamports per compute unit on a Pump.fun buy)`
  );

  const t0 = Date.now();
  const guardInstructions = slotGuard ? [slotGuardMod.maxSlotInstruction(slotGuard.maxSlot)] : null;
  const directTx = await tryBuildDirect('buy', { mint, amountSol, slippage, tip, venue: route, pool, curveHint, guardInstructions, fastHint, coinFilter });
  // No direct build and no other route for buys: say why it can't be bought
  // at all (e.g. a coin paired to another token instead of SOL), rather
  // than blaming the slot guard.
  if (!directTx && !config.USE_SOLANAPORTAL.buy && !config.JUPITER_FALLBACK.buy) {
    const why = lastDirectMiss.get(mint) || 'no direct build';
    throw new CoinFilteredError(`No route for this buy: ${why}, and neither SolanaPortal nor Jupiter is switched on for buys`, {
      setting: 'direct builders only',
      short: `can't be bought (${why.length > 80 ? `${why.slice(0, 80)}…` : why})`
    });
  }
  if (slotGuard && !(directTx && typeof directTx.tx.guardIxIndex === 'number')) {
    throw new CoinFilteredError(
      `the slot guard can only be added to direct Pump.fun / PumpSwap buys (${directTx ? directTx.label : 'no direct build'})`,
      { setting: 'MAX_SLOTS_BEHIND', short: 'the slot guard works only on Pump.fun / PumpSwap buys' }
    );
  }
  // A rehearsal never goes through SolanaPortal or Jupiter (that would send it).
  if (!directTx && dryRun) return { dryRun: true, noDirect: true, why: lastDirectMiss.get(mint) || 'no direct build' };
  if (directTx && directTx.tx.quoteTrade && directTx.tx.quoteTrade.spendRaw) {
    // Paid from a QUOTE_TOKENS reserve: whatever happens below, the amount
    // set aside is released (as spent once the buy has gone out).
    const qt = directTx.tx.quoteTrade;
    let sent = false;
    try {
      return await sendDirectBuy(directTx, { mint, amountSol, coinFilter, priceCheck, slotGuard, t0, dryRun, onSent: () => { sent = true; } });
    } catch (err) {
      if (err && err.txSignature) sent = true;
      throw err;
    } finally {
      quoteTokens.release(qt.quoteMint, qt.spendRaw, { spent: sent });
      if (sent) quoteTokens.afterTrade(qt.quoteMint);
    }
  }
  if (directTx) return sendDirectBuy(directTx, { mint, amountSol, coinFilter, priceCheck, slotGuard, t0, dryRun });

  // No direct build: the market cap isn't known without a lookup.
  if (needsMcap(coinFilter)) checkCoinFilters(null, null, coinFilter, mint);
  if (priceCheck) {
    info('[tradeExecutor] MAX_ENTRY_PREMIUM_PCT only checks direct builds; this buy goes ahead without the price check.');
  }
  const params = {
    wallet_address: config.PUBLIC_KEY,
    action: 'buy',
    dex,
    mint,
    amount: amountSol,
    slippage,
    // Via Sender, the portal's Jito tip is redirected to Sender (and needs Sender's amount).
    tip: effectiveTip(tip),
    type: 'jito'
  };
  return sendViaPortalOrJupiter('buy', params, () =>
    buildJupiterBuyTx({ user: walletPublicKey, mint, amountSol, slippagePct: slippage, tipSol: effectiveTip(tip) })
  );
}

function rememberCompute(signature, tx) {
  if (tx && tx.compute) computeBudget.remember(signature, tx.compute.kind, tx.compute.limit, tx.compute.learned);
}

/** "; compute limit 96,400 (learned), 15 lamports per unit" */
function computeText(tx) {
  const c = tx && tx.compute;
  if (!c || !c.limit) return '';
  const perUnit = c.feeSol > 0 ? `, ${Math.round((c.feeSol * 1e9) / c.limit)} lamports per unit` : '';
  return `; compute limit ${c.limit.toLocaleString('en-US')}${c.learned ? ' (learned)' : ''}${perUnit}`;
}

/** Filters, lateness check, then sign and send a directly built buy. */
async function sendDirectBuy(directTx, { mint, amountSol, coinFilter, priceCheck, slotGuard, t0, dryRun = false, onSent = () => {} }) {
  {
    checkCoinFilters(directTx.tx, directTx.label, coinFilter, mint);
    checkEntryPrice(directTx.tx, directTx.label, priceCheck);
    if (slotGuard && typeof slotGuard.seenAt === 'number') {
      // Already well past the last allowed slot: don't pay a fee for a buy
      // the guard would cancel. (Time since WE saw his trade understates how
      // late we are, so this never skips a buy that could still make it.)
      const lateMs = Date.now() - slotGuard.seenAt;
      if (lateMs > (slotGuard.slotsAllowed + 1) * SLOT_MS) {
        throw new CoinFilteredError(`${lateMs}ms after his trade is too late for MAX_SLOTS_BEHIND=${slotGuard.slotsAllowed}`, {
          setting: 'MAX_SLOTS_BEHIND',
          short: `too late to land within ${slotGuard.slotsAllowed} slot(s) of his buy`
        });
      }
    }
    const builtMs = Date.now() - t0;
    if (dryRun) {
      // Everything a real send does up to the network call: Sender's tip and
      // fee, signing, and the bytes that would go out. Nothing is sent.
      const tSign = Date.now();
      const { tx } = prepareAndSign(directTx.tx, { feeSol: priorityFeeSol('buy', amountSol) });
      tx.serialize();
      const readyAt = Date.now();
      info(`[tradeExecutor] Rehearsal: ${directTx.label} BUY built in ${builtMs}ms and signed in ${readyAt - tSign}ms; not sent (buying is paused).`);
      return { dryRun: true, buildMs: builtMs, signMs: readyAt - tSign, readyAt, label: directTx.label };
    }
    const guardInfo = slotGuard ? { maxSlot: slotGuard.maxSlot, ixIndex: directTx.tx.guardIxIndex } : null;
    const tSend = Date.now();
    let signature;
    try {
      signature = await signAndSendTx(directTx.tx, { feeSol: priorityFeeSol('buy', amountSol) });
    } catch (err) {
      if (guardInfo && err && err.txSignature) slotGuardMod.remember(err.txSignature, guardInfo);
      if (err && err.txSignature) rememberTiming(err.txSignature, { buildMs: builtMs, sendMs: Date.now() - tSend, sentAt: tSend });
      if (err && err.txSignature) rememberQuoteTrade(err.txSignature, directTx.tx.quoteTrade);
      if (err && err.txSignature) rememberCompute(err.txSignature, directTx.tx);
      throw err;
    }
    onSent();
    rememberCompute(signature, directTx.tx);
    if (guardInfo) slotGuardMod.remember(signature, guardInfo);
    rememberTiming(signature, { buildMs: builtMs, sendMs: Date.now() - tSend, sentAt: tSend });
    rememberQuoteTrade(signature, directTx.tx.quoteTrade);
    const from = directTx.builtFrom ? `, ${directTx.builtFrom}` : '';
    info(`[tradeExecutor] BUY txn sent via ${directTx.label} direct (built by the bot in ${builtMs}ms${from}${computeText(directTx.tx)}): https://solscan.io/tx/${signature}`);
    return signature;
  }
}

/**
 * Sell a token. Returns the signature string.
 * @param mint          - token mint address
 * @param amountTokens  - number of tokens to sell (exact UI decimal string)
 * @param slippage      - percent
 * @param tip           - SOL tip for Jito
 * @param dex           - value sent to SolanaPortal
 * @param venue         - where the position's token trades (direct path)
 */
async function sellToken({ mint, amountTokens, slippage, tip, dex, venue, pool = null }) {
  const route = venue || dex;
  info(
    `[tradeExecutor] Placing SELL order: mint=${mint}, tokenAmount=${amountTokens}, ` +
      `dex=${dex}, venue=${route}, slippage=${slippage}%, tip=${effectiveTip(tip)} SOL via ${USE_SENDER ? 'Helius Sender' : 'Jito'}`
  );

  const t0 = Date.now();
  const directTx = await tryBuildDirect('sell', { mint, amountTokens, slippage, tip, venue: route, pool });
  if (directTx) {
    const builtMs = Date.now() - t0;
    const qt = directTx.tx.quoteTrade || null;
    let signature;
    try {
      signature = await signAndSendTx(directTx.tx);
    } catch (err) {
      if (err && err.txSignature) rememberQuoteTrade(err.txSignature, qt);
      if (err && err.txSignature) rememberCompute(err.txSignature, directTx.tx);
      throw err;
    }
    rememberQuoteTrade(signature, qt);
    rememberCompute(signature, directTx.tx);
    if (qt) quoteTokens.afterTrade(qt.quoteMint);
    info(
      `[tradeExecutor] SELL txn sent via ${directTx.label} direct (built by the bot in ${builtMs}ms${qt ? `; paid out in ${qt.label}` : ''}${computeText(directTx.tx)}): https://solscan.io/tx/${signature}`
    );
    return signature;
  }

  const params = {
    wallet_address: config.PUBLIC_KEY,
    action: 'sell',
    dex,
    mint,
    amount: amountTokens,
    slippage,
    // Via Sender, the portal's Jito tip is redirected to Sender (and needs Sender's amount).
    tip: effectiveTip(tip),
    type: 'jito'
  };
  return sendViaPortalOrJupiter('sell', params, () =>
    buildJupiterSellTx({ user: walletPublicKey, mint, tokenAmountUi: amountTokens, slippagePct: slippage, tipSol: effectiveTip(tip) })
  );
}

/** Buy `amountSol` SOL of a token via Jupiter (QUOTE_TOKENS reserves). Returns the signature. */
async function buyTokenViaJupiter(mint, amountSol) {
  const built = await buildJupiterBuyTx({ user: walletPublicKey, mint, amountSol, slippagePct: 2, tipSol: effectiveTip(config.JITO_TIP) });
  return signAndSendTx(built.tx);
}

module.exports = {
  priorityFeeSol,
  quoteTradeOf,
  buyTokenViaJupiter,
  buyTiming,
  EntryPriceTooHighError,
  CoinFilteredError,
  checkCoinFilters,
  checkEntryPrice,
  _resetForTests: () => { portalDown.until = 0; directUnsupported.clear(); },
  describePortalError, buyToken, sellToken, signAndSendTx, AmbiguousSendError };
