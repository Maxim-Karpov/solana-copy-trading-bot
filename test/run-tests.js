// test/run-tests.js — `npm test`
//
// Runs the unit tests and every end-to-end scenario, each in its own
// process and its own scratch copy of the bot (so data/positions.json and
// module state never leak between tests). No network access is used: RPC,
// Jito, SolanaPortal, DexScreener and Telegram are all simulated.
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const { Keypair } = require('@solana/web3.js');

let bs58;
{
  const m = require('bs58');
  bs58 = m.default || m;
}

const repo = path.join(__dirname, '..');
const scenarios = require('./scenarios');
const only = process.argv.slice(2);

const wallet = Keypair.generate();
const copyWallet = Keypair.generate();
const baseEnv = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  SOLANA_RPC: 'http://127.0.0.1:1',
  PRIVATE_KEY: bs58.encode(wallet.secretKey),
  PUBLIC_KEY: wallet.publicKey.toBase58(),
  COPY_WALLET: copyWallet.publicKey.toBase58(),
  BOT_MODE: 'COPY',
  TRADE_TYPE: 'SAFE',
  BUY_AMOUNT: '0.1',
  TAKE_PROFIT: '50',
  STOP_LOSS: '20',
  SLIPPAGE: '20',
  JITO_TIP: '0.001',
  JITO_ENGINE: 'http://127.0.0.1:1/api/v1/transactions',
  PRICE_CHECK_DELAY: '250',
  PREFERRED_DEX: 'auto',
  CONFIRM_TIMEOUT_SEC: '1.5',
  SELL_RETRY_DELAY_MS: '50',
  SELL_RETRY_COOLDOWN_MS: '400',
  ENABLE_MULTI_BUY: 'false',
  ENABLE_TRAILING_STOP: 'false',
  START_PAUSED: 'false', // scenarios that test it turn it on
  MAX_OPEN_POSITIONS: '0', // no cap, except in the scenarios that test it
  BUY_COOLDOWN_SEC: '0', // likewise
  HOLD_CHECK_MS: '600000', // the missed-sell check only where tested
  TELEGRAM_SEND_GAP_MS: '0', // no pacing of Telegram messages in tests
  LEADER_INFO: 'false' // no leader-location lookups, except where tested
};

function scratchCopy() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-test-'));
  fs.cpSync(path.join(repo, 'src'), path.join(dir, 'src'), { recursive: true });
  fs.cpSync(path.join(repo, 'utils'), path.join(dir, 'utils'), { recursive: true });
  // A link to the real node_modules instead of a copy. On Windows a normal
  // symlink needs admin rights, so use a "junction" (same effect, no rights needed).
  fs.symlinkSync(path.join(repo, 'node_modules'), path.join(dir, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  fs.mkdirSync(path.join(dir, 'data'));
  return dir;
}

function removeScratch(dir) {
  // Remove the node_modules LINK first, so deleting the scratch folder can
  // never reach through it into the real node_modules.
  const link = path.join(dir, 'node_modules');
  try {
    fs.unlinkSync(link);
  } catch {
    try {
      fs.rmdirSync(link); // how a Windows junction is removed (the target is untouched)
    } catch {
      // already gone
    }
  }
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    // a leftover temp folder is harmless
  }
}

function runChild(script, args, env, marker) {
  const dir = scratchCopy();
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(__dirname, script), ...args], { cwd: dir, env });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('close', () => {
      const line = out.split('\n').find((l) => l.startsWith(marker));
      let parsed = null;
      if (line) {
        try {
          parsed = JSON.parse(line.slice(marker.length));
        } catch {
          // fall through
        }
      }
      removeScratch(dir);
      resolve({ parsed, out });
    });
  });
}

function tail(out, n = 40) {
  return out.split('\n').filter((l) => !l.startsWith('(node:') && !l.includes('--trace-deprecation')).slice(-n).join('\n');
}

(async () => {
  let failed = 0;
  let passed = 0;
  const report = (name, failures, out) => {
    if (failures.length === 0) {
      passed += 1;
      console.log(`  PASS  ${name}`);
    } else {
      failed += 1;
      console.log(`  FAIL  ${name}`);
      for (const f of failures) console.log(`        - ${f}`);
      if (out && process.env.VERBOSE) console.log(tail(out).replace(/^/gm, '        | '));
    }
  };

  if (only.length === 0 || only.includes('unit')) {
    console.log('Unit tests');
    const unitEnv = {
      ...baseEnv,
      SOLANA_RPC_FALLBACKS: 'http://127.0.0.1:2,http://127.0.0.1:3',
      SOLANA_WS: 'ws://127.0.0.1:18765',
      __WS_PORT: '18765',
      DIRECT_PUMPFUN_SWAP: 'true'
    };
    const { parsed, out } = await runChild('unit.js', [], unitEnv, '__UNIT__');
    if (!parsed) {
      report('unit tests (crashed)', ['no result'], out);
      console.log(tail(out));
    } else {
      for (const r of parsed) report(r.name, r.failures, out);
    }
  }

  if (only.length === 0 || only.includes('unit')) {
    console.log('\nUnit tests (DETECTION_COMMITMENT=processed)');
    const env = { ...baseEnv, SOLANA_WS: 'ws://127.0.0.1:18766', __WS_PORT: '18766', DETECTION_COMMITMENT: 'processed' };
    const { parsed, out } = await runChild('unit_processed.js', [], env, '__UNIT__');
    if (!parsed) {
      report('processed-mode unit tests (crashed)', ['no result'], out);
      console.log(tail(out));
    } else {
      for (const r of parsed) report(r.name, r.failures, out);
    }
  }

  const names = Object.keys(scenarios).filter((n) => only.length === 0 || only.includes(n));
  if (names.length) console.log('\nEnd-to-end scenarios');
  const queue = [...names];
  const workers = Array.from({ length: 4 }, async () => {
    while (queue.length) {
      const name = queue.shift();
      const extra = typeof scenarios[name].env === 'function' ? scenarios[name].env(baseEnv) : scenarios[name].env || {};
      const env = { ...baseEnv, ...extra };
      const { parsed, out } = await runChild('child.js', [name], env, '__RESULT__');
      if (!parsed) report(name, ['scenario crashed without a result'], out);
      else report(name, parsed.failures, out);
    }
  });
  await Promise.all(workers);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
