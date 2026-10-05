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
const { prepareForSender, sendViaSender, startKeepAlive, SENDER_TIP_ACCOUNTS } = require('./heliusSender');
const { buildJupiterBuyTx, buildJupiterSellTx } = require('./jupiterSwap');
const { EntryPriceTooHighError, CoinFilteredError, checkCoinFilters, needsMcap } = require('./buyQuote');
const slotGuardMod = require('./slotGuard');
const { randomTipAccount, JITO_TIP_ACCOUNTS } = require('./jitoTip');
const SLOT_MS = 400; // Solana's target slot time

const PORTAL_TIMEOUT_MS = 10000;
// After SolanaPortal's SERVER fails (5xx, Cloudflare 52x, unreachable), skip
// it for this long and build with Jupiter straight away (JUPITER_FALLBACK).
const PORTAL_DOWN_SKIP_MS = 2 * 60 * 1000;
const portalDown = { until: 0, at: 0, reason: '' };
// A coin a direct builder can't handle (no standard Raydium pool, migrated
// curve, ...) isn't retried with that builder for this long.
const DIRECT_UNSUPPORTED_SKIP_MS = 10 * 60 * 1000;
const directUnsupported = new Map(); // `${label}:${side}:${mint}` -> { until, reason }
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
  if (tx.handBuilt) {
    // Written for its route already (Sender's tip and fee, or Jito's).
    tx.sign(walletKeypair);
    return { tx, viaSender: USE_SENDER, txSignature: bs58.encode(tx.signatures[0]) };
  }
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
      return await sendViaSender(raw.toString('base64'), { hedge: () => sendViaRpcFallback(raw, txSignature) });
    } catch (err) {
      if (err.ambiguous) throw new AmbiguousSendError(err.message, txSignature);
      if (err.rateLimited) return sendViaRpcFallback(raw, txSignature);
      throw err;
    }
  }
  // base64: Jito accepts it, and it's ~1 ms quicker to encode than base58.
  return sendSignedTxViaJito(Buffer.from(tx.serialize()).toString('base64'), txSignature, 'base64');
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

/** Submit an already-signed transaction via Jito (base58 text unless `encoding` is 'base64'). */
async function sendSignedTxViaJito(signedTx, txSignature, encoding = 'base58') {
  const jitoPayload = {
    jsonrpc: '2.0',
    id: 1,
    method: 'sendTransaction',
    params: encoding === 'base64' ? [signedTx, { encoding: 'base64' }] : [signedTx]
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

  // A gateway error may come after Jito already forwarded it: follow it.
  if (res.status >= 500) {
    throw new AmbiguousSendError(`Jito answered ${res.status} ${res.statusText}; outcome unknown`, txSignature);
  }
  // Otherwise an error status or error body is a definite rejection.
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

async function tryBuildDirect(side, { mint, amountSol, amountTokens, slippage, tip, venue, pool, curveHint = null, guardInstructions = null, fastHint = null, coinFilter = null, warm = false }) {
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

  // Per side: a reason a buy can't be built (e.g. fast-path hints) mustn't send this coin's sells elsewhere.
  const cacheKey = `${label}:${side}:${mint}`;
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
        if (config.HAND_BUILT_BUYS) args.handBuilt = handBuiltPlan(feeSol, cuLimit, args.tipSol);
      }
      if (guardInstructions && guardInstructions.length) args.guardInstructions = guardInstructions;
    } else {
      args.tokenAmountUi = amountTokens;
      if (warm && label === 'Pump.fun') args.warm = true; // INSTANT_SELL: the state read when the buy went out
    }
    const tx = await withTimeout(builder(args), DIRECT_BUILD_TIMEOUT_MS, `Direct ${label} build`);
    // AUTO_COMPUTE_UNITS: the limit this kind of trade really needs (a
    // hand-built buy was sized as it was written).
    if (!tx.handBuilt) {
      const fitted = computeBudget.fit(tx, side, Math.round(feeSol * 1e9));
      tx.compute = { ...fitted, feeSol };
    }
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

/** What a hand-built buy needs to be written for its route: fee, compute ceiling, Sender or Jito, the tip. */
function handBuiltPlan(feeSol, ceiling, tipSol) {
  const tip = USE_SENDER
    ? { account: SENDER_TIP_ACCOUNTS[Math.floor(Math.random() * SENDER_TIP_ACCOUNTS.length)], lamports: Math.round(config.SENDER_TIP * 1e9) }
    : tipSol > 0
      ? { account: randomTipAccount().toBase58(), lamports: Math.round(tipSol * 1e9) }
      : null;
  return { feeSol, ceiling, useSender: USE_SENDER, tip };
}

/**
 * Practice + self-check for hand-built buys (prewarm.js, every practice
 * build): refresh the template from the SDK, build the same practice buy
 * both ways, and compare. Any difference switches hand-built buys off for
 * the run. Nothing is sent. Returns { ok, handMs, sdkMs } or null.
 */
let handCheckLogged = false;
async function practiceHandBuilt() {
  if (!config.HAND_BUILT_BUYS || !config.DIRECT_PUMPFUN_SWAP || !config.SHRED_FAST_BUY) return null;
  const pumpBuyRaw = require('./pumpBuyRaw');
  if (pumpBuyRaw.status().disabled) return null;
  const { prepareHandBuilt, buildPumpfunBuyTx } = require('./pumpfunDirect');
  if (!(await prepareHandBuilt(walletPublicKey))) {
    if (pumpBuyRaw.status().disabled && !handCheckLogged) {
      handCheckLogged = true;
      warn(`[tradeExecutor] Hand-built Pump.fun buys are off: ${pumpBuyRaw.status().disabled}. Buys use Pump.fun's SDK instead.`);
    }
    return null;
  }
  const result = await compareHandBuilt(buildPumpfunBuyTx, pumpBuyRaw);
  if (!result) return null;
  if (!result.ok) {
    pumpBuyRaw.disable(result.why);
    warn(`[tradeExecutor] Hand-built Pump.fun buys are off: ${result.why}. Buys use Pump.fun's SDK instead.`);
  } else if (!handCheckLogged) {
    handCheckLogged = true;
    info(
      `[tradeExecutor] Hand-built Pump.fun buys on (SHRED_FAST_BUY): checked identical to the SDK's; ` +
        `build+sign ${result.handMs.toFixed(2)} ms vs ${result.sdkMs.toFixed(2)} ms the SDK way.`
    );
  }
  return result;
}

/** The same practice buy built both ways, compared instruction by instruction. */
async function compareHandBuilt(buildPumpfunBuyTx, pumpBuyRaw) {
  const { performance } = require('perf_hooks');
  const { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID: SPL, TOKEN_2022_PROGRAM_ID: T22 } = require('@solana/spl-token');
  const sdk = require('@pump-fun/pump-sdk');
  const prewarm = require('./prewarm');
  const global = prewarm.pumpGlobal();
  if (!global || !prewarm.blockhash()) return null;
  const mint = Keypair.generate().publicKey;
  const prog = Math.random() < 0.5 ? SPL : T22;
  const curve = sdk.bondingCurvePda(mint);
  const fastHint = {
    mint: mint.toBase58(),
    creatorVault: sdk.creatorVaultPda(Keypair.generate().publicKey).toBase58(),
    txKeys: [curve, getAssociatedTokenAddressSync(mint, curve, true, prog), sdk.bondingCurveV2Pda(mint), global.feeRecipient].map((k) => k.toBase58())
  };
  const feeSol = priorityFeeSol('buy', 0.01);
  const ceiling = PUMPFUN_CU_LIMIT;
  const guardInstructions = [slotGuardMod.maxSlotInstruction(123456789)];
  const base = {
    connection: getDirectConnection(),
    user: walletPublicKey,
    mint: mint.toBase58(),
    solAmount: 0.01,
    slippagePct: 20,
    tipSol: effectiveTip(config.JITO_TIP),
    computeUnitLimit: ceiling,
    priorityFeeMicroLamports: feeSol > 0 ? Math.ceil((feeSol * 1e9 * 1e6) / ceiling) : 0,
    fastHint,
    maxMcapSol: 1000,
    minMcapSol: null,
    guardInstructions
  };
  // The SDK route, as a real buy goes: build, size, Sender's preparation.
  const t0 = performance.now();
  const sdkTx = await buildPumpfunBuyTx(base);
  if (!/no lookup/.test(sdkTx.builtFrom || '')) return { ok: false, why: 'the practice buy did not take the no-lookup route' };
  computeBudget.fit(sdkTx, 'buy', Math.round(feeSol * 1e9));
  const sdkSigned = prepareAndSign(sdkTx, { feeSol }).tx;
  sdkSigned.serialize();
  const t1 = performance.now();
  const handTx = await buildPumpfunBuyTx({ ...base, handBuilt: handBuiltPlan(feeSol, ceiling, base.tipSol) });
  if (!handTx.handBuilt) return { ok: false, why: `the practice buy wasn't hand-built (${handTx.builtFrom || 'SDK route'})` };
  const { tx: handSigned } = prepareAndSign(handTx, { feeSol });
  const raw = handSigned.serialize();
  const t2 = performance.now();
  // Compare what each transaction does.
  let handParsed;
  try {
    handParsed = VersionedTransaction.deserialize(raw);
  } catch (err) {
    return { ok: false, why: `the hand-built transaction can't be read back (${err.message})` };
  }
  const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), walletPublicKey.toBuffer()]);
  const pub = require('crypto').createPublicKey({ key: spki, format: 'der', type: 'spki' });
  if (!require('crypto').verify(null, Buffer.from(handParsed.message.serialize()), pub, Buffer.from(handParsed.signatures[0]))) {
    return { ok: false, why: 'the hand-built signature does not verify' };
  }
  const recipients = new Set(require('./pumpfunDirect').recipientsOf(global).normal);
  const tips = new Set((USE_SENDER ? SENDER_TIP_ACCOUNTS : JITO_TIP_ACCOUNTS).map(String));
  const a = describeForCompare(sdkSigned, recipients, tips);
  const b = describeForCompare(handParsed, recipients, tips);
  if (a !== b) return { ok: false, why: `it differs from the SDK's transaction (${firstDifference(a, b)})` };
  return { ok: true, sdkMs: t1 - t0, handMs: t2 - t1 };
}

/**
 * FAST_PATH="rust": the same practice buy built here (hand-built) and by the
 * Rust fast path, with the same inputs; the signed bytes must be identical.
 * Returns { ok, why, rustUs } or null if not ready.
 */
async function compareWithRust(fastPath) {
  const pumpBuyRaw = require('./pumpBuyRaw');
  const prewarm = require('./prewarm');
  const { minTokensAtMcap, recipientsOf } = require('./pumpfunDirect');
  const { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID: SPL, TOKEN_2022_PROGRAM_ID: T22 } = require('@solana/spl-token');
  const sdk = require('@pump-fun/pump-sdk');
  const global = prewarm.pumpGlobal();
  const blockhash = prewarm.blockhash();
  if (!global || !blockhash || !pumpBuyRaw.ready(walletPublicKey)) return null;
  const results = [];
  for (const [prog, guarded] of [[T22, true], [SPL, false]]) {
    const mint = Keypair.generate().publicKey;
    const curve = sdk.bondingCurvePda(mint);
    const feeRecipient = recipientsOf(global).normal[0];
    const txKeys = [curve, getAssociatedTokenAddressSync(mint, curve, true, prog), sdk.bondingCurveV2Pda(mint), new PublicKey(feeRecipient)].map((k) => k.toBase58());
    const creatorVault = sdk.creatorVaultPda(Keypair.generate().publicKey).toBase58();
    const lamports = 123456789n;
    const maxMcapSol = config.MAX_MARKET_CAP_SOL || 300;
    const feeSol = priorityFeeSol('buy', 0.123456789);
    const ceiling = PUMPFUN_CU_LIMIT;
    const plan = handBuiltPlan(feeSol, ceiling, effectiveTip(config.JITO_TIP));
    const guardMaxSlot = guarded ? 987654321 : null;
    const kind = `buy|${guarded ? 'L2TExM+' : ''}AToken+6EF8rr|${prog.equals(T22) ? 't22' : 'spl'}|a18`;
    const mine = pumpBuyRaw.buildBuy({
      user: walletPublicKey,
      mint: mint.toBase58(),
      txKeys,
      creatorVault,
      feeRecipients: [new PublicKey(feeRecipient).toBuffer()],
      lamports,
      minOut: minTokensAtMcap(global, lamports, maxMcapSol),
      fees: { feeSol, ceiling, useSender: USE_SENDER },
      guardInstructions: guarded ? [slotGuardMod.maxSlotInstruction(guardMaxSlot)] : [],
      tip: plan.tip,
      blockhash
    });
    if (!mine.tx) return { ok: false, why: `this bot couldn't build the practice buy (${mine.reason})` };
    mine.tx.sign(walletKeypair);
    const wire = Buffer.from(mine.tx.serialize());
    const r = await fastPath.practice({
      mint: mint.toBase58(),
      txKeys,
      knownTokenProgram: null,
      creatorVault,
      feeRecipient,
      lamports: lamports.toString(),
      maxMcapSol,
      fees: { feeSol, ceiling, useSender: USE_SENDER, learnedLimit: computeBudget.estimate(kind, ceiling) },
      guardMaxSlot,
      tip: plan.tip ? { account: String(plan.tip.account), lamports: plan.tip.lamports } : null,
      blockhash
    });
    if (!r || !r.ok) return { ok: false, why: `the Rust fast path couldn't build the practice buy (${(r && r.error) || 'no answer'})` };
    const theirs = Buffer.from(r.wire, 'base64');
    if (!theirs.equals(wire)) {
      let at = 0;
      while (at < wire.length && wire[at] === theirs[at]) at++;
      return { ok: false, why: `its practice buy differs from this bot's (first difference at byte ${at} of ${wire.length})` };
    }
    if (r.kind !== mine.tx.compute.kind || r.limit !== mine.tx.compute.limit) return { ok: false, why: `its compute sizing differs (${r.kind} ${r.limit} vs ${mine.tx.compute.kind} ${mine.tx.compute.limit})` };
    results.push(r.buildUs);
  }
  return { ok: true, why: null, rustUs: Math.max(...results) };
}

/** A buy the Rust fast path sent: remembered as if sent from here (timing, slot guard, compute learning). */
function noteExternalBuy(signature, { buildMs = null, sendMs = null, sentAt = null, guard = null, compute = null } = {}) {
  if (!signature) return;
  rememberTiming(signature, { buildMs: buildMs === null ? null : Math.round(buildMs * 100) / 100, sendMs: sendMs === null ? null : Math.round(sendMs), sentAt });
  if (guard && typeof guard.ixIndex === 'number') slotGuardMod.remember(signature, guard);
  if (compute && compute.kind) computeBudget.remember(signature, compute.kind, compute.limit, compute.learned);
}

/** Instructions as text (program, accounts with signer/writable flags, data), random picks normalised. */
function describeForCompare(tx, recipients, tips) {
  const msg = tx.message;
  const keys = msg.staticAccountKeys.map((k) => k.toBase58());
  const flag = (i) => `${msg.isAccountSigner(i) ? 's' : '-'}${msg.isAccountWritable(i) ? 'w' : '-'}`;
  return msg.compiledInstructions
    .map((ix) => {
      const program = keys[ix.programIdIndex];
      const accounts = ix.accountKeyIndexes.map((i, pos) => {
        let k = keys[i];
        if (program === '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P' && pos === 1 && recipients.has(k)) k = 'FEE_RECIPIENT';
        if (program === '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P' && pos === 17) k = 'BUYBACK_RECIPIENT';
        if (program === '11111111111111111111111111111111' && pos === 1 && tips.has(k)) k = 'TIP_ACCOUNT';
        return `${k}:${flag(i)}`;
      });
      return `${program}(${accounts.join(',')})${Buffer.from(ix.data).toString('hex')}`;
    })
    .join(' | ');
}

function firstDifference(a, b) {
  const x = a.split(' | ');
  const y = b.split(' | ');
  if (x.length !== y.length) return `${x.length} vs ${y.length} instructions`;
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return `instruction ${i}: ${x[i].slice(0, 120)} vs ${y[i].slice(0, 120)}`;
  return 'unknown';
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
/**
 * INSTANT_SELL: read the coin's state now (as the buy goes out), so the sell
 * that follows the landing is built without a lookup.
 */
function prewarmSell(mint) {
  if (!config.DIRECT_PUMPFUN_SWAP) return;
  try {
    require('./pumpfunDirect').prewarmSell(getDirectConnection(), new PublicKey(mint), walletPublicKey).catch(() => {});
  } catch {
    // best effort
  }
}

async function sellToken({ mint, amountTokens, slippage, tip, dex, venue, pool = null, warm = false }) {
  const route = venue || dex;
  info(
    `[tradeExecutor] Placing SELL order: mint=${mint}, tokenAmount=${amountTokens}, ` +
      `dex=${dex}, venue=${route}, slippage=${slippage}%, tip=${effectiveTip(tip)} SOL via ${USE_SENDER ? 'Helius Sender' : 'Jito'}`
  );

  const t0 = Date.now();
  const directTx = await tryBuildDirect('sell', { mint, amountTokens, slippage, tip, venue: route, pool, warm });
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
      `[tradeExecutor] SELL txn sent via ${directTx.label} direct (built by the bot in ${builtMs}ms${directTx.builtFrom ? `, ${directTx.builtFrom}` : ''}${qt ? `; paid out in ${qt.label}` : ''}${computeText(directTx.tx)}): https://solscan.io/tx/${signature}`
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
  prewarmSell,
  priorityFeeSol,
  quoteTradeOf,
  buyTokenViaJupiter,
  buyTiming,
  EntryPriceTooHighError,
  CoinFilteredError,
  checkCoinFilters,
  checkEntryPrice,
  _resetForTests: () => { portalDown.until = 0; directUnsupported.clear(); },
  describePortalError, buyToken, sellToken, signAndSendTx, prepareAndSign, practiceHandBuilt, compareHandBuilt, compareWithRust, noteExternalBuy, handBuiltPlan, AmbiguousSendError };
