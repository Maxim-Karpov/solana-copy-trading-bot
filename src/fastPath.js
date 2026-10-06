// src/fastPath.js
//
// FAST_PATH="rust": the link with the Rust fast path (fastpath/), a separate
// program on the same server that reads the shred feeds and builds, signs
// and sends shred-copied Pump.fun buys itself. This bot stays in charge:
//   - it keeps the fast path supplied with everything a buy decision needs,
//     the moment anything changes (and every 250 ms regardless) (paused or not, room under the caps,
//     cooldown, coins to skip, buy sizes, fees, blockhash, learned routers
//     and compute limits), and the buy template from Pump.fun's SDK;
//   - before the fast path may buy, the same practice buy is built here and
//     there and compared byte for byte (again every 30 s);
//   - every copy-wallet transaction the fast path sees comes here, with what
//     it did ("bought", "rehearsed", or "declined" and why). What it didn't
//     buy is handled here as before.
// One JSON object per line over 127.0.0.1 (never leaves the server).

const net = require('net');
const EventEmitter = require('events');
const { PublicKey } = require('@solana/web3.js');
const config = require('./config');
const { info, warn } = require('./logger');

const RECONNECT_MS = 1000;
const STATE_EVERY_MS = 250;
const CHECK_EVERY_MS = 30_000;

class FastPath extends EventEmitter {
  constructor({ port = config.FAST_PATH_PORT, stateProvider = () => null } = {}) {
    super();
    this.port = port;
    this.stateProvider = stateProvider;
    this.sock = null;
    this.connected = false;
    this.hello = null;
    this.buf = '';
    this.stopped = false;
    this.version = 0;
    this.practiceId = 0;
    this.pendingPractice = new Map();
    this.verified = false;
    this.lastBlockhash = null;
    this.feedStates = new Map(); // source -> 'up' | 'down' | 'stopped'
    this.connectWarned = false;
    this.acked = []; // its buys this bot has taken over (so it stops counting them itself)
  }

  /** Its buy's position is saved (or the buy definitely failed): it may forget the report. */
  saved(signature) {
    this.savedSigs = this.savedSigs || [];
    this.savedSigs.push(signature);
    if (this.savedSigs.length > 50) this.savedSigs.shift();
    this.pushState();
  }

  ack(signature) {
    this.acked.push(signature);
    if (this.acked.length > 50) this.acked.shift();
  }

  start() {
    this._connect();
    this.stateTimer = setInterval(() => this.pushState(), STATE_EVERY_MS);
    if (this.stateTimer.unref) this.stateTimer.unref();
    this.checkTimer = setInterval(() => this.check().catch((err) => warn(`[FastPath] Check failed: ${err.message}`)), CHECK_EVERY_MS);
    if (this.checkTimer.unref) this.checkTimer.unref();
  }

  stop() {
    // A last state first (shutting down: no buying), flushed before closing.
    this.pushState();
    this.stopped = true;
    clearInterval(this.stateTimer);
    clearInterval(this.checkTimer);
    clearTimeout(this.reconnectTimer);
    clearTimeout(this.soonTimer);
    if (this.sock) {
      const sock = this.sock;
      sock.end();
      const t = setTimeout(() => sock.destroy(), 500);
      if (t.unref) t.unref();
    }
  }

  /**
   * Something the fast path decides from has changed (paused, a position
   * opened or closed, the balance, a coin the copy wallet bought or exited):
   * send the state right away instead of at the next 250 ms tick. Changes made
   * together (in the same turn of the event loop) go out as one.
   */
  pushSoon() {
    if (this.pushQueued || !this.connected) return;
    this.pushQueued = true;
    setImmediate(() => {
      this.pushQueued = false;
      this.pushState();
    });
  }

  _connect() {
    if (this.stopped) return;
    const sock = net.connect({ host: '127.0.0.1', port: this.port });
    sock.setNoDelay(true);
    this.sock = sock;
    sock.on('connect', () => {
      this.connected = true;
      this.connectWarned = false;
      this.buf = '';
    });
    sock.on('data', (d) => {
      this.buf += d.toString('utf8');
      let i;
      while ((i = this.buf.indexOf('\n')) !== -1) {
        const line = this.buf.slice(0, i);
        this.buf = this.buf.slice(i + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        this._onMessage(msg);
      }
    });
    const lost = () => {
      if (sock !== this.sock) return;
      const was = this.connected;
      this.connected = false;
      this.hello = null;
      this.verified = false;
      this.feedStates.clear();
      if (was && this.stopped) {
        // our own shutdown: nothing to report
      } else if (was) {
        warn('[FastPath] Lost the link with the Rust fast path; reconnecting.');
        this.emit('down');
      } else if (!this.connectWarned && !this.stopped) {
        this.connectWarned = true;
        warn(`[FastPath] The Rust fast path isn't answering on 127.0.0.1:${this.port} yet (start it with ./fastpath/target/release/fastpath); retrying every second.`);
        this.emit('down');
      }
      if (!this.stopped) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = setTimeout(() => this._connect(), RECONNECT_MS);
        if (this.reconnectTimer.unref) this.reconnectTimer.unref();
      }
    };
    sock.on('error', () => {});
    sock.on('close', lost);
  }

  send(obj) {
    if (!this.connected || !this.sock) return false;
    try {
      this.sock.write(`${JSON.stringify(obj)}\n`);
      return true;
    } catch {
      return false;
    }
  }

  _onMessage(msg) {
    switch (msg.type) {
      case 'hello': {
        this.hello = msg;
        if (msg.wallet !== config.PUBLIC_KEY) {
          warn(`[FastPath] The Rust fast path signs for ${msg.wallet}, not ${config.PUBLIC_KEY}: not using it. Check that both read the same .env.`);
          this.sock.destroy();
          return;
        }
        // Its feeds' states as they are now (they're only reported again when they change).
        this.feedStates = new Map(Object.entries(msg.feeds || {}));
        info(`[FastPath] Linked with the Rust fast path ${msg.version} (feeds: ${(msg.sources || []).map((x) => `${x} ${this.feedStates.get(x) || 'connecting'}`).join(', ')}).`);
        this.lastBlockhash = null;
        this.pushAll();
        this.check().catch((err) => warn(`[FastPath] Check failed: ${err.message}`));
        this.emit('linked');
        break;
      }
      case 'feed':
        this.feedStates.set(msg.source, msg.state);
        this.emit('feed', msg);
        break;
      case 'practiceResult': {
        const p = this.pendingPractice.get(msg.id);
        if (p) {
          this.pendingPractice.delete(msg.id);
          p(msg);
        }
        break;
      }
      default:
        this.emit(msg.type, msg); // 'tx', 'seen', 'unreadable'
    }
  }

  /** Is the fast path linked, checked, and is one of its feeds up? */
  isUp() {
    return this.connected && [...this.feedStates.values()].includes('up');
  }

  // ---- what the fast path needs ----

  pushAll() {
    this.pushTemplate();
    this.pushRouters();
    this.pushTables();
    this.pushState();
  }

  pushState() {
    if (!this.connected) return;
    const prewarm = require('./prewarm');
    const bh = prewarm.blockhash();
    if (bh && bh !== this.lastBlockhash) {
      this.lastBlockhash = bh;
      // Its age too: a blockhash lasts ~60 s from when it was fetched, not from when the fast path hears of it.
      this.send({ type: 'blockhash', value: bh, ageMs: prewarm.blockhashAgeMs ? prewarm.blockhashAgeMs() : 0 });
    }
    let s = null;
    try {
      s = this.stateProvider();
    } catch (err) {
      warn(`[FastPath] Couldn't put together the state for the fast path: ${err.message}`);
    }
    if (!s) return;
    this.version += 1;
    this.send({ type: 'state', version: this.version, at: Date.now(), ...s, ack: this.acked, saved: this.savedSigs || [] });
  }

  pushTemplate() {
    const raw = require('./pumpBuyRaw');
    const prewarm = require('./prewarm');
    const t = raw.getTemplate();
    const global = prewarm.pumpGlobal();
    if (!t || !global) return false;
    const { SENDER_TIP_ACCOUNTS } = require('./heliusSender');
    const { JITO_TIP_ACCOUNTS } = require('./jitoTip');
    const { recipientsOf } = require('./pumpfunDirect');
    const { worstFeeBpsFor } = require('./pumpfunDirect');
    const r = recipientsOf(global);
    return this.send({
      type: 'template',
      user: new PublicKey(t.user).toBase58(),
      accounts: t.accounts.map((a) => [new PublicKey(a.key).toBase58(), a.isSigner, a.isWritable]),
      trackVolume: t.trackVolume,
      feeRecipients: r.normal,
      reservedFeeRecipients: r.reserved,
      minOut: {
        vS0: global.initialVirtualSolReserves.toString(),
        vT0: global.initialVirtualTokenReserves.toString(),
        supply: global.tokenTotalSupply.toString(),
        worstFeeBps: worstFeeBpsFor(global)
      },
      senderTips: SENDER_TIP_ACCOUNTS.map(String),
      jitoTips: JITO_TIP_ACCOUNTS.map(String),
      // TOKEN_ACCOUNT_MODE=plain: the Rust path makes plain token accounts too (Token-2022 once the length is known).
      plain: require('./plainAccount').enabled() ? { t22Len: require('./plainAccount').accountLen(require('@solana/spl-token').TOKEN_2022_PROGRAM_ID) } : undefined
    });
  }

  pushRouters() {
    const learner = this.learner;
    if (!learner) return;
    const list = [];
    for (const key of learner.routers.keys()) {
      const i = key.lastIndexOf(':');
      const program = key.slice(0, i);
      const tagHex = key.slice(i + 1);
      const status = learner.status(program, tagHex);
      if (status !== 'buy' && status !== 'mixed') continue;
      const offset = learner.bestOffset(program, tagHex);
      const r = learner.routers.get(key);
      const ratios = [...((r.ratios && r.ratios[offset]) || [])].sort((a, b) => a - b);
      const ratio = ratios.length ? ratios[Math.floor(ratios.length / 2)] : 1;
      list.push({ program, tag: parseInt(tagHex, 16), status, offset, ratio, vaultIndex: learner.vaultIndex(program, tagHex) });
    }
    this.send({ type: 'routers', list });
  }

  pushTables() {
    if (!this.tables || !this.tables.size) return;
    this.send({ type: 'tables', tables: Object.fromEntries(this.tables) });
  }

  // ---- the byte-for-byte check ----

  practice(input) {
    return new Promise((resolve) => {
      const id = ++this.practiceId;
      const timer = setTimeout(() => {
        this.pendingPractice.delete(id);
        resolve({ ok: false, error: 'no answer' });
      }, 3000);
      if (timer.unref) timer.unref();
      this.pendingPractice.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      if (!this.send({ type: 'practice', id, input })) {
        clearTimeout(timer);
        this.pendingPractice.delete(id);
        resolve({ ok: false, error: 'not linked' });
      }
    });
  }

  /**
   * Build the same practice buy here (hand-built, itself checked against
   * the SDK) and in Rust, with the same inputs, and compare the signed
   * bytes. The fast path buys only while they match.
   */
  async check() {
    if (!this.connected || !this.hello) return null;
    const te = require('./tradeExecutor');
    const result = await te.practiceHandBuilt(); // refreshes the template, checks it against the SDK
    if (!this.pushTemplate()) {
      return this._verdict(false, 'no buy template yet (Pump.fun config or hand-built buys not ready)', true);
    }
    if (result && result.ok === false) return this._verdict(false, `the hand-built buy failed its own check (${result.why})`);
    const cmp = await te.compareWithRust(this);
    if (!cmp) return this._verdict(false, 'nothing to compare yet', true);
    return this._verdict(cmp.ok, cmp.why, false, cmp);
  }

  _verdict(ok, why, quiet = false, detail = null) {
    const changed = ok !== this.verified;
    this.verified = ok;
    // Not ready yet (just started: the Pump.fun config is still loading): try
    // again in 2 s rather than at the next 30 s check, so it can buy sooner.
    if (!ok && quiet && !this.stopped) {
      clearTimeout(this.soonTimer);
      this.soonTimer = setTimeout(() => this.check().catch(() => {}), 2000);
      if (this.soonTimer.unref) this.soonTimer.unref();
    }
    this.send({ type: 'verified', ok, why: why || null });
    if (changed && ok) {
      info(
        `[FastPath] The Rust fast path's buy is identical to this bot's, byte for byte: it now buys shred-copied Pump.fun coins itself` +
          (detail && typeof detail.rustUs === 'number' ? ` (it built and signed the practice buy in ${(detail.rustUs / 1000).toFixed(3)} ms).` : '.')
      );
    } else if (!ok && !quiet) {
      warn(`[FastPath] Not letting the Rust fast path buy: ${why}. This bot builds the buys itself meanwhile.`);
    }
    return { ok, why };
  }
}

module.exports = { FastPath };
