// src/websocket.js
//
// Raw Solana RPC WebSocket feed: subscribes directly to `logsSubscribe` for
// the copy wallet via the standard Solana JSON-RPC WebSocket API. No
// third-party indexer (CoinVera, Helius, etc.) is involved — this works
// against any RPC provider that exposes a websocket endpoint.
//
// On each notification it fetches the full parsed transaction and turns it
// into the same 'copyTrade' event shape the rest of the bot already
// expects (see txParser.js), so index.js needs no changes at all.
const WebSocket = require('ws');
const EventEmitter = require('events');
const config = require('./config');
const slotClock = require('./slotClock');
const rpcPool = require('./rpcPool');
const { info, error, warn, redactUrl } = require('./logger');
const { parseCopyWalletEvents, MAX_TX_VERSION, DEX_PROGRAM_LABELS } = require('./txParser');
const { decodePumpTradesFromLogs, decodePumpCurveHint, decodePumpTradeDetails, swapPrice } = require('./fastPumpParser');

/** The curve hint for a processed Pump.fun buy (null if unusable); `at` = when seen. */
function curveHintFor(logs, mint, seenAt, wallet = config.COPY_WALLET) {
  try {
    const h = decodePumpCurveHint(logs, wallet, mint);
    return h ? { ...h, at: seenAt } : null;
  } catch {
    return null;
  }
}
const { findStockInTx } = require('./stockTokens');
const { PublicKey } = require('@solana/web3.js');
const usageStats = require('./usageStats');

// DETECTION_COMMITMENT="processed": hear about the copy wallet's trades as
// soon as they're processed. Pump.fun trades are then read straight from the
// notification's logs; anything else falls back to fetching the transaction,
// which only becomes available once it's confirmed — so allow longer for that.
const PROCESSED = config.DETECTION_COMMITMENT === 'processed';
const PUMP_TOKEN_DECIMALS = 6;

const PING_INTERVAL_MS = 30000;
const COPY_WALLET_SET = new Set(config.COPY_WALLETS);
const LOGS_ID_BASE = 100; // request ids of the per-wallet logsSubscribe calls
const RECONNECT_DELAY_MS = 5000;
const FIRST_RECONNECT_DELAY_MS = 500;
const GET_TX_MAX_ATTEMPTS = PROCESSED ? 12 : 5;
const GET_TX_RETRY_DELAY_MS = 400;
const SEEN_SIGNATURES_MAX = 2000;
// If SOLANA_RPC_FALLBACKS is configured, rotate to the next RPC/WS endpoint
// after this many consecutive failed connection attempts, rather than
// hammering the same dead endpoint forever.
const ROTATE_AFTER_CONSECUTIVE_FAILURES = 3;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const TOKEN_PROGRAMS = ['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'];

// Recurring transactions that mention the copy wallet but are signed by
// someone else (spam bots, airdrops, other people's routers). They can never
// be the copy wallet's own buy/sell/transfer, yet each one would cost a
// lookup. Once a lookup shows such a transaction, its "shape" (the exact
// sequence of programs and instructions in its logs) is remembered and later
// look-alikes are skipped without a lookup. Safety:
//   - Pump.fun trades by the copy wallet are read from the logs and are never
//     skipped.
//   - 1 in NOISE_VERIFY_EVERY look-alikes is still looked up, and if the copy
//     wallet itself ever signs one, that shape is forgotten at once.
const NOISE_VERIFY_EVERY = 20;
// A token program called directly (a plain transfer or burn by the signer).
const MOVES_TOKENS_RE = /Program (TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA|TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb) invoke \[1\]/;
const NOISE_SHAPES_MAX = 200;

/** The program/instruction sequence of a transaction's logs ('' if none). */
function logShape(logs) {
  if (!Array.isArray(logs)) return '';
  return logs
    .filter((l) => typeof l === 'string' && (/^Program \S+ invoke \[\d+\]$/.test(l) || l.startsWith('Program log: Instruction: ')))
    .join('|');
}

/**
 * A transactionSubscribe (jsonParsed) transaction in the same shape
 * getParsedTransaction returns (public keys as PublicKey objects), so the
 * same parser handles both.
 */
function toParsedTx(tx, slot) {
  const pk = (v) => (typeof v === 'string' ? new PublicKey(v) : v);
  const fixIx = (ix) => (ix && ix.programId ? { ...ix, programId: pk(ix.programId) } : ix);
  const msg = tx.transaction && tx.transaction.message;
  if (!msg || !Array.isArray(msg.accountKeys)) throw new Error('no account keys');
  const accountKeys = msg.accountKeys.map((k) =>
    typeof k === 'string' ? { pubkey: pk(k), signer: false, writable: false } : { ...k, pubkey: pk(k.pubkey) }
  );
  const meta = tx.meta
    ? {
        ...tx.meta,
        innerInstructions: (tx.meta.innerInstructions || []).map((g) => ({ ...g, instructions: (g.instructions || []).map(fixIx) }))
      }
    : null;
  return {
    slot: typeof slot === 'number' ? slot : tx.slot,
    version: tx.version,
    meta,
    transaction: { ...tx.transaction, message: { ...msg, accountKeys, instructions: (msg.instructions || []).map(fixIx) } }
  };
}

/**
 * True if a transaction's logs show it can't be a buy, sell or token
 * transfer, so fetching it would be a wasted RPC call. Every one of those
 * moves tokens, and moving tokens always runs a token program, which shows up
 * in the logs (even when called by a swap program). Plain SOL transfers, tip
 * payments etc. never do. Unknown or truncated logs: don't skip.
 */
function cannotBeTokenActivity(logs) {
  if (!Array.isArray(logs) || logs.length === 0) return false;
  if (logs.some((l) => typeof l !== 'string' || l.includes('Log truncated'))) return false;
  if (logs.some((l) => TOKEN_PROGRAMS.some((p) => l.includes(p)))) return false;
  return !anyCopyPumpTrade(logs);
}

/** Does the log hold a Pump.fun trade by any of the copy wallets? */
function anyCopyPumpTrade(logs) {
  return config.COPY_WALLETS.some((w) => {
    const pump = decodePumpTradesFromLogs(logs, w);
    return Boolean(pump && pump.length);
  });
}

/** The copy wallets that signed a parsed transaction. */
function copySigners(parsedTx) {
  const keys = (parsedTx.transaction && parsedTx.transaction.message && parsedTx.transaction.message.accountKeys) || [];
  const signers = new Set(keys.filter((k) => k && k.signer).map((k) => String(k.pubkey && k.pubkey.toBase58 ? k.pubkey.toBase58() : k.pubkey)));
  return config.COPY_WALLETS.filter((w) => signers.has(w));
}

class CopyEmitter extends EventEmitter {
  constructor() {
    super();
    this.ws = null;
    this.noiseShapes = new Map(); // shape -> { matches, example }
    // 'logs' (logsSubscribe, any provider) or 'transaction' (Helius
    // transactionSubscribe: whole transactions, failed ones filtered out by
    // Helius; Developer plan or higher). Falls back to 'logs' if refused.
    this.feed = config.DETECTION_FEED;
    this._subWallet = new Map(); // logsSubscribe id -> copy wallet
    this._msgBytes = 0;
    this.pingInterval = null;
    this.subscriptionId = null;
    // Small ring buffer so a duplicate notification (e.g. after a
    // reconnect/resubscribe) doesn't get processed twice.
    this.seenSignatures = new Set();
    // Tracks consecutive failed connect attempts, for optional RPC rotation.
    this.consecutiveFailures = 0;
    // Set by disconnect() so a deliberate close (shutdown) doesn't trigger
    // the auto-reconnect in the 'close' handler.
    this.stopped = false;
    // Pong watchdog: a half-open connection (network dropped without a
    // close frame) otherwise looks "connected" forever while delivering
    // nothing — trade detection would silently stop.
    this.isAlive = false;
  }

  _markSeen(signature) {
    if (this.seenSignatures.has(signature)) return true;
    this.seenSignatures.add(signature);
    if (this.seenSignatures.size > SEEN_SIGNATURES_MAX) {
      const oldest = this.seenSignatures.values().next().value;
      this.seenSignatures.delete(oldest);
    }
    return false;
  }

  connect() {
    if (this.stopped) return;
    const wsUrl = rpcPool.getWsUrl();
    if (!wsUrl) {
      warn(`[WebSocket] Endpoint ${redactUrl(rpcPool.getHttpUrl())} has no derivable websocket URL; skipping it.`);
      if (rpcPool.hasFallbacks()) rpcPool.rotate();
      setTimeout(() => this.connect(), RECONNECT_DELAY_MS);
      return;
    }
    // A connect that hangs (no answer to the handshake) fails after 10 s instead of never.
    const ws = new WebSocket(wsUrl, { handshakeTimeout: 10_000 });
    this.ws = ws;

    ws.on('pong', () => {
      this.isAlive = true;
    });

    ws.on('open', () => {
      this.isAlive = true;
      const txFeed = this.feed === 'transaction';
      info(
        `[WebSocket] Connected to Solana RPC WS (${redactUrl(wsUrl)}). Subscribing to ` +
          `${txFeed ? 'transactions (failed ones filtered out)' : 'logs'} for ${config.COPY_WALLETS.join(', ')}...`
      );
      // logsSubscribe takes one address: one subscription per copy wallet
      // (ids LOGS_ID_BASE + i).
      const txPayload = txFeed
        ? {
            jsonrpc: '2.0',
            id: 1,
            method: 'transactionSubscribe',
            params: [
              {
                accountInclude: config.COPY_WALLETS,
                // Spam that comes through known accounts (SHRED_EXCLUDE_ACCOUNTS).
                ...(config.SHRED_EXCLUDE_ACCOUNTS && config.SHRED_EXCLUDE_ACCOUNTS.length ? { accountExclude: config.SHRED_EXCLUDE_ACCOUNTS } : {}),
                failed: false,
                vote: false
              },
              {
                commitment: config.DETECTION_COMMITMENT,
                encoding: 'jsonParsed',
                transactionDetails: 'full',
                showRewards: false,
                maxSupportedTransactionVersion: MAX_TX_VERSION
              }
            ]
          }
        : null;
      const all = txPayload
        ? [txPayload]
        : config.COPY_WALLETS.map((w, i) => ({
            jsonrpc: '2.0',
            id: LOGS_ID_BASE + i,
            method: 'logsSubscribe',
            params: [{ mentions: [w] }, { commitment: config.DETECTION_COMMITMENT }]
          }));
      for (const p of all) ws.send(JSON.stringify(p));
      // With a shred feed: when each slot starts (slotClock.js), to measure
      // how far into the copy wallet's slot our buys go out.
      if (config.SHRED_SOURCE) ws.send(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'slotSubscribe' }));

      // Keep-alive PING so load balancers / proxies don't drop an idle
      // connection — and if the previous ping never got a pong back, the
      // connection is dead: terminate it so the 'close' handler reconnects.
      if (this.pingInterval) clearInterval(this.pingInterval);
      this.pingInterval = setInterval(() => {
        if (ws.readyState !== WebSocket.OPEN) return;
        if (!this.isAlive) {
          warn(`[WebSocket] No pong for ${PING_INTERVAL_MS / 1000}s; connection looks dead. Reconnecting...`);
          ws.terminate();
          return;
        }
        this.isAlive = false;
        ws.ping();
      }, PING_INTERVAL_MS);
    });

    ws.on('message', (data) => {
      const bytes = data && data.length ? data.length : 0;
      this._msgBytes = bytes; // for the per-wallet usage figures
      usageStats.countWs(bytes);
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch (err) {
        error('[WebSocket] Error parsing message:', err.message);
        return;
      }

      if (msg.method === 'slotNotification') {
        const r = msg.params && msg.params.result;
        if (r && typeof r.slot === 'number') slotClock.record(r.slot);
        return;
      }
      if (msg.id === 2) {
        if (msg.error) warn(`[WebSocket] Slot timing unavailable (${(msg.error && msg.error.message) || 'refused'}); buy timing won't show the position in the slot.`);
        return; // slotSubscribe confirmation
      }

      // Subscription confirmation: { "id": 1, "result": <subscriptionId> }
      const isSubId = msg.id === 1 || (typeof msg.id === 'number' && msg.id >= LOGS_ID_BASE);
      if (isSubId && typeof msg.result === 'number') {
        this.subscriptionId = msg.result;
        if (msg.id >= LOGS_ID_BASE) this._subWallet.set(msg.result, config.COPY_WALLETS[msg.id - LOGS_ID_BASE]); // logs feed: which wallet a notification is for
        // Only a working subscription counts as a healthy endpoint (an
        // endpoint that accepts connections but rejects logsSubscribe should
        // still get rotated away from).
        this.consecutiveFailures = 0;
        const forWallet = msg.id >= LOGS_ID_BASE && config.COPY_WALLETS.length > 1 ? ` of ${config.COPY_WALLETS[msg.id - LOGS_ID_BASE]}` : '';
        info(`[WebSocket] Subscribed to ${this.feed === 'transaction' ? 'transactions' : 'logs'}${forWallet} (subscription id ${this.subscriptionId}).`);
        // After a reconnect, trades made while the feed was down were never
        // delivered: the bot re-checks its open positions.
        if (msg.id === 1 || msg.id === LOGS_ID_BASE) {
          this.subscribeCount = (this.subscribeCount || 0) + 1;
          if (this.subscribeCount > 1) this.emit('resubscribed');
        }
        return;
      }

      if (msg.error) {
        error('[WebSocket] RPC error:', JSON.stringify(msg.error));
        // The subscription request itself was rejected — without a live
        // subscription nothing will ever be detected, so reconnect and retry
        // rather than sitting on a connection that delivers nothing.
        if (msg.id === 1 && this.feed === 'transaction') {
          // Not on this plan / provider: carry on with the standard feed.
          warn(
            '[WebSocket] DETECTION_FEED=transaction was refused by the RPC provider ' +
              `(${(msg.error && msg.error.message) || 'error'}). It needs Helius's transactionSubscribe ` +
              '(Developer plan or higher). Using the standard logs feed for this run.'
          );
          this.feed = 'logs';
          this.reconnectNow = true; // no gap in detection
          ws.close();
          return;
        }
        if (isSubId) {
          warn('[WebSocket] logsSubscribe was rejected; reconnecting to retry.');
          ws.close();
        }
        return;
      }

      if (msg.method === 'transactionNotification') {
        this._handleTxNotification(msg.params && msg.params.result);
        return;
      }

      if (msg.method !== 'logsNotification') {
        usageStats.countWsKind('other');
        return;
      }

      const value = msg.params && msg.params.result && msg.params.result.value;
      if (!value) return;

      const { signature, err } = value;
      const logWallet = this._subWallet.get(msg.params && msg.params.subscription);
      if (err) {
        usageStats.countWsKind('failed');
        if (logWallet) usageStats.countWallet(logWallet, this._msgBytes, 'failed');
        return; // failed transaction on-chain, nothing to copy
      }
      if (this._markSeen(signature)) {
        usageStats.countWsKind('duplicate');
        if (logWallet) usageStats.countWallet(logWallet, this._msgBytes, 'duplicate');
        return; // already processed (duplicate/replay)
      }
      if (logWallet) usageStats.countWallet(logWallet, this._msgBytes, 'activity'); // logs don't say who signed it
      if (cannotBeTokenActivity(value.logs)) {
        usageStats.countSkipped();
        return; // e.g. a plain SOL transfer: nothing to copy, no lookup needed
      }
      const shape = this._noiseCheck(value.logs);
      if (shape === false) {
        usageStats.countSkippedNoise();
        return; // a known kind of transaction someone else signs
      }

      // Fire-and-forget: resolve + parse + emit without blocking the
      // websocket message loop for subsequent notifications.
      const slot = msg.params.result.context && msg.params.result.context.slot;
      const seenAt = Date.now(); // for the bot's own reaction-time report
      const work = PROCESSED
        ? this._handleProcessed(signature, value.logs, slot, seenAt, shape)
        : this._handleSignature(signature, seenAt, shape);
      work.catch((e) => {
        error(`[WebSocket] Error handling signature ${signature}:`, e.message);
      });
    });

    ws.on('error', (err) => {
      error('[WebSocket] Error:', err.message);
    });

    ws.on('close', (code, reason) => {
      if (this.pingInterval) clearInterval(this.pingInterval);
      this.pingInterval = null;
      this.subscriptionId = null;
      if (this.stopped) {
        info('[WebSocket] Closed (shutdown).');
        return;
      }
      if (this.reconnectNow) {
        this.reconnectNow = false;
        this.connect();
        return;
      }
      this.consecutiveFailures += 1;
      // A connection that was working and dropped: straight back (copy trades
      // are missed while it's down). Repeated failures: wait between tries.
      const delay = this.consecutiveFailures === 1 ? FIRST_RECONNECT_DELAY_MS : RECONNECT_DELAY_MS;
      warn(`[WebSocket] Closed: ${code} - ${reason}. Reconnecting in ${delay}ms...`);

      if (
        rpcPool.hasFallbacks() &&
        this.consecutiveFailures >= ROTATE_AFTER_CONSECUTIVE_FAILURES
      ) {
        this.consecutiveFailures = 0;
        rpcPool.rotate();
      }

      setTimeout(() => this.connect(), delay);
    });
  }

  /**
   * Processed-stage fast path. Pump.fun trades are built straight from the
   * logs. A sell also needs the copy wallet's remaining balance (STIERED
   * mirrors the % sold), read at the processed stage; if that read isn't
   * fresh enough to include this trade, or the logs hold no Pump.fun trade by
   * the copy wallet, the whole transaction goes through the normal path.
   */
  async _handleProcessed(signature, logs, slot, seenAt, shape = '') {
    const trades = [];
    for (const wallet of config.COPY_WALLETS) {
      for (const t of decodePumpTradesFromLogs(logs, wallet) || []) trades.push({ ...t, wallet });
    }
    if (trades.length === 0) return this._handleSignature(signature, seenAt, shape);

    const events = [];
    for (const t of trades) {
      const wallet = t.wallet;
      const scale = 10 ** PUMP_TOKEN_DECIMALS;
      if (t.isBuy) {
        const solAmount = -Number(t.solLamports) / 1e9;
        if (Math.abs(solAmount) < config.MIN_TRADE_SOL) continue; // same dust filter as the normal path
        events.push({
          signature, slot, dexs: ['Pump.fun'], ca: t.mint, trade: 'buy', wallet,
          solAmount, tokenAmount: Number(t.tokenRaw) / scale, sellPercent: null, fast: true,
          // The copy wallet's exact swap price (SOL per token), for the buy
          // message's "vs copy wallet" comparison.
          copyPriceSol: swapPrice(t.solLamports, t.tokenRaw, PUMP_TOKEN_DECIMALS),
          copyPriceExact: true,
          // The coin's curve right after his buy, from his trade record: lets
          // a direct Pump.fun buy be built with no lookups (pumpfunDirect.js).
          curveHint: curveHintFor(logs, t.mint, seenAt, wallet)
        });
        const last = events[events.length - 1];
        if (last.curveHint && last.curveHint.creator) last.creator = last.curveHint.creator;
      } else {
        const sellPercent = await this._sellPercentNow(t.mint, t.tokenRaw, slot, wallet);
        if (sellPercent === null) return this._handleSignature(signature, seenAt); // emit nothing twice
        events.push({
          signature, slot, dexs: ['Pump.fun'], ca: t.mint, trade: 'sell', wallet,
          solAmount: Number(t.solLamports) / 1e9, tokenAmount: -Number(t.tokenRaw) / scale, sellPercent, fast: true
        });
      }
    }
    for (const event of events) this.emit('copyTrade', { ...event, seenAt });
  }

  /** % of its holding the copy wallet just sold, from its balance right now; null if unsure. */
  async _sellPercentNow(mint, soldRaw, slot, wallet = config.COPY_WALLET) {
    try {
      const resp = await rpcPool.withFailover((conn) =>
        conn.getParsedTokenAccountsByOwner(new PublicKey(wallet), { mint: new PublicKey(mint) }, 'processed')
      );
      // The node must have reached the trade's slot, or the balance could
      // still show the pre-sell amount and understate the % sold.
      if (typeof slot === 'number' && !(resp.context && resp.context.slot >= slot)) return null;
      let remaining = 0n;
      for (const acct of resp.value) remaining += BigInt(acct.account.data.parsed.info.tokenAmount.amount);
      const before = remaining + soldRaw;
      if (before <= 0n) return 100;
      return Math.min(100, Number((soldRaw * 1000000n) / before) / 10000);
    } catch (err) {
      warn(`[WebSocket] Fast sell % lookup failed for ${mint}: ${err.message}; using the confirmed path.`);
      return null;
    }
  }

  /**
   * false: skip this transaction (a known shape someone else signs).
   * Otherwise its shape string ('' if it can't be used), to learn from after
   * the lookup.
   */
  _noiseCheck(logs) {
    if (!Array.isArray(logs) || logs.some((l) => typeof l === 'string' && l.includes('Log truncated'))) return '';
    if (anyCopyPumpTrade(logs)) return ''; // a copy wallet's own Pump.fun trade: never skipped
    const shape = logShape(logs);
    if (!shape) return '';
    const known = this.noiseShapes.get(shape);
    if (!known) return shape;
    known.matches += 1;
    return known.matches % NOISE_VERIFY_EVERY === 0 ? shape : false; // spot-check 1 in 20
  }

  /** After a lookup: remember (or forget) the shape depending on who signed it. */
  _learnShape(shape, parsedTx, signature) {
    if (!shape) return;
    // Never learn (and so never skip) a kind of transaction that swaps on a
    // known exchange or transfers tokens directly: spam copies those layouts
    // (address poisoning), and the copy wallet's own sells and transfers look
    // exactly the same.
    if (MOVES_TOKENS_RE.test(shape) || Object.keys(DEX_PROGRAM_LABELS).some((id) => shape.includes(id))) return;
    const keys = (parsedTx.transaction && parsedTx.transaction.message && parsedTx.transaction.message.accountKeys) || [];
    if (!keys.some((k) => k && typeof k.signer === 'boolean')) return; // signers unknown: learn nothing
    const signedByCopy = copySigners(parsedTx).length > 0;
    if (signedByCopy) {
      if (this.noiseShapes.delete(shape)) {
        info(`[WebSocket] The copy wallet signed a transaction of a kind that was being skipped (${signature}); no longer skipping that kind.`);
      }
      return;
    }
    if (this.noiseShapes.has(shape) || this.noiseShapes.size >= NOISE_SHAPES_MAX) return;
    this.noiseShapes.set(shape, { matches: 0, example: signature });
    info(
      `[WebSocket] Transactions like ${signature} mention the copy wallet but are signed by someone else ` +
        `(spam or another bot); skipping look-alikes without a lookup (1 in ${NOISE_VERIFY_EVERY} still checked).`
    );
  }

  async _handleSignature(signature, seenAt = Date.now(), shape = '') {
    let parsedTx = null;

    // The websocket notification can arrive slightly before the transaction
    // is fetchable via getParsedTransaction (especially against a load-
    // balanced RPC provider) — retry briefly before giving up.
    // Processed mode: the transaction can't be fetched until it's confirmed
    // (~0.4s+ later), so an immediate lookup would only waste a call.
    if (PROCESSED) await sleep(GET_TX_RETRY_DELAY_MS);
    for (let attempt = 1; attempt <= GET_TX_MAX_ATTEMPTS; attempt++) {
      try {
        parsedTx = await rpcPool.withFailover((conn) =>
          conn.getParsedTransaction(signature, {
            maxSupportedTransactionVersion: MAX_TX_VERSION,
            commitment: 'confirmed'
          })
        );
      } catch (err) {
        // "Too many requests" is already reported (at most every 30s) by the
        // RPC pool; the lookup is simply retried, so don't log every one.
        if (!/\b429\b|Too Many Requests/i.test(err && err.message)) {
          warn(`[WebSocket] getParsedTransaction attempt ${attempt} for ${signature} failed: ${err.message}`);
        }
      }
      if (parsedTx) break;
      await sleep(GET_TX_RETRY_DELAY_MS);
    }

    if (!parsedTx) {
      warn(`[WebSocket] Could not fetch transaction ${signature} after ${GET_TX_MAX_ATTEMPTS} attempts; skipping.`);
      return;
    }
    this._learnShape(shape, parsedTx, signature);
    this._processParsedTx(parsedTx, seenAt);
  }

  /** Turn a parsed transaction into copyTrade events for each copy wallet in it. */
  _processParsedTx(parsedTx, seenAt, wallets = config.COPY_WALLETS) {
    for (const wallet of wallets) this._processForWallet(parsedTx, seenAt, wallet);
  }

  _processForWallet(parsedTx, seenAt, wallet) {
    // Buys/sells, plus 'transfer' events for tokens that left the wallet
    // without being sold for SOL. Nothing at all for unrelated activity.
    // Pump.fun trades carry their exact swap amounts in the logs; other
    // venues fall back to the wallet's balance changes (which include its
    // fees, so the price is approximate).
    const pumpTrades = decodePumpTradesFromLogs(parsedTx.meta && parsedTx.meta.logMessages, wallet) || [];
    for (const event of parseCopyWalletEvents(parsedTx, wallet)) {
      event.wallet = wallet;
      if (event.trade === 'buy') {
        // Did the copy wallet already hold this coin just before this buy?
        // (ONLY_COPY_FIRST_BUY; read from the transaction, no extra call.)
        let preRaw = 0n;
        for (const tb of (parsedTx.meta && parsedTx.meta.preTokenBalances) || []) {
          if (tb.owner === wallet && tb.mint === event.ca) preRaw += BigInt(tb.uiTokenAmount.amount);
        }
        event.copyHeldBefore = preRaw > 0n;
        // Stock-paired launch? (the trade went through a tokenized stock)
        event.pairedStock = findStockInTx(parsedTx, event.ca);
        const exact = pumpTrades.find((t) => t.isBuy && t.mint === event.ca);
        if (exact) {
          // The coin's creator, from Pump.fun's trade record (teaches the shred
          // feed where a router keeps the creator vault).
          try {
            const d = decodePumpTradeDetails(parsedTx.meta && parsedTx.meta.logMessages, wallet, event.ca);
            if (d && d.creator) event.creator = d.creator;
          } catch {}
          event.copyPriceSol = swapPrice(exact.solLamports, exact.tokenRaw, PUMP_TOKEN_DECIMALS);
          event.copyPriceExact = true;
        } else if (event.tokenAmount > 0) {
          event.copyPriceSol = Math.abs(event.solAmount) / event.tokenAmount;
          event.copyPriceExact = false;
        }
      }
      this.emit('copyTrade', { ...event, seenAt });
    }
  }

  /**
   * DETECTION_FEED=transaction: the notification carries the whole
   * transaction, so no lookup is needed, for any venue.
   */
  _handleTxNotification(result) {
    const seenAt = Date.now();
    const signature = result && result.signature;
    const tx = result && result.transaction;
    if (!signature || !tx) return;
    // Which copy wallet the data is for (the first one the transaction names).
    let wallet = null;
    try {
      const keys = (tx.transaction && tx.transaction.message && tx.transaction.message.accountKeys) || [];
      for (const k of keys) {
        const a = typeof k === 'string' ? k : k && k.pubkey && String(k.pubkey);
        if (a && COPY_WALLET_SET.has(a)) {
          wallet = a;
          break;
        }
      }
    } catch {
      // statistics only
    }
    const count = (kind) => {
      if (wallet) usageStats.countWallet(wallet, this._msgBytes, kind);
    };
    if (tx.meta && tx.meta.err) {
      usageStats.countWsKind('failed');
      count('failed');
      return;
    }
    if (this._markSeen(signature)) {
      usageStats.countWsKind('duplicate');
      count('duplicate');
      return;
    }
    let parsedTx;
    try {
      parsedTx = toParsedTx(tx, result.slot);
    } catch (err) {
      // Unexpected shape: fall back to looking it up.
      warn(`[WebSocket] Couldn't read transaction ${signature} from the feed (${err.message}); looking it up instead.`);
      this._handleSignature(signature, seenAt).catch((e) => error(`[WebSocket] Error handling signature ${signature}:`, e.message));
      return;
    }
    // Only a copy wallet's own transactions can be its buys, sells or
    // transfers out; everything else mentioning it (spam) is dropped here.
    const signers = copySigners(parsedTx);
    try {
      const ks = (parsedTx.transaction && parsedTx.transaction.message && parsedTx.transaction.message.accountKeys) || [];
      const names = ks.map((k) => String(k.pubkey && k.pubkey.toBase58 ? k.pubkey.toBase58() : k.pubkey));
      const payer = ks.findIndex((k) => k && k.signer);
      usageStats.noteTx(names, payer >= 0 ? names[payer] : null, signers.length > 0, COPY_WALLET_SET);
    } catch {
      // statistics only
    }
    if (!signers.length) {
      usageStats.countSkippedNoise();
      count('others');
      return;
    }
    count('own');
    this._processParsedTx(parsedTx, seenAt, signers);
  }

  /** Close for good (shutdown) — no auto-reconnect afterwards. */
  disconnect() {
    this.stopped = true;
    if (this.pingInterval) clearInterval(this.pingInterval);
    this.pingInterval = null;
    if (this.ws) {
      this.ws.close();
    }
  }
}

module.exports = CopyEmitter;
module.exports.cannotBeTokenActivity = cannotBeTokenActivity;
module.exports.logShape = logShape;
module.exports.toParsedTx = toParsedTx;
module.exports.copySigners = copySigners;
