// src/shredFeed.js
//
// Decoded shred stream: the copy wallet's transactions as the slot leader
// produces them, typically a few hundred milliseconds before the websocket
// feed reports them as processed. Three sources (SHRED_SOURCE):
//   - "jito-grpc": the Jito ShredStream gRPC service
//     (shredstream.ShredstreamProxy/SubscribeEntries) at SHRED_STREAM_URL,
//     e.g. a provider's decoded-shreds endpoint or Jito's shredstream-proxy
//     run next to the bot. Carries every transaction; the copy wallet's are
//     picked out here.
//   - "helius-preprocessed": Helius preprocessedSubscribe, a websocket that
//     sends only transactions mentioning the copy wallet (filtered by
//     Helius), one binary frame each: version u8, slot u64 LE, signature
//     [64], then the transaction in wire format.
//   - "shreder": Shreder's decoded shreds (shredstream.ShrederService/
//     SubscribeTransactions) at SHREDER_URL: only transactions mentioning a
//     copy wallet (filtered by Shreder), already decoded into fields.
//     Access is by IP address (no token).
// Several sources can run side by side (ShredFeeds, below): the first to
// report a trade wins, and FeedRace logs which was faster and by how much.
//
// It runs ALONGSIDE the websocket feed rather than replacing it:
//   - Buys it can read (direct Pump.fun/PumpSwap, or a learned router) are
//     sent to the bot straight away and marked as seen, so the websocket
//     feed's later report of the same transaction is ignored.
//   - Everything else (sells needing the % sold, other venues, routers not yet
//     learned) is left to the websocket feed, which also supplies the
//     confirmed results routers are learned from.
//   - Sells it can read trigger an early exit only where the % doesn't matter
//     (EXACT, or STIERED with FULL_EXIT_ON_COPY_SELL); the websocket feed
//     still records the sell itself afterwards.
//
// Shreds show what was SENT, not what happened: the copy wallet's buy may
// still fail. Each early buy is checked a few seconds later, and if it failed
// the bot is told ('copyBuyFailed') so it can sell ours.

const path = require('path');
const EventEmitter = require('events');
const WebSocket = require('ws');
const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');
const { PublicKey } = require('@solana/web3.js');
const { performance } = require('perf_hooks');
const config = require('./config');
const rpcPool = require('./rpcPool');
const { info, warn, error, redactUrl } = require('./logger');
const { signedTransactions, resolveKeys, parseTransaction, fromDecoded } = require('./shredTx');
const { FeedRace, label: sourceLabel } = require('./feedRace');
const { classify, RouterLearner, warmUp: warmUpDecode } = require('./shredDecode');
const { creatorVaultPda } = require('@pump-fun/pump-sdk');
const bs58Mod = require('bs58');
const bs58 = bs58Mod.default || bs58Mod;

const PROTO_PATH = path.join(__dirname, 'proto', 'shredstream.proto');
const SHREDER_PROTO_PATH = path.join(__dirname, 'proto', 'shreder.proto');
const RECENT_MAX = 2_000; // signatures remembered to drop a source's repeats
const ROUTERS_FILE = path.join(__dirname, '..', 'data', 'shred-routers.json');
const STALL_MS = 15_000; // a live stream delivers several messages per second
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const TABLE_REFETCH_MS = 5_000;
const VERIFY_DELAYS_MS = [2_000, 6_000, 15_000];
const STASH_MAX = 300;
const HELIUS_PREPROCESSED_WS = 'wss://beta.helius-rpc.com/';
const HELIUS_CREDITS_PER_MESSAGE = 0.1;
// Programs and sysvars too common to exclude (the copy wallet's own trades use them).
const COMMON_ACCOUNTS = new Set([
  '11111111111111111111111111111111',
  'ComputeBudget111111111111111111111111111111',
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
  'So11111111111111111111111111111111111111112',
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
  'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA',
  'SysvarRent111111111111111111111111111111111',
  'SysvarC1ock11111111111111111111111111111111',
  'Sysvar1nstructions1111111111111111111111111'
]);
const PING_INTERVAL_MS = 30_000;
const FRAME_HEADER = 1 + 8 + 64; // version, slot, signature

/** The Helius preprocessed websocket URL, with the API key. */
function heliusPreprocessedUrl() {
  if (config.SHRED_STREAM_URL) return config.SHRED_STREAM_URL;
  let key = config.SHRED_STREAM_TOKEN;
  if (!key) {
    try {
      key = new URL(config.SOLANA_RPC).searchParams.get('api-key');
    } catch {}
  }
  return `${HELIUS_PREPROCESSED_WS}?api-key=${encodeURIComponent(key || '')}`;
}

/** { target, secure } from "https://host:443", "http://host:9999" or "host:port". */
function parseTarget(url) {
  const m = /^(?:(https?|grpcs?):\/\/)?([^/:\s]+)(?::(\d+))?\/?$/.exec(String(url || '').trim());
  if (!m) throw new Error(`SHRED_STREAM_URL "${url}" isn't a valid address (expected e.g. https://host:443 or host:port)`);
  const scheme = (m[1] || '').toLowerCase();
  const port = m[3] ? Number(m[3]) : scheme === 'http' || scheme === 'grpc' ? 80 : 443;
  const secure = scheme === 'https' || scheme === 'grpcs' || (!scheme && port === 443);
  return { target: `${m[2]}:${port}`, secure };
}

// The most a router buy read from the shreds may be before it is treated as
// misread (an instruction variant that keeps something else at that place).
const MAX_ROUTER_SOL_CURVE = 200;
const MAX_ROUTER_SOL_AMM = 2000;

class ShredFeed extends EventEmitter {
  /**
   * @param emitter - the websocket CopyEmitter: copy trades are emitted on it
   *                  (one stream of events for the bot) and its seen-set dedupes.
   * @param isHeld  - (mint, wallet) => boolean|null: does that copy wallet hold the coin
   */
  constructor({
    emitter,
    isHeld = () => null,
    routersFile = ROUTERS_FILE,
    checkStatus = null,
    verifyDelaysMs = VERIFY_DELAYS_MS,
    source = null, // default: the first in SHRED_SOURCE (read at start)
    learner = null, // shared between sources running side by side
    earlyExits = null, // ditto, so a sell is acted on once
    race = null, // FeedRace, when several sources run
    tag = '[Shreds]',
    fastPath = null // FAST_PATH="rust": the link with the Rust fast path (source 'rust')
  } = {}) {
    super();
    this.fastPath = fastPath;
    this.sourceOpt = source;
    this.race = race;
    this.tag = tag;
    this.recent = new Set();
    this.emitter = emitter;
    this.isHeld = isHeld;
    this.verifyDelaysMs = verifyDelaysMs;
    // signature -> { err, confirmationStatus } | null (replaceable in tests)
    this.checkStatus =
      checkStatus ||
      (async (signature) => {
        const resp = await rpcPool.withFailover((c) => c.getSignatureStatuses([signature]));
        return (resp && resp.value && resp.value[0]) || null;
      });
    this.wallets = config.COPY_WALLETS;
    this.wallet = this.wallets[0];
    this.walletSet = new Set(this.wallets);
    this.walletBytesList = this.wallets.map((w) => new PublicKey(w).toBuffer());
    this.walletBytes = this.walletBytesList[0];
    this.learner = learner || new RouterLearner(routersFile);
    this.tables = new Map(); // lookup table -> base58[]
    this.tableFetchedAt = new Map();
    this.stash = new Map(); // signature -> router instructions seen (learning)
    this.earlyExits = earlyExits || new Set(); // signatures already turned into an early exit
    this.stopped = false;
    this.call = null;
    this.client = null;
    this.reconnectMs = RECONNECT_MIN_MS;
    this.lastDataAt = 0;
    this.stats = { messages: 0, bytes: 0, txs: 0, buys: 0, exits: 0, parseErrors: 0, dupes: 0 };
    this.transit = []; // ms from the provider's timestamp to here (Shreder)
    this.statsSince = Date.now();
    this.parseErrorsLogged = 0;
    this.firstTxLogged = false;
  }

  start() {
    const minutes = config.USAGE_LOG_MIN || 10;
    this.statsTimer = setInterval(() => this._logStats(), minutes * 60_000);
    if (this.statsTimer.unref) this.statsTimer.unref();
    // An early report, so a feed that delivers nothing useful shows up at once.
    this.firstStatsTimer = setTimeout(() => this._logStats(), 60_000);
    if (this.firstStatsTimer.unref) this.firstStatsTimer.unref();
    this._prewarmTables().catch(() => {});
    try {
      warmUpDecode(); // compile the router coin search now, not on the first buy
    } catch {}
    this.source = this.sourceOpt || String(config.SHRED_SOURCE || '').split(',')[0] || 'jito-grpc';
    if (this.source === 'helius-preprocessed') {
      this.heliusUrl = heliusPreprocessedUrl();
      this._connectHelius();
      return;
    }
    if (this.source === 'shreder') {
      this._startShreder();
      return;
    }
    if (this.source === 'rust') {
      this._startRust();
      return;
    }
    const { target, secure } = parseTarget(config.SHRED_STREAM_URL);
    const def = protoLoader.loadSync(PROTO_PATH, { keepCase: true, longs: String, defaults: true });
    const pkg = grpc.loadPackageDefinition(def).shredstream;
    this.client = new pkg.ShredstreamProxy(target, secure ? grpc.credentials.createSsl() : grpc.credentials.createInsecure(), {
      'grpc.keepalive_time_ms': 10_000,
      'grpc.keepalive_timeout_ms': 5_000,
      'grpc.keepalive_permit_without_calls': 1,
      'grpc.max_receive_message_length': 64 * 1024 * 1024
    });
    this.target = target;
    this._subscribe();
    this.watchdog = setInterval(() => {
      if (this.call && this.lastDataAt && Date.now() - this.lastDataAt > STALL_MS) {
        warn(`${this.tag} No data for ${STALL_MS / 1000}s; reconnecting.`);
        this._restart();
      }
    }, 5_000);
    if (this.watchdog.unref) this.watchdog.unref();
  }

  // ---- Helius preprocessedSubscribe ----

  _connectHelius() {
    if (this.stopped) return;
    info(`${this.tag} Connecting to Helius preprocessed transactions (${redactUrl(this.heliusUrl)})...`);
    const ws = new WebSocket(this.heliusUrl);
    this.ws = ws;
    this.isAlive = true;
    ws.on('open', () => {
      ws.send(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'preprocessedSubscribe',
          // Transactions that mention the copy wallet. (Narrowing this with
          // accountInclude: [Pump.fun, PumpSwap] + accountRequired: [wallet]
          // made Helius send EVERY Pump.fun transaction: ~20,000 a minute.)
          params: { accountInclude: this.wallets, accountExclude: config.SHRED_EXCLUDE_ACCOUNTS || [], accountRequired: [] }
        })
      );
      clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => {
        if (ws.readyState !== WebSocket.OPEN) return;
        if (!this.isAlive) {
          warn(`${this.tag} No pong for ${PING_INTERVAL_MS / 1000}s; Helius connection looks dead. Reconnecting...`);
          ws.terminate();
          return;
        }
        this.isAlive = false;
        ws.ping();
      }, PING_INTERVAL_MS);
      if (this.pingTimer.unref) this.pingTimer.unref();
    });
    ws.on('pong', () => {
      this.isAlive = true;
    });
    ws.on('message', (data, isBinary) => {
      this.isAlive = true;
      if (isBinary) {
        this._onHeliusFrame(Buffer.isBuffer(data) ? data : Buffer.from(data));
        return;
      }
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (msg.id === 1 && msg.error) {
        // Not on this plan, or a bad key: no point retrying every few seconds.
        error(
          `${this.tag} Helius refused preprocessedSubscribe: ${(msg.error && msg.error.message) || JSON.stringify(msg.error)}. ` +
            'It needs a paid Helius plan. Shred feed off for this run; the websocket feed keeps detecting.'
        );
        this._setState('stopped', 'Helius refused preprocessedSubscribe (it needs a paid plan)');
        this.stop();
        return;
      }
      if (msg.id === 1 && msg.result !== undefined) {
        this.reconnectMs = RECONNECT_MIN_MS;
        info(`${this.tag} Subscribed to Helius preprocessed transactions for ${this.wallets.join(', ')} (subscription ${msg.result}).`);
        this._setState('up');
      }
    });
    ws.on('error', (err) => {
      if (!this.stopped) error(`${this.tag} Helius websocket error: ${err.message}`);
    });
    ws.on('close', (code) => {
      clearInterval(this.pingTimer);
      if (this.stopped || ws !== this.ws) return;
      warn(`${this.tag} Helius preprocessed connection closed (${code}).`);
      this._scheduleReconnect();
    });
  }

  /** One Helius preprocessed frame. Exposed for tests. */
  _onHeliusFrame(buf) {
    const seenAt = Date.now();
    const t0 = performance.now(); // step timing for [Timing] (sub-millisecond)
    this.stats.messages += 1;
    this.stats.bytes += buf.length;
    if (this.stopped) return;
    let tx = null;
    let slot = null;
    if (buf.length <= FRAME_HEADER) {
      this.stats.parseErrors += 1;
    } else {
      if (buf[0] > 1 && !this.schemaWarned) {
        // Helius: "always read and check the version byte first".
        this.schemaWarned = true;
        warn(`${this.tag} Helius sent message format version ${buf[0]} (the bot knows version 1); trying to read it anyway.`);
      }
      slot = Number(buf.readBigUInt64LE(1));
      try {
        ({ tx } = parseTransaction(buf, FRAME_HEADER));
      } catch (err) {
        this._parseError(err); // left to the websocket feed
      }
    }
    // accountInclude matches any mention; only a copy wallet's own count.
    const wallet = tx ? this._signerOf(tx) : null;
    const mine = Boolean(wallet && tx.signature);
    // The summary's bookkeeping (every address as text) waits until a copy
    // wallet's own transaction has been handed on.
    if (!mine) this._tally(tx, Boolean(wallet));
    if (this._overBudget(seenAt)) return;
    if (!mine) return;
    if (this.race) this.race.note(this.source, tx.signature, t0, slot);
    if (!(this.emitter && this.emitter.seenSignatures && this.emitter.seenSignatures.has(tx.signature))) {
      this._countCopyTx(tx, slot);
      this._handleTx(tx, slot, seenAt, wallet, { t0, parsed: performance.now() }).catch((err) => warn(`${this.tag} Couldn't read ${tx.signature}: ${err.message}`));
    }
    setImmediate(() => this._tally(tx, true));
  }

  /** The copy wallet that signed `tx` (base58), or null. */
  _signerOf(tx) {
    for (let i = 0; i < tx.numSigners && i < tx.staticKeys.length; i++) {
      const j = this.walletBytesList.findIndex((b) => tx.staticKeys[i].equals(b));
      if (j !== -1) return this.wallets[j];
    }
    return null;
  }

  /** " (4vw5…9Ud9)" when several wallets are copied, else "". */
  _who(wallet) {
    return this.wallets.length > 1 && wallet ? ` (${wallet.slice(0, 4)}…${wallet.slice(-4)})` : '';
  }

  /** What is arriving, for the summary: duplicates, who signs, which accounts recur. */
  _tally(tx, signed) {
    const b = this.breakdown || (this.breakdown = { total: 0, mine: 0, dupes: 0, sigs: new Set(), signers: new Map(), accounts: new Map(), myAccounts: new Set() });
    b.total += 1;
    if (!tx) return;
    if (tx.signature) {
      if (b.sigs.has(tx.signature)) b.dupes += 1;
      else if (b.sigs.size < 50_000) b.sigs.add(tx.signature);
    }
    const keys = tx.staticKeys.map((k) => bs58.encode(k));
    if (signed) {
      b.mine += 1;
      for (const k of keys) b.myAccounts.add(k);
      return;
    }
    const signer = keys[0];
    if (signer && (b.signers.size < 5000 || b.signers.has(signer))) b.signers.set(signer, (b.signers.get(signer) || 0) + 1);
    for (const k of new Set(keys)) {
      if (this.walletSet.has(k) || k === signer) continue;
      if (b.accounts.size < 20_000 || b.accounts.has(k)) b.accounts.set(k, (b.accounts.get(k) || 0) + 1);
    }
  }

  /**
   * One line describing the messages since the last report: how many were
   * the copy wallet's own, duplicates, the busiest other signers, and the
   * accounts found in most of the rest: candidates for SHRED_EXCLUDE_ACCOUNTS
   * (never one seen in the copy wallet's own transactions, nor a common
   * program it may need).
   */
  _describeBreakdown() {
    const b = this.breakdown;
    if (!b || !b.total) return '';
    const others = b.total - b.mine;
    const top = (m, n) => [...m.entries()].sort((x, y) => y[1] - x[1]).slice(0, n);
    const signers = top(b.signers, 3).map(([k, n]) => `${k} (${n})`).join(', ');
    const exclude = top(b.accounts, 40)
      .filter(([k, n]) => n >= others * 0.25 && !b.myAccounts.has(k) && !COMMON_ACCOUNTS.has(k))
      .slice(0, 3)
      .map(([k, n]) => `${k} (in ${Math.round((100 * n) / Math.max(1, others))}%)`)
      .join(', ');
    return (
      ` Breakdown: ${b.mine} from the copy wallet, ${others} from others, ${b.dupes} duplicate(s)` +
      (signers ? `; busiest other signers: ${signers}` : '') +
      (exclude ? `; accounts in most of the others (candidates for SHRED_EXCLUDE_ACCOUNTS): ${exclude}` : '') +
      '.'
    );
  }

  /**
   * Credit safety (Helius bills every message): if far more messages arrive
   * in a minute than expected, stop the feed instead of burning credits.
   * Counted per full minute, so a short burst on connecting doesn't trip it.
   */
  _overBudget(now) {
    const max = config.SHRED_MAX_MSGS_PER_MIN;
    if (this.stopped) return true;
    if (!max) return false;
    if (!this.rateWindowAt || now - this.rateWindowAt >= 60_000) {
      this.rateWindowAt = now;
      this.rateWindowCount = 0;
    }
    this.rateWindowCount += 1;
    if (this.rateWindowCount <= max) return false;
    const secs = Math.max(1, Math.round((now - this.rateWindowAt) / 1000));
    const why = `${this.rateWindowCount} messages in ${secs}s, over SHRED_MAX_MSGS_PER_MIN=${max}`;
    error(`${this.tag} ${why} (~${Math.round(this.rateWindowCount * HELIUS_CREDITS_PER_MESSAGE)} credits). Shred feed stopped for this run.${this._describeBreakdown()}`);
    this._setState('stopped', `${why}; stopped to save credits`);
    this.stop();
    return true;
  }

  _countCopyTx(tx, slot) {
    this.stats.txs += 1;
    if (!this.firstTxLogged) {
      this.firstTxLogged = true;
      info(`${this.tag} First copy-wallet transaction received from the shred stream (slot ${slot}, ${tx.version === 'legacy' ? 'legacy' : `v${tx.version}`}): ${tx.signature}`);
    }
  }

  _parseError(err) {
    this.stats.parseErrors += 1;
    if (this.parseErrorsLogged < 3) {
      this.parseErrorsLogged += 1;
      warn(`${this.tag} Couldn't read a message (${err.message}); that transaction is left to the websocket feed.`);
    }
  }

  _subscribe() {
    if (this.stopped) return;
    const md = new grpc.Metadata();
    if (config.SHRED_STREAM_TOKEN) md.add(config.SHRED_STREAM_AUTH_HEADER, config.SHRED_STREAM_TOKEN);
    info(`${this.tag} Connecting to ${this.target}...`);
    const call = this.client.SubscribeEntries({}, md);
    this.call = call;
    this.lastDataAt = Date.now();
    let announced = false;
    call.on('data', (msg) => {
      if (!announced) {
        announced = true;
        this.reconnectMs = RECONNECT_MIN_MS;
        this._setState('up');
        info(`${this.tag} Streaming from ${this.target}; watching for ${this.wallets.join(', ')}'s transactions.`);
      }
      this.lastDataAt = Date.now();
      this._onMessage(msg);
    });
    call.on('error', (err) => {
      if (this.stopped || call !== this.call) return;
      const auth = err && (err.code === grpc.status.UNAUTHENTICATED || err.code === grpc.status.PERMISSION_DENIED);
      error(`${this.tag} Stream error: ${err.message}${auth ? ' (check SHRED_STREAM_TOKEN / SHRED_STREAM_AUTH_HEADER)' : ''}`);
      this._scheduleReconnect();
    });
    call.on('end', () => {
      if (this.stopped || call !== this.call) return;
      warn(`${this.tag} Stream ended by the server.`);
      this._scheduleReconnect();
    });
  }

  // ---- the Rust fast path (FAST_PATH="rust") ----

  _startRust() {
    const fp = this.fastPath;
    if (!fp) throw new Error('FAST_PATH="rust" but no fast path link');
    fp.learner = this.learner; // its learned routers go to the fast path
    fp.tables = this.tables; // and the lookup tables loaded here
    const update = (detail = '') => {
      const states = [...fp.feedStates.values()];
      if (fp.isUp()) this._setState('up');
      else if (fp.connected && states.length && states.every((x) => x === 'stopped')) this._setState('stopped', detail || 'every feed of the fast path stopped');
      else this._setState('down');
    };
    fp.on('feed', (m) => {
      if (m.state === 'stopped') warn(`${this.tag} The fast path's ${sourceLabel(m.source)} feed stopped${m.detail ? `: ${m.detail}` : ''}.`);
      update(m.detail);
    });
    fp.on('down', () => update());
    fp.on('linked', () => update());
    fp.on('tx', (m) => {
      try {
        this._onRustTx(m);
      } catch (err) {
        this._parseError(err);
      }
    });
    fp.on('seen', (m) => {
      if (this.race) this.race.note(m.source, m.signature, m.at, m.slot);
    });
    // It's buying this transaction: no other feed here may act on it.
    this.claimed = new Set();
    fp.on('claim', (m) => {
      if (!m.his || !this.emitter) return;
      if (!this.emitter._markSeen(m.his)) this.claimed.add(m.his);
    });
    fp.on('unclaim', (m) => {
      if (m.his && this.claimed.delete(m.his) && this.emitter && this.emitter.seenSignatures) this.emitter.seenSignatures.delete(m.his);
    });
    fp.on('unreadable', () => {
      this.stats.messages += 1;
      this.stats.parseErrors += 1;
    });
    this._setState('down');
    // Lookup tables found here reach the fast path too.
    this.tablesTimer = setInterval(() => fp.pushTables(), 30_000);
    if (this.tablesTimer.unref) this.tablesTimer.unref();
  }

  /**
   * One copy-wallet transaction from the fast path, with what it did:
   * bought / rehearsed (we take it from there), or declined / none (handled
   * here as any shred transaction). Exposed for tests.
   */
  _onRustTx(m) {
    this.stats.messages += 1;
    if (this.stopped) return;
    const tx = fromRustTx(m.tx);
    this.stats.bytes += tx.size;
    const slot = Number(m.slot);
    if (this.race) this.race.note(m.source, tx.signature, m.at, slot);
    const outcome = m.outcome || { status: 'none' };
    const fast = outcome.status === 'bought' || outcome.status === 'rehearsed' ? outcome : null;
    if (fast && fast.signature) {
      // A report can come twice (resent after a reconnect): take it over once.
      this.fastReports = this.fastReports || new Set();
      if (this.fastReports.has(fast.signature)) return;
      this.fastReports.add(fast.signature);
      if (this.fastReports.size > 2000) this.fastReports.delete(this.fastReports.values().next().value);
      if (m.resent) fast.resent = true;
      if (m.resent) setImmediate(() => info(`${this.tag} The fast path's buy ${fast.signature} of ${fast.mint} reached this bot only now (resent after a reconnect); taking it over.`));
    }
    if (this.claimed) this.claimed.delete(tx.signature);
    if (!fast && this.emitter && this.emitter.seenSignatures && this.emitter.seenSignatures.has(tx.signature)) return;
    if (outcome.status === 'declined' && outcome.reason && outcome.mint) {
      setImmediate(() => info(`${this.tag} The fast path left ${outcome.mint}'s buy to this bot: ${outcome.reason}.`));
    } else if (outcome.status === 'failed') {
      setImmediate(() => warn(`${this.tag} The fast path's buy of ${outcome.mint} was refused (${outcome.reason}); this bot handles the copy buy.`));
    }
    this._countCopyTx(tx, slot);
    const mk = m.marks || {};
    // Its step times, on its own clock, from the moment his trade arrived.
    const marks = { t0: 0, parsed: 0, keys: mk.keys, tablesFetched: Boolean(mk.tablesFetched), classified: mk.classified };
    if (fast) {
      marks.handler = mk.classified;
      marks.decide = mk.decide;
    }
    const wallet = m.wallet && this.walletSet.has(m.wallet) ? m.wallet : this._signerOf(tx);
    this._handleTx(tx, slot, m.seenAt, wallet, marks, { fast, keys: Array.isArray(m.keys) ? m.keys : null }).catch((err) => warn(`${this.tag} Couldn't read ${tx.signature}: ${err.message}`));
  }

  // ---- Shreder (ShrederService/SubscribeTransactions) ----

  _startShreder() {
    const { target, secure } = parseTarget(config.SHREDER_URL);
    const def = protoLoader.loadSync(SHREDER_PROTO_PATH, { keepCase: true, longs: String, defaults: true, oneofs: true });
    const pkg = grpc.loadPackageDefinition(def).shredstream;
    this.client = new pkg.ShrederService(target, secure ? grpc.credentials.createSsl() : grpc.credentials.createInsecure(), {
      // A filtered stream can be silent for minutes (no copy trades), so a
      // dead connection is found by keepalive pings, not by missing data.
      'grpc.keepalive_time_ms': 15_000,
      'grpc.keepalive_timeout_ms': 5_000,
      'grpc.keepalive_permit_without_calls': 1,
      'grpc.max_receive_message_length': 64 * 1024 * 1024
    });
    this.target = target;
    this._subscribeShreder();
  }

  _subscribeShreder() {
    if (this.stopped) return;
    info(`${this.tag} Connecting to Shreder at ${this.target}...`);
    const call = this.client.SubscribeTransactions(new grpc.Metadata());
    this.call = call;
    let announced = false;
    const up = (how) => {
      if (announced || call !== this.call || this.stopped) return;
      announced = true;
      this.reconnectMs = RECONNECT_MIN_MS;
      this._setState('up');
      info(`${this.tag} Subscribed to Shreder (${this.target}) for ${this.wallets.join(', ')} (${how}).`);
    };
    call.on('metadata', () => up('connected'));
    call.on('data', (msg) => {
      up('first data');
      this.lastDataAt = Date.now();
      this._onShrederMessage(msg);
    });
    call.on('error', (err) => {
      if (this.stopped || call !== this.call) return;
      const code = err && err.code;
      const hint =
        code === grpc.status.PERMISSION_DENIED || code === grpc.status.UNAUTHENTICATED
          ? " (Shreder refused the connection: is this server's IP address whitelisted with them?)"
          : code === grpc.status.UNAVAILABLE
            ? " (couldn't reach it: check SHREDER_URL, that the trial is active, and that this server's IP address is whitelisted)"
            : '';
      error(`${this.tag} Shreder stream error: ${err.message}${hint}`);
      this._scheduleReconnect();
    });
    call.on('end', () => {
      if (this.stopped || call !== this.call) return;
      warn(`${this.tag} Shreder ended the stream.`);
      this._scheduleReconnect();
    });
    call.write({
      transactions: {
        copy: {
          // Transactions that mention a copy wallet (the copy wallet's own
          // are picked out here, as with Helius).
          account_include: this.wallets,
          account_exclude: config.SHRED_EXCLUDE_ACCOUNTS || [],
          account_required: []
        }
      }
    });
    // Some servers send nothing (not even headers) until the first match: a
    // ready channel with no error after a few seconds counts as connected.
    const t = setTimeout(() => {
      try {
        if (this.client.getChannel().getConnectivityState(false) === grpc.connectivityState.READY) up('channel ready');
      } catch {}
    }, 3_000);
    if (t.unref) t.unref();
  }

  /** One Shreder message: { filters, transaction: { transaction, slot }, created_at }. Exposed for tests. */
  _onShrederMessage(msg) {
    const seenAt = Date.now();
    const t0 = performance.now();
    this.stats.messages += 1;
    if (this.stopped) return;
    const upd = msg && msg.transaction;
    let tx;
    try {
      tx = fromDecoded(upd && upd.transaction);
    } catch (err) {
      this._parseError(err);
      return;
    }
    this.stats.bytes += tx.size;
    const slot = Number(upd.slot);
    const c = msg.created_at;
    if (c && c.seconds !== undefined && this.transit.length < 20_000) {
      const sent = Number(c.seconds) * 1000 + (Number(c.nanos) || 0) / 1e6;
      if (sent > 0) this.transit.push(seenAt - sent);
    }
    const wallet = this._signerOf(tx);
    const mine = Boolean(wallet && tx.signature);
    if (!mine) {
      this._tally(tx, Boolean(wallet));
      return;
    }
    if (this.race) this.race.note(this.source, tx.signature, t0, slot);
    // "A transaction may be sent multiple times" (Shreder's docs).
    if (this.recent.has(tx.signature)) {
      this.stats.dupes += 1;
      return;
    }
    this.recent.add(tx.signature);
    if (this.recent.size > RECENT_MAX) this.recent.delete(this.recent.values().next().value);
    if (!(this.emitter && this.emitter.seenSignatures && this.emitter.seenSignatures.has(tx.signature))) {
      this._countCopyTx(tx, slot);
      this._handleTx(tx, slot, seenAt, wallet, { t0, parsed: performance.now() }).catch((err) => warn(`${this.tag} Couldn't read ${tx.signature}: ${err.message}`));
    }
    setImmediate(() => this._tally(tx, true));
  }

  /**
   * " Shreder→here: median 2 ms (p90 4 ms)." from Shreder's own timestamps.
   * Only as good as both clocks (a few ms with NTP).
   */
  _describeTransit() {
    const t = this.transit;
    if (!t.length) return '';
    const s = [...t].sort((a, b) => a - b);
    const at = (q) => s[Math.min(s.length - 1, Math.floor(q * s.length))];
    return ` Shreder→here (by Shreder's timestamps; needs both clocks right): median ${Math.round(at(0.5))} ms, p90 ${Math.round(at(0.9))} ms.`;
  }

  _restart() {
    const old = this.call;
    this.call = null;
    if (old) {
      try {
        old.cancel();
      } catch {}
    }
    this._scheduleReconnect();
  }

  // Connection state for the bot ('up' / 'down' / 'stopped'): with
  // SHRED_BUYS_ONLY, buying stops while the feed is down.
  _setState(state, detail = '') {
    if (this.state === state) return;
    this.state = state;
    this.emit(state, detail);
  }

  _scheduleReconnect() {
    if (!this.stopped) this._setState('down');
    if (this.stopped || this.reconnectTimer) return;
    const delay = this.reconnectMs;
    this.reconnectMs = Math.min(RECONNECT_MAX_MS, this.reconnectMs * 2);
    info(`${this.tag} Reconnecting in ${Math.round(delay / 1000)}s (the websocket feed keeps detecting meanwhile).`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.source === 'helius-preprocessed') this._connectHelius();
      else if (this.source === 'shreder') this._subscribeShreder();
      else this._subscribe();
    }, delay);
    if (this.reconnectTimer.unref) this.reconnectTimer.unref();
  }

  stop() {
    if (!this.stopped && this.stats.messages) this._logStats();
    this.stopped = true;
    clearInterval(this.watchdog);
    clearInterval(this.statsTimer);
    clearTimeout(this.firstStatsTimer);
    clearTimeout(this.reconnectTimer);
    clearInterval(this.pingTimer);
    clearInterval(this.tablesTimer);
    if (this.ws) {
      try {
        this.ws.close();
      } catch {}
    }
    if (this.call) {
      try {
        this.call.cancel();
      } catch {}
    }
    if (this.client) this.client.close();
  }

  _logStats() {
    const s = this.stats;
    const minutes = Math.max(1, Math.round((Date.now() - this.statsSince) / 60_000));
    this.statsSince = Date.now();
    info(
      `${this.tag} Last ${minutes} min: ${s.messages} messages, ${(s.bytes / 1048576).toFixed(0)} MB, ` +
        `${s.txs} copy-wallet transaction(s), ${s.buys} buy(s) and ${s.exits} exit(s) sent early` +
        (s.parseErrors ? `, ${s.parseErrors} unreadable message(s)` : '') +
        (s.dupes ? `, ${s.dupes} repeat(s) dropped` : '') +
        (this.source === 'helius-preprocessed' ? ` (~${Math.round(s.messages * HELIUS_CREDITS_PER_MESSAGE)} Helius credits)` : '') +
        '.' +
        (this.source === 'shreder' ? this._describeTransit() : '') +
        (this.source === 'helius-preprocessed' || this.source === 'shreder' ? this._describeBreakdown() : '')
    );
    this.breakdown = null;
    this.transit = [];
    this.stats = { messages: 0, bytes: 0, txs: 0, buys: 0, exits: 0, parseErrors: 0, dupes: 0 };
  }

  /** One gRPC message: { slot, entries }. Exposed for tests. */
  _onMessage(msg) {
    const seenAt = Date.now();
    const t0 = performance.now();
    const buf = Buffer.isBuffer(msg.entries) ? msg.entries : Buffer.from(msg.entries || []);
    this.stats.messages += 1;
    this.stats.bytes += buf.length;
    let txs;
    try {
      txs = signedTransactions(buf, this.walletBytesList);
    } catch (err) {
      this._parseError(err);
      return;
    }
    const slot = Number(msg.slot);
    for (const tx of txs) {
      if (this.race && tx.signature) this.race.note(this.source, tx.signature, t0, slot);
      if (!tx.signature || (this.emitter && this.emitter.seenSignatures && this.emitter.seenSignatures.has(tx.signature))) continue;
      this._countCopyTx(tx, slot);
      this._handleTx(tx, slot, seenAt, this._signerOf(tx), { t0, parsed: performance.now() }).catch((err) => warn(`${this.tag} Couldn't read ${tx.signature}: ${err.message}`));
    }
  }

  /**
   * Load the address lookup tables the copy wallets' recent transactions
   * used, so their next trade through one of them is read straight away
   * instead of waiting for the table to be fetched first (tens of ms, in the
   * middle of the race). Runs once at startup, in the background.
   */
  async _prewarmTables(perWallet = 15) {
    const found = new Set();
    for (const w of this.wallets) {
      if (this.stopped) return;
      try {
        const sigs = await rpcPool.withFailover((c) => c.getSignaturesForAddress(new PublicKey(w), { limit: perWallet }), undefined, { priority: 'low' });
        for (const sig of sigs || []) {
          if (sig.err) continue;
          const t = await rpcPool.withFailover(
            // (Version 1 transactions included: the copy wallets' routers send them.)
            (c) => c.getParsedTransaction(sig.signature, { maxSupportedTransactionVersion: 1, commitment: 'confirmed' }),
            undefined,
            { priority: 'low' }
          );
          const lookups = (t && t.transaction && t.transaction.message && t.transaction.message.addressTableLookups) || [];
          for (const l of lookups) if (l && l.accountKey) found.add(typeof l.accountKey === 'string' ? l.accountKey : l.accountKey.toBase58());
        }
      } catch (err) {
        warn(`${this.tag} Couldn't read ${w.slice(0, 4)}…${w.slice(-4)}'s recent transactions to pre-load its lookup tables (${err.message}).`);
      }
    }
    let loaded = 0;
    for (const key of found) {
      if (this.stopped || this.tables.has(key)) continue;
      try {
        const resp = await rpcPool.withFailover((c) => c.getAddressLookupTable(new PublicKey(key)), undefined, { priority: 'low' });
        if (resp && resp.value) {
          this.tables.set(key, resp.value.state.addresses.map((a) => a.toBase58()));
          this.tableFetchedAt.set(key, Date.now());
          loaded += 1;
        }
      } catch {}
    }
    if (loaded) info(`${this.tag} Pre-loaded ${loaded} address lookup table(s) the copy wallet(s) used recently, so trades through them are read without waiting.`);
  }

  async _keysFor(tx) {
    let keys = resolveKeys(tx, this.tables);
    if (keys) return keys;
    tx.tablesFetched = true; // for the step timing: this read had to wait for a lookup
    // A lookup table we don't have (or one that has grown): fetch it. The
    // copy wallet tends to reuse the same tables, so this is rare.
    await Promise.all(
      tx.lookups.map(async (l) => {
        const key = new PublicKey(l.key).toBase58();
        const last = this.tableFetchedAt.get(key) || 0;
        if (this.tables.has(key) && Date.now() - last < TABLE_REFETCH_MS) return;
        this.tableFetchedAt.set(key, Date.now());
        const resp = await rpcPool.withFailover((c) => c.getAddressLookupTable(new PublicKey(key)));
        if (resp && resp.value) this.tables.set(key, resp.value.state.addresses.map((a) => a.toBase58()));
      })
    );
    keys = resolveKeys(tx, this.tables);
    return keys;
  }

  async _handleTx(tx, slot, seenAt, wallet = this.wallet, marks = null, { fast = null, keys: givenKeys = null } = {}) {
    marks = marks || { t0: performance.now() };
    const keys = givenKeys || (await this._keysFor(tx));
    if (!givenKeys) {
      marks.keys = performance.now();
      marks.tablesFetched = Boolean(tx.tablesFetched);
    }
    if (fast) {
      // The fast path bought (or rehearsed) it: take it from there.
      this.emitter._markSeen(tx.signature);
      this.stats.buys += 1;
      const sol = typeof fast.copySol === 'number' ? fast.copySol : 0;
      const via = fast.via || 'Pump.fun';
      setImmediate(() => info(`${this.tag} Copy wallet${this._who(wallet)} BUY of ${fast.mint} seen early (${via}, ${fast.approx ? '≤' : ''}${sol.toFixed(4)} SOL, slot ${slot}): ${tx.signature}; the fast path ${fast.status === 'bought' ? 'bought' : 'rehearsed'} it.`));
      this.emitter.emit('copyTrade', {
        signature: tx.signature,
        slot,
        dexs: ['Pump.fun'],
        ca: fast.mint,
        trade: 'buy',
        wallet,
        solAmount: -sol,
        solAmountApprox: Boolean(fast.approx),
        tokenAmount: 0,
        sellPercent: null,
        fast: true,
        shred: true,
        copyPriceSol: null,
        fastHint: null,
        fastSent: fast,
        seenAt,
        marks
      });
      if (fast.status === 'bought') this._verifyLater(tx.signature, fast.mint, 0, wallet);
      // Still read for router learning; a problem there can't affect the take-over.
      try {
        if (!keys) throw new Error('no keys');
        const { routerIxs } = classify(tx, keys, wallet, { learner: this.learner, isHeld: (mint) => this.isHeld(mint, wallet) });
        if (routerIxs.length) {
          this.stash.set(tx.signature, routerIxs);
          if (this.stash.size > STASH_MAX) this.stash.delete(this.stash.keys().next().value);
        }
      } catch {}
      return;
    }
    if (!keys) {
      warn(`${this.tag} ${tx.signature}: couldn't resolve its address lookup tables; leaving it to the websocket feed.`);
      return;
    }
    const { intents, routerIxs } = classify(tx, keys, wallet, { learner: this.learner, isHeld: (mint) => this.isHeld(mint, wallet) });
    if (routerIxs.length) {
      this.stash.set(tx.signature, routerIxs);
      if (this.stash.size > STASH_MAX) this.stash.delete(this.stash.keys().next().value);
    }

    if (!givenKeys) marks.classified = performance.now();
    const buy = intents.find((i) => i.side === 'buy' && i.solLamports !== null);
    if (buy) {
      const sol = Number(buy.solLamports) / 1e9;
      if (sol < config.MIN_TRADE_SOL) return;
      // A router amount far beyond any real buy (a Pump.fun curve holds ~85
      // SOL in all) means this instruction doesn't keep the amount where the
      // router's other buys do: don't trust it; the websocket feed reports
      // the real trade.
      const ceiling = buy.pool === 'pumpswap' ? MAX_ROUTER_SOL_AMM : MAX_ROUTER_SOL_CURVE;
      if (buy.approx && sol > ceiling) {
        warn(
          `${this.tag} ${tx.signature}: read ${sol.toFixed(2)} SOL from ${buy.via}'s instruction for ${buy.mint}, more than any real buy (over ${ceiling} SOL); ` +
            'not copying it early. The websocket feed reports what actually happened.'
        );
        return;
      }
      if (this.emitter._markSeen(tx.signature)) return; // the websocket feed got there first
      this.stats.buys += 1;
      // Logged once our buy is under way, not before it.
      const seenLine = `${this.tag} Copy wallet${this._who(wallet)} BUY of ${buy.mint} seen early (${buy.via}, ${buy.approx ? '≤' : ''}${sol.toFixed(4)} SOL, slot ${slot}): ${tx.signature}`;
      setImmediate(() => info(seenLine));
      marks.emit = performance.now();
      this.emitter.emit('copyTrade', {
        signature: tx.signature,
        slot,
        dexs: [buy.pool === 'pumpswap' ? 'Pump.fun Amm' : 'Pump.fun'],
        ca: buy.mint,
        trade: 'buy',
        wallet,
        solAmount: -sol,
        solAmountApprox: buy.approx,
        tokenAmount: buy.tokenRaw !== null ? Number(buy.tokenRaw) / 1e6 : 0,
        sellPercent: null,
        fast: true,
        shred: true,
        copyPriceSol: null, // no fill yet: the price is only known once it has run
        // SHRED_FAST_BUY: what a buy can be built from without a lookup.
        fastHint: config.SHRED_FAST_BUY && buy.pool === 'pump-curve' ? { mint: buy.mint, creatorVault: buy.creatorVault || null, txKeys: keys } : null,
        seenAt,
        marks
      });
      this._verifyLater(tx.signature, buy.mint, 0, wallet);
      return;
    }

    const sell = intents.find((i) => i.side === 'sell');
    const fullExitMode = config.TRADE_TYPE === 'EXACT' || (config.TRADE_TYPE === 'STIERED' && config.FULL_EXIT_ON_COPY_SELL);
    if (sell && fullExitMode && !this.earlyExits.has(tx.signature)) {
      this.earlyExits.add(tx.signature);
      if (this.earlyExits.size > STASH_MAX) this.earlyExits.delete(this.earlyExits.values().next().value);
      this.stats.exits += 1;
      info(`${this.tag} Copy wallet${this._who(wallet)} SELL of ${sell.mint} seen early (${sell.via}, slot ${slot}): ${tx.signature}`);
      // Not marked as seen: the websocket feed still reports the sell itself
      // (with the real % sold) for the bot's records.
      this.emitter.emit('copyTrade', {
        signature: tx.signature,
        slot,
        dexs: [sell.pool === 'pumpswap' ? 'Pump.fun Amm' : 'Pump.fun'],
        ca: sell.mint,
        trade: 'sell',
        wallet,
        solAmount: 0,
        tokenAmount: -1,
        sellPercent: 100,
        fast: true,
        shred: true,
        shredEarlyExit: true,
        seenAt
      });
    }
  }

  /** Check that an early-copied buy actually succeeded; tell the bot if it failed. */
  _verifyLater(signature, mint, attempt = 0, wallet = this.wallet) {
    const delays = this.verifyDelaysMs;
    if (attempt >= delays.length || this.stopped) return;
    const t = setTimeout(async () => {
      try {
        const st = await this.checkStatus(signature);
        if (st && st.err) {
          warn(`${this.tag} The copy wallet's buy ${signature} FAILED on-chain (${JSON.stringify(st.err)}).`);
          this.emitter.emit('copyBuyFailed', { signature, mint, wallet, neverLanded: false });
          return;
        }
        if (st && (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized')) return; // fine
        if (!st && attempt === delays.length - 1) {
          // Still unknown at the last check: it was dropped (or landed on a
          // fork that lost) and never happened.
          warn(`${this.tag} The copy wallet's buy ${signature} never landed.`);
          this.emitter.emit('copyBuyFailed', { signature, mint, wallet, neverLanded: true });
          return;
        }
      } catch (err) {
        if (attempt === delays.length - 1) warn(`${this.tag} Couldn't check ${signature}'s result: ${err.message}`);
      }
      this._verifyLater(signature, mint, attempt + 1, wallet);
    }, delays[attempt] - (attempt ? delays[attempt - 1] : 0));
    if (t.unref) t.unref();
  }

  /**
   * A confirmed copy trade from the websocket feed: if its transaction went
   * through a router we saw in the shreds, learn that router's format.
   */
  learn(event) {
    if (!event || event.shred || !event.signature || (event.trade !== 'buy' && event.trade !== 'sell')) return;
    const ixs = this.stash.get(event.signature);
    if (!ixs) return;
    this.stash.delete(event.signature);
    for (const ix of ixs) {
      if (ix.mint !== event.ca) continue;
      const before = this.learner.status(ix.program, ix.disc);
      const after = this.learner.observe(ix, event.trade, Math.abs(Number(event.solAmount) || 0));
      if (after !== before) {
        if (after === 'buy' || after === 'mixed') {
          info(
            `${this.tag} Learned the copy wallet's router ${ix.program} (instruction 0x${ix.disc}) (${this.learner.describe(ix.program, ix.disc)}): ` +
              `its buys are now copied from the shred stream${after === 'mixed' ? ' (first buys only: the same instruction also sells)' : ''}.`
          );
        } else if (after === 'sell') {
          info(`${this.tag} Learned the copy wallet's router ${ix.program} (instruction 0x${ix.disc}) sell instruction; early exits from the shred stream are on for it.`);
        }
      } else if (!after) {
        info(`${this.tag} Learning the copy wallet's router ${ix.program} (instruction 0x${ix.disc}): ${this.learner.describe(ix.program, ix.disc)} (needs the amount at the same place in 2 confirmed buys).`);
      }
      // Where the router keeps the coin's creator vault (for SHRED_FAST_BUY).
      if (event.trade === 'buy' && event.creator && ix.pool === 'pump-curve') {
        const hadVault = this.learner.vaultIndex(ix.program, ix.disc) !== null;
        try {
          this.learner.observeVault(ix.program, ix.disc, ix.accountKeys, creatorVaultPda(new PublicKey(event.creator)).toBase58());
        } catch {}
        if (!hadVault && this.learner.vaultIndex(ix.program, ix.disc) !== null && config.SHRED_FAST_BUY) {
          info(`${this.tag} Learned where router ${ix.program} (instruction 0x${ix.disc}) keeps the coin's creator account: its buys can now be built without a lookup (SHRED_FAST_BUY).`);
        }
      }
    }
  }
}

/**
 * The shred feed(s) the bot runs: one per source in SHRED_SOURCE, side by
 * side. Each reports into the same emitter, whose seen-set makes the first
 * report of a buy the one acted on. They share the router learner (so a
 * router is learned once, not counted twice) and the early-exit set (so a
 * sell is acted on once). Same interface as one ShredFeed: start, stop,
 * learn, state, and 'up' / 'down' / 'stopped' events ('up' while any
 * source is up; 'stopped' once all have stopped).
 */
class ShredFeeds extends EventEmitter {
  constructor({ emitter, isHeld, routersFile = ROUTERS_FILE, sources = null, checkStatus = null, verifyDelaysMs = VERIFY_DELAYS_MS, raceOptions = {}, fastPath = null, fallbackMs = config.FAST_PATH_FALLBACK_MS } = {}) {
    super();
    const configured = config.SHRED_SOURCES && config.SHRED_SOURCES.length ? config.SHRED_SOURCES : [String(config.SHRED_SOURCE || '').split(',')[0] || 'jito-grpc'];
    // FAST_PATH="rust": the fast path reads the feeds; ours stand by in case it's unreachable.
    this.fastPath = fastPath;
    this.sources = sources || (fastPath ? ['rust'] : configured);
    this.standbySources = fastPath ? configured : [];
    this.fallbackMs = fallbackMs;
    this.standby = [];
    const raced = fastPath ? configured : this.sources;
    const multi = raced.length > 1;
    this.race = multi ? new FeedRace(raced, raceOptions) : null;
    const learner = new RouterLearner(routersFile);
    const earlyExits = new Set();
    this.shared = { emitter, isHeld, checkStatus, verifyDelaysMs, learner, earlyExits };
    this.feeds = this.sources.map(
      (source) =>
        new ShredFeed({
          emitter,
          isHeld,
          routersFile: null,
          checkStatus,
          verifyDelaysMs,
          source,
          learner,
          earlyExits,
          race: this.race,
          fastPath,
          tag: source === 'rust' ? '[Shreds]' : multi ? `[Shreds ${sourceLabel(source)}]` : '[Shreds]'
        })
    );
    this.state = undefined;
    for (const f of this.feeds) {
      f.on('stopped', (why) => {
        f.stoppedWhy = `${multi ? `${sourceLabel(f.sourceOpt)}: ` : ''}${why || 'stopped'}`;
      });
      for (const ev of ['up', 'down', 'stopped']) f.on(ev, (detail) => this._update(f, ev, detail));
    }
  }

  _update(feed, ev, detail) {
    if (feed.sourceOpt === 'rust') this._fallback(ev);
    const states = [...this.feeds, ...this.standby].map((f) => f.state);
    const next = states.includes('up') ? 'up' : states.every((x) => x === 'stopped') ? 'stopped' : 'down';
    if (this.feeds.length > 1 && ev !== 'up' && next === 'up') {
      // One source lost while another still works: say so, buying goes on.
      warn(`[Shreds] ${sourceLabel(feed.sourceOpt)} is ${ev === 'stopped' ? 'stopped' : 'down'}${detail ? ` (${detail})` : ''}; still receiving from the other source(s).`);
    }
    if (next === this.state) return;
    this.state = next;
    const why = next === 'stopped' ? this.feeds.map((f) => f.stoppedWhy).filter(Boolean).join('; ') || detail : detail;
    this.emit(next, why);
  }

  /** FAST_PATH: open our own feeds while the fast path is unreachable, close them once it's back. */
  _fallback(ev) {
    if (!this.standbySources.length || this.stopped) return;
    if (ev === 'up') {
      clearTimeout(this.fallbackTimer);
      this.fallbackTimer = null;
      if (this.standby.length) {
        info('[Shreds] The fast path is back; closing this bot\'s own shred feed(s).');
        for (const f of this.standby) {
          try {
            f.stop();
          } catch {}
        }
        this.standby = [];
      }
      return;
    }
    if (this.standby.length || this.fallbackTimer) return;
    this.fallbackTimer = setTimeout(() => {
      this.fallbackTimer = null;
      if (this.stopped || (this.feeds[0] && this.feeds[0].state === 'up')) return;
      warn(`[Shreds] The fast path has been unreachable for ${Math.round(this.fallbackMs / 1000)}s: this bot opens its own shred feed(s) (${this.standbySources.map(sourceLabel).join(', ')}) until it's back.`);
      const sh = this.shared;
      for (const source of this.standbySources) {
        const f = new ShredFeed({ ...sh, routersFile: null, source, race: null, tag: `[Shreds fallback ${sourceLabel(source)}]` });
        f.on('stopped', (why) => {
          f.stoppedWhy = `${sourceLabel(source)}: ${why || 'stopped'}`;
        });
        for (const e of ['up', 'down', 'stopped']) f.on(e, (detail) => this._update(f, e, detail));
        try {
          f.start();
          this.standby.push(f);
        } catch (err) {
          warn(`[Shreds] Fallback ${sourceLabel(source)} not started: ${err.message}`);
        }
      }
    }, this.fallbackMs);
    if (this.fallbackTimer.unref) this.fallbackTimer.unref();
  }

  start() {
    let started = 0;
    let firstErr = null;
    for (const f of this.feeds) {
      try {
        f.start();
        started += 1;
      } catch (err) {
        firstErr = firstErr || err;
        try {
          f.stop();
        } catch {}
        f.state = 'stopped';
        f.stoppedWhy = `${sourceLabel(f.sourceOpt)}: ${err.message}`;
        if (this.feeds.length > 1) error(`[Shreds] ${sourceLabel(f.sourceOpt)} not started: ${err.message}. Continuing with the other source(s).`);
      }
    }
    if (!started) throw firstErr;
    if (this.race) {
      info(`[Shreds] Running ${this.race.sources.map(sourceLabel).join(' and ')} side by side${this.fastPath ? ' (read by the fast path)' : ''}: the first to report a trade is used; [Race] lines show which was faster.`);
      const minutes = config.USAGE_LOG_MIN || 10;
      this.raceTimer = setInterval(() => this.race.logSummary(), minutes * 60_000);
      if (this.raceTimer.unref) this.raceTimer.unref();
    }
  }

  /** A confirmed copy trade from the websocket feed: learn from the source that stashed its router instructions. */
  learn(event) {
    if (!event || !event.signature) return;
    const all = [...this.feeds, ...this.standby];
    const holder = all.find((f) => f.stash.has(event.signature));
    if (!holder) return;
    holder.learn(event);
    for (const f of all) f.stash.delete(event.signature);
    // A newly learned router reaches the fast path straight away.
    if (this.fastPath) this.fastPath.pushRouters();
  }

  stop() {
    this.stopped = true;
    clearInterval(this.raceTimer);
    clearTimeout(this.fallbackTimer);
    for (const f of [...this.feeds, ...this.standby]) {
      try {
        f.stop();
      } catch {}
    }
    if (this.race) {
      this.race.logSummary(true);
      this.race.stop();
    }
  }
}

/** A transaction as the fast path sends it (byte fields base64) -> the shape parseTransaction returns. */
function fromRustTx(t) {
  if (!t || !Array.isArray(t.staticKeys)) throw new Error('fast path transaction without accounts');
  const b = (x) => Buffer.from(x || '', 'base64');
  const staticKeys = t.staticKeys.map(b);
  let size = staticKeys.length * 32;
  const instructions = (t.instructions || []).map((ix) => {
    const data = b(ix.data);
    size += 2 + (ix.accounts || []).length + data.length;
    return { programIdIndex: ix.programIdIndex, accounts: ix.accounts || [], data };
  });
  return {
    signature: t.signature || null,
    numSigners: t.numSigners,
    version: t.version,
    staticKeys,
    instructions,
    lookups: (t.lookups || []).map((l) => ({ key: b(l.key), writable: l.writable || [], readonly: l.readonly || [] })),
    size: size + 64
  };
}

module.exports = { ShredFeed, ShredFeeds, parseTarget, heliusPreprocessedUrl, fromRustTx };
