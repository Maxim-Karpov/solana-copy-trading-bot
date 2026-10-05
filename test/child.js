// test/child.js — runs ONE scenario from scenarios.js against the real
// src/index.js, in a scratch copy of the bot (cwd), with mocks installed.
const path = require('path');
const fs = require('fs');
const { Keypair } = require('@solana/web3.js');
const { installMocks, sleep } = require('./mocks');
const scenarios = require('./scenarios');

const rootDir = process.cwd();
const name = process.argv[2];
const sc = scenarios[name];
if (!sc) {
  console.error(`Unknown scenario ${name}`);
  process.exit(2);
}

const { ledger, telegram } = installMocks(rootDir, process.env.PUBLIC_KEY);
const posFile = path.join(rootDir, 'data', 'positions.json');
const failures = [];
let copySeq = 0;
let slotSeq = 1000;

// Everything the bot logs, for scenarios that check a log line.
const logs = [];
const origLog = console.log;
console.log = (...args) => {
  logs.push(args.map(String).join(' '));
  if (logs.length > 5000) logs.shift();
  origLog(...args);
};

const h = {
  ledger,
  logs,
  telegram,
  sleep,
  state: {},
  newMint: () => Keypair.generate().publicKey.toBase58(),
  emit(evt) {
    global.__emitter.emit('copyTrade', evt);
  },
  buy(mint, sol, extra = {}) {
    h.emit({ signature: `copyBuy${++copySeq}`, dexs: ['Pump.fun'], ca: mint, trade: 'buy', solAmount: -sol, tokenAmount: 1000, sellPercent: null, slot: ++slotSeq, ...extra });
  },
  transfer(mint, pct, extra = {}) {
    h.emit({ signature: `copyXfer${++copySeq}`, dexs: [], ca: mint, trade: 'transfer', solAmount: 0, tokenAmount: -1000, sellPercent: pct, slot: ++slotSeq, ...extra });
  },
  sell(mint, pct, extra = {}) {
    h.emit({ signature: `copySell${++copySeq}`, dexs: ['Pump.fun'], ca: mint, trade: 'sell', solAmount: 0.5, tokenAmount: -1000, sellPercent: pct, slot: ++slotSeq, ...extra });
  },
  writePositions(list, extra = {}) {
    fs.mkdirSync(path.dirname(posFile), { recursive: true });
    fs.writeFileSync(posFile, JSON.stringify({ positions: list, ...extra }, null, 2));
  },
  rawData() {
    try {
      return JSON.parse(fs.readFileSync(posFile, 'utf8'));
    } catch {
      return {};
    }
  },
  positions() {
    // Open (and recently closed) positions, plus the archive of closed ones.
    let current = [];
    try {
      current = JSON.parse(fs.readFileSync(posFile, 'utf8')).positions;
    } catch {}
    let archived = [];
    try {
      archived = fs.readFileSync(path.join(rootDir, 'data', 'positions-closed.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    } catch {}
    const ids = new Set(current.map((p) => p.id));
    return [...archived.filter((p) => !ids.has(p.id)), ...current];
  },
  exitedMints() {
    try {
      return fs.readFileSync(path.join(rootDir, 'data', 'exited-mints.txt'), 'utf8').split('\n').filter(Boolean);
    } catch {
      return [];
    }
  },
  active: () => h.positions().filter((p) => p.status === 'active'),
  byMint: (mint) => h.positions().filter((p) => p.mint === mint),
  async waitFor(pred, label, ms = 8000) {
    const start = Date.now();
    while (Date.now() - start < ms) {
      const v = pred();
      if (v) return v;
      await sleep(25);
    }
    throw new Error(`timed out waiting for: ${label}`);
  },
  check(cond, msg) {
    if (!cond) failures.push(msg);
  },
  approx(actual, expected, eps, msg) {
    if (!(Math.abs(Number(actual) - expected) <= eps)) failures.push(`${msg} (expected ${expected}, got ${actual})`);
  }
};

let finished = false;
const realExit = process.exit.bind(process);
function finish(extra = {}) {
  if (finished) return;
  finished = true;
  process.stdout.write('\n__RESULT__' + JSON.stringify({ name, failures, ...extra }) + '\n');
  realExit(0);
}
process.exit = (code) => {
  if (sc.onExit) {
    try {
      sc.onExit(h, code);
    } catch (e) {
      failures.push('onExit threw: ' + (e.stack || e));
    }
  } else {
    failures.push(`unexpected process.exit(${code})`);
  }
  finish({ exitCode: code });
};
process.on('uncaughtException', (e) => {
  failures.push('uncaughtException: ' + (e.stack || e));
  finish();
});

if (sc.setup) sc.setup(h);
require(path.join(rootDir, 'src', 'index.js'));

(async () => {
  try {
    if (process.env.BOT_MODE !== 'SELLING') await h.waitFor(() => global.__emitter, 'bot start', 5000);
    if (sc.run) await sc.run(h);
  } catch (e) {
    failures.push(e.message);
  }
  if (!sc.onExit) finish();
})();

setTimeout(() => {
  failures.push('scenario timed out');
  finish();
}, sc.timeoutMs || 30000).unref();
