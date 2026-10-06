// src/index.js
const repeatAlerts = new Map(); // error message -> last Telegram alert time
const sidesText = (x) => (x.buy && x.sell ? 'on' : x.sell ? 'sells only' : x.buy ? 'buys only' : 'off');
/** Network fee + tip + net token-account deposit of a measured transaction, in SOL. */
const extraCostsSol = (m) => ((m.feeLamports || 0) + (m.tipLamports || 0) + (m.rentLamports || 0)) / 1e9;
require('./pdaCache'); // remember program-derived addresses (see pdaCache.js)
const config = require('./config');
const { info, warn, error } = require('./logger');
const CopyEmitter = require('./websocket');
const { ShredFeeds } = require('./shredFeed');
const { FastPath } = require('./fastPath');
const prewarm = require('./prewarm');
const storage = require('./storage');
const { mapDex, detectVenue, detectPool } = require('./dexMapper');
const { explainTxError } = require('./txErrors');
const { getPrices, getPriceOnChain, sleep } = require('./priceChecker');
const tradeExecutorMod = require('./tradeExecutor');
const { buyToken, sellToken, buyTiming: tradeTiming } = tradeExecutorMod;
const quoteTokens = require('./quoteTokens');
const buyTiming = require('./buyTiming');
const slotGuard = require('./slotGuard');
const leaderInfo = require('./leaderInfo');
const slotClock = require('./slotClock');
const computeBudget = require('./computeBudget');
const hostStats = require('./hostStats');
const { performance } = require('perf_hooks');

// Instant buy filters, checked against what the direct builder learns about
// the coin while building (no extra lookups). null = none set.
const COIN_FILTER =
  config.MIN_MARKET_CAP_SOL !== null || config.MAX_MARKET_CAP_SOL !== null || config.BLOCKED_CREATORS.size
    ? { minMcapSol: config.MIN_MARKET_CAP_SOL, maxMcapSol: config.MAX_MARKET_CAP_SOL, blockedCreators: config.BLOCKED_CREATORS }
    : null;

function filtersText() {
  const parts = [];
  if (config.MIN_MARKET_CAP_SOL !== null || config.MAX_MARKET_CAP_SOL !== null) {
    parts.push(`market cap ${config.MIN_MARKET_CAP_SOL ?? 0}-${config.MAX_MARKET_CAP_SOL ?? '∞'} SOL`);
  }
  if (config.MIN_COPY_BUY_SOL !== null) parts.push(`his buy >= ${config.MIN_COPY_BUY_SOL} SOL`);
  if (config.BLOCKED_CREATORS.size) parts.push(`${config.BLOCKED_CREATORS.size} blocked creator(s)`);
  if (config.MAX_SLOTS_BEHIND !== null) parts.push(`land within ${config.MAX_SLOTS_BEHIND} slot(s) of his buy`);
  if (config.LEADER_MAX_KM !== null) parts.push(`slot leader within ${config.LEADER_MAX_KM} km`);
  if (config.SHRED_FAST_BUY) parts.push('shred buys without lookup');
  return parts.length ? parts.join(', ') : 'off';
}
const { computeTieredBuyAmount } = require('./tieredBuy');
const { axiomLink } = require('./tokenLinks');
const rpcPool = require('./rpcPool');
const telegramBot = require('./telegramBot');
const { measureWalletDeltas, MAX_TX_VERSION } = require('./txParser');
const { decodePumpTradeDetails, swapPrice } = require('./fastPumpParser');
const coinInfo = require('./coinInfo');
const { uiToRaw, rawToUi, rawPercent } = require('./amounts');
const getTimestamp = require('../utils/getTimestamp');
const { PublicKey, Keypair } = require('@solana/web3.js');
const { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync } = require('@solana/spl-token');
const accountCleaner = require('./accountCleaner');
const tokenTax = require('./tokenTax');
const { isStockToken, stockLabel } = require('./stockTokens');
let bs58;
{
  const imported = require('bs58');
  bs58 = imported.default ? imported.default : imported;
}

const COMPUTE_BUDGET_PROGRAM = 'ComputeBudget111111111111111111111111111111';

/** { used, budget } compute units of a fetched transaction (either may be null). */
function computeUnitsOf(parsedTx) {
  const used = parsedTx && parsedTx.meta && typeof parsedTx.meta.computeUnitsConsumed === 'number' ? parsedTx.meta.computeUnitsConsumed : null;
  let budget = null;
  const ixs = (parsedTx && parsedTx.transaction && parsedTx.transaction.message && parsedTx.transaction.message.instructions) || [];
  for (const ix of ixs) {
    const program = ix.programId && (ix.programId.toBase58 ? ix.programId.toBase58() : String(ix.programId));
    if (program !== COMPUTE_BUDGET_PROGRAM) continue;
    if (ix.parsed && ix.parsed.type === 'setComputeUnitLimit' && ix.parsed.info) {
      budget = Number(ix.parsed.info.units);
    } else if (typeof ix.data === 'string') {
      try {
        const d = Buffer.from(bs58.decode(ix.data));
        if (d.length >= 5 && d[0] === 2) budget = d.readUInt32LE(1); // SetComputeUnitLimit
      } catch {}
    }
  }
  return { used, budget };
}

const CONFIRM_POLL_MS = 500;
const INSTANT_POLL_MS = 50; // INSTANT_SELL: how often a buy is checked until it lands (backup to the push below)
const INSTANT_BALANCE_TRIES = 6;
const INSTANT_BALANCE_RETRY_MS = 50;
const OWN_TX_FETCH_ATTEMPTS = 6;
const OWN_TX_FETCH_DELAY_MS = 500;
const ZERO_BALANCE_RECHECK_MS = 1000;
const RECENT_SELL_TTL_MS = 120000;
const MAX_SELL_COOLDOWN_MS = 10 * 60 * 1000;
const SHUTDOWN_DRAIN_TIMEOUT_MS = 30000;
const SHUTDOWN_POLL_INTERVAL_MS = 200;

// Trade modes whose exits mirror the copy wallet's sells, vs. those that
// exit on our own TP/SL. Keyed off each POSITION's own trade_mode, so
// changing TRADE_TYPE and restarting doesn't strand older positions.
const MIRRORS_COPY_SELLS = new Set(['EXACT', 'STIERED']);
const USES_TP_SL = new Set(['SAFE', 'TIERED']);

function num(v, fallback = 0) {
  if (v === null || v === undefined || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function shortId(id) {
  return String(id).slice(0, 8);
}

function shortMint(mint) {
  return `${mint.slice(0, 4)}...${mint.slice(-4)}`;
}

function fmtSigned(n, digits) {
  return `${n >= 0 ? '+' : ''}${n.toFixed(digits)}`;
}

// A stray rejected promise must not take the whole bot down (Node's default
// is to exit) — open positions still need managing. Log it loudly instead.
process.on('unhandledRejection', (reason) => {
  error('[Main] Unhandled promise rejection (bot keeps running):', reason && reason.stack ? reason.stack : reason);
});

// Same idea for a dropped connection that some library forgot to handle
// (an unhandled socket 'error' event): the socket is already dead, so it's
// safe to log and carry on. Anything else is a genuine bug — exit rather
// than keep running in an unknown state (positions are only ever marked
// closed after a confirmed sell, so a restart picks up exactly where this
// left off).
const TRANSIENT_NETWORK_CODES = new Set([
  'ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN',
  'ECONNABORTED', 'EHOSTUNREACH', 'ENETUNREACH', 'ENETDOWN', 'UND_ERR_SOCKET'
]);
process.on('uncaughtException', (err) => {
  if (err && TRANSIENT_NETWORK_CODES.has(err.code)) {
    error(`[Main] Network error escaped a library (${err.code}: ${err.message}); bot keeps running.`);
    return;
  }
  error('[Main] Uncaught exception — exiting:', err && err.stack ? err.stack : err);
  process.exit(1);
});

(async () => {
  try {
    info('=== Starting Copy-Trading Bot ===');
    storage.initStorage(); // ensure data/positions.json exists and is readable

    const walletAddress = config.PUBLIC_KEY;
    const walletPubkey = new PublicKey(walletAddress);

    info(
      `[Main] Mode=${config.BOT_MODE}, TRADE_TYPE=${config.TRADE_TYPE}, ` +
        `MAX_BUY_AMOUNT=${config.MAX_BUY_AMOUNT} SOL, MAX_TOTAL_EXPOSURE=${config.MAX_TOTAL_EXPOSURE} SOL, ` +
        `direct swaps: pumpfun=${config.DIRECT_PUMPFUN_SWAP} raydium=${config.DIRECT_RAYDIUM_SWAP}, ` +
        `SolanaPortal=${sidesText(config.USE_SOLANAPORTAL)}, Jupiter=${sidesText(config.JUPITER_FALLBACK)}, ` +
        `RPC fallbacks=${config.SOLANA_RPC_FALLBACKS.length}, mirror transfers=${config.MIRROR_TRANSFERS}, ` +
        `skip rebuys=${config.SKIP_REBUYS}, detection=${config.DETECTION_COMMITMENT}/${config.DETECTION_FEED}${config.SHRED_SOURCE ? ` + shreds (${config.SHRED_SOURCE})` : ''}, ` +
        `max entry premium=${config.MAX_ENTRY_PREMIUM_PCT === null ? 'off' : `${config.MAX_ENTRY_PREMIUM_PCT}%`}, ` +
        `sell after=${config.INSTANT_SELL ? `instant (as soon as the buy lands${config.INSTANT_SELL_DELAY_MS > 0 ? `, +${config.INSTANT_SELL_DELAY_MS}ms` : ''})` : config.SELL_AFTER_SECONDS > 0 ? `${config.SELL_AFTER_SECONDS}s` : 'off'}, ` +
        `buy filters=${filtersText()}, ` +
        `max open positions=${config.MAX_OPEN_POSITIONS || 'no limit'}, ` +
        `buy cooldown=${config.BUY_COOLDOWN_SEC ? `${config.BUY_COOLDOWN_SEC}s` : 'off'}, ` +
        `Telegram=${telegramBot.isEnabled() ? 'on' : 'off'}`
    );

    if (!config.USE_SOLANAPORTAL.sell && !config.JUPITER_FALLBACK.sell) {
      warn(
        "[Main] Neither SolanaPortal nor Jupiter may build SELLS: a coin the direct builders can't handle " +
          '(e.g. its Pump.fun curve completes while you hold it) can then only be sold from a wallet app.'
      );
    }
    if (!config.USE_SOLANAPORTAL.buy && !config.JUPITER_FALLBACK.buy) {
      info('[Main] Buys only through the direct builders (Pump.fun curve, Raydium); other coins are skipped.');
    }

    // In-memory map of active positions (status === 'active'), keyed by id.
    // These objects are the live copies; persist() writes changes through
    // to storage.
    const activeMap = new Map();
    for (const pos of storage.getActivePositions()) {
      activeMap.set(pos.id, { ...pos });
    }
    if (activeMap.size > 0) {
      info(`[Main] Loaded ${activeMap.size} open position(s) from storage.`);
      const perMint = new Map();
      for (const p of activeMap.values()) perMint.set(p.mint, (perMint.get(p.mint) || 0) + 1);
      for (const [mint, n] of perMint) {
        if (n > 1) {
          warn(
            `[Main] ${n} open positions for ${mint} (left by an older version of the bot). ` +
              'Copy-sells will apply to all of them; each can also be sold from Telegram.'
          );
        }
      }
    }

    // Ids of positions with a sell running, and with a sell queued.
    const closingSet = new Set();
    const queuedSells = new Set();
    // SOL reserved by buys that are in flight (sent, not yet recorded as a
    // position). Counted toward MAX_TOTAL_EXPOSURE so several buys arriving
    // at once can't each see the same free room and jointly blow the cap.
    let pendingBuySol = 0;
    // Recent copy-wallet sells, per mint: [{ slot, pct, at }]. Lets a buy
    // that's processed late (after a sell that happened AFTER it on-chain)
    // be skipped or trimmed instead of re-opening a position the copy
    // wallet has already exited.
    const recentCopySells = new Map(); // key: wallet:mint
    // Coins a copy wallet has exited, for SKIP_REBUYS (persisted, as
    // "wallet:mint"; a plain mint from an older version counts for all).
    const exitedMints = new Set(storage.getExitedMints());
    // New positions being bought right now (MAX_OPEN_POSITIONS counts them).
    let pendingNewPositions = 0;
    // When the bot last went for a buy (BUY_COOLDOWN_SEC); 0 = never.
    let lastBuyAt = 0;
    // Paused (via Telegram /pause): no new buys; exits keep working. Persisted.
    let paused = storage.getPaused();
    // FAST_PATH="rust": the link with the Rust fast path (set up below).
    let fastPath = null;
    const buyingMints = new Map(); // mint -> buys of it in flight (from here or the fast path)
    // Something the fast path decides from has changed: it hears at once.
    const stateChanged = () => {
      if (fastPath) fastPath.pushSoon();
    };
    // The fast path's buys from the moment it decides (its "claim"), until
    // this bot takes them over: counted against the caps at once.
    const fastClaims = new Map(); // his signature -> { mint, sol, opensNew, at }
    function releaseClaim(his) {
      const c = fastClaims.get(his);
      if (!c) return;
      fastClaims.delete(his);
      if (lastBuyAt === c.at) lastBuyAt = c.prevBuyAt; // nothing went out: no cooldown
      pendingBuySol = Math.max(0, pendingBuySol - c.sol);
      if (c.opensNew) pendingNewPositions = Math.max(0, pendingNewPositions - 1);
      const n = (buyingMints.get(c.mint) || 1) - 1;
      if (n > 0) buyingMints.set(c.mint, n);
      else buyingMints.delete(c.mint);
    }
    const round2 = (x) => (typeof x === 'number' ? Math.round(x * 100) / 100 : x);
    if (config.START_PAUSED) {
      if (telegramBot.isEnabled()) {
        paused = true;
        storage.setPaused(true);
      } else {
        warn('[Main] START_PAUSED is on, but Telegram is not set up (no way to resume), so starting UNPAUSED.');
      }
    }
    if (paused && !telegramBot.isEnabled()) {
      // Saved by an earlier run that had Telegram: without it there is no way
      // to resume, so don't stay paused.
      warn('[Main] Buying was paused in an earlier run, but Telegram is not set up now (no way to resume), so starting UNPAUSED.');
      paused = false;
      storage.setPaused(false);
    }
    {
      const { compareWithExample } = require('./envFile');
      const { file, missing } = compareWithExample(config.ENV_FILE);
      info(`[Main] Settings from ${file || '(environment only)'}.`);
      if (missing.length) {
        info(`[Main] ${missing.length} setting(s) not in your file, using defaults: ${missing.join(', ')}. ("npm run check-env" lists them.)`);
      }
    }
    if (config.REHEARSE_ONLY) {
      paused = true; // not saved: only this run
      warn('[Main] REHEARSE_ONLY: this bot NEVER buys. Each buy copied from the shreds is rehearsed (checks, build, signing; not sent) and its timing logged.');
    } else if (paused) warn('[Main] Buying is PAUSED. Exits still work. Tap Resume (or send /resume) in Telegram to start buying.');

    // --- Graceful shutdown bookkeeping ---
    let shuttingDown = false;
    let inFlightCount = 0;
    async function tracked(fn) {
      inFlightCount += 1;
      try {
        return await fn();
      } finally {
        inFlightCount = Math.max(0, inFlightCount - 1);
      }
    }

    // --- Per-mint serialization ---
    // Every action touching a given mint (copy buy, copy sell, TP/SL,
    // Telegram sell, retries) runs one at a time, in arrival order. That's
    // what makes "copy wallet sells while our buy is still confirming" work
    // (the sell waits for the buy, then finds the position), stops two sells
    // of one position from racing each other, and stops two buys of the same
    // mint from both deciding there's no existing position.
    // Rule: code already running inside runExclusive(mint) must never await
    // runExclusive(mint) again (that would wait on itself).
    const mintQueues = new Map();
    function runExclusive(mint, fn) {
      const prev = mintQueues.get(mint) || Promise.resolve();
      const run = prev.then(fn);
      const tail = run.then(
        () => {},
        () => {}
      );
      mintQueues.set(mint, tail);
      tail.then(() => {
        if (mintQueues.get(mint) === tail) mintQueues.delete(mint);
      });
      return run;
    }

    function activeByMint(mint) {
      return Array.from(activeMap.values()).filter((p) => p.mint === mint && p.status === 'active');
    }

    // --- Several copy wallets (COPY_WALLET="A,B") ---
    const MULTI_WALLET = config.COPY_WALLETS.length > 1;
    /** The copy wallet a position follows (older positions: the first one). */
    function walletOf(pos) {
      return pos.copy_wallet || config.COPY_WALLET;
    }
    /** " (4vw5…9Ud9)" in log lines when several wallets are copied. */
    function who(wallet) {
      return MULTI_WALLET && wallet ? ` (${wallet.slice(0, 4)}…${wallet.slice(-4)})` : '';
    }
    function hasExited(wallet, mint) {
      return exitedMints.has(`${wallet}:${mint}`) || exitedMints.has(mint);
    }
    // Skips that can come in bursts (MAX_OPEN_POSITIONS, BUY_COOLDOWN_SEC):
    // the first of each kind goes to Telegram at once, the rest are counted
    // and summed up every 10 minutes (each one is still in the log).
    const SKIP_SUMMARY_MS = 10 * 60 * 1000;
    const skipNotice = { cap: { lastAt: 0, count: 0 }, cooldown: { lastAt: 0, count: 0 }, leader: { lastAt: 0, count: 0 } };
    function notifySkip(kind, text) {
      const k = skipNotice[kind];
      if (Date.now() - k.lastAt >= SKIP_SUMMARY_MS) {
        k.lastAt = Date.now();
        telegramBot.notifyInfo(text + ' (Further skips like this are summed up every 10 minutes.)');
      } else {
        k.count += 1;
      }
    }
    const skipSummaryTimer = setInterval(() => {
      const parts = [];
      if (skipNotice.cap.count) parts.push(`${skipNotice.cap.count} with MAX_OPEN_POSITIONS (${config.MAX_OPEN_POSITIONS}) reached`);
      if (skipNotice.cooldown.count) parts.push(`${skipNotice.cooldown.count} within BUY_COOLDOWN_SEC (${config.BUY_COOLDOWN_SEC}s) of another buy`);
      if (skipNotice.leader.count) parts.push(`${skipNotice.leader.count} because the slot leader was too far away (LEADER_MAX_KM=${config.LEADER_MAX_KM})`);
      if (parts.length) telegramBot.notifyInfo(`⛔ Buys skipped in the last 10 minutes: ${parts.join('; ')}.`);
      skipNotice.cap.count = 0;
      skipNotice.cooldown.count = 0;
      skipNotice.leader.count = 0;
    }, SKIP_SUMMARY_MS);
    if (skipSummaryTimer.unref) skipSummaryTimer.unref();

    /** Open positions, plus new ones whose buy is in flight. */
    function openPositionCount() {
      let n = 0;
      for (const p of activeMap.values()) if (p.status === 'active') n += 1;
      return n + pendingNewPositions;
    }

    function isBusy(id) {
      return closingSet.has(id) || queuedSells.has(id);
    }

    /** SOL committed: remaining cost basis of open positions + in-flight buys. */
    function currentExposureSol() {
      let sum = 0;
      for (const p of activeMap.values()) {
        if (p.status === 'active') sum += num(p.cost_basis_sol ?? p.buy_amount);
      }
      return sum + pendingBuySol;
    }

    function persist(pos, updates) {
      Object.assign(pos, updates);
      storage.updatePosition(pos.id, updates);
      if ('status' in updates || 'cost_basis_sol' in updates || 'buy_amount' in updates) stateChanged();
    }

    // --- Wallet SOL balance (checked in the background) ---
    // So a buy the wallet can't afford is skipped up front, instead of being
    // sent, failing, and then polled for confirmation for up to 90s.
    const BALANCE_REFRESH_MS = Number(process.env.BALANCE_REFRESH_MS) || 20_000; // env override: tests only
    const FEE_RESERVE_SOL = 0.01; // network fees + token-account deposit
    let walletSol = null; // last known balance (null until first read)
    let lastLowBalanceNotice = 0;

    async function refreshBalance() {
      try {
        const lamports = await rpcPool.withFailover((c) => c.getBalance(walletPubkey, 'confirmed'), 5000, { priority: 'low' });
        if (walletSol !== lamports / 1e9) {
          walletSol = lamports / 1e9;
          stateChanged();
        }
      } catch {
        // keep the last known value
      }
    }

    // --- Empty token account cleanup (CLOSE_EMPTY_ACCOUNTS) ---
    // A fully sold coin leaves an empty token account holding ~0.002 SOL of
    // deposit; close it shortly after the sale (and sweep periodically for
    // any others). Background only: never on the buy/sell path.
    // (The env overrides exist for the test suite; there's no need to set them.)
    const ACCOUNT_CLOSE_DELAY_MS = Number(process.env.CLEANUP_DELAY_MS) || 30_000;
    const ACCOUNT_SWEEP_INTERVAL_MS = Number(process.env.CLEANUP_SWEEP_INTERVAL_MS) || 30 * 60_000;
    const ACCOUNT_SWEEP_FIRST_MS = Number(process.env.CLEANUP_FIRST_SWEEP_MS) || 2 * 60_000;
    let cleanerKeypair = null;
    let sweepRunning = false;
    const cleanupEnabled = () => config.CLOSE_EMPTY_ACCOUNTS && config.BOT_MODE === 'COPY' && !shuttingDown;

    /** Coins to leave alone: held, or with a buy/sell queued or running. */
    function busyMints() {
      const set = new Set(mintQueues.keys());
      for (const p of activeMap.values()) set.add(p.mint);
      return set;
    }

    let sweepAgain = false;
    async function runAccountCleanup({ onlyMint = null, label }) {
      if (!cleanupEnabled()) return;
      if (sweepRunning) {
        // Don't drop it: one full sweep once the current one ends.
        sweepAgain = true;
        return;
      }
      sweepRunning = true;
      try {
        if (!cleanerKeypair) cleanerKeypair = Keypair.fromSecretKey(bs58.decode(config.PRIVATE_KEY));
        await accountCleaner.sweep({
          owner: walletPubkey,
          signer: cleanerKeypair,
          confirm: (sig) => waitForConfirmation(sig),
          skipMints: busyMints(),
          onlyMint,
          label
        });
      } finally {
        sweepRunning = false;
      }
      if (sweepAgain && !shuttingDown) {
        sweepAgain = false;
        await runAccountCleanup({ label: 'after sells during a sweep' });
      }
    }

    function scheduleAccountClose(mint) {
      if (!cleanupEnabled()) return;
      const t = setTimeout(() => {
        runAccountCleanup({ onlyMint: mint, label: `after selling ${mint}` }).catch(() => {});
      }, ACCOUNT_CLOSE_DELAY_MS);
      if (t.unref) t.unref();
    }

    function markClosed(pos, extra = {}) {
      activeMap.delete(pos.id);
      scheduleAccountClose(pos.mint);
      refreshBalance();
      persist(pos, {
        status: 'closed',
        closed_at: getTimestamp(),
        pending_exit: null,
        pending_sell_pct: null,
        needs_reconcile: false,
        ...extra
      });
    }

    /**
     * Wait for a signature to land. Returns { confirmed: true } only if it
     * confirmed WITHOUT an error — a transaction that landed but failed
     * (slippage exceeded, etc.) still reports a confirmationStatus, and must
     * not be treated as done. Accepts 'finalized' too, in case we first see
     * it after it has already finalized.
     * alongWith: another signature (the copy wallet's trade) to look up in
     * the same calls; its slot comes back as `alongSlot` (null if unknown).
     */
    // onLanded(slot): called once, the moment the transaction is first seen
    // executed without error ("processed": in a block, not yet voted on),
    // which is usually a few hundred ms before "confirmed". Until then the
    // status is checked every 100 ms instead of 250 (INSTANT_SELL).
    async function waitForConfirmation(signature, timeoutSec = config.CONFIRM_TIMEOUT_SEC, { alongWith = null, onLanded = null } = {}) {
      const start = Date.now();
      const sigs = alongWith && alongWith !== signature ? [signature, alongWith] : [signature];
      let alongSlot = null;
      let landedSeen = false;
      while ((Date.now() - start) / 1000 < timeoutSec) {
        try {
          const resp = await rpcPool.withFailover((conn) => conn.getSignatureStatuses(sigs));
          const st = resp && resp.value && resp.value[0];
          const other = sigs.length > 1 && resp && resp.value && resp.value[1];
          if (other && typeof other.slot === 'number' && !other.err) alongSlot = other.slot;
          if (st && !st.err && onLanded && !landedSeen) {
            landedSeen = true;
            try {
              onLanded(typeof st.slot === 'number' ? st.slot : null);
            } catch (err) {
              warn(`[Main] onLanded handler failed: ${err.message}`);
            }
          }
          if (st) {
            if (st.err) return { confirmed: false, err: st.err, slot: typeof st.slot === 'number' ? st.slot : null, alongSlot };
            if (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized') {
              return { confirmed: true, slot: typeof st.slot === 'number' ? st.slot : null, alongSlot };
            }
          }
        } catch {
          // transient RPC error — keep polling until the timeout
        }
        // Most transactions confirm within seconds, so check often at first,
        // then ease off (a buy that never lands shouldn't eat the RPC budget).
        // (Every 250 ms for the first 2.5 s: a position is recorded, and a
        // copy sell waiting behind it can go, as soon as the buy confirms.)
        const elapsed = Date.now() - start;
        const fast = onLanded && !landedSeen && elapsed < 5000 ? INSTANT_POLL_MS : null;
        await sleep(fast || (elapsed < 2500 ? 250 : elapsed < 5000 ? CONFIRM_POLL_MS : elapsed < 20000 ? 1000 : 2000));
      }
      return { confirmed: false, timedOut: true, alongSlot };
    }

    /** One-shot status check: 'confirmed' | 'failed' | 'unknown'. */
    async function signatureStatus(signature) {
      try {
        const resp = await rpcPool.withFailover((conn) => conn.getSignatureStatuses([signature]));
        const st = resp && resp.value && resp.value[0];
        if (!st) return 'unknown';
        if (st.err) return 'failed';
        return st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized' ? 'confirmed' : 'unknown';
      } catch {
        return 'unknown';
      }
    }

    // Buys sent from here whose position isn't saved yet (storage.js: pending-buys.json).
    const buysInFlight = new Set();
    function dropPendingBuy(sig) {
      try {
        storage.removePendingBuy(sig);
      } catch (err) {
        warn(`[Main] Couldn't clear the note of buy ${sig.slice(0, 8)}… (${err.message}).`);
      }
    }
    const PENDING_BUY_GIVE_UP_MS = process.env.PENDING_BUY_GIVE_UP_MS !== undefined ? Number(process.env.PENDING_BUY_GIVE_UP_MS) : 10 * 60_000;

    /**
     * Buys sent whose position was never saved (the bot stopped in between, or
     * the buy landed after it gave up waiting): checked on-chain. One that
     * landed gets a position of its own (its amount read from the wallet);
     * one that failed is dropped; one that can't be found yet is kept a
     * while longer.
     */
    async function recoverPendingBuys(why) {
      if (shuttingDown) return 0;
      let recovered = 0;
      for (const rec of storage.getPendingBuys()) {
        if (buysInFlight.has(rec.signature)) continue;
        const known = storage.getAllPositions().some((p) => p.buy_signature === rec.signature);
        if (known) {
          dropPendingBuy(rec.signature);
          continue;
        }
        const st = await signatureStatus(rec.signature);
        if (buysInFlight.has(rec.signature) || shuttingDown) continue;
        if (st === 'failed') {
          dropPendingBuy(rec.signature);
          continue;
        }
        if (st !== 'confirmed') {
          if (Date.now() - rec.at > PENDING_BUY_GIVE_UP_MS) {
            warn(`[Main] Buy ${rec.signature.slice(0, 8)}… of ${rec.mint} never showed up on-chain; forgetting it.`);
            dropPendingBuy(rec.signature);
          }
          continue;
        }
        recovered += 1;
        await tracked(() =>
          runExclusive(rec.mint, async () => {
            if (storage.getAllPositions().some((p) => p.buy_signature === rec.signature)) return;
            const current = activeByMint(rec.mint)[0] || null;
            let note;
            if (current) {
              // An add-on to a position we hold: the whole amount is re-read from the wallet.
              persist(current, { needs_reconcile: true, buy_amount: num(current.buy_amount) + rec.sol, cost_basis_sol: num(current.cost_basis_sol ?? current.buy_amount) + rec.sol, buy_count: num(current.buy_count, 1) + 1 });
              note = `added to position ${shortId(current.id)}`;
            } else {
              const usesTpSl = USES_TP_SL.has(rec.mode);
              const newPos = storage.addPosition({
                mint: rec.mint,
                buy_amount: rec.sol,
                cost_basis_sol: rec.sol,
                swap_cost_sol: rec.sol,
                token_amount: '0',
                decimals: null,
                needs_reconcile: true, // its amount comes from the wallet
                entry_price: 0,
                current_price: 0,
                highest_price: 0,
                trade_mode: rec.mode,
                parent_signature: rec.parent || null,
                buy_signature: rec.signature,
                copy_wallet: rec.wallet,
                stop_loss_pct: usesTpSl ? config.STOP_LOSS : null,
                take_profit_pct: usesTpSl ? config.TAKE_PROFIT : null,
                dex: rec.dex,
                venue: rec.venue,
                pool: rec.pool || null,
                realized_pnl_sol: 0,
                trailing_stop_distance: config.ENABLE_TRAILING_STOP ? config.TRAILING_STOP_DISTANCE : null,
                trailing_stop_activation: config.ENABLE_TRAILING_STOP ? config.TRAILING_STOP_ACTIVATION : null,
                sell_after_at: null
              });
              activeMap.set(newPos.id, { ...newPos });
              stateChanged();
              note = `new position ${shortId(newPos.id)}`;
            }
            const msg = `Buy ${rec.signature.slice(0, 8)}… of ${rec.mint} (${rec.sol} SOL) landed but was never recorded (${why}); recovered as ${note}. Its token amount will be read from the wallet.`;
            warn(`[Main] ${msg}`);
            telegramBot.notifyAlert(msg);
            dropPendingBuy(rec.signature);
          })
        ).catch((err) => error(`[Main] Couldn't recover buy ${rec.signature}:`, err.message));
      }
      return recovered;
    }

    /** Exact effect of one of our own transactions on our wallet for `mint`, or null. */
    /**
     * Compute units our transaction actually used, next to the budget it set
     * (PUMPFUN_COMPUTE_UNITS for direct Pump.fun / PumpSwap trades): the
     * priority fee is spread over the budget, so a budget close to what's
     * really used gives a higher price per unit for the same fee.
     */
    let mostUnitsUsed = 0;
    function logComputeUnits(signature, parsedTx) {
      const { used, budget } = computeUnitsOf(parsedTx);
      if (!(used > 0)) return;
      computeBudget.observe(signature, used); // AUTO_COMPUTE_UNITS learns from it
      mostUnitsUsed = Math.max(mostUnitsUsed, used);
      info(
        `[Main] ${signature.slice(0, 8)}… used ${used.toLocaleString('en-US')} compute units` +
          (budget ? ` of the ${budget.toLocaleString('en-US')} budgeted (${Math.round((100 * used) / budget)}%)` : '') +
          `; most used by one trade this run: ${mostUnitsUsed.toLocaleString('en-US')}.`
      );
      // A trade that nearly ran out: the next, slightly heavier one (a new
      // token account, a first trade on a coin) will fail and still pay.
      // (A learned limit adjusts itself: only the fixed ceiling needs you.)
      if (budget && used >= budget * 0.95 && !computeBudget.wasLearned(signature)) {
        const suggest = Math.ceil((mostUnitsUsed * 1.2) / 5000) * 5000;
        warn(
          `[Main] That trade used ${Math.round((100 * used) / budget)}% of its compute budget: one needing a little more fails on-chain ` +
            `(and still pays its fees). Raise PUMPFUN_COMPUTE_UNITS to about ${suggest.toLocaleString('en-US')}.`
        );
      }
    }

    /** A trade that ran out of compute: its kind gets a bigger limit from now on. */
    function noteComputeFailure(signature, err) {
      const ie = err && err.InstructionError;
      if (Array.isArray(ie) && (ie[1] === 'ComputationalBudgetExceeded' || ie[1] === 'ProgramFailedToComplete')) {
        computeBudget.ranOut(signature);
      }
    }

    async function measureOwnTx(signature, mint) {
      for (let attempt = 1; attempt <= OWN_TX_FETCH_ATTEMPTS; attempt++) {
        try {
          const parsedTx = await rpcPool.withFailover((conn) =>
            conn.getParsedTransaction(signature, { maxSupportedTransactionVersion: MAX_TX_VERSION, commitment: 'confirmed' })
          );
          if (parsedTx) {
            logComputeUnits(signature, parsedTx);
            const deltas = measureWalletDeltas(parsedTx, walletAddress, mint);
            if (!deltas) return null;
            // A trade in a coin paired to another token (QUOTE_TOKENS): what it
            // spent or received in that token, valued in SOL at its price.
            const qt = typeof tradeExecutorMod.quoteTradeOf === 'function' ? tradeExecutorMod.quoteTradeOf(signature) : null;
            if (qt) {
              if (!(qt.lamportsPerRaw > 0)) return null; // can't value it: the bot estimates instead
              const qd = measureWalletDeltas(parsedTx, walletAddress, qt.quoteMint);
              const quoteDeltaRaw = qd ? qd.tokenDeltaRaw : 0n;
              deltas.lamportsDelta += Math.round(Number(quoteDeltaRaw) * qt.lamportsPerRaw);
              deltas.valuedIn = qt.label;
            }
            // Pump.fun's record of this trade: the coin's reserves and creator
            // right after it (for the buy message; free, no extra call).
            const logs = parsedTx.meta && parsedTx.meta.logMessages;
            return { ...deltas, pumpEvent: decodePumpTradeDetails(logs, walletAddress, mint) };
          }
        } catch (err) {
          warn(`[Main] Fetching own tx ${signature} (attempt ${attempt}) failed: ${err.message}`);
        }
        await sleep(OWN_TX_FETCH_DELAY_MS);
      }
      return null;
    }

    /** Our wallet's total on-chain balance of `mint`: { raw, decimals } (decimals null if no token account). */
    async function getOnChainBalance(mint) {
      const accounts = await rpcPool.withFailover((conn) =>
        conn.getParsedTokenAccountsByOwner(walletPubkey, { mint: new PublicKey(mint) })
      );
      let raw = 0n;
      let decimals = null;
      for (const acct of accounts.value) {
        const t = acct.account.data.parsed.info.tokenAmount;
        raw += BigInt(t.amount);
        decimals = t.decimals;
      }
      return { raw, decimals };
    }

    /**
     * Same, but a zero reading is re-checked once before being believed: a
     * lagging RPC node can briefly report 0, and "0" is what lets us mark a
     * position closed.
     */
    async function getOnChainBalanceCareful(mint) {
      const bal = await getOnChainBalance(mint);
      if (bal.raw > 0n) return bal;
      await sleep(ZERO_BALANCE_RECHECK_MS);
      return getOnChainBalance(mint);
    }

    /** Token decimals for a position (stored on newer positions; looked up on-chain for older ones). */
    async function resolveDecimals(pos) {
      if (Number.isInteger(pos.decimals)) return pos.decimals;
      const bal = await getOnChainBalance(pos.mint);
      if (bal.decimals === null) return null;
      persist(pos, { decimals: bal.decimals });
      return bal.decimals;
    }

    /**
     * A position whose token amount couldn't be determined at buy time
     * (RPC trouble right after the buy confirmed) is recorded anyway, with
     * needs_reconcile set, and its amount filled in from the on-chain
     * balance here. Caller must hold the mint's exclusive lock.
     */
    const RECONCILE_GIVE_UP_MS = process.env.RECONCILE_GIVE_UP_MS !== undefined ? Number(process.env.RECONCILE_GIVE_UP_MS) : 120_000;
    async function reconcileInner(pos) {
      if (!pos.needs_reconcile || !activeMap.has(pos.id)) return;
      const bal = await getOnChainBalance(pos.mint);
      if (bal.decimals === null || bal.raw === 0n) {
        // Not visible yet. After ~20 tries (a couple of minutes of polling),
        // conclude the buy delivered nothing rather than track it forever.
        // (Time as well as tries: polling every 250 ms makes 20 tries only 5 s.)
        pos.reconcileAttempts = (pos.reconcileAttempts || 0) + 1;
        if (!pos.reconcileSince) pos.reconcileSince = Date.now();
        if (pos.reconcileAttempts >= 20 && Date.now() - pos.reconcileSince >= RECONCILE_GIVE_UP_MS) {
          markClosed(pos, { close_reason: 'buy delivered no tokens (none found on-chain)', token_amount: '0' });
          const msg = `Position ${shortId(pos.id)} (${pos.mint}): no tokens ever appeared on-chain after its buy; marked closed.`;
          warn(`[Main] ${msg}`);
          telegramBot.notifyAlert(msg);
        }
        return;
      }
      persist(pos, { token_amount: rawToUi(bal.raw, bal.decimals), decimals: bal.decimals, needs_reconcile: false });
      info(`[Main] Position ${shortId(pos.id)} reconciled from on-chain balance: ${pos.token_amount} tokens.`);
    }

    /**
     * Log + Telegram-notify PnL for a sell. If the sell transaction could be
     * read, PnL is REALIZED: the SOL it returned minus what the sold tokens
     * cost. With PNL_EXCLUDE_FEES (default) both are the swaps' own amounts,
     * without network fees, tips and token-account deposits; otherwise they
     * are what actually left / arrived in the wallet.
     * Otherwise it falls back to a price-based estimate, marked "(est.)".
     */
    async function reportSellPnl(pos, reason, soldPct, costs, sale, priorRealized = 0) {
      let pnlSol = null;
      let pnlPct = null;
      let realized = false;
      let detail;

      // PNL_EXCLUDE_FEES (default): compare what the swaps themselves paid and
      // returned, leaving out network fees, tips and token-account deposits.
      const exFees = config.PNL_EXCLUDE_FEES && typeof sale.swapProceedsSol === 'number';
      const costSold = exFees ? costs.swapCostSold : costs.costSold;
      const proceedsSol = exFees ? sale.swapProceedsSol : sale.proceedsSol;

      if (typeof proceedsSol === 'number' && Number.isFinite(proceedsSol) && costSold > 0) {
        pnlSol = proceedsSol - costSold;
        pnlPct = (pnlSol / costSold) * 100;
        realized = true;
        detail = `received ${proceedsSol.toFixed(4)} SOL for tokens that cost ${costSold.toFixed(4)} SOL`;
        if (sale.valuedIn) detail = `received ${sale.valuedIn} worth ${proceedsSol.toFixed(4)} SOL (at its current price) for tokens that cost ${costSold.toFixed(4)} SOL`;
        if (exFees) {
          const fees = Math.max(0, costs.costSold - costs.swapCostSold) + Math.max(0, sale.sellFeesSol || 0);
          const withFees = sale.proceedsSol - costs.costSold;
          detail += ` (fees, tips & deposits of ${fees.toFixed(4)} SOL left out; including them: ${fmtSigned(withFees, 4)} SOL)`;
        }
      } else {
        const entry = num(pos.entry_price);
        let cur = 0;
        try {
          const pd = await getPriceOnChain(pos.mint);
          if (pd) cur = num(pd.priceInUsd);
        } catch {
          // fall through to "unknown"
        }
        if (entry > 0 && cur > 0 && costSold > 0) {
          pnlPct = ((cur - entry) / entry) * 100;
          pnlSol = costSold * (pnlPct / 100);
          detail = `estimated from price $${entry.toPrecision(6)} -> $${cur.toPrecision(6)}`;
        } else {
          detail = 'no fill or price data available';
        }
      }

      let pnlText = pnlSol !== null
        ? `${fmtSigned(pnlSol, 4)} SOL (${fmtSigned(pnlPct, 2)}%)${realized ? '' : ' (est.)'}`
        : 'unknown';
      if (pnlSol !== null && priorRealized !== 0) {
        pnlText += `; position total so far ${fmtSigned(priorRealized + pnlSol, 4)} SOL`;
      }

      info(
        `[Main][PnL] ${reason}: sold ${soldPct.toFixed(2)}% of ${pos.mint} (position ${shortId(pos.id)}). ` +
          `PnL: ${pnlText} — ${detail}.`
      );
      telegramBot.notifySell({ pos, reason, soldPct, pnlSol, pnlPct, realized });
      return pnlSol;
    }

    /**
     * Sell `desiredRaw` of pos's token, confirm it landed, and measure what it
     * returned. Retries up to SELL_MAX_ATTEMPTS times. Before a retry it
     * checks whether the previous attempt landed after all (by its
     * signature, then by the balance), so a slow or ambiguously-sent sell is
     * never sent twice; and it re-reads the real balance, so a stale stored
     * amount can't keep failing.
     * Returns { ok: true, signature, proceedsSol, soldRaw } | { ok: true, empty: true } | { ok: false }.
     */
    /** Exits triggered by the copy wallet (which "Keep" switches off). */
    const isCopyExit = (reason) => /copy-(sell|transfer)/.test(reason || '');

    /**
     * stopIf: checked before each retry; if it returns true (the user tapped
     * Keep mid-retry), stop — but only once the previous attempt is known
     * not to have landed, so a sell is never lost track of.
     */
    // alreadySent { signature, amountRaw, ambiguous }: a sell sent before the
    // position existed (INSTANT_SELL). The first attempt follows it instead
    // of sending another; if it fails, later attempts sell as usual.
    // A transaction can no longer land once its blockhash is ~150 blocks old (~60 s); this is the margin.
    const SELL_EXPIRY_MS = process.env.SELL_EXPIRY_MS !== undefined ? Number(process.env.SELL_EXPIRY_MS) : 90_000;
    async function sellWithRetries(pos, desiredRaw, decimals, { full, stopIf = null, trackedKnown = true, alreadySent = null }) {
      // trackedKnown=false: the stored amount is stale (a buy's fill couldn't
      // be read), so a full sell takes the whole on-chain balance.
      const trackedRaw = trackedKnown ? uiToRaw(pos.token_amount, decimals) : 0n;
      let amountRaw = desiredRaw;
      let lastSig = null; // most recent sell tx that might be on-chain
      let maybeLanded = false; // its fate is unknown (not a definite failure)
      let lastSentAt = 0;

      const landed = async (signature, fallbackSoldRaw) => {
        const measured = await measureOwnTx(signature, pos.mint);
        const proceedsSol = measured ? measured.lamportsDelta / 1e9 : null;
        // What the swap itself paid out: add back the network fee and tip
        // (and remove any deposit refund).
        const swapProceedsSol = measured ? proceedsSol + extraCostsSol(measured) : null;
        const sellFeesSol = measured ? extraCostsSol(measured) : null;
        const soldRaw = measured && measured.tokenDeltaRaw < 0n ? -measured.tokenDeltaRaw : fallbackSoldRaw;
        return { ok: true, signature, proceedsSol, swapProceedsSol, sellFeesSol, soldRaw, valuedIn: measured ? measured.valuedIn || null : null };
      };

      for (let attempt = 1; attempt <= config.SELL_MAX_ATTEMPTS; attempt++) {
        try {
          if (attempt > 1 && !full && lastSig && maybeLanded) {
            // A partial sell that may still land can't be sent again until it can
            // no longer land (its blockhash has expired): two of the same %
            // would sell too much. Looked at every few seconds meanwhile.
            while (Date.now() - lastSentAt < SELL_EXPIRY_MS) {
              const st = await signatureStatus(lastSig);
              if (st === 'confirmed') break; // handled just below
              if (st === 'failed') {
                maybeLanded = false;
                break;
              }
              await sleep(Math.min(3000, Math.max(50, SELL_EXPIRY_MS - (Date.now() - lastSentAt))));
            }
          }
          if (attempt > 1 || amountRaw <= 0n) {
            if (lastSig && maybeLanded && (await signatureStatus(lastSig)) === 'confirmed') {
              info(`[Main] Earlier sell ${lastSig} did land; not selling again.`);
              return landed(lastSig, amountRaw);
            }
            const bal = await getOnChainBalanceCareful(pos.mint);
            if (bal.raw === 0n) {
              if (lastSig && maybeLanded) return landed(lastSig, trackedRaw); // it landed; RPC just hadn't said so
              return { ok: true, empty: true };
            }
            if (!full && lastSig && maybeLanded && bal.raw <= trackedRaw - amountRaw) {
              info(`[Main] Balance shows earlier sell ${lastSig} landed; not selling again.`);
              return { ok: true, signature: lastSig, proceedsSol: null, soldRaw: trackedRaw - bal.raw };
            }
            if (full) amountRaw = trackedRaw > 0n && trackedRaw < bal.raw ? trackedRaw : bal.raw;
            else if (amountRaw > bal.raw) amountRaw = bal.raw;
          }

          if (attempt > 1 && stopIf && stopIf() && !(lastSig && maybeLanded)) {
            info(`[Main] Stopping sell retries for ${shortId(pos.id)}: Keep was tapped.`);
            return { ok: false, stopped: true };
          }
          lastSig = null;
          maybeLanded = false;
          let signature;
          let ambiguous = false;
          if (attempt === 1 && alreadySent && alreadySent.signature) {
            signature = alreadySent.signature;
            ambiguous = Boolean(alreadySent.ambiguous);
            if (alreadySent.amountRaw > 0n) amountRaw = alreadySent.amountRaw;
          } else try {
            signature = await sellToken({
              mint: pos.mint,
              amountTokens: rawToUi(amountRaw, decimals),
              slippage: config.SLIPPAGE,
              tip: config.JITO_TIP,
              dex: pos.dex,
              venue: pos.venue,
              pool: pos.pool || null
            });
          } catch (err) {
            // An ambiguous send (connection dropped after the request went
            // out) carries the tx signature: it may still land. Follow it
            // like any sent sell, rather than retrying blind and selling twice.
            if (!(err && err.txSignature)) throw err;
            warn(`[Main] Sell send outcome unknown (${err.message}); checking whether ${err.txSignature} lands...`);
            signature = err.txSignature;
            ambiguous = true;
          }
          lastSig = signature;
          maybeLanded = true;
          lastSentAt = attempt === 1 && alreadySent && alreadySent.sentAt ? alreadySent.sentAt : Date.now();

          // An ambiguous send that never left the bot would otherwise hold the
          // exit for the whole timeout; a sent one confirms within seconds. A
          // full sell retries sooner (a second full sell can't oversell: it
          // re-reads the balance); a partial one waits longer, since selling
          // the same % twice would sell too much.
          const ambiguousWaitSec = full ? 8 : 20;
          const conf = await waitForConfirmation(signature, ambiguous ? Math.min(ambiguousWaitSec, config.CONFIRM_TIMEOUT_SEC) : config.CONFIRM_TIMEOUT_SEC);
          if (conf.confirmed) return landed(signature, amountRaw);
          if (conf.err) {
            maybeLanded = false; // definite on-chain failure
            noteComputeFailure(signature, conf.err);
            warn(`[Main] Sell tx ${signature} for ${shortId(pos.id)} FAILED on-chain: ${explainTxError(conf.err, pos.pool || pos.venue)}`);
          } else {
            warn(`[Main] Sell tx ${signature} for ${shortId(pos.id)} not confirmed within ${config.CONFIRM_TIMEOUT_SEC}s.`);
          }
        } catch (err) {
          warn(`[Main] Sell attempt ${attempt}/${config.SELL_MAX_ATTEMPTS} for ${shortId(pos.id)} failed: ${err.message}`);
        }
        if (attempt < config.SELL_MAX_ATTEMPTS) await sleep(config.SELL_RETRY_DELAY_MS);
      }
      // The last attempt's fate may still be open: one more look before
      // reporting failure, so the retry after the cooldown can't sell twice.
      if (lastSig && maybeLanded && (await signatureStatus(lastSig).catch(() => null)) === 'confirmed') {
        info(`[Main] Sell ${lastSig} did land after all.`);
        return landed(lastSig, amountRaw);
      }
      return { ok: false };
    }

    /**
     * A sell failed every attempt: keep the position OPEN, back off
     * (doubling each time, up to 10 min), and alert — on the 1st, 2nd, 4th,
     * 8th... consecutive failure, so a token that simply can't be sold
     * doesn't spam you forever.
     */
    function failSell(pos, reason, detail, { noRetry = false } = {}) {
      pos.sellFailures = (pos.sellFailures || 0) + 1;
      const cooldown = Math.min(config.SELL_RETRY_COOLDOWN_MS * 2 ** (pos.sellFailures - 1), MAX_SELL_COOLDOWN_MS);
      pos.nextSellAttemptAt = Date.now() + cooldown;
      const willRetry = !noRetry && (pos.pending_exit || num(pos.pending_sell_pct) > 0 || USES_TP_SL.has(pos.trade_mode));
      const msg =
        `Could not sell ${pos.mint} (position ${shortId(pos.id)}, ${reason})` +
        `${detail ? `: ${detail}` : ` after ${config.SELL_MAX_ATTEMPTS} attempts`}. It stays OPEN` +
        (willRetry && config.BOT_MODE === 'COPY' ? ` and will be retried in ${Math.round(cooldown / 1000)}s.` : '.');
      error(`[Main] ${msg}`);
      if ((pos.sellFailures & (pos.sellFailures - 1)) === 0) telegramBot.notifyAlert(msg);
      return { ok: false, message: msg };
    }

    /** Sell 100% of a position. Caller must hold the mint's exclusive lock. */
    async function closeInner(live, reason, { persistIntent, alreadySent = null }) {
      // For exits that have no natural re-trigger (copy-sells, Telegram),
      // remember the intent so a failed sell is retried after the cooldown —
      // and still retried after a restart.
      if (persistIntent && live.pending_exit !== reason) persist(live, { pending_exit: reason });

      // A buy whose fill couldn't be read: the stored amount is stale. Read
      // the balance first; if that still fails, the sell takes everything.
      if (live.needs_reconcile) await reconcileInner(live).catch(() => {});
      if (!activeMap.has(live.id)) return { ok: true, message: `Position ${shortId(live.id)} had no tokens on-chain; marked closed.` };
      const trackedKnown = !live.needs_reconcile;

      let decimals = await resolveDecimals(live);
      if (decimals === null) {
        const bal = await getOnChainBalanceCareful(live.mint);
        if (bal.decimals === null || bal.raw === 0n) {
          markClosed(live, { close_reason: `${reason} (no tokens on-chain)`, token_amount: '0' });
          warn(`[Main] Position ${shortId(live.id)} has no tokens on-chain; marked closed.`);
          return { ok: true, message: `Position ${shortId(live.id)} had no tokens on-chain; marked closed.` };
        }
        decimals = bal.decimals;
        persist(live, { decimals });
      }

      const trackedRaw = trackedKnown ? uiToRaw(live.token_amount, decimals) : 0n;
      const res = await sellWithRetries(live, trackedRaw, decimals, {
        full: true,
        trackedKnown,
        alreadySent,
        stopIf: isCopyExit(reason) ? () => Boolean(live.keep) : null
      });
      if (res.stopped) {
        if (live.pending_exit) persist(live, { pending_exit: null });
        return { ok: false, message: 'Stopped: you tapped Keep.' };
      }
      if (!res.ok) return failSell(live, reason);

      const costSold = num(live.cost_basis_sol ?? live.buy_amount);
      const swapCostSold = num(live.swap_cost_sol ?? live.cost_basis_sol ?? live.buy_amount);
      const priorRealized = num(live.realized_pnl_sol);
      if (res.empty) {
        markClosed(live, { close_reason: `${reason} (nothing left on-chain)`, token_amount: '0' });
        warn(`[Main] Position ${shortId(live.id)} has zero on-chain balance; marked closed.`);
        return { ok: true, message: `Position ${shortId(live.id)} had no tokens left on-chain; marked closed.` };
      }

      // Persist the close BEFORE anything else (PnL lookup, notifications).
      markClosed(live, { close_reason: reason, token_amount: '0', cost_basis_sol: 0, swap_cost_sol: 0, close_signature: res.signature });
      info(`[Main] Position ${shortId(live.id)} (${live.mint}) closed via ${reason}: https://solscan.io/tx/${res.signature}`);

      const pnlSol = await reportSellPnl(live, reason, 100, { costSold, swapCostSold }, res, priorRealized);
      if (pnlSol !== null) storage.updatePosition(live.id, { realized_pnl_sol: priorRealized + pnlSol });

      return {
        ok: true,
        message: `Sold ${shortMint(live.mint)} (${reason})` + (pnlSol !== null ? `, PnL ${fmtSigned(pnlSol, 4)} SOL` : '')
      };
    }

    /**
     * Close a position fully: sell, confirm, THEN mark closed. If the sell
     * fails, the position stays open (and is retried) — it is never marked
     * closed while its tokens are still in the wallet.
     * Caller must hold the mint's exclusive lock (runExclusive).
     */
    async function closePosition(pos, reason, { persistIntent = false, alreadySent = null } = {}) {
      const live = activeMap.get(pos.id);
      if (!live || live.status !== 'active') {
        info(`[Main] Position ${shortId(pos.id)} is already closed; skipping ${reason}.`);
        return { ok: false, message: 'That position is already closed.' };
      }
      if (closingSet.has(live.id)) {
        return { ok: false, message: 'A sell for this position is already in progress.' };
      }
      // Keep tapped while this copy-wallet exit waited in the coin's queue.
      if (isCopyExit(reason) && live.keep) {
        info(`[Main] Position ${shortId(live.id)} is on KEEP; not following the copy wallet's exit.`);
        return { ok: false, message: 'Stopped: you tapped Keep.' };
      }
      closingSet.add(live.id);
      try {
        return await tracked(() => closeInner(live, reason, { persistIntent, alreadySent }));
      } catch (err) {
        return failSell(live, reason, err.message);
      } finally {
        closingSet.delete(live.id);
      }
    }

    /**
     * Sell `pct`% of a position (STIERED). Confirms before reducing the
     * stored amount, and uses exact integer math. If what would remain is
     * dust (<= 0.1%), sells everything instead of leaving a stub open
     * forever. A partial sell that fails is remembered (pending_sell_pct)
     * and retried by the polling loop. Caller must hold the mint's lock.
     */
    async function partialSell(pos, pct, reason, { isRetry = false, rememberFailure = true } = {}) {
      // rememberFailure=false (manual Telegram sells): a failed sell is
      // reported but NOT queued for automatic retry — you decide whether to
      // tap again.
      const remember = !isRetry && rememberFailure;
      const live = activeMap.get(pos.id);
      if (!live || live.status !== 'active') return { ok: false, message: 'That position is already closed.' };
      if (closingSet.has(live.id)) return { ok: false, message: 'A sell for this position is already in progress.' };
      // Keep tapped while this copy-wallet sell waited in the coin's queue.
      if (isCopyExit(reason) && live.keep) {
        info(`[Main] Position ${shortId(live.id)} is on KEEP; not following the copy wallet's sell.`);
        return { ok: false, message: 'Stopped: you tapped Keep.' };
      }

      closingSet.add(live.id);
      try {
        return await tracked(async () => {
          if (live.needs_reconcile) {
            await reconcileInner(live);
            if (live.needs_reconcile) {
              // Amount still unknown: remember the sell and retry it later.
              if (remember) {
                const remaining = (1 - num(live.pending_sell_pct) / 100) * (1 - pct / 100);
                persist(live, { pending_sell_pct: (1 - remaining) * 100 });
              }
              return failSell(live, reason, 'its token amount is not known yet', { noRetry: !remember });
            }
          }
          const decimals = await resolveDecimals(live);
          if (decimals === null) {
            markClosed(live, { close_reason: `${reason} (no tokens on-chain)`, token_amount: '0' });
            return { ok: true, message: 'No tokens on-chain; marked closed.' };
          }

          const trackedRaw = uiToRaw(live.token_amount, decimals);
          const sellRaw = rawPercent(trackedRaw, pct);
          if (sellRaw <= 0n) {
            info(`[Main] ${pct.toFixed(2)}% of position ${shortId(live.id)} rounds to zero tokens; nothing to sell.`);
            if (isRetry) persist(live, { pending_sell_pct: null });
            return { ok: true, message: 'Nothing to sell.' };
          }
          if ((trackedRaw - sellRaw) * 1000n <= trackedRaw) {
            info(`[Main] Selling ${pct.toFixed(2)}% would leave dust; closing position ${shortId(live.id)} fully instead.`);
            return closeInner(live, `${reason} (remainder was dust)`, { persistIntent: true });
          }

          info(
            `[Main] Selling ${rawToUi(sellRaw, decimals)} tokens (${pct.toFixed(2)}%) of position ${shortId(live.id)} (${reason}).`
          );
          const res = await sellWithRetries(live, sellRaw, decimals, {
            full: false,
            stopIf: isCopyExit(reason) ? () => Boolean(live.keep) : null
          });
          if (res.stopped) return { ok: false, message: 'Stopped: you tapped Keep.' };
          if (!res.ok) {
            if (remember) {
              // Combine with any earlier failed partial: remaining fractions multiply.
              const remaining = (1 - num(live.pending_sell_pct) / 100) * (1 - pct / 100);
              persist(live, { pending_sell_pct: (1 - remaining) * 100 });
            }
            return failSell(live, reason, null, { noRetry: !remember });
          }
          if (res.empty) {
            markClosed(live, { close_reason: `${reason} (nothing left on-chain)`, token_amount: '0' });
            return { ok: true, message: 'No tokens left on-chain; marked closed.' };
          }

          live.sellFailures = 0;
          const soldRaw = res.soldRaw > trackedRaw ? trackedRaw : res.soldRaw;
          const soldPct = Number((soldRaw * 1000000n) / trackedRaw) / 10000;
          const costBefore = num(live.cost_basis_sol ?? live.buy_amount);
          const costSold = costBefore * (soldPct / 100);
          const swapCostBefore = num(live.swap_cost_sol ?? live.cost_basis_sol ?? live.buy_amount);
          const swapCostSold = swapCostBefore * (soldPct / 100);
          const priorRealized = num(live.realized_pnl_sol);
          const remainingRaw = trackedRaw - soldRaw;
          const remainderIsDust = remainingRaw * 1000n <= trackedRaw;

          const updates = {
            token_amount: rawToUi(remainingRaw, decimals),
            cost_basis_sol: costBefore - costSold,
            swap_cost_sol: swapCostBefore - swapCostSold,
            decimals
          };
          if (isRetry) updates.pending_sell_pct = null;
          if (remainderIsDust) {
            markClosed(live, { ...updates, close_reason: `${reason} (remainder was dust)`, close_signature: res.signature });
          } else {
            persist(live, updates);
          }
          info(
            `[Main] Position ${shortId(live.id)} ${remainderIsDust ? 'closed' : 'partially sold'} ` +
              `(https://solscan.io/tx/${res.signature}); ${rawToUi(remainingRaw, decimals)} tokens remain.`
          );

          const pnlSol = await reportSellPnl(live, reason, soldPct, { costSold, swapCostSold }, res, priorRealized);
          if (pnlSol !== null) storage.updatePosition(live.id, { realized_pnl_sol: priorRealized + pnlSol });
          if (pnlSol !== null && !remainderIsDust) live.realized_pnl_sol = priorRealized + pnlSol;
          return { ok: true, message: `Sold ${soldPct.toFixed(2)}% of position ${shortId(live.id)}.` };
        });
      } catch (err) {
        // e.g. an RPC error reading the balance: remember the sell like any
        // failed one, or a mirrored STIERED sell would be lost.
        if (remember && activeMap.has(live.id)) {
          const remaining = (1 - num(live.pending_sell_pct) / 100) * (1 - pct / 100);
          persist(live, { pending_sell_pct: (1 - remaining) * 100 });
        }
        return failSell(live, reason, err.message, { noRetry: !remember });
      } finally {
        closingSet.delete(live.id);
      }
    }

    // SELL_AFTER_SECONDS: sell the whole position at pos.sell_after_at. A
    // timer fires it on time; the price-polling loop is the backstop (and
    // covers positions restored after a restart). The exit is remembered
    // (pending_exit), so a failed sell is retried like a copy-sell.
    function timedExitReason() {
      return `SELL_AFTER_SECONDS (${config.SELL_AFTER_SECONDS}s)`;
    }

    function timedExitDue(pos, now = Date.now()) {
      return Boolean(pos.sell_after_at) && now >= num(pos.sell_after_at) && !pos.pending_exit && !pos.keep;
    }

    function triggerTimedExit(pos) {
      const live = activeMap.get(pos.id);
      if (!live || live.status !== 'active' || !timedExitDue(live) || isBusy(live.id)) return;
      info(`[Main] ${timedExitReason()}: selling all of position ${shortId(live.id)} (${live.mint}).`);
      requestClose(live, timedExitReason(), { persistIntent: true });
    }

    function scheduleTimedExit(pos) {
      const delay = Math.max(0, num(pos.sell_after_at) - Date.now());
      const t = setTimeout(() => triggerTimedExit(pos), delay);
      if (t.unref) t.unref();
    }

    // INSTANT_SELL: sell the whole buy the moment it is seen landed (at
    // "processed"), before it is confirmed or recorded as a position. The
    // tokens are read from the block the buy is in, in one call (both
    // possible token-account addresses plus the mint, for its decimals).
    // Returns { signature, amountRaw, ambiguous } for the position's close to
    // follow, or null (nothing sent: the close then sells the usual way).
    async function heldAtProcessed(mint) {
      const mintPk = new PublicKey(mint);
      const [classic, t22, mintAcc] = await rpcPool.withFailover((conn) =>
        conn.getMultipleAccountsInfo(
          [
            getAssociatedTokenAddressSync(mintPk, walletPubkey, true, TOKEN_PROGRAM_ID),
            getAssociatedTokenAddressSync(mintPk, walletPubkey, true, TOKEN_2022_PROGRAM_ID),
            mintPk
          ],
          'processed'
        )
      );
      const acc = mintAcc && mintAcc.owner.equals(TOKEN_2022_PROGRAM_ID) ? t22 : classic;
      const raw = acc && acc.data && acc.data.length >= 72 ? Buffer.from(acc.data).readBigUInt64LE(64) : 0n;
      const decimals = mintAcc && mintAcc.data && mintAcc.data.length >= 45 ? Buffer.from(mintAcc.data).readUInt8(44) : null;
      return { raw, decimals };
    }

    /**
     * INSTANT_SELL: be told the moment our tokens of `mint` arrive, instead
     * of polling: a subscription to both possible token-account addresses
     * (classic and Token-2022), at "processed". The RPC pushes the account
     * as soon as it has run the block with our buy, balance included, so the
     * sell can be built at once without reading it again.
     * Returns a function that ends the subscription.
     */
    function watchOwnTokens(mint, onTokens) {
      let conn;
      try {
        conn = rpcPool.getConnection('processed');
      } catch {
        return () => {};
      }
      if (!conn || typeof conn.onAccountChange !== 'function') return () => {};
      const ids = [];
      let done = false;
      let mintPk;
      try {
        mintPk = new PublicKey(mint);
      } catch {
        return () => {};
      }
      for (const program of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
        try {
          const ata = getAssociatedTokenAddressSync(mintPk, walletPubkey, true, program);
          ids.push(
            conn.onAccountChange(
              ata,
              (acc) => {
                if (done || !acc || !acc.data || acc.data.length < 72) return;
                const raw = Buffer.from(acc.data).readBigUInt64LE(64);
                if (raw > 0n) {
                  done = true;
                  onTokens(raw);
                }
              },
              'processed'
            )
          );
        } catch {
          // no websocket: the status polling still catches the landing
        }
      }
      return () => {
        done = true;
        for (const id of ids) Promise.resolve(conn.removeAccountChangeListener(id)).catch(() => {});
      };
    }

    async function sendInstantSell({ mint, dex, venue, pool, buySig, landedAt, knownRaw = null, knownDecimals = null }) {
      if (config.INSTANT_SELL_DELAY_MS > 0) await sleep(config.INSTANT_SELL_DELAY_MS);
      // The amount pushed with the landing (watchOwnTokens) needs no read.
      // Otherwise read it: a node a moment behind the one that reported the
      // buy can still show no tokens, so look again briefly.
      let bal = knownRaw > 0n && knownDecimals !== null && !config.INSTANT_SELL_DELAY_MS ? { raw: knownRaw, decimals: knownDecimals } : null;
      for (let i = 0; !bal && i < INSTANT_BALANCE_TRIES; i++) {
        try {
          bal = await heldAtProcessed(mint);
        } catch (err) {
          bal = null;
          if (i === INSTANT_BALANCE_TRIES - 1) warn(`[Main] INSTANT_SELL: reading the tokens failed (${err.message}).`);
        }
        if (bal && bal.raw > 0n && bal.decimals !== null) break;
        bal = null;
        await sleep(INSTANT_BALANCE_RETRY_MS);
      }
      if (!bal || !(bal.raw > 0n) || bal.decimals === null) {
        warn(`[Main] INSTANT_SELL: the tokens from buy ${buySig.slice(0, 8)}… aren't visible yet; selling them as soon as the buy is confirmed instead.`);
        return null;
      }
      try {
        const signature = await sellToken({
          mint,
          amountTokens: rawToUi(bal.raw, bal.decimals),
          slippage: config.SLIPPAGE,
          tip: config.JITO_TIP,
          dex,
          venue,
          pool: pool || null,
          warm: true
        });
        info(`[Main] INSTANT_SELL: sell of ${mint} sent ${Date.now() - landedAt}ms after the buy was seen landed: https://solscan.io/tx/${signature}`);
        return { signature, amountRaw: bal.raw };
      } catch (err) {
        if (err && err.txSignature) {
          warn(`[Main] INSTANT_SELL: sell send outcome unknown (${err.message}); following ${err.txSignature}.`);
          return { signature: err.txSignature, amountRaw: bal.raw, ambiguous: true };
        }
        warn(`[Main] INSTANT_SELL: the sell couldn't be sent (${err.message}); retrying once the buy is recorded.`);
        return null;
      }
    }

    /**
     * Close now, or, if a sell for it is already running or queued, remember
     * the exit (pending_exit) so the polling loop does it right after.
     * Returns 'started' | 'remembered'.
     */
    function closeOrRemember(pos, reason) {
      if (isBusy(pos.id)) {
        if (activeMap.has(pos.id) && pos.pending_exit !== reason) persist(pos, { pending_exit: reason });
        return 'remembered';
      }
      requestClose(pos, reason, { persistIntent: true });
      return 'started';
    }

    /** Queue a full close behind anything else in flight for this mint. */
    function requestClose(pos, reason, opts) {
      if (isBusy(pos.id)) {
        return Promise.resolve({ ok: false, message: 'A sell for this position is already in progress.' });
      }
      queuedSells.add(pos.id);
      return tracked(() => runExclusive(pos.mint, () => closePosition(pos, reason, opts)))
        .catch((err) => {
          error(`[Main] Close of ${shortId(pos.id)} failed unexpectedly:`, err.message);
          return { ok: false, message: err.message };
        })
        .finally(() => queuedSells.delete(pos.id));
    }

    /** Queue a retry of a failed partial sell. */
    /** Queue a partial sell behind anything else in flight for this mint. */
    function requestPartial(pos, pct, reason, opts) {
      if (isBusy(pos.id)) {
        return Promise.resolve({ ok: false, message: 'A sell for this position is already in progress.' });
      }
      queuedSells.add(pos.id);
      return tracked(() => runExclusive(pos.mint, () => partialSell(pos, pct, reason, opts)))
        .catch((err) => {
          error(`[Main] Partial sell of ${shortId(pos.id)} failed unexpectedly:`, err.message);
          return { ok: false, message: err.message };
        })
        .finally(() => queuedSells.delete(pos.id));
    }

    const PRICE_SAVE_EVERY_MS = 5000;
    let lastPriceSaveAt = 0;

    function requestPartialRetry(pos) {
      if (isBusy(pos.id)) return;
      queuedSells.add(pos.id);
      // The % is read when it runs (Keep may have cleared it, or another failure added to it, meanwhile).
      tracked(() =>
        runExclusive(pos.mint, () => {
          const pct = num(pos.pending_sell_pct);
          if (!(pct > 0)) return { ok: true, message: 'Nothing to retry.' };
          return partialSell(pos, pct, 'STIERED copy-sell (retry)', { isRetry: true });
        })
      )
        .catch((err) => error(`[Main] Partial-sell retry for ${shortId(pos.id)} failed unexpectedly:`, err.message))
        .finally(() => queuedSells.delete(pos.id));
    }

    function requestReconcile(pos) {
      if (isBusy(pos.id)) return;
      queuedSells.add(pos.id);
      tracked(() => runExclusive(pos.mint, () => reconcileInner(pos)))
        .catch((err) => warn(`[Main] Reconcile of ${shortId(pos.id)} failed: ${err.message}`))
        .finally(() => queuedSells.delete(pos.id));
    }

    // === BOT_MODE = SELLING ===
    if (config.BOT_MODE === 'SELLING') {
      info(`[Main] BOT_MODE=SELLING → liquidating ${activeMap.size} active position(s)...`);
      let failed = 0;
      for (const pos of Array.from(activeMap.values())) {
        try {
          const res = await closePosition(pos, 'SELLING mode liquidation');
          if (!res.ok) failed += 1;
        } catch (err) {
          failed += 1;
          error(`[Main] Liquidating ${shortId(pos.id)} failed:`, err.message);
        }
      }
      if (failed > 0) {
        warn(`[Main] ${failed} position(s) could not be sold and are still open. Run SELLING mode again or sell them manually.`);
      } else {
        info('[Main] All positions processed. Exiting.');
      }
      process.exit(failed > 0 ? 1 : 0);
    }

    // === BOT_MODE = COPY ===
    info('[Main] BOT_MODE=COPY → starting normal copy flow.');

    // --- 1) Price-polling loop: TP/SL/TSL for SAFE/TIERED, retries of
    // failed exits, current_price for everything (shown in Telegram) ---
    // A tick never waits on a sell: exits are queued and run in the
    // background, so one slow sell can't delay every other position's
    // stop-loss check.
    let pricePollInFlight = false;

    function pruneRecentCopySells() {
      const now = Date.now();
      for (const [mint, list] of recentCopySells) {
        const keep = list.filter((o) => now - o.at < RECENT_SELL_TTL_MS);
        if (keep.length) recentCopySells.set(mint, keep);
        else recentCopySells.delete(mint);
      }
    }

    async function pricePollingLoop() {
      if (pricePollInFlight || shuttingDown) return;
      pricePollInFlight = true;
      try {
        await tracked(async () => {
          pruneRecentCopySells();
          const now = Date.now();
          const positions = Array.from(activeMap.values()).filter(
            (p) => p.status === 'active' && !isBusy(p.id)
          );
          const batchedUpdates = [];

          // One batched DexScreener request (per 30 tokens) for every open
          // position, instead of one request per position.
          const priceTargets = positions.filter((p) => !p.pending_exit).map((p) => p.mint);
          const prices = priceTargets.length > 0 ? await getPrices(priceTargets) : new Map();

          await Promise.all(
            positions.map(async (pos) => {
              try {
                const coolingDown = now < (pos.nextSellAttemptAt || 0);

                // Exits that failed earlier (copy-sell / Telegram): retry them.
                if (pos.pending_exit) {
                  if (!coolingDown) {
                    info(`[Main] Retrying pending exit for ${shortId(pos.id)} (${pos.pending_exit}).`);
                    requestClose(pos, pos.pending_exit, { persistIntent: true });
                  }
                  return;
                }
                if (num(pos.pending_sell_pct) > 0 && !coolingDown) {
                  info(`[Main] Retrying failed partial sell (${num(pos.pending_sell_pct).toFixed(2)}%) for ${shortId(pos.id)}.`);
                  requestPartialRetry(pos);
                  return;
                }
                if (pos.needs_reconcile) requestReconcile(pos);

                if (timedExitDue(pos, now)) {
                  if (!coolingDown) triggerTimedExit(pos);
                  return;
                }

                const priceData = prices.get(pos.mint);
                if (!priceData) return;
                const cur = num(priceData.priceInUsd);
                if (!(cur > 0)) return;
                if (!activeMap.has(pos.id) || isBusy(pos.id)) return; // closed/closing meanwhile

                pos.current_price = cur;
                const updates = { current_price: cur };
                batchedUpdates.push({ id: pos.id, updates });

                // No entry price yet (DexScreener hadn't indexed the token at
                // buy time): adopt the first real price as entry. Comparing
                // against 0 would read as +Infinity% and trigger an instant TP.
                const entry = num(pos.entry_price);
                if (!(entry > 0)) {
                  pos.entry_price = cur;
                  pos.highest_price = cur;
                  updates.entry_price = cur;
                  updates.highest_price = cur;
                  info(`[Main] Position ${shortId(pos.id)} entry price set to first available price $${cur.toPrecision(6)}.`);
                  return;
                }

                if (!USES_TP_SL.has(pos.trade_mode)) return; // EXACT/STIERED exit by copy-sells

                const changePct = ((cur - entry) / entry) * 100;
                let exitReason = null;

                // === TRAILING STOP LOSS ===
                if (config.ENABLE_TRAILING_STOP && num(pos.trailing_stop_distance) > 0 && pos.trailing_stop_activation != null) {
                  if (cur > num(pos.highest_price)) {
                    pos.highest_price = cur;
                    updates.highest_price = cur;
                  }
                  if (!pos.trailing_stop_activated && changePct >= num(pos.trailing_stop_activation)) {
                    pos.trailing_stop_activated = true;
                    updates.trailing_stop_activated = true;
                    info(`[Main][TSL] Trailing stop activated for ${shortId(pos.id)} at ${changePct.toFixed(2)}% profit.`);
                  }
                  if (pos.trailing_stop_activated) {
                    const stop = num(pos.highest_price) * (1 - num(pos.trailing_stop_distance) / 100);
                    if (stop !== pos.trailing_stop_price) {
                      pos.trailing_stop_price = stop;
                      updates.trailing_stop_price = stop;
                    }
                    if (cur <= stop) {
                      exitReason = 'TSL';
                      info(
                        `[Main][TSL] Trailing stop hit for ${shortId(pos.id)} (${pos.mint}): peak $${num(pos.highest_price).toPrecision(6)}, ` +
                          `now $${cur.toPrecision(6)}, ${fmtSigned(changePct, 2)}% from entry.`
                      );
                    }
                  }
                }

                const tp = pos.take_profit_pct == null ? Infinity : num(pos.take_profit_pct, Infinity);
                const sl = pos.stop_loss_pct == null ? Infinity : num(pos.stop_loss_pct, Infinity);
                if (!exitReason && changePct >= tp) {
                  exitReason = 'TP';
                  info(`[Main][TP] Position ${shortId(pos.id)} (${pos.mint}) hit TAKE_PROFIT ${fmtSigned(changePct, 2)}%.`);
                }
                if (!exitReason && changePct <= -sl) {
                  exitReason = 'SL';
                  info(`[Main][SL] Position ${shortId(pos.id)} (${pos.mint}) hit STOP_LOSS ${fmtSigned(changePct, 2)}%.`);
                }

                if (exitReason) {
                  if (coolingDown) return; // a sell just failed; wait out the cooldown
                  requestClose(pos, exitReason);
                  return;
                }

                let logMessage =
                  `[Main] Position ${shortId(pos.id)} (${pos.mint}) open. Entry $${entry.toPrecision(6)}, ` +
                  `now $${cur.toPrecision(6)}, Δ ${fmtSigned(changePct, 2)}%`;
                if (pos.trailing_stop_activated && pos.trailing_stop_price) {
                  logMessage += `, peak $${num(pos.highest_price).toPrecision(6)}, TSL $${num(pos.trailing_stop_price).toPrecision(6)}`;
                }
                info(logMessage + '.');
              } catch (err) {
                error('[Main] Error in pricePollingLoop for', pos.id, err.message);
              }
            })
          );

          // Only the latest price changed: written at most every few seconds
          // (the whole positions file is rewritten each time, blocking the
          // bot meanwhile; the live values are in memory anyway).
          const priceOnly = batchedUpdates.every((u) => Object.keys(u.updates).every((k) => k === 'current_price'));
          if (batchedUpdates.length > 0 && (!priceOnly || Date.now() - lastPriceSaveAt >= PRICE_SAVE_EVERY_MS)) {
            lastPriceSaveAt = Date.now();
            try {
              storage.updatePositionsBatch(batchedUpdates);
            } catch (err) {
              error('[Main] Failed to save price updates:', err.message);
            }
          }
        });
      } catch (err) {
        error('[Main] Price polling tick failed:', err.message);
      } finally {
        pricePollInFlight = false;
      }
    }

    const pricePollTimer = setInterval(pricePollingLoop, config.PRICE_CHECK_DELAY);
    refreshBalance();
    const balanceTimer = setInterval(refreshBalance, BALANCE_REFRESH_MS);
    if (balanceTimer.unref) balanceTimer.unref();
    // Recover deposits from empty token accounts: once soon after start
    // (catches coins traded before this feature), then every 30 minutes.
    const firstSweepTimer = setTimeout(() => runAccountCleanup({ label: 'startup sweep' }).catch(() => {}), ACCOUNT_SWEEP_FIRST_MS);
    const sweepTimer = setInterval(() => runAccountCleanup({ label: 'periodic sweep' }).catch(() => {}), ACCOUNT_SWEEP_INTERVAL_MS);
    if (firstSweepTimer.unref) firstSweepTimer.unref();
    if (sweepTimer.unref) sweepTimer.unref();
    info(`[Main] Launched price polling every ${config.PRICE_CHECK_DELAY}ms.`);
    require('./usageStats').start(config.USAGE_LOG_MIN);
    // Closed positions move out of positions.json a few minutes after closing
    // (to data/positions-closed.jsonl), keeping every save small.
    const archiveTimer = setInterval(() => {
      try {
        storage.archiveClosed();
      } catch (err) {
        warn(`[Main] Couldn't archive closed positions: ${err.message}`);
      }
    }, 60_000);
    if (archiveTimer.unref) archiveTimer.unref();

    // --- 2) Copy-trade handling ---

    function recordCopySell(mint, slot, pct, wallet = config.COPY_WALLET) {
      if (typeof slot !== 'number') return;
      const now = Date.now();
      const key = `${wallet}:${mint}`;
      const list = (recentCopySells.get(key) || []).filter((o) => now - o.at < RECENT_SELL_TTL_MS);
      list.push({ slot, pct, at: now });
      recentCopySells.set(key, list);
    }

    /**
     * Fraction of a buy at `buySlot` the copy wallet still held after any of
     * its sells that landed LATER on-chain but were processed before this
     * buy (1 = none). EXACT treats any later sell as a full exit.
     */
    function remainingAfterLaterSells(mint, buySlot, mode, wallet = config.COPY_WALLET) {
      const list = recentCopySells.get(`${wallet}:${mint}`);
      if (!list || typeof buySlot !== 'number') return 1;
      const now = Date.now();
      let remaining = 1;
      for (const o of list) {
        if (now - o.at >= RECENT_SELL_TTL_MS || !(o.slot > buySlot)) continue;
        remaining *= mode === 'EXACT' ? 0 : 1 - o.pct / 100;
      }
      return remaining;
    }

    function sizeBuy(copyAmountSol) {
      if (config.TRADE_TYPE === 'EXACT') return copyAmountSol;
      if (config.TRADE_TYPE === 'TIERED' || config.TRADE_TYPE === 'STIERED') {
        return computeTieredBuyAmount(copyAmountSol, config.TIER_BUY_CONFIG);
      }
      return config.BUY_AMOUNT;
    }

    /** What the confirmed buy delivered and cost: { receivedRaw, decimals, costSol } (receivedRaw null if unknown). */
    async function measureBuy(buySig, mint, buyAmountSol) {
      const measured = await measureOwnTx(buySig, mint);
      if (measured) {
        const costSol = measured.lamportsDelta < 0 ? -measured.lamportsDelta / 1e9 : buyAmountSol;
        // The same without network fee, tip and token-account deposit: what
        // went into the swap itself.
        const feesSol = measured.lamportsDelta < 0 ? Math.min(costSol, Math.max(0, extraCostsSol(measured))) : 0;
        const swapCostSol = costSol - feesSol;
        if (measured.tokenDeltaRaw > 0n && measured.decimals !== null) {
          return { receivedRaw: measured.tokenDeltaRaw, decimals: measured.decimals, costSol, swapCostSol, feesSol, pumpEvent: measured.pumpEvent };
        }
        // The transaction itself is readable and shows no tokens arrived.
        return { receivedRaw: 0n, decimals: measured.decimals, costSol, swapCostSol, feesSol };
      }
      // Fallback: wallet balance minus what we already track for this mint.
      // A reading that shows nothing new is treated as UNKNOWN (the RPC may
      // just be lagging), not as "no tokens" — losing track of a real buy is
      // worse than reconciling a position a little later.
      warn(`[Main] Couldn't read buy tx ${buySig}; falling back to wallet balance.`);
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const bal = await getOnChainBalance(mint);
          if (bal.decimals === null) return { receivedRaw: null, decimals: null, costSol: buyAmountSol };
          let alreadyRaw = 0n;
          for (const p of activeByMint(mint)) alreadyRaw += uiToRaw(p.token_amount, bal.decimals);
          const receivedRaw = bal.raw - alreadyRaw;
          return { receivedRaw: receivedRaw > 0n ? receivedRaw : null, decimals: bal.decimals, costSol: buyAmountSol };
        } catch (err) {
          warn(`[Main] Balance read after buy failed (attempt ${attempt}/3): ${err.message}`);
          await sleep(1000);
        }
      }
      return { receivedRaw: null, decimals: null, costSol: buyAmountSol };
    }

    async function handleCopyBuy({ signature, mint, solAmount, slot, seenAt, portalDex, venue, pool = null, copyPriceSol = null, copyPriceExact = false, pairedStock = null, copyHeldBefore = null, copyBoughtEarlier = false, curveHint = null, shred = false, fastHint = null, wallet = config.COPY_WALLET, marks = null, fastSent = null }) {
      // FAST_PATH="rust": the fast path rehearsed this buy (paused): log its timing.
      if (fastSent && fastSent.status === 'rehearsed') {
        const r = { buildMs: round2(fastSent.buildMs), readyAt: seenAt + (fastSent.readyMs || 0), label: 'Rust fast path' };
        info(buyTiming.rehearsal({ mint, hisSlot: slot, seenAt, decideAt: null, result: r, marks, leader: leaderInfo.leaderOf(slot) }) + ' (Rust fast path)');
        return;
      }
      // FAST_PATH="rust": already bought by the fast path; everything from here on is ours.
      const fastBought = Boolean(fastSent && fastSent.status === 'bought');
      if (fastBought && fastSent.resent && storage.getAllPositions().some((p) => p.buy_signature === fastSent.signature)) {
        // Resent after a reconnect, but already taken over before it.
        if (fastPath) {
          fastPath.ack(fastSent.signature);
          fastPath.saved(fastSent.signature);
        }
        return;
      }
      if (shuttingDown && !fastBought) {
        info(`[Main] Shutting down; not opening a new buy for ${mint}.`);
        return;
      }

      // PAUSED_REHEARSAL: a paused bot still goes through a shred buy up to
      // the send (checks, build, signing) to measure its timing.
      const rehearse = !fastBought && paused && shred && (config.PAUSED_REHEARSAL || config.REHEARSE_ONLY);
      const existing = activeByMint(mint)[0] || null;
      const copyAmountSol = Math.abs(solAmount);
      let buyAmountSol = fastBought ? fastSent.amountSol : null;
      // The copy wallet's own sells that landed after this buy but were
      // processed first (used again once the buy has filled).
      const remainingFrac = MIRRORS_COPY_SELLS.has(config.TRADE_TYPE)
        ? remainingAfterLaterSells(mint, slot, config.TRADE_TYPE, wallet)
        : 1;
      checks: {
      if (fastBought) break checks;
      if (paused && !rehearse) {
        info(`[Main] Buying is paused; not copying the buy of ${mint}.`);
        return;
      }

      if (config.SKIP_REBUYS !== 'off' && hasExited(wallet, mint)) {
        info(`[Main] Copy wallet${who(wallet)} is buying back into ${mint} after exiting it; SKIP_REBUYS=${config.SKIP_REBUYS}, not buying.`);
        return;
      }

      if (!existing && buyingMints.has(mint)) {
        // The fast path (or another buy here) is buying this coin right now.
        info(`[Main] Copy wallet${who(wallet)} bought ${mint}, which is already being bought; not buying it again.`);
        return;
      }
      if (existing && walletOf(existing) !== wallet) {
        // Bought on another copy wallet's buy: that wallet's trades run it.
        info(`[Main] Copy wallet${who(wallet)} bought ${mint}, which you already hold from${who(walletOf(existing))}'s buy; not adding to it.`);
        return;
      }
      if (existing && !config.ENABLE_MULTI_BUY) {
        info(`[Main] MULTI_BUY disabled & position exists for ${mint}, skipping buy.`);
        return;
      }
      if (existing && (existing.pending_exit || num(existing.pending_sell_pct) > 0)) {
        info(`[Main] Position in ${mint} has a pending sell; not adding to it.`);
        return;
      }

      // ONLY_COPY_FIRST_BUY: if the copy wallet already held this coin, this
      // is one of its later buys (e.g. the bot was started mid-trade): skip.
      // (When we already hold the coin, ENABLE_MULTI_BUY decides instead.)
      if (config.ONLY_COPY_FIRST_BUY && !existing) {
        let held = copyHeldBefore;
        let how = 'his balance just before this buy';
        if (typeof held !== 'boolean') {
          if (copyBoughtEarlier) {
            held = true;
            how = 'he bought it earlier while the bot was running';
          } else {
            await Promise.race([copyHoldings.ready, sleep(3000)]);
            held = holdingsOf(wallet).atStart.has(mint);
            how = 'he held it when the bot started';
          }
        }
        if (held) {
          info(`[Main] Copy wallet${who(wallet)} already held ${mint} (${how}); ONLY_COPY_FIRST_BUY is on, so only his first buy of a coin is copied. Skipping.`);
          return;
        }
      }

      // The copy wallet's own sells that landed after this buy but were
      // processed first: if they've already sold out, don't buy at all.
      if (remainingFrac <= 0.001) {
        info(`[Main] Copy wallet already sold out of ${mint} after this buy; skipping it.`);
        return;
      }

      // MAX_TOKEN_TAX_PCT: skip coins with a transfer fee ("tax") above the
      // limit. Pump.fun coins can't have one, so they skip the lookup, and
      // stock-paired coins are exempt (your choice).
      if (config.MAX_TOKEN_TAX_PCT !== null && pairedStock) {
        info(`[Main] ${mint} is paired to ${stockLabel(pairedStock)} (a stock); tax cap not applied.`);
      } else if (config.MAX_TOKEN_TAX_PCT !== null && venue !== 'pumpfun') {
        let taxPct;
        try {
          taxPct = await tokenTax.getTransferFeePct(mint);
        } catch (err) {
          warn(`[Main] Couldn't check ${mint} for a transfer tax (${err.message}); buying anyway.`);
        }
        if (taxPct !== undefined && taxPct > config.MAX_TOKEN_TAX_PCT) {
          info(`[Main] Skipping ${mint}: ${taxPct}% transfer tax is above MAX_TOKEN_TAX_PCT (${config.MAX_TOKEN_TAX_PCT}%).`);
          telegramBot.notifyInfo(`⛔ Skipped ${mint.slice(0, 4)}...${mint.slice(-4)}: it has a ${taxPct}% transfer tax (your max is ${config.MAX_TOKEN_TAX_PCT}%).`);
          return;
        }
      }

      // MIN_COPY_BUY_SOL: ignore the copy wallet's small (test / low-conviction) buys.
      if (config.MIN_COPY_BUY_SOL !== null && copyAmountSol < config.MIN_COPY_BUY_SOL) {
        info(`[Main] Copy wallet's buy of ${mint} is ${copyAmountSol} SOL, below MIN_COPY_BUY_SOL (${config.MIN_COPY_BUY_SOL}); not buying.`);
        return;
      }
      buyAmountSol = sizeBuy(copyAmountSol);

      // --- Risk cap #1: hard per-trade ceiling (clamp, never skip) ---
      if (buyAmountSol > config.MAX_BUY_AMOUNT) {
        warn(`[Main] Computed buy ${buyAmountSol} SOL exceeds MAX_BUY_AMOUNT (${config.MAX_BUY_AMOUNT} SOL); clamping down.`);
        buyAmountSol = config.MAX_BUY_AMOUNT;
      }

      // --- Risk cap #2: total exposure, including buys still in flight ---
      const exposure = currentExposureSol();
      const room = config.MAX_TOTAL_EXPOSURE - exposure;
      if (buyAmountSol > room) {
        if (room <= 0 || room < config.MIN_TRADE_SOL) {
          warn(
            `[Main] Skipping buy for ${mint}: exposure ${exposure.toFixed(4)} SOL leaves no room under ` +
              `MAX_TOTAL_EXPOSURE (${config.MAX_TOTAL_EXPOSURE} SOL).`
          );
          return;
        }
        warn(
          `[Main] Buy of ${buyAmountSol} SOL for ${mint} would exceed MAX_TOTAL_EXPOSURE ` +
            `(${config.MAX_TOTAL_EXPOSURE} SOL); clamping to remaining room of ${room.toFixed(4)} SOL.`
        );
        buyAmountSol = room;
      }
      buyAmountSol = Math.floor(buyAmountSol * 1e9) / 1e9; // whole lamports

      // Not enough SOL in the wallet for this buy (plus its tip and fees)?
      const needSol = buyAmountSol + (config.SEND_VIA === 'sender' ? config.SENDER_TIP : config.JITO_TIP) + FEE_RESERVE_SOL;
      if (walletSol !== null && walletSol < needSol) {
        info(`[Main] Skipping buy of ${mint}: wallet has ${walletSol.toFixed(4)} SOL, needs ~${needSol.toFixed(4)}.`);
        if (!rehearse && Date.now() - lastLowBalanceNotice > 10 * 60_000) {
          lastLowBalanceNotice = Date.now();
          telegramBot.notifyAlert(
            `Wallet balance too low to copy buys: ${walletSol.toFixed(4)} SOL (this buy needed ~${needSol.toFixed(4)}). ` +
              'Buys are skipped until you top up; you will not get this message more than every 10 minutes.'
          );
        }
        refreshBalance(); // in case it was just topped up
        return;
      }

      // BUY_COOLDOWN_SEC: another buy went out moments ago: skip this one.
      // Claimed with no await before the reservation below, so two buys
      // arriving together can't both pass; given back if nothing is sent.
      const cooldownMs = config.BUY_COOLDOWN_SEC * 1000;
      const sinceLast = Date.now() - lastBuyAt;
      if (cooldownMs > 0 && lastBuyAt > 0 && sinceLast < cooldownMs) {
        const ago = (sinceLast / 1000).toFixed(1);
        info(`[Main] Skipping buy of ${mint}${who(wallet)}: the bot sent another buy ${ago}s ago (BUY_COOLDOWN_SEC=${config.BUY_COOLDOWN_SEC}).`);
        if (!rehearse) notifySkip('cooldown', `⛔ Skipped ${mint.slice(0, 4)}...${mint.slice(-4)}: another buy went out ${ago}s earlier (BUY_COOLDOWN_SEC=${config.BUY_COOLDOWN_SEC}).`);
        return;
      }

      // MAX_OPEN_POSITIONS: a buy that would open one more position than
      // allowed is skipped (adding to one you hold is not a new position).
      // Checked and reserved with no await in between, so buys arriving
      // together can't both take the last place.
      if (!existing && config.MAX_OPEN_POSITIONS > 0 && openPositionCount() >= config.MAX_OPEN_POSITIONS) {
        const open = openPositionCount();
        info(
          `[Main] Skipping buy of ${mint}${who(wallet)}: ${open} position(s) open or being bought, ` +
            `the most allowed by MAX_OPEN_POSITIONS (${config.MAX_OPEN_POSITIONS}).`
        );
        if (!rehearse) notifySkip('cap', `⛔ Skipped ${mint.slice(0, 4)}...${mint.slice(-4)}: already ${open} open position(s) (MAX_OPEN_POSITIONS=${config.MAX_OPEN_POSITIONS}).`);
        return;
      }
      } // checks
      const opensNew = !existing;

      // Reserve the SOL (and the position's place) before the first await
      // so concurrent buys see it.
      const prevBuyAt = lastBuyAt;
      const myBuyAt = Date.now();
      lastBuyAt = myBuyAt;
      // Nothing went out after all: this buy doesn't start a cooldown.
      const unclaimCooldown = () => {
        if (lastBuyAt === myBuyAt) lastBuyAt = prevBuyAt;
      };
      // A fast path buy was already counted when it claimed his transaction.
      const claim = fastBought ? fastClaims.get(signature) : null;
      if (claim) fastClaims.delete(signature);
      if (!claim) {
        pendingBuySol += buyAmountSol;
        if (opensNew) pendingNewPositions += 1;
        // Being bought: the fast path leaves this coin alone meanwhile.
        buyingMints.set(mint, (buyingMints.get(mint) || 0) + 1);
        if (fastPath) fastPath.pushState();
      } else if (claim.sol !== buyAmountSol) {
        pendingBuySol = Math.max(0, pendingBuySol - claim.sol + buyAmountSol);
      }
      let reserved = true;
      let placeReserved = claim ? claim.opensNew : opensNew;
      const releasePlace = () => {
        if (placeReserved) {
          pendingNewPositions = Math.max(0, pendingNewPositions - 1);
          placeReserved = false;
        }
      };
      const release = () => {
        if (reserved) {
          pendingBuySol = Math.max(0, pendingBuySol - buyAmountSol);
          reserved = false;
        }
      };

      // A buy sent from here is noted on disk until its position is saved, so a
      // stop in between can't leave tokens nobody is tracking (the fast path's
      // buys are kept by the fast path itself).
      let myPendingSig = null;
      const notePendingBuy = (sig) => {
        if (rehearse || !sig) return;
        buysInFlight.add(sig);
        myPendingSig = sig;
        try {
          storage.addPendingBuy({ signature: sig, mint, sol: buyAmountSol, at: Date.now(), wallet, venue, dex: portalDex, pool, parent: signature, mode: config.TRADE_TYPE });
        } catch (err) {
          warn(`[Main] Couldn't note buy ${sig.slice(0, 8)}… on disk (${err.message}).`);
        }
      };
      try {
        let buySig;
        let sentAt = null;
        let decideAt = null;
        if (fastBought) {
          // Sent by the Rust fast path: record it as if sent from here.
          buySig = fastSent.signature;
          sentAt = fastSent.sentAt || null;
          tradeExecutorMod.noteExternalBuy(buySig, { buildMs: fastSent.buildMs, sendMs: fastSent.sendMs, sentAt, guard: fastSent.guard, compute: fastSent.compute });
          if (fastPath) {
            fastPath.ack(buySig);
            fastPath.pushState();
          }
          info(
            `[Main] Copy buy detected${who(wallet)}: mint=${mint}, SOL=${copyAmountSol} (mode=${config.TRADE_TYPE}). ` +
              `The Rust fast path bought ${buyAmountSol} SOL (${fastSent.via || 'Pump.fun'}, built and signed in ${round2(fastSent.buildMs)} ms, Sender answered in ${Math.round(fastSent.sendMs || 0)} ms): https://solscan.io/tx/${buySig}`
          );
          if (fastSent.ambiguous) warn(`[Main] The fast path couldn't tell whether ${buySig} was accepted (${fastSent.ambiguous}); following it by signature.`);
        } else {
          info(
            `[Main] Copy buy detected${who(wallet)}: mint=${mint}, SOL=${copyAmountSol} (mode=${config.TRADE_TYPE}). ` +
              `${rehearse ? 'Buying is paused: rehearsing' : 'Placing'} our BUY of ${buyAmountSol} SOL (venue=${venue}, dex=${portalDex})...`
          );

          // MAX_ENTRY_PREMIUM_PCT: the most we'll pay per token vs the copy wallet.
          let priceCheck = null;
          if (config.MAX_ENTRY_PREMIUM_PCT !== null) {
            if (copyPriceSol > 0) priceCheck = { copyPriceSol, maxPct: config.MAX_ENTRY_PREMIUM_PCT };
            else info(`[Main] MAX_ENTRY_PREMIUM_PCT: the copy wallet's price for ${mint} isn't known; buying without the price check.`);
          }

          // MAX_SLOTS_BEHIND: the buy cancels itself on-chain if it lands too late.
          let guard = null;
          if (config.MAX_SLOTS_BEHIND !== null && slotGuard.isAvailable()) {
            if (typeof slot !== 'number') {
              info(`[Main] Skipping buy of ${mint}: the copy wallet's slot isn't known, so MAX_SLOTS_BEHIND can't be enforced. Nothing was sent.`);
              unclaimCooldown();
              return;
            }
            guard = { maxSlot: slot + config.MAX_SLOTS_BEHIND, seenAt, slotsAllowed: config.MAX_SLOTS_BEHIND };
          }

          // LEADER_MAX_KM: the slot(s) it could land in are led from too far
          // away to reach in time; it would be cancelled (or land late) and
          // still pay its priority fee.
          const reach = leaderInfo.reachable(slot, guard ? guard.slotsAllowed : 0);
          if (!reach.ok) {
            info(`[Main] ${rehearse ? 'Rehearsal: would skip' : 'Skipping'} buy of ${mint}: ${reach.why}, so it would almost certainly arrive too late. Nothing was sent.`);
            buyTiming.noteSkipped();
            if (!rehearse) notifySkip('leader', `⛔ Skipped ${mint.slice(0, 4)}...${mint.slice(-4)}: ${reach.why}.`);
            unclaimCooldown();
            return;
          }

          // Copied early from the shreds, and his buy has already failed: it
          // never held the coin, so there is nothing to copy.
          if (failedCopyBuys.has(signature)) {
            info(`[Main] Not buying ${mint}: the copy wallet's buy ${signature} has already failed. Nothing was sent.`);
            unclaimCooldown();
            return;
          }

          decideAt = Date.now();
          if (marks) marks.decide = performance.now();
          try {
            buySig = await buyToken({
              mint,
              amountSol: buyAmountSol,
              slippage: config.SLIPPAGE,
              tip: config.JITO_TIP,
              dex: portalDex,
              venue,
              pool,
              priceCheck,
              curveHint,
              coinFilter: COIN_FILTER,
              slotGuard: guard,
              fastHint,
              dryRun: rehearse
            });
            sentAt = Date.now();
            notePendingBuy(buySig);
          } catch (err) {
            if (!(err && err.txSignature)) unclaimCooldown(); // nothing was sent
            if (err && err.coinFiltered) {
              info(`[Main] ${rehearse ? 'Rehearsal: would skip' : 'Skipping'} buy of ${mint}: ${err.message} (${err.setting}). Nothing was sent.`);
              if (!rehearse) telegramBot.notifyInfo(`⛔ Skipped ${mint.slice(0, 4)}...${mint.slice(-4)}: ${err.short}.`);
              return;
            }
            if (err && err.entryPriceTooHigh) {
              info(`[Main] ${rehearse ? 'Rehearsal: would skip' : 'Skipping'} buy of ${mint}: ${err.message} (MAX_ENTRY_PREMIUM_PCT). Nothing was sent.`);
              if (!rehearse) telegramBot.notifyInfo(
                `⛔ Skipped ${mint.slice(0, 4)}...${mint.slice(-4)}: price already ${err.premiumPct >= 0 ? '+' : ''}${err.premiumPct.toFixed(0)}% above the copy wallet's (your max is ${err.maxPct}%).`
              );
              return;
            }
            // Connection dropped after the request went out: the buy may still
            // land, so follow it by signature instead of assuming it failed.
            if (!(err && err.txSignature)) throw err;
            warn(`[Main] Buy send outcome unknown (${err.message}); checking whether ${err.txSignature} lands...`);
            buySig = err.txSignature;
            notePendingBuy(buySig);
          }

        }

        if (rehearse) {
          // Built and signed, not sent: log how long it took and stop here.
          unclaimCooldown();
          const r = buySig && typeof buySig === 'object' ? buySig : {};
          if (r.noDirect) info(`[Main] Rehearsal of ${mint}: no direct build (${r.why}); a real buy would go through SolanaPortal/Jupiter if allowed.`);
          else info(buyTiming.rehearsal({ mint, hisSlot: slot, seenAt, decideAt, result: r, marks, leader: leaderInfo.leaderOf(slot) }));
          return;
        }

        info(`[Main] Waiting for confirmation of ${buySig}...`);
        // INSTANT_SELL: sold the moment the buy lands (an add-on to a coin
        // already held is left to that position's own exits).
        const instant = config.INSTANT_SELL && activeByMint(mint).length === 0;
        let instantSell = null; // Promise<{ signature, amountRaw, ambiguous } | null>
        // Whichever notices first: our tokens arriving (pushed), or the
        // buy's status (polled every 50 ms).
        let landedOnce = false;
        let stopWatch = () => {};
        const fireLanded = (landedSlot, how, knownRaw = null) => {
          if (landedOnce) return;
          landedOnce = true;
          stopWatch();
          const landedAt = Date.now();
          info(
            `[Main] INSTANT_SELL: buy ${buySig.slice(0, 8)}… landed${typeof landedSlot === 'number' ? ` in slot ${landedSlot}` : ''}` +
              `${sentAt !== null ? ` ${landedAt - sentAt}ms after sending` : ''} (${how}); selling it` +
              `${config.INSTANT_SELL_DELAY_MS > 0 ? ` in ${config.INSTANT_SELL_DELAY_MS}ms` : ' now'}.`
          );
          // Every Pump.fun coin has 6 decimals; other venues read them.
          const knownDecimals = knownRaw !== null && venue === 'pumpfun' ? 6 : null;
          instantSell = sendInstantSell({ mint, dex: portalDex, venue, pool, buySig, landedAt, knownRaw: knownDecimals !== null ? knownRaw : null, knownDecimals }).catch((err) => {
            warn(`[Main] INSTANT_SELL failed unexpectedly: ${err.message}`);
            return null;
          });
        };
        const onLanded = instant ? (landedSlot) => fireLanded(landedSlot, 'its status') : null;
        if (instant) {
          // Read the coin's state now, while the buy is landing, so the sell is built without a lookup.
          if (venue === 'pumpfun') tradeExecutorMod.prewarmSell(mint);
          stopWatch = watchOwnTokens(mint, (raw) => fireLanded(null, 'its tokens arrived', raw));
        }
        const conf = await waitForConfirmation(buySig, config.CONFIRM_TIMEOUT_SEC, { alongWith: signature, onLanded });
        stopWatch();
        if (shred) {
          // Shred buys: timing of each step and where it landed vs his block.
          const his = typeof conf.alongSlot === 'number' ? conf.alongSlot : slot;
          const cancelled = !conf.confirmed && conf.err && slotGuard.explainFailure(buySig, conf.err);
          let outcome = 'unknown';
          if (conf.confirmed) outcome = conf.slot === his ? 'same' : 'late';
          else if (cancelled) outcome = 'late';
          else if (conf.err) outcome = typeof conf.slot === 'number' && conf.slot !== his ? 'late' : 'failed';
          info(
            buyTiming.record({
              mint,
              outcome,
              hisSlot: his,
              ourSlot: typeof conf.slot === 'number' ? conf.slot : null,
              seenAt,
              decideAt,
              timing: tradeTiming(buySig),
              failure: conf.err && !cancelled ? explainTxError(conf.err, pool || venue).split(';')[0] : '',
              leader: leaderInfo.leaderOf(his),
              marks
            })
          );
        }
        if (!conf.confirmed) {
          if (instantSell) {
            instantSell.then((sent) => {
              if (sent) warn(`[Main] INSTANT_SELL: buy ${buySig.slice(0, 8)}… didn't confirm after all, so sell ${sent.signature} fails on-chain (network fee only) unless the buy lands late.`);
            });
          }
          const guardWhy = conf.err ? slotGuard.explainFailure(buySig, conf.err) : null;
          if (guardWhy) {
            info(`[Main] Buy ${buySig} of ${mint} cancelled: ${guardWhy}.`);
            dropPendingBuy(buySig);
          } else if (conf.err) {
            dropPendingBuy(buySig);
            noteComputeFailure(buySig, conf.err);
            warn(`[Main] Buy ${buySig} FAILED on-chain: ${explainTxError(conf.err, pool || venue)}; no position opened.`);
          } else {
            const msg =
              `Buy ${buySig} for ${mint} was not confirmed within ${config.CONFIRM_TIMEOUT_SEC}s; no position opened. ` +
              'If it landed late, those tokens are in your wallet but NOT tracked by the bot.';
            warn(`[Main] ${msg}`);
            telegramBot.notifyAlert(msg);
          }
          return;
        }
        // How far behind the copy wallet we landed, in slots (~400ms each),
        // and how long the bot itself took from seeing the trade to sending.
        // His slot as the chain records it (looked up alongside ours): the
        // feed's slot is when the notification came, which can be later.
        const hisSlot = typeof conf.alongSlot === 'number' ? conf.alongSlot : slot;
        const slotsBehind = typeof hisSlot === 'number' && typeof conf.slot === 'number' ? conf.slot - hisSlot : null;
        const reactionMs = typeof seenAt === 'number' && sentAt !== null ? sentAt - seenAt : null;
        const feedNote =
          typeof conf.alongSlot === 'number' && typeof slot === 'number' && conf.alongSlot !== slot
            ? `; the feed reported his trade at slot ${slot}, it landed in ${conf.alongSlot}`
            : '';
        info(
          `[Main] Buy ${buySig} confirmed on-chain` +
            (slotsBehind !== null ? `, ${slotsBehind} slot(s) after the copy wallet (${hisSlot} -> ${conf.slot}${feedNote})` : '') +
            (reactionMs !== null ? `; bot reaction ${reactionMs}ms (seen -> sent)` : '') +
            '.'
        );

        // What the buy actually delivered and cost, read from the transaction
        // itself — exact, and unaffected by tokens we already held.
        // The USD price (DexScreener) can take seconds: only an add-on buy,
        // whose entry price is averaged, waits for it. A new position takes it
        // when it arrives, so a copy sell queued behind this buy isn't held up.
        const pricePromise = getPriceOnChain(mint).catch(() => null);
        const fill = await measureBuy(buySig, mint, buyAmountSol);
        const priceData = activeByMint(mint).length ? await pricePromise : null;
        const { receivedRaw, decimals, costSol, pumpEvent } = fill;
        // Unknown fill (balance fallback): no fee breakdown, the full cost is used.
        const swapCostSol = typeof fill.swapCostSol === 'number' ? fill.swapCostSol : costSol;

        if (receivedRaw !== null && !(receivedRaw > 0n)) {
          const msg = `Buy ${buySig} for ${mint} confirmed but no tokens were received; no position opened.`;
          dropPendingBuy(buySig);
          warn(`[Main] ${msg}`);
          telegramBot.notifyAlert(msg);
          return;
        }
        const unknownFill = receivedRaw === null;
        if (unknownFill) {
          const msg =
            `Buy ${buySig} for ${mint} CONFIRMED but its token amount couldn't be read (RPC trouble). ` +
            'Recording the position anyway; its amount will be filled in from the on-chain balance.';
          warn(`[Main] ${msg}`);
          telegramBot.notifyAlert(msg);
        }

        const entryPriceUsd = priceData ? num(priceData.priceInUsd) : 0;

        let pos;
        let added = false;
        const current = activeByMint(mint)[0] || null;
        if (current) {
          // ENABLE_MULTI_BUY: add to the existing position instead of opening
          // a duplicate one.
          const updates = {
            buy_amount: num(current.buy_amount) + buyAmountSol,
            cost_basis_sol: num(current.cost_basis_sol ?? current.buy_amount) + costSol,
            swap_cost_sol: num(current.swap_cost_sol ?? current.cost_basis_sol ?? current.buy_amount) + swapCostSol,
            buy_count: num(current.buy_count, 1) + 1
          };
          if (unknownFill || current.needs_reconcile) {
            // One of the fills is unknown: the whole position gets its
            // amount from the on-chain balance instead.
            updates.needs_reconcile = true;
          } else {
            const prevRaw = uiToRaw(current.token_amount, decimals);
            const newRaw = prevRaw + receivedRaw;
            const prevEntry = num(current.entry_price);
            let entry = prevEntry;
            if (prevEntry > 0 && entryPriceUsd > 0 && newRaw > 0n) {
              entry = (prevEntry * Number(prevRaw) + entryPriceUsd * Number(receivedRaw)) / Number(newRaw);
            } else if (!(prevEntry > 0)) {
              entry = entryPriceUsd;
            }
            Object.assign(updates, { token_amount: rawToUi(newRaw, decimals), decimals, entry_price: entry });
          }
          persist(current, updates);
          pos = current;
          added = true;
        } else {
          const tradeMode = config.TRADE_TYPE;
          const usesTpSl = USES_TP_SL.has(tradeMode);
          const newPos = storage.addPosition({
            mint,
            buy_amount: buyAmountSol,
            cost_basis_sol: costSol,
            swap_cost_sol: swapCostSol, // cost without network fee, tip and deposit (PNL_EXCLUDE_FEES)
            token_amount: unknownFill ? '0' : rawToUi(receivedRaw, decimals),
            decimals: unknownFill ? null : decimals,
            needs_reconcile: unknownFill,
            entry_price: entryPriceUsd,
            current_price: entryPriceUsd,
            highest_price: entryPriceUsd,
            trade_mode: tradeMode,
            parent_signature: signature,
            buy_signature: buySig,
            copy_wallet: wallet, // whose sells this position follows
            stop_loss_pct: usesTpSl ? config.STOP_LOSS : null,
            take_profit_pct: usesTpSl ? config.TAKE_PROFIT : null,
            dex: portalDex,
            venue,
            pool, // pool type the copy wallet bought on: sells go straight to the matching builder
            realized_pnl_sol: 0,
            trailing_stop_distance: config.ENABLE_TRAILING_STOP ? config.TRAILING_STOP_DISTANCE : null,
            trailing_stop_activation: config.ENABLE_TRAILING_STOP ? config.TRAILING_STOP_ACTIVATION : null,
            // SELL_AFTER_SECONDS: when this position is sold regardless of the copy wallet.
            // (INSTANT_SELL sells it straight away instead.)
            sell_after_at: config.SELL_AFTER_SECONDS > 0 && !instant ? Date.now() + config.SELL_AFTER_SECONDS * 1000 : null
          });
          activeMap.set(newPos.id, { ...newPos });
          releasePlace(); // now counted as an open position
          stateChanged();
          pos = activeMap.get(newPos.id);
          if (pos.sell_after_at) scheduleTimedExit(pos);
          const opened = pos;
          pricePromise.then((pd) => {
            const px = pd ? num(pd.priceInUsd) : 0;
            if (!(px > 0)) {
              info(`[Main] No price for ${mint} yet; entry will be set from the first price the polling loop sees.`);
              return;
            }
            // Unless the price loop got there first.
            if (activeMap.get(opened.id) === opened && !(num(opened.entry_price) > 0)) {
              persist(opened, { entry_price: px, current_price: px, highest_price: Math.max(px, num(opened.highest_price)) });
            }
          });
        }
        dropPendingBuy(buySig); // its position is saved
        release(); // now counted via the position's cost basis instead
        refreshBalance();
        // Copied early from the shreds, and the copy wallet's own buy has
        // since failed: it never held the coin.
        if (!added && failedCopyBuys.has(signature)) exitFailedCopyBuy(pos);

        info(
          `[Main] ${added ? 'Added to' : 'New'} position ID=${pos.id}, mint=${mint}, tokens=${pos.token_amount}, ` +
            `cost=${num(pos.cost_basis_sol).toFixed(4)} SOL, entry=$${num(pos.entry_price).toPrecision(6)}, venue=${venue}.`
        );
        info(`[Main] View on Axiom: ${axiomLink(mint)}`);
        // Market cap, curve progress and holder figures, looked up in the
        // background — the buy is done, nothing here delays trading.
        // What we paid per token vs what the copy wallet paid. Exact when both
        // sides are Pump.fun trades (read from their trade records);
        // otherwise approximate (balance changes include fees).
        let vsCopy = null;
        if (copyPriceSol > 0 && receivedRaw !== null && receivedRaw > 0n) {
          const ours = pumpEvent && pumpEvent.solLamports > 0n
            ? swapPrice(pumpEvent.solLamports, pumpEvent.tokenRaw, decimals)
            : buyAmountSol / Number(rawToUi(receivedRaw, decimals));
          if (ours > 0) {
            vsCopy = { pct: (ours / copyPriceSol - 1) * 100, exact: Boolean(copyPriceExact && pumpEvent && pumpEvent.solLamports > 0n) };
            if (!added) persist(pos, { copy_price_sol: copyPriceSol, entry_vs_copy_pct: vsCopy.pct });
            info(`[Main] ${mint}: paid ${vsCopy.pct >= 0 ? '+' : ''}${vsCopy.pct.toFixed(1)}% vs the copy wallet's price${vsCopy.exact ? '' : ' (approx.)'}.`);
          }
        }

        const coinSnapshot = pricePromise.then((pd) => coinInfo.snapshot({ mint, pumpEvent, priceData: pd })).then((snap) => {
          const lines = coinInfo.describe(snap);
          if (lines.length) info(`[Main] ${mint}: ${lines.join(' | ').replace(/\n/g, ' ')}`);
          return snap;
        });
        // Paid from a QUOTE_TOKENS reserve: remember which token (sells pay out in it).
        const qtBuy = typeof tradeExecutorMod.quoteTradeOf === 'function' ? tradeExecutorMod.quoteTradeOf(buySig) : null;
        if (qtBuy && !added) {
          persist(pos, { quote_mint: qtBuy.quoteMint });
          info(`[Main] ${mint} is paired to ${qtBuy.label}: bought from the ${qtBuy.label} reserve (cost valued in SOL at its price); its sells pay out in ${qtBuy.label}.`);
        }
        // Stock pairing: from the copy wallet's trade, or Pump.fun's record of ours.
        const stock = pairedStock || (pumpEvent && isStockToken(pumpEvent.quoteMint) ? pumpEvent.quoteMint : null);
        if (stock && !added) persist(pos, { paired_stock: stock });
        telegramBot.notifyBuy(pos, { added, slotsBehind, reactionMs, coinSnapshot, vsCopy, pairedStock: stock ? stockLabel(stock) : null, blockRate: shred ? buyTiming.summary() : '' });

        // INSTANT_SELL: the sell sent when the buy landed (usually confirmed
        // by now) closes the position; if none could be sent, sell now.
        if (instant && !added) {
          const early = instantSell ? await instantSell : null;
          if (!early) info(`[Main] INSTANT_SELL: selling position ${shortId(pos.id)} now.`);
          await closePosition(pos, 'INSTANT_SELL', { persistIntent: true, alreadySent: early });
        } else if (remainingFrac < 1 && pos.trade_mode === 'STIERED' && config.FULL_EXIT_ON_COPY_SELL && !pos.keep) {
          info(`[Main] Copy wallet already sold some of ${mint} before our buy landed; FULL_EXIT_ON_COPY_SELL is on, so selling all of it.`);
          await closePosition(pos, 'STIERED copy-sell (processed before buy, full exit)', { persistIntent: true });
        } else if (remainingFrac < 1 && pos.trade_mode === 'STIERED' && !unknownFill) {
          const totalRaw = uiToRaw(pos.token_amount, decimals);
          const trimRaw = (receivedRaw * BigInt(Math.round((1 - remainingFrac) * 1e6))) / 1000000n;
          if (trimRaw > 0n && totalRaw > 0n) {
            const pctOfTotal = Number((trimRaw * 1000000n) / totalRaw) / 10000;
            await partialSell(pos, pctOfTotal, 'STIERED copy-sell (processed before buy)');
          }
        }
      } finally {
        release();
        releasePlace();
        // Saved (or definitely not bought): the fast path can forget its report.
        if (fastBought && fastPath) fastPath.saved(fastSent.signature);
        if (myPendingSig) buysInFlight.delete(myPendingSig);
        const n = (buyingMints.get(mint) || 1) - 1;
        if (n > 0) buyingMints.set(mint, n);
        else buyingMints.delete(mint);
        stateChanged();
      }
    }

    // bookkeeping=false: an early exit from the shred stream; the websocket
    // feed records the sell itself (with the real % sold) when it arrives.
    async function handleCopySell({ mint, sellPercent, slot, viaTransfer = false, bookkeeping = true, wallet = config.COPY_WALLET }) {
      const pct = typeof sellPercent === 'number' ? Math.min(100, Math.max(0, sellPercent)) : 100;
      const what = viaTransfer ? 'copy-transfer' : bookkeeping ? 'copy-sell' : 'copy-sell (early, shreds)';
      const moved = viaTransfer ? 'moved out' : 'sold';
      if (bookkeeping) recordCopySell(mint, slot, pct, wallet);

      // SKIP_REBUYS: remember that the copy wallet has exited this coin, so
      // later buys of it are ignored. Recorded whether or not we hold it.
      const exited = config.SKIP_REBUYS === 'any' ? pct > 0 : config.SKIP_REBUYS === 'full' ? pct >= 99.9 : false;
      if (bookkeeping && exited && !hasExited(wallet, mint)) {
        exitedMints.add(`${wallet}:${mint}`);
        stateChanged();
        try {
          storage.addExitedMint(`${wallet}:${mint}`);
        } catch (err) {
          warn(`[Main] Could not save exited coin ${mint}: ${err.message}`);
        }
        info(`[Main] Copy wallet${who(wallet)} exited ${mint}; its future buys of it will be ignored (SKIP_REBUYS=${config.SKIP_REBUYS}).`);
      }

      const held = activeByMint(mint);
      // Only positions bought on this wallet's buys follow its sells.
      const positions = held.filter((p) => walletOf(p) === wallet);
      if (positions.length === 0) {
        if (held.length) info(`[Main] Copy wallet${who(wallet)} ${moved} ${mint}; your position follows${who(walletOf(held[0]))} instead, ignoring.`);
        else if (!viaTransfer) info(`[Main] Copy sell ${mint}${who(wallet)} but no active position, ignoring.`);
        return;
      }

      for (const pos of positions) {
        if (pos.keep) {
          // "Keep" tapped in Telegram: the user is managing this one by hand.
          const msg = `Copy wallet ${moved} ${pct.toFixed(0)}% of ${mint}; not following, you're keeping position ${shortId(pos.id)}.`;
          info(`[Main] ${msg}`);
          telegramBot.notifyInfo(`📌 Copy wallet ${moved} ${pct.toFixed(0)}% of ${mint.slice(0, 4)}...${mint.slice(-4)}. You're keeping your position; sell with the buttons when ready.`);
          continue;
        }
        if (pos.trade_mode === 'EXACT') {
          info(`[Main] Copy wallet ${moved} ${pct.toFixed(2)}% of ${mint}. Closing EXACT position ${shortId(pos.id)}...`);
          await closePosition(pos, `EXACT ${what}`, { persistIntent: true });
        } else if (pos.trade_mode === 'STIERED') {
          // An early exit from the shreds doesn't know how much he sold: a
          // STIERED position that mirrors partial sells (e.g. one opened before
          // TRADE_TYPE was changed) waits for the real % from the websocket feed.
          if (!bookkeeping && !config.FULL_EXIT_ON_COPY_SELL) {
            info(`[Main] Copy wallet${who(wallet)} is selling ${mint}; position ${shortId(pos.id)} mirrors the % sold, so it waits for the confirmed sell.`);
            continue;
          }
          // Mirror the percentage of their OWN stack the copy wallet let go of.
          if (pct >= 99.9) {
            info(`[Main] Copy wallet ${moved} ~100% of ${mint}; closing STIERED position ${shortId(pos.id)}.`);
            await closePosition(pos, `STIERED ${what} (full)`, { persistIntent: true });
          } else if (config.FULL_EXIT_ON_COPY_SELL) {
            info(
              `[Main] Copy wallet ${moved} ${pct.toFixed(2)}% of ${mint}; FULL_EXIT_ON_COPY_SELL is on, ` +
                `so selling ALL of STIERED position ${shortId(pos.id)}.`
            );
            await closePosition(pos, `STIERED ${what} (first sell, full exit)`, { persistIntent: true });
          } else {
            info(`[Main] Copy wallet ${moved} ${pct.toFixed(2)}% of ${mint}; mirroring on STIERED position ${shortId(pos.id)}.`);
            await partialSell(pos, pct, `STIERED ${what} (partial)`);
          }
        } else {
          info(`[Main] Copy wallet ${moved} ${mint}; ignored for ${pos.trade_mode} position (it exits via TP/SL).`);
        }
      }
    }

    async function handleCopyTrade(msg) {
      // (A fast-path buy's marks are on the fast path's own clock and already complete.)
      if (msg.marks && !msg.fastSent) msg.marks.handler = performance.now();
      const { signature, dexs, ca: mint, trade, solAmount, tokenAmount, sellPercent, slot, seenAt, copyPriceSol, copyPriceExact, pairedStock, copyHeldBefore, copyBoughtEarlier, curveHint, shred, fastHint } = msg;
      const wallet = msg.wallet || config.COPY_WALLET;

      // Tokens that left the copy wallet without a sale (sent elsewhere,
      // burned, swapped into another token): an exit for mirroring purposes.
      if (trade === 'transfer') {
        if (!config.MIRROR_TRANSFERS) {
          if (activeByMint(mint).some((p) => walletOf(p) === wallet)) info(`[Main] Copy wallet${who(wallet)} moved ${mint} out; MIRROR_TRANSFERS=false, ignoring.`);
          movedOut.add(`${wallet}:${mint}`);
          if (movedOut.size > 2000) movedOut.delete(movedOut.values().next().value);
          return;
        }
        await handleCopySell({ mint, sellPercent, slot, viaTransfer: true, wallet });
        return;
      }

      let portalDex = mapDex(dexs);
      if (!portalDex) {
        warn(`[Main] Unrecognized dexs ${JSON.stringify(dexs)}, defaulting to "jupiter".`);
        portalDex = 'jupiter';
      }
      const venue = detectVenue(dexs) || portalDex;
      const pool = detectPool(dexs);

      if (msg.shredEarlyExit) {
        await handleCopySell({ mint, sellPercent: 100, slot, bookkeeping: false, wallet });
        return;
      }
      // SHRED_BUYS_ONLY: a buy the shred stream didn't report (it arrived via
      // the websocket feed) is too late to copy profitably.
      // A later buy of a coin he already held: say so (the real reason) rather
      // than blaming the feed it came through.
      if (
        trade === 'buy' && solAmount < 0 && config.ONLY_COPY_FIRST_BUY && config.SHRED_SOURCE && config.SHRED_BUYS_ONLY && !msg.shred &&
        (copyHeldBefore === true || copyBoughtEarlier) && !activeByMint(mint).some((p) => walletOf(p) === wallet)
      ) {
        info(`[Main] Copy wallet${who(wallet)} bought more of ${mint}, which it already held; only first buys are copied (ONLY_COPY_FIRST_BUY).`);
        return;
      }
      if (trade === 'buy' && solAmount < 0 && config.SHRED_SOURCE && config.SHRED_BUYS_ONLY && !msg.shred) {
        info(
          `[Main] Copy buy of ${mint}${who(wallet)} seen only by the websocket feed (not the shred stream); not buying (SHRED_BUYS_ONLY).` +
            (shredFeed && shredFeed.state !== 'up' ? ' The shred feed is currently down.' : '')
        );
        return;
      }
      if (trade === 'buy' && solAmount < 0) {
        await handleCopyBuy({ signature, mint, solAmount, slot, seenAt, portalDex, venue, pool, copyPriceSol, copyPriceExact, pairedStock, copyHeldBefore, copyBoughtEarlier, curveHint, shred: !!shred, fastHint: fastHint || null, wallet, marks: msg.marks || null, fastSent: msg.fastSent || null });
      } else if (trade === 'sell' && tokenAmount < 0) {
        await handleCopySell({ mint, sellPercent, slot, wallet });
      }
    }

    // ONLY_COPY_FIRST_BUY: coins each copy wallet holds. One snapshot at
    // startup (two calls per wallet), then kept up to date from its own
    // trades; the buy path itself makes no extra call.
    const holdingsByWallet = new Map(config.COPY_WALLETS.map((w) => [w, { atStart: new Set(), seen: new Set(), loaded: false }]));
    function holdingsOf(wallet) {
      if (!holdingsByWallet.has(wallet)) holdingsByWallet.set(wallet, { atStart: new Set(), seen: new Set(), loaded: false });
      return holdingsByWallet.get(wallet);
    }
    const copyHoldings = { ready: Promise.resolve() };
    // Also needed by the shred stream (router buys are only copied for coins
    // the copy wallet doesn't hold yet).
    if (config.ONLY_COPY_FIRST_BUY || config.SHRED_SOURCE) {
      // One wallet's coins (both token programs). Retried until it works:
      // until then, router buys from the shreds can't be copied for it
      // (whether he already holds the coin is unknown).
      const loadHoldings = async (wallet, attempt = 1) => {
        const h = holdingsOf(wallet);
        try {
          const owner = new PublicKey(wallet);
          const found = new Set();
          for (const programId of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
            const resp = await rpcPool.withFailover((c) => c.getParsedTokenAccountsByOwner(owner, { programId }), undefined, { priority: 'low' });
            for (const acc of resp.value || []) {
              const inf = acc.account.data.parsed && acc.account.data.parsed.info;
              if (inf && inf.tokenAmount && inf.tokenAmount.amount !== '0') found.add(inf.mint);
            }
          }
          // Sells seen while loading already removed coins from `seen`; a coin
          // he exited meanwhile may still be in this snapshot, which only makes
          // the check stricter (his next buy of it isn't treated as a first).
          for (const m of found) h.atStart.add(m);
          h.loaded = true;
          stateChanged();
          info(
            `[Main] Copy wallet${who(wallet)} holds ${h.atStart.size} coin(s) right now` +
              (config.ONLY_COPY_FIRST_BUY ? "; its later buys of those won't be copied (ONLY_COPY_FIRST_BUY)." : '.')
          );
        } catch (err) {
          const retryIn = Math.min(60, 5 * attempt);
          warn(
            `[Main] Couldn't read the copy wallet${who(wallet)}'s current coins (${err.message}); trying again in ${retryIn}s.` +
              (config.SHRED_SOURCE ? ' Until then its router buys are not copied from the shreds.' : '')
          );
          if (shuttingDown) return;
          await sleep(retryIn * 1000);
          if (!shuttingDown) await loadHoldings(wallet, attempt + 1);
        }
      };
      copyHoldings.ready = Promise.all(config.COPY_WALLETS.map((w) => loadHoldings(w)));
    }

    const emitter = new CopyEmitter();
    emitter.connect();

    // PREWARM: blockhash + Pump.fun config kept warm for one-lookup trades.
    prewarm.start().catch((err) => warn(`[Prewarm] Not started: ${err.message}`));
    // QUOTE_TOKENS: reserves of the tokens some Pump.fun coins are paired to.
    if (quoteTokens.enabled() && config.DIRECT_PUMPFUN_SWAP) {
      const jupiterOk = Boolean(config.JUPITER_API_KEY);
      quoteTokens
        .start({
          priceProbe: jupiterOk ? require('./jupiterSwap').priceProbe : null,
          buyWithSol: jupiterOk
            ? async (mint, sol) => {
                const sig = await tradeExecutorMod.buyTokenViaJupiter(mint, sol);
                const c = await waitForConfirmation(sig, 60);
                if (!c.confirmed) throw new Error(`top-up ${sig} ${c.err ? 'failed on-chain' : 'was not confirmed'}`);
                refreshBalance();
                return sig;
              }
            : null
        })
        .catch((err) => warn(`[QuoteTokens] Not started: ${err.message}`));
    }
    // Where each slot's leader is: for the timing lines and LEADER_MAX_KM.
    leaderInfo.start();
    // Is this server keeping up? (event-loop delay, CPU, CPU stolen by other VMs)
    hostStats.start();

    if (config.MAX_SLOTS_BEHIND !== null) {
      if (!config.SHRED_SOURCE && config.MAX_SLOTS_BEHIND <= 1) {
        warn(
          `[Main] MAX_SLOTS_BEHIND=${config.MAX_SLOTS_BEHIND} without a shred feed: the websocket feed usually reports his buy ` +
            'after his block has ended, so most buys will be cancelled (each costs the network fee). Shreds are what make this work.'
        );
      }
      slotGuard.verifyDeployed(rpcPool.getConnection()).then((ok) => {
        if (ok) {
          info(`[Main] Slot guard on: buys cancel themselves on-chain if they land more than ${config.MAX_SLOTS_BEHIND} slot(s) after the copy wallet's (MAX_SLOTS_BEHIND).`);
        } else {
          error('[Main] The slot guard\'s on-chain program (Lighthouse) was not found, so MAX_SLOTS_BEHIND is OFF: buys are NOT guarded.');
          telegramBot.notifyAlert('MAX_SLOTS_BEHIND is OFF: its on-chain program (Lighthouse) was not found. Buys are not guarded.');
        }
      });
    }

    // What the fast path needs to decide a buy the way handleCopyBuy would.
    // Anything it can't be sure of, it leaves to this bot.
    const creatorVaultText = new Map();
    let farCache = { at: 0, ranges: [] };
    function farSlotRanges() {
      if (config.LEADER_MAX_KM === null) return [];
      if (Date.now() - farCache.at < 2000) return farCache.ranges;
      const now = slotClock.latestSlot ? slotClock.latestSlot() : null;
      const ranges = [];
      if (typeof now === 'number') {
        let start = null;
        for (let x = now; x <= now + 1500; x++) {
          const l = leaderInfo.leaderOf(x);
          const far = Boolean(l && l.km !== null && l.km > config.LEADER_MAX_KM);
          if (far && start === null) start = x;
          if (!far && start !== null) {
            ranges.push([start, x - 1]);
            start = null;
          }
        }
        if (start !== null) ranges.push([start, now + 1500]);
      }
      farCache = { at: Date.now(), ranges };
      return ranges;
    }
    function fastPathState() {
      const { creatorVaultPda } = require('@pump-fun/pump-sdk');
      const wallets = {};
      for (const w of config.COPY_WALLETS) {
        const h = holdingsOf(w);
        const exited = [];
        if (config.SKIP_REBUYS !== 'off') {
          for (const k of exitedMints) {
            const i = k.indexOf(':');
            if (i === -1) exited.push(k);
            else if (k.slice(0, i) === w) exited.push(k.slice(i + 1));
          }
        }
        wallets[w] = { allowed: true, holdingsLoaded: h.loaded, held: h.loaded ? [...h.atStart, ...h.seen] : [], exited };
      }
      const positions = [...buyingMints.keys()];
      for (const p of activeMap.values()) if (p.status === 'active') positions.push(p.mint);
      const blockedVaults = [];
      if (COIN_FILTER && COIN_FILTER.blockedCreators) {
        for (const c of COIN_FILTER.blockedCreators) {
          if (!creatorVaultText.has(c)) {
            try {
              creatorVaultText.set(c, creatorVaultPda(new PublicKey(c)).toBase58());
            } catch {
              creatorVaultText.set(c, null);
            }
          }
          if (creatorVaultText.get(c)) blockedVaults.push(creatorVaultText.get(c));
        }
      }
      const tipSol = config.SEND_VIA === 'sender' ? config.SENDER_TIP : config.JITO_TIP;
      const stocks = require('./stockTokens').stockRules();
      const tt = config.TRADE_TYPE;
      const sizing = tt === 'EXACT'
        ? { mode: 'exact' }
        : tt === 'TIERED' || tt === 'STIERED'
          ? { mode: 'tiers', tiers: config.TIER_BUY_CONFIG.map((t) => [t.maxSol, t.buyAmount]) }
          : { mode: 'fixed', fixed: config.BUY_AMOUNT };
      return {
        buying: !paused && !shuttingDown,
        rehearse: !shuttingDown && paused && (config.PAUSED_REHEARSAL || config.REHEARSE_ONLY),
        fastBuy: Boolean(config.SHRED_FAST_BUY && config.DIRECT_PUMPFUN_SWAP && config.HAND_BUILT_BUYS && fastPath && fastPath.verified),
        onlyFirstBuy: Boolean(config.ONLY_COPY_FIRST_BUY),
        wallets,
        positions,
        sizing,
        minTradeSol: config.MIN_TRADE_SOL,
        minCopyBuySol: config.MIN_COPY_BUY_SOL,
        maxBuySol: config.MAX_BUY_AMOUNT,
        roomSol: config.MAX_TOTAL_EXPOSURE - currentExposureSol(),
        spendableSol: walletSol === null ? null : walletSol - tipSol - FEE_RESERVE_SOL,
        cooldownMs: config.BUY_COOLDOWN_SEC * 1000,
        lastBuyAt,
        openSlots: config.MAX_OPEN_POSITIONS > 0 ? config.MAX_OPEN_POSITIONS - openPositionCount() : null,
        maxMcapSol: COIN_FILTER ? COIN_FILTER.maxMcapSol : null,
        minMcapSet: Boolean(COIN_FILTER && COIN_FILTER.minMcapSol !== null),
        blockedVaults,
        quoteMints: [...quoteTokens.knownQuoteMintList(), ...stocks.mints],
        quotePrefixes: stocks.prefixes,
        maxSlotsBehind: config.MAX_SLOTS_BEHIND,
        guardAvailable: slotGuard.isAvailable(),
        farSlots: farSlotRanges(),
        fees: {
          buyFeeSol: config.BUY_PRIORITY_FEE_SOL,
          buyFeePct: config.BUY_PRIORITY_FEE_PCT || 0,
          useSender: config.SEND_VIA === 'sender',
          senderTip: config.SENDER_TIP,
          jitoTip: config.JITO_TIP,
          ceiling: config.PUMPFUN_COMPUTE_UNITS
        },
        computeLimits: computeBudget.allEstimates(config.PUMPFUN_COMPUTE_UNITS)
      };
    }

    // FAST_PATH="rust": the Rust fast path reads the shred feeds and sends the
    // shred-copied Pump.fun buys it can; it needs this bot's state to decide.
    if (config.FAST_PATH === 'rust') {
      fastPath = new FastPath({ stateProvider: fastPathState });
      fastPath.on('claim', (m) => {
        if (!m.his || fastClaims.has(m.his) || !(m.amountSol > 0)) return;
        const opensNew = activeByMint(m.mint).length === 0;
        fastClaims.set(m.his, { mint: m.mint, sol: m.amountSol, opensNew, at: Date.now(), prevBuyAt: lastBuyAt });
        pendingBuySol += m.amountSol;
        if (opensNew) pendingNewPositions += 1;
        buyingMints.set(m.mint, (buyingMints.get(m.mint) || 0) + 1);
        lastBuyAt = fastClaims.get(m.his).at;
        fastPath.pushState();
      });
      fastPath.on('unclaim', (m) => {
        releaseClaim(m.his);
        fastPath.pushState();
      });
      // A claim whose report never came (the fast path stopped and lost it):
      // released after 10 minutes. A report waiting in this coin's queue is
      // still counted meanwhile.
      const claimSweep = setInterval(() => {
        for (const [his, c] of fastClaims) if (Date.now() - c.at > 600_000) releaseClaim(his);
      }, 30_000);
      if (claimSweep.unref) claimSweep.unref();
      fastPath.start();
      info(`[Main] FAST_PATH="rust": linking with the Rust fast path on 127.0.0.1:${config.FAST_PATH_PORT}.`);
    }

    // SHRED_SOURCE: decoded shreds alongside the websocket feed (see
    // shredFeed.js); several sources run side by side, first report wins.
    let shredFeed = null;
    if (config.SHRED_SOURCE) {
      shredFeed = new ShredFeeds({
        fastPath,
        emitter,
        isHeld: (mint, wallet = config.COPY_WALLET) => {
          const h = holdingsOf(wallet);
          return h.loaded ? h.atStart.has(mint) || h.seen.has(mint) : null;
        }
      });
      // SHRED_BUYS_ONLY: buying depends on this feed, so say when it's down.
      const downAlertMs = Number(process.env.SHRED_DOWN_ALERT_MS) || 30_000;
      let downTimer = null;
      let downAlerted = false;
      shredFeed.on('down', () => {
        if (!config.SHRED_BUYS_ONLY || downTimer) return;
        downTimer = setTimeout(() => {
          downTimer = null;
          downAlerted = true;
          warn(`[Main] Shred feed down for ${Math.round(downAlertMs / 1000)}s: no buys until it's back (SHRED_BUYS_ONLY). Sells still work.`);
          telegramBot.notifyAlert(`Shred feed down for ${Math.round(downAlertMs / 1000)}s: no copy buys until it reconnects. Sells and exits still work.`);
        }, downAlertMs);
        if (downTimer.unref) downTimer.unref();
      });
      shredFeed.on('up', () => {
        clearTimeout(downTimer);
        downTimer = null;
        if (downAlerted) {
          downAlerted = false;
          info('[Main] Shred feed is back; copy buys resume.');
          telegramBot.notifyInfo('✅ Shred feed is back; copy buys resume.');
        }
      });
      shredFeed.on('stopped', (why) => {
        clearTimeout(downTimer);
        const what = config.SHRED_BUYS_ONLY ? 'No copy buys this run (SHRED_BUYS_ONLY); sells and exits still work.' : 'Buys continue from the websocket feed.';
        warn(`[Main] Shred feed stopped: ${why}. ${what}`);
        telegramBot.notifyAlert(`Shred feed stopped: ${why}. ${what}`);
      });
      try {
        shredFeed.start();
      } catch (err) {
        error(`[Main] Shred stream not started: ${err.message}. Detection continues on the websocket feed.`);
        if (config.SHRED_BUYS_ONLY) {
          warn('[Main] No copy buys this run (SHRED_BUYS_ONLY and no shred feed); sells and exits still work.');
          telegramBot.notifyAlert(`Shred stream not started (${err.message}): no copy buys this run. Sells and exits still work.`);
        }
        shredFeed = null;
      }
      if (shredFeed && config.SHRED_BUYS_ONLY) {
        info('[Main] Buys only from the shred stream (SHRED_BUYS_ONLY): buys the websocket feed reports are not copied; sells and exits come from both.');
      }
    }

    // A buy copied early from the shreds whose original then failed on-chain.
    const failedCopyBuys = new Set();
    const failedHow = new Map(); // signature -> 'failed on-chain' | 'never landed'
    function exitFailedCopyBuy(pos) {
      const how = failedHow.get(pos.parent_signature) || 'failed on-chain';
      const reason = `copy wallet's buy ${how === 'never landed' ? 'never landed' : 'failed'} (seen early via shreds)`;
      const w = who(walletOf(pos));
      if (config.SHRED_SELL_IF_COPY_FAILED) {
        info(`[Main] The copy wallet${w}'s buy of ${pos.mint} ${how}; selling our position ${shortId(pos.id)} (SHRED_SELL_IF_COPY_FAILED).`);
        telegramBot.notifyAlert(`The copy wallet's buy of ${pos.mint} ${how} after we copied it early; selling ours.`);
        closeOrRemember(pos, reason);
      } else {
        telegramBot.notifyAlert(`The copy wallet's buy of ${pos.mint} ${how} after we copied it early. You still hold it (SHRED_SELL_IF_COPY_FAILED=false).`);
      }
    }
    /**
     * Does the copy wallet hold `mint` right now? true / false / null (couldn't
     * tell). Wallets that fire several copies of each buy (only one lands, the
     * rest fail) would otherwise make a failed duplicate look like a failed buy.
     */
    async function copyWalletHoldsNow(mint, wallet = config.COPY_WALLET, commitment = 'processed') {
      try {
        const resp = await rpcPool.withFailover((conn) =>
          conn.getParsedTokenAccountsByOwner(new PublicKey(wallet), { mint: new PublicKey(mint) }, commitment)
        );
        return resp.value.some((a) => BigInt(a.account.data.parsed.info.tokenAmount.amount) > 0n);
      } catch (err) {
        warn(`[Main] Couldn't check whether the copy wallet holds ${mint} (${err.message}).`);
        return null;
      }
    }

    // Safety net for a copy sell the feeds never delivered (the websocket was
    // down, or a transaction format the parser doesn't read): every minute,
    // and right after the websocket reconnects, check that each copy wallet
    // still holds the coins of the positions following it. EXACT / STIERED
    // positions have no TP/SL, so a missed sell would otherwise leave them
    // open for good. One small RPC call per open position.
    const HOLD_CHECK_MS = Number(process.env.HOLD_CHECK_MS) || 60_000;
    // His buy may still be landing before that (tests shorten both).
    const HOLD_CHECK_MIN_AGE_MS = process.env.HOLD_CHECK_MIN_AGE_MS !== undefined ? Number(process.env.HOLD_CHECK_MIN_AGE_MS) : 60_000;
    const movedOut = new Set(); // wallet:mint he moved out (MIRROR_TRANSFERS off: not an exit)
    // One empty reading isn't enough to sell on (a lagging RPC node can briefly
    // show none): read again, a moment later and at "confirmed".
    const HOLD_RECHECK_MS = process.env.HOLD_RECHECK_MS !== undefined ? Number(process.env.HOLD_RECHECK_MS) : 2000;
    let holdCheckRunning = false;
    async function checkCopyHoldings(why) {
      if (holdCheckRunning || shuttingDown) return;
      holdCheckRunning = true;
      try {
        const now = Date.now();
        for (const pos of Array.from(activeMap.values())) {
          if (pos.status !== 'active' || pos.keep || pos.pending_exit || isBusy(pos.id)) continue;
          if (!MIRRORS_COPY_SELLS.has(pos.trade_mode)) continue;
          const openedAt = Date.parse(pos.time || '');
          if (Number.isFinite(openedAt) && now - openedAt < HOLD_CHECK_MIN_AGE_MS) continue;
          const wallet = walletOf(pos);
          if (movedOut.has(`${wallet}:${pos.mint}`)) continue;
          if ((await copyWalletHoldsNow(pos.mint, wallet)) !== false) continue;
          await sleep(HOLD_RECHECK_MS);
          if ((await copyWalletHoldsNow(pos.mint, wallet, 'confirmed')) !== false) continue;
          if (!activeMap.has(pos.id) || isBusy(pos.id) || pos.keep || pos.pending_exit) continue;
          const msg = `Copy wallet${who(wallet)} no longer holds ${pos.mint}, but its sell never reached the bot (${why}); exiting position ${shortId(pos.id)} as if it sold everything.`;
          warn(`[Main] ${msg}`);
          telegramBot.notifyAlert(msg);
          tracked(() => runExclusive(pos.mint, () => handleCopySell({ mint: pos.mint, sellPercent: 100, slot: null, wallet }))).catch((err) =>
            error('[Main] Exit after a missed copy sell failed:', err.message)
          );
        }
      } finally {
        holdCheckRunning = false;
      }
    }
    // Buys that were sent but never saved as positions (see recoverPendingBuys):
    // looked at once shortly after starting, then every minute.
    const PENDING_SWEEP_MS = Number(process.env.PENDING_SWEEP_MS) || 60_000;
    const pendingFirst = setTimeout(() => recoverPendingBuys('found after a restart').catch((err) => warn(`[Main] Pending-buy check failed: ${err.message}`)), Number(process.env.PENDING_FIRST_MS) || 3000);
    if (pendingFirst.unref) pendingFirst.unref();
    const pendingTimer = setInterval(() => recoverPendingBuys('found by the regular check').catch(() => {}), PENDING_SWEEP_MS);
    if (pendingTimer.unref) pendingTimer.unref();
    const holdCheckTimer = setInterval(() => checkCopyHoldings('regular check').catch(() => {}), HOLD_CHECK_MS);
    if (holdCheckTimer.unref) holdCheckTimer.unref();
    emitter.on('resubscribed', () => {
      checkCopyHoldings('checked after the websocket reconnected').catch(() => {});
    });

    emitter.on('copyBuyFailed', ({ signature, mint, neverLanded, wallet = config.COPY_WALLET }) => {
      tracked(async () => {
        // Another of its transactions may have bought the coin: then this was
        // just a failed duplicate, and our position stays.
        if ((await copyWalletHoldsNow(mint, wallet)) === true) {
          info(
            `[Main] The copy wallet's transaction ${signature} for ${mint} ${neverLanded ? 'never landed' : 'failed'}, ` +
              'but it holds the coin (another of its transactions bought it); keeping our position.'
          );
          return;
        }
        failedCopyBuys.add(signature);
        failedHow.set(signature, neverLanded ? 'never landed' : 'failed on-chain');
        if (failedHow.size > 500) failedHow.delete(failedHow.keys().next().value);
        if (failedCopyBuys.size > 500) failedCopyBuys.delete(failedCopyBuys.values().next().value);
        // It didn't hold the coin after all.
        holdingsOf(wallet).seen.delete(mint);
        stateChanged();
        for (const pos of activeByMint(mint)) {
          if (pos.parent_signature === signature) exitFailedCopyBuy(pos);
        }
      }).catch((err) => error('[Main] Error handling a failed copy-wallet buy:', err.message));
    });

    emitter.on('copyTrade', (msg) => {
      if (shuttingDown) {
        info('[Main] Shutting down; ignoring incoming copyTrade event.');
        return;
      }
      if (msg.trade !== 'transfer' || activeByMint(msg.ca).length > 0) {
        // (The account list a no-lookup buy uses is left out: 1-3 KB per line,
        // written before our buy goes out.)
        const line = () => console.log('[Main] Received copyTrade:', JSON.stringify(msg, (k, v) => (k === 'marks' ? undefined : k === 'txKeys' && Array.isArray(v) ? `${v.length} accounts` : v)));
        // A shred buy is a race: write this once our buy is under way.
        if (msg.shred && msg.trade === 'buy') setImmediate(line);
        else line();
      }
      // Confirmed trades teach the shred stream the copy wallet's router.
      if (shredFeed && !msg.shred) shredFeed.learn(msg);
      if (!msg.wallet) msg.wallet = config.COPY_WALLET;
      // Keep track of the coins it holds, in arrival order (ONLY_COPY_FIRST_BUY).
      const h = holdingsOf(msg.wallet);
      if (msg.shredEarlyExit) {
        // bookkeeping happens when the websocket feed reports the sell
      } else if (msg.trade === 'buy') {
        msg.copyBoughtEarlier = h.seen.has(msg.ca);
        h.seen.add(msg.ca);
        if (h.seen.size > 5000) h.seen.delete(h.seen.values().next().value);
      } else if ((msg.trade === 'sell' || msg.trade === 'transfer') && num(msg.sellPercent) >= 99.9) {
        h.seen.delete(msg.ca);
        h.atStart.delete(msg.ca);
      }
      if (!msg.shredEarlyExit && (msg.trade === 'buy' || num(msg.sellPercent) >= 99.9)) stateChanged();
      tracked(() => runExclusive(msg.ca, () => handleCopyTrade(msg))).catch((err) => {
        error('[Main] Error handling copyTrade:', err.message);
        // The same failure (e.g. SolanaPortal down) for every trade in a row
        // would flood Telegram: alert once per 5 minutes per distinct error.
        const now = Date.now();
        const last = repeatAlerts.get(err.message) || 0;
        if (now - last >= 5 * 60 * 1000) {
          repeatAlerts.set(err.message, now);
          if (repeatAlerts.size > 50) repeatAlerts.delete(repeatAlerts.keys().next().value);
          telegramBot.notifyAlert(`Error handling a copy trade for ${msg.ca}: ${err.message}`);
        }
      });
    });

    // --- Optional Telegram control bot (no-op if not configured) ---
    telegramBot.init({
      getActivePositions: () => Array.from(activeMap.values()).filter((p) => p.status === 'active'),
      sellPositionById: async (id, pct = 100) => {
        if (shuttingDown) return { ok: false, message: 'The bot is shutting down.' };
        const pos = activeMap.get(id);
        if (!pos) return { ok: false, message: 'That position is already closed.' };
        if (pct >= 100) return requestClose(pos, 'Telegram manual sell', { persistIntent: true });
        return requestPartial(pos, pct, `Telegram manual sell (${pct}%)`, { rememberFailure: false });
      },
      // "Keep": stop following the copy wallet's sells for one position
      // (true), or go back to following them (false). TP/SL, if configured,
      // still apply. An exit the copy wallet already triggered that failed
      // and is waiting to retry is cancelled by Keep.
      setKeep: (id, keep) => {
        const pos = activeMap.get(id);
        if (!pos) return { ok: false, message: 'That position is already closed.' };
        const updates = { keep: Boolean(keep) };
        if (keep) {
          if (pos.pending_exit && /copy-(sell|transfer)/.test(pos.pending_exit)) updates.pending_exit = null;
          if (num(pos.pending_sell_pct) > 0) updates.pending_sell_pct = null;
        }
        persist(pos, updates);
        info(`[Main] Position ${shortId(pos.id)} (${pos.mint}): ${keep ? 'KEEP on (copy-wallet sells ignored)' : 'following copy-wallet sells again'}.`);
        return { ok: true, message: keep ? 'kept' : 'following' };
      },
      requestStop: () => gracefulShutdown('Telegram /stop'),
      isPaused: () => paused,
      setPaused: (value) => {
        if (config.REHEARSE_ONLY) {
          info('[Main] Resume ignored: REHEARSE_ONLY is on, this bot never buys.');
          return;
        }
        paused = Boolean(value);
        storage.setPaused(paused);
        stateChanged();
        info(`[Main] Buying ${paused ? 'PAUSED' : 'RESUMED'} from Telegram.`);
      },
      // Sell every open position at once (different tokens in parallel).
      // Each is a normal full close: confirmed before it's marked closed,
      // and retried automatically if it fails.
      closeAllPositions: async () => {
        if (shuttingDown) throw new Error('The bot is shutting down.');
        const positions = Array.from(activeMap.values()).filter((p) => p.status === 'active');
        // A position with a sell already running is sold right after it.
        const busy = positions.filter((p) => isBusy(p.id));
        for (const pos of busy) closeOrRemember(pos, 'Telegram close all');
        const now = positions.filter((p) => !busy.includes(p));
        const results = await Promise.all(now.map((pos) => requestClose(pos, 'Telegram close all', { persistIntent: true })));
        const closed = results.filter((r) => r && r.ok).length;
        return { total: positions.length, closed, queued: busy.length, failed: now.length - closed };
      }
    });

    info(`[Main] Bot is now listening to ${config.COPY_WALLETS.join(', ')} trades...`);
    if (MULTI_WALLET || config.MAX_OPEN_POSITIONS) {
      info(
        `[Main] Copying ${config.COPY_WALLETS.length} wallet(s); at most ${config.MAX_OPEN_POSITIONS || 'any number of'} position(s) open at once (MAX_OPEN_POSITIONS).` +
          (MULTI_WALLET ? " Each position follows the sells of the wallet whose buy opened it; another wallet's buy of a coin you hold is not copied." : '')
      );
    }
    telegramBot.notifyStarted({ paused, copyWallet: config.COPY_WALLET, copyWallets: config.COPY_WALLETS, maxOpen: config.MAX_OPEN_POSITIONS, openPositions: activeMap.size });
    {
      // Open positions bought on a wallet that is no longer in COPY_WALLET:
      // its sells aren't watched any more, and they still count toward
      // MAX_OPEN_POSITIONS.
      const orphans = [...activeMap.values()].filter((p) => p.status === 'active' && p.copy_wallet && !config.COPY_WALLETS.includes(p.copy_wallet));
      if (orphans.length) {
        const list = orphans.map((p) => `${shortMint(p.mint)} (from ${p.copy_wallet.slice(0, 4)}…${p.copy_wallet.slice(-4)})`).join(', ');
        const msg =
          `${orphans.length} open position(s) were bought on a wallet no longer in COPY_WALLET: ${list}. ` +
          "That wallet's sells are no longer watched; each is sold if the wallet stops holding the coin (checked every minute), " +
          'or sell it from Telegram. They count toward MAX_OPEN_POSITIONS.';
        warn(`[Main] ${msg}`);
        telegramBot.notifyAlert(msg);
      }
    }

    // --- Graceful shutdown (SIGINT/SIGTERM) ---
    // Stop taking on new work immediately, then wait for whatever's already
    // in flight (a buy/sell round-trip, a price-polling tick) to finish
    // before exiting. If something hangs we still exit after a bounded
    // timeout — safe, because a position is only ever marked closed once its
    // sell has confirmed, so an interrupted sell just leaves it open and it
    // is re-checked against the on-chain balance next run.
    let shutdownInProgress = false;

    async function gracefulShutdown(signal) {
      if (shutdownInProgress) {
        warn(`[Shutdown] Received ${signal} again while already shutting down; ignoring.`);
        return;
      }
      shutdownInProgress = true;
      shuttingDown = true;

      info(`[Shutdown] Received ${signal}. No longer accepting new copy trades or price-poll ticks.`);
      clearInterval(pricePollTimer);
      clearInterval(balanceTimer);
      clearTimeout(firstSweepTimer);
      clearInterval(sweepTimer);
      emitter.disconnect();
      if (shredFeed) shredFeed.stop();
      if (fastPath) fastPath.stop();
      prewarm.stop();
      await telegramBot.stop();

      if (inFlightCount > 0) {
        info(`[Shutdown] Waiting for ${inFlightCount} in-flight operation(s) to finish (up to ${SHUTDOWN_DRAIN_TIMEOUT_MS / 1000}s)...`);
      }

      const start = Date.now();
      while (inFlightCount > 0 && Date.now() - start < SHUTDOWN_DRAIN_TIMEOUT_MS) {
        await sleep(SHUTDOWN_POLL_INTERVAL_MS);
      }

      if (inFlightCount > 0) {
        warn(`[Shutdown] Timed out with ${inFlightCount} operation(s) still in flight; exiting anyway.`);
      } else {
        info('[Shutdown] All in-flight operations drained. Exiting cleanly.');
        if (buyTiming.summary()) info(`[Timing] ${buyTiming.summary()}`);
      }
      try {
        const usageStats = require('./usageStats');
        usageStats.stop();
        usageStats.logTotal();
      } catch {}
      const open = Array.from(activeMap.values()).filter((p) => p.status === 'active').length;
      await telegramBot.notifyStopped(
        `🛑 Bot stopped (${signal}).` +
          (open ? ` ${open} position(s) still open and NOT sold — start the bot again to resume managing them.` : ' No open positions.')
      );
      process.exit(0);
    }

    process.on('SIGINT', () => gracefulShutdown('SIGINT'));
    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  } catch (err) {
    error('[Main] Fatal error:', err.message);
    process.exit(1);
  }
})();
