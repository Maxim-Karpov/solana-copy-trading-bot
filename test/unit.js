// test/unit.js — module-level tests, run in a scratch copy of the bot (cwd).
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const {
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction
} = require('@solana/web3.js');

const NODE_FETCH = globalThis.fetch; // real fetch, saved before any test stubs it
const root = process.cwd();
const src = (f) => path.join(root, 'src', f);
const results = [];
let current = null;

function check(cond, msg) {
  if (!cond) current.failures.push(msg);
}
async function test(name, fn) {
  current = { name, failures: [] };
  try {
    await fn();
  } catch (e) {
    current.failures.push('threw: ' + (e.stack || e));
  }
  results.push(current);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- fixtures for txParser ----
function parsedTx({ wallet, lamportsPre, lamportsPost, fee = 5000, pre = [], post = [], slot = 123, err = null }) {
  return {
    slot,
    meta: { err, fee, preBalances: [lamportsPre], postBalances: [lamportsPost], preTokenBalances: pre, postTokenBalances: post, innerInstructions: [] },
    transaction: {
      signatures: ['sigX'],
      message: {
        accountKeys: [{ pubkey: new PublicKey(wallet) }],
        instructions: [{ programId: new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P') }]
      }
    }
  };
}
const tb = (owner, mint, amount, decimals = 6) => ({ owner, mint, uiTokenAmount: { amount: String(amount), decimals } });

(async () => {
  const WSOL = 'So11111111111111111111111111111111111111112';

  await test('amounts: exact UI <-> raw conversion', async () => {
    const { uiToRaw, rawToUi, rawPercent } = require(src('amounts.js'));
    check(uiToRaw('10.757565596', 9) === 10757565596n, 'basic 9-decimal');
    check(uiToRaw('35123456.789012', 6) === 35123456789012n, 'large 6-decimal exact (float math is off by one here)');
    check(uiToRaw('1.23456789', 6) === 1234567n, 'extra decimals truncated down, never rounded up');
    check(uiToRaw('1.2e-5', 9) === 12000n, 'legacy exponent strings accepted');
    check(uiToRaw('5000', 6) === 5000000000n, 'integer string');
    check(uiToRaw('9007199254.740993', 6) === 9007199254740993n, 'beyond 2^53 stays exact');
    check(rawToUi(5n, 6) === '0.000005', `small amounts never become "5e-6" (got ${rawToUi(5n, 6)})`);
    check(rawToUi(10757565596n, 9) === '10.757565596', 'rawToUi basic');
    check(rawToUi(7n, 0) === '7', 'zero decimals');
    check(rawPercent(15000000000n, 40) === 6000000000n, 'rawPercent 40%');
    check(rawPercent(3n, 50) === 1n, 'rawPercent rounds down');
    let threw = false;
    try { uiToRaw('abc', 6); } catch { threw = true; }
    check(threw, 'garbage rejected');
  });

  await test('txParser: buy, persistent-WSOL buy, partial sell %, own-fill measurement', async () => {
    const { parseCopyTradeTransaction, measureWalletDeltas } = require(src('txParser.js'));
    const w = Keypair.generate().publicKey.toBase58();
    const mint = Keypair.generate().publicKey.toBase58();

    const buy = parseCopyTradeTransaction(
      parsedTx({ wallet: w, lamportsPre: 10e9, lamportsPost: 10e9 - 1e9 - 5000, post: [tb(w, mint, 1000e6)] }),
      w
    );
    check(buy && buy.trade === 'buy' && Math.abs(buy.solAmount + 1) < 1e-9, `plain buy (got ${JSON.stringify(buy)})`);
    check(buy && buy.slot === 123, 'slot included');

    // Wallet pays from a persistent WSOL account: lamports barely move.
    const wsolBuy = parseCopyTradeTransaction(
      parsedTx({
        wallet: w, lamportsPre: 10e9, lamportsPost: 10e9 - 5000,
        pre: [tb(w, WSOL, 5e9, 9)], post: [tb(w, WSOL, 3e9, 9), tb(w, mint, 500e6)]
      }),
      w
    );
    check(wsolBuy && wsolBuy.trade === 'buy' && Math.abs(wsolBuy.solAmount + 2) < 1e-9, `WSOL-settled buy detected as 2 SOL (got ${JSON.stringify(wsolBuy)})`);

    const sell = parseCopyTradeTransaction(
      parsedTx({ wallet: w, lamportsPre: 1e9, lamportsPost: 1.5e9, pre: [tb(w, mint, 1000e6)], post: [tb(w, mint, 600e6)] }),
      w
    );
    check(sell && sell.trade === 'sell' && Math.abs(sell.sellPercent - 40) < 1e-9, `40% sell (got ${JSON.stringify(sell)})`);

    const transfer = parseCopyTradeTransaction(
      parsedTx({ wallet: w, lamportsPre: 5e9, lamportsPost: 4e9 - 5000 }),
      w
    );
    check(transfer === null, 'plain SOL transfer ignored');

    const failed = parseCopyTradeTransaction(
      parsedTx({ wallet: w, lamportsPre: 10e9, lamportsPost: 9e9, post: [tb(w, mint, 1)], err: { x: 1 } }),
      w
    );
    check(failed === null, 'failed tx ignored');

    const m = measureWalletDeltas(
      parsedTx({ wallet: w, lamportsPre: 10e9, lamportsPost: 10e9 - 101005000, post: [tb(w, mint, 10000e6)] }),
      w,
      mint
    );
    check(m && m.tokenDeltaRaw === 10000000000n && m.lamportsDelta === -101005000 && m.decimals === 6, `own fill measured (got ${JSON.stringify(m, (k, v) => typeof v === 'bigint' ? v.toString() : v)})`);
  });

  await test('dexMapper: PREFERRED_DEX=auto still detects the real venue', async () => {
    const { mapDex, detectVenue } = require(src('dexMapper.js'));
    check(mapDex(['Pump.fun']) === 'auto', 'portal gets preferred dex');
    check(detectVenue(['Pump.fun']) === 'pumpfun', 'venue detected');
    check(detectVenue(['Raydium Cpmm']) === 'raydium', 'raydium venue');
    check(detectVenue(['Raydium Launchpad']) === 'raydium' && detectVenue(['Raydium Clmm']) === 'raydium', 'LaunchLab and CLMM go to the direct Raydium builder');
  });

  await test('storage: atomic writes, corrupt file is an error (not a silent wipe), zeros kept', async () => {
    const storage = require(src('storage.js'));
    storage.initStorage();
    const p = storage.addPosition({ mint: 'M', buy_amount: 0.1, token_amount: '1.000000', entry_price: 0, trailing_stop_activation: 0, stop_loss_pct: 20 });
    check(p.trailing_stop_activation === 0, `0 preserved (got ${p.trailing_stop_activation})`);
    check(p.cost_basis_sol === 0.1, 'cost basis defaults to buy_amount');
    check(!fs.existsSync(storage.filePath + '.tmp'), 'no temp file left behind');
    fs.writeFileSync(storage.filePath, '{"positions": [ {"id": "a"');
    let err = null;
    try { storage.initStorage(); } catch (e) { err = e; }
    check(err instanceof storage.StorageCorruptError, 'corrupt file raises StorageCorruptError');
    check(fs.readFileSync(storage.filePath, 'utf8').startsWith('{"positions": [ {"id": "a"'), 'corrupt file left untouched for recovery');
    fs.unlinkSync(storage.filePath);
    storage.initStorage();
    check(storage.getAllPositions().length === 0, 'missing file starts fresh');

    // An older file holding history: closed positions and exited coins move
    // out at startup; open ones stay; nothing is lost.
    for (const f of [storage.archivePath, storage.exitedPath]) { try { fs.unlinkSync(f); } catch {} }
    const old = new Date(Date.now() - 3600e3).toISOString();
    fs.writeFileSync(storage.filePath, JSON.stringify({
      positions: [
        { id: 'open1', mint: 'A', status: 'active' },
        { id: 'shut1', mint: 'B', status: 'closed', closed_at: old },
        { id: 'shut2', mint: 'C', status: 'closed' }
      ],
      exitedMints: ['X', 'Y'],
      paused: true
    }));
    storage.initStorage();
    const onDisk = JSON.parse(fs.readFileSync(storage.filePath, 'utf8'));
    check(onDisk.positions.length === 1 && onDisk.positions[0].id === 'open1' && onDisk.paused === true && !onDisk.exitedMints, `positions.json keeps open positions and settings only (${JSON.stringify(onDisk)})`);
    const archived = fs.readFileSync(storage.archivePath, 'utf8').trim().split('\n').map((l) => JSON.parse(l).id);
    check(JSON.stringify(archived) === '["shut1","shut2"]', `closed positions archived (${archived})`);
    check(JSON.stringify(storage.getExitedMints()) === '["X","Y"]', 'exited coins carried over');
    storage.addExitedMint('Z');
    storage.addExitedMint('Z');
    check(fs.readFileSync(storage.exitedPath, 'utf8') === 'X\nY\nZ\n', 'a new exit is one appended line');
    check(storage.getAllPositions().map((p) => p.id).sort().join() === 'open1,shut1,shut2', 'getAllPositions still sees the history');
    // A recent close stays (its PnL is written just after), an old one moves.
    storage.updatePosition('open1', { status: 'closed', closed_at: new Date().toISOString() });
    check(storage.archiveClosed() === 0, 'just-closed position not archived yet');
    check(storage.updatePosition('open1', { realized_pnl_sol: 0.01 }).realized_pnl_sol === 0.01, 'PnL written after the close');
    fs.unlinkSync(storage.filePath);
    for (const f of [storage.archivePath, storage.exitedPath]) { try { fs.unlinkSync(f); } catch {} }
    storage.initStorage();
  });

  await test('fast signing: same signature as @solana/web3.js; PDA cache: same addresses', async () => {
    const { signTx } = require(src('fastSign.js'));
    const { VersionedTransaction, TransactionMessage, SystemProgram, PublicKey } = require('@solana/web3.js');
    for (let i = 0; i < 5; i++) {
      const kp = Keypair.generate();
      const msg = new TransactionMessage({ payerKey: kp.publicKey, recentBlockhash: '11111111111111111111111111111111', instructions: [SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 5 + i })] }).compileToV0Message();
      const a = new VersionedTransaction(msg);
      const b = new VersionedTransaction(msg);
      a.sign([kp]);
      signTx(b, kp);
      check(Buffer.from(a.signatures[0]).equals(Buffer.from(b.signatures[0])), `signature ${i} identical`);
    }
    require(src('pdaCache.js'));
    const prog = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
    const m = Keypair.generate().publicKey;
    const seeds = [Buffer.from('bonding-curve'), m.toBuffer()];
    const one = PublicKey.findProgramAddressSync(seeds, prog);
    const two = PublicKey.findProgramAddressSync([Buffer.from('bonding-curve'), new Uint8Array(m.toBytes())], prog);
    const other = PublicKey.findProgramAddressSync([Buffer.from('bonding-curve'), Keypair.generate().publicKey.toBuffer()], prog);
    check(PublicKey.findProgramAddressSync.__cached && one[0].equals(two[0]) && one[1] === two[1] && !other[0].equals(one[0]), 'cached derivations match, different seeds differ');
    const viaCreate = PublicKey.createProgramAddressSync([...seeds, Buffer.from([one[1]])], prog);
    check(viaCreate.equals(one[0]), 'cached result is the real address');
  });

  await test('rpcPool: per-call timeout and failover to next endpoint', async () => {
    const rpcPool = require(src('rpcPool.js'));
    const t0 = Date.now();
    let err = null;
    try {
      await rpcPool.withFailover(() => new Promise(() => {}), 150);
    } catch (e) { err = e; }
    const took = Date.now() - t0;
    check(err && /timed out/.test(err.message), `hung call times out (err: ${err && err.message})`);
    check(took < 1500, `bounded wait across endpoints (took ${took}ms)`);

    const seen = [];
    const r = await rpcPool.withFailover(async (conn) => {
      seen.push(conn.rpcEndpoint);
      if (seen.length === 1) throw new Error('503 from primary');
      return 'ok';
    });
    check(r === 'ok' && seen.length === 2 && seen[0] !== seen[1], `failed over to a different endpoint (${JSON.stringify(seen)})`);
  });

  await test('config: bad values refuse to start', async () => {
    const base = { ...process.env };
    const other = Keypair.generate();
    const cases = [
      [{ MAX_BUY_AMOUNT: 'abc' }, /MAX_BUY_AMOUNT must be a number/],
      [{ MAX_TOTAL_EXPOSURE: '0' }, /MAX_TOTAL_EXPOSURE must be greater than 0/],
      [{ STOP_LOSS: '' }, /Missing environment variable STOP_LOSS/],
      [{ PRICE_CHECK_DELAY: '50' }, /PRICE_CHECK_DELAY must be at least 250/],
      [{ SLIPPAGE: '1O' }, /SLIPPAGE must be a number/],
      [{ PUBLIC_KEY: other.publicKey.toBase58() }, /does not match the wallet PRIVATE_KEY controls/],
      [{ COPY_WALLET: base.PUBLIC_KEY }, /COPY_WALLET is your own wallet/],
      [{ COPY_WALLET: 'not-an-address' }, /COPY_WALLET: "not-an-address" is not a valid Solana address/],
      [{ MAX_OPEN_POSITIONS: '1.5' }, /MAX_OPEN_POSITIONS/],
      [{ MAX_OPEN_POSITIONS: '-1' }, /MAX_OPEN_POSITIONS/],
      [{ BUY_COOLDOWN_SEC: '-1' }, /BUY_COOLDOWN_SEC/],
      [{ BUY_PRIORITY_FEE_PCT: '80' }, /BUY_PRIORITY_FEE_PCT/],
      [{ ENABLE_TRAILING_STOP: 'true', TRAILING_STOP_DISTANCE: '0' }, /TRAILING_STOP_DISTANCE greater than 0/],
      [{ SELL_MAX_ATTEMPTS: '1' }, /SELL_MAX_ATTEMPTS must be at least 2/],
      [{ SKIP_REBUYS: 'sometimes' }, /SKIP_REBUYS must be one of: off, full, any/],
      [{ DETECTION_COMMITMENT: 'finalized' }, /DETECTION_COMMITMENT must be "confirmed" or "processed"/],
      [{ SEND_VIA: 'axiom' }, /SEND_VIA must be "jito" or "sender"/],
      [{ MAX_TOKEN_TAX_PCT: 'five' }, /MAX_TOKEN_TAX_PCT must be a number/],
      [{ MAX_TOKEN_TAX_PCT: '150' }, /MAX_TOKEN_TAX_PCT must be at most 100/],
      [{ SEND_VIA: 'sender', SENDER_TIP: '0.0005' }, /SENDER_TIP must be at least 0.001 SOL/],
      [{ SEND_VIA: 'sender', SENDER_SWQOS_ONLY: 'true', SENDER_TIP: '0.000001' }, /SENDER_TIP must be at least 0.000005 SOL with SENDER_SWQOS_ONLY/],
      [{ SEND_VIA: 'sender', PRIORITY_FEE_SOL: '0' }, /requires PRIORITY_FEE_SOL greater than 0/],
      [{ SEND_VIA: 'sender', SENDER_ENDPOINT: 'fra-sender.helius-rpc.com/fast' }, /SENDER_ENDPOINT must be an http\(s\) URL/],
      [{ MIN_MARKET_CAP_SOL: '100', MAX_MARKET_CAP_SOL: '80' }, /MIN_MARKET_CAP_SOL \(100\) must be below MAX_MARKET_CAP_SOL \(80\)/],
      [{ MAX_MARKET_CAP_SOL: '0' }, /MAX_MARKET_CAP_SOL must be greater than 0/],
      [{ BLOCKED_CREATORS: 'not-an-address' }, /BLOCKED_CREATORS: "not-an-address" is not a valid Solana address/],
      [{ MAX_SLOTS_BEHIND: '0.5' }, /MAX_SLOTS_BEHIND must be a whole number/],
      [{ SHRED_FAST_BUY: 'true' }, /SHRED_FAST_BUY="true" needs MAX_MARKET_CAP_SOL/],
      [{ PUMPFUN_COMPUTE_UNITS: '1000' }, /PUMPFUN_COMPUTE_UNITS must be at least 60000/],
      [{ SHRED_EXCLUDE_ACCOUNTS: 'nope' }, /SHRED_EXCLUDE_ACCOUNTS: "nope" is not a valid Solana address/]
    ];
    for (const [overrides, re] of cases) {
      const r = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(src('config.js'))})`], {
        cwd: root, env: { ...base, ...overrides }, encoding: 'utf8'
      });
      check(r.status === 1 && re.test(r.stderr), `${JSON.stringify(overrides)} -> exit ${r.status}, stderr: ${r.stderr.trim().slice(0, 160)}`);
    }
    const ok = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(src('config.js'))})`], { cwd: root, env: base, encoding: 'utf8' });
    check(ok.status === 0, `valid config loads (stderr: ${ok.stderr.trim().slice(0, 200)})`);
    const show = `const c = require(${JSON.stringify(src('config.js'))}); console.log(JSON.stringify([c.SEND_VIA, c.SENDER_TIP, c.PRIORITY_FEE_SOL, c.SENDER_ENDPOINT]))`;
    const sender = spawnSync(process.execPath, ['-e', show], { cwd: root, env: { ...base, SEND_VIA: 'sender' }, encoding: 'utf8' });
    check(sender.status === 0 && sender.stdout.trim() === '["sender",0.001,0.0001,"http://fra-sender.helius-rpc.com/fast"]',
      `sender defaults: Frankfurt, 0.001 SOL tip, 0.0001 SOL priority fee (${sender.stdout.trim()} ${sender.stderr.trim().slice(0, 200)})`);
    const jito = spawnSync(process.execPath, ['-e', show], { cwd: root, env: base, encoding: 'utf8' });
    check(jito.status === 0 && JSON.parse(jito.stdout)[0] === 'jito' && JSON.parse(jito.stdout)[2] === 0,
      `default is Jito with no priority fee, as before (${jito.stdout.trim()})`);
  });

  await test('tradeExecutor: direct path used with PREFERRED_DEX=auto; never double-sends after a send error', async () => {
    // Stub the Pump.fun builder, and fetch (SolanaPortal + Jito).
    const bs58m = require('bs58');
    const payer = Keypair.fromSecretKey((bs58m.default || bs58m).decode(process.env.PRIVATE_KEY));
    const msg = new TransactionMessage({
      payerKey: payer.publicKey,
      recentBlockhash: '11111111111111111111111111111111',
      instructions: [SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: payer.publicKey, lamports: 1 })]
    }).compileToV0Message();
    const makeTx = () => new VersionedTransaction(msg);

    let buildMode = 'ok';
    let stubBuilds = 0;
    let lastBuildArgs = null;
    class UnsupportedPumpfunTradeError extends Error {}
    const pumpStub = {
      UnsupportedPumpfunTradeError,
      buildPumpfunBuyTx: async (a) => {
        stubBuilds += 1;
        lastBuildArgs = a;
        if (buildMode === 'unsupported') throw new UnsupportedPumpfunTradeError('curve complete');
        const t = makeTx();
        if (a.guardInstructions) Object.defineProperty(t, 'guardIxIndex', { value: 2 });
        return t;
      },
      buildPumpfunSellTx: async () => makeTx()
    };
    const p = src('pumpfunDirect.js');
    require.cache[p] = { id: p, filename: p, loaded: true, exports: pumpStub, children: [], paths: [] };

    const calls = [];
    let jitoMode = 'ok';
    const respond = (body) => ({ ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify(body) });
    global.fetch = async (url, opts) => {
      const host = new URL(url).host;
      calls.push(host);
      if (host.includes('solanaportal')) return respond(Buffer.from(makeTx().serialize()).toString('base64'));
      if (jitoMode === 'networkError') throw new Error('socket hang up');
      if (jitoMode === 'rateLimited') return { ok: false, status: 429, statusText: 'Too Many Requests', text: async () => 'rate limited' };
      return respond({ result: 'jitoSig' });
    };

    const { buyToken } = require(src('tradeExecutor.js'));
    const args = { mint: Keypair.generate().publicKey.toBase58(), amountSol: 0.1, slippage: 20, tip: 0.001, dex: 'auto', venue: 'pumpfun' };

    calls.length = 0;
    const curveHint = { mint: args.mint, virtualSolReserves: '1' };
    const sig = await buyToken({ ...args, curveHint });
    check(sig === 'jitoSig' && !calls.some((h) => h.includes('solanaportal')), `direct build used, SolanaPortal skipped (calls ${JSON.stringify(calls)})`);
    check(lastBuildArgs && lastBuildArgs.curveHint === curveHint, 'the copy wallet\'s trade record is handed to the Pump.fun builder');

    // Buys can pay a higher priority fee than sells (BUY_PRIORITY_FEE_SOL /
    // _PCT); the fee is spread over the compute-unit budget.
    {
      const cfg = require(src('config.js'));
      const te = require(src('tradeExecutor.js'));
      const saved = { s: cfg.PRIORITY_FEE_SOL, b: cfg.BUY_PRIORITY_FEE_SOL, p: cfg.BUY_PRIORITY_FEE_PCT };
      Object.assign(cfg, { PRIORITY_FEE_SOL: 0.0001, BUY_PRIORITY_FEE_SOL: 0.02, BUY_PRIORITY_FEE_PCT: 3 });
      try {
        check(te.priorityFeeSol('sell', 5) === 0.0001, 'sells: PRIORITY_FEE_SOL');
        check(te.priorityFeeSol('buy', 0.0003) === 0.02, 'small buy: the fixed buy fee');
        check(Math.abs(te.priorityFeeSol('buy', 2) - 0.06) < 1e-12, '2 SOL buy at 3%: 0.06 SOL');
        await buyToken({ ...args, amountSol: 1 });
        const cu = cfg.PUMPFUN_COMPUTE_UNITS;
        check(lastBuildArgs.priorityFeeMicroLamports === Math.ceil((0.03 * 1e9 * 1e6) / cu), `1 SOL buy built with 0.03 SOL over ${cu} units (${lastBuildArgs.priorityFeeMicroLamports})`);
      } finally {
        Object.assign(cfg, { PRIORITY_FEE_SOL: saved.s, BUY_PRIORITY_FEE_SOL: saved.b, BUY_PRIORITY_FEE_PCT: saved.p });
      }
    }

    // PAUSED_REHEARSAL: built and signed exactly as for real, but not sent.
    calls.length = 0;
    const builtBefore = stubBuilds;
    const rehearsed = await buyToken({ ...args, dryRun: true, slotGuard: { maxSlot: 123, seenAt: Date.now(), slotsAllowed: 0 } });
    check(rehearsed && rehearsed.dryRun && typeof rehearsed.buildMs === 'number' && typeof rehearsed.signMs === 'number' && rehearsed.readyAt > 0, `rehearsal result (${JSON.stringify(rehearsed)})`);
    check(stubBuilds === builtBefore + 1 && calls.length === 0, `built once, nothing sent (calls ${JSON.stringify(calls)})`);
    buildMode = 'unsupported';
    const noDirect = await buyToken({ ...args, mint: Keypair.generate().publicKey.toBase58(), dryRun: true });
    buildMode = 'ok';
    check(noDirect && noDirect.dryRun && noDirect.noDirect && calls.length === 0, `no direct build: SolanaPortal/Jupiter not used in a rehearsal (calls ${JSON.stringify(calls)})`);

    // MAX_SLOTS_BEHIND: the guard goes into the build; too late = nothing sent.
    calls.length = 0;
    await buyToken({ ...args, slotGuard: { maxSlot: 123, seenAt: Date.now(), slotsAllowed: 0 } });
    const g = lastBuildArgs.guardInstructions;
    check(g && g.length === 1 && g[0].programId.toBase58() === 'L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95', 'slot guard instruction handed to the builder');
    calls.length = 0;
    let late = null;
    try { await buyToken({ ...args, slotGuard: { maxSlot: 123, seenAt: Date.now() - 2000, slotsAllowed: 0 } }); } catch (e) { late = e; }
    check(late && late.coinFiltered && late.setting === 'MAX_SLOTS_BEHIND' && calls.length === 0, `already too late: skipped, nothing sent (${late && late.message}; calls ${JSON.stringify(calls)})`);
    let noGuard = null;
    try { await buyToken({ ...args, venue: 'raydium', dex: 'raydium', slotGuard: { maxSlot: 1, seenAt: Date.now(), slotsAllowed: 0 } }); } catch (e) { noGuard = e; }
    check(noGuard && noGuard.coinFiltered && /only be added to direct Pump.fun/.test(noGuard.message), `a buy that can't carry the guard is skipped (${noGuard && noGuard.message})`);

    calls.length = 0;
    jitoMode = 'networkError';
    let err = null;
    try { await buyToken(args); } catch (e) { err = e; }
    check(err && !calls.some((h) => h.includes('solanaportal')), `send failure is NOT retried via SolanaPortal (calls ${JSON.stringify(calls)})`);
    check(err && typeof err.txSignature === 'string' && err.txSignature.length > 40, `ambiguous send error carries the tx signature (${err && err.txSignature})`);

    jitoMode = 'rateLimited';
    err = null;
    try { await buyToken(args); } catch (e) { err = e; }
    check(err && !err.txSignature, 'a definite Jito rejection (429) is NOT reported as ambiguous');

    calls.length = 0;
    jitoMode = 'ok';
    buildMode = 'unsupported';
    stubBuilds = 0;
    const sig2 = await buyToken(args);
    check(sig2 === 'jitoSig' && calls[0].includes('solanaportal'), `unsupported build falls back to SolanaPortal (calls ${JSON.stringify(calls)})`);
    await buyToken(args);
    check(stubBuilds === 1, `a coin the direct builder can't handle isn't retried straight away (${stubBuilds} build attempts for 2 buys)`);

    // Direct builders only (no SolanaPortal / Jupiter for buys): a coin they
    // can't build is skipped with the real reason, even with the slot guard on.
    const config = require(src('config.js'));
    const savedRoutes = { p: config.USE_SOLANAPORTAL, j: config.JUPITER_FALLBACK };
    config.USE_SOLANAPORTAL = { ...config.USE_SOLANAPORTAL, buy: false };
    config.JUPITER_FALLBACK = { ...config.JUPITER_FALLBACK, buy: false };
    try {
      calls.length = 0;
      let noRoute = null;
      try { await buyToken({ ...args, mint: Keypair.generate().publicKey.toBase58(), slotGuard: { maxSlot: 9, seenAt: Date.now(), slotsAllowed: 0 } }); } catch (e) { noRoute = e; }
      check(noRoute && noRoute.coinFiltered && /No route for this buy: curve complete/.test(noRoute.message) && !/slot guard/.test(noRoute.message) && calls.length === 0,
        `no route at all: the real reason, nothing sent (${noRoute && noRoute.message}; calls ${JSON.stringify(calls)})`);
    } finally {
      config.USE_SOLANAPORTAL = savedRoutes.p;
      config.JUPITER_FALLBACK = savedRoutes.j;
    }
  });

  await test('Jupiter backup: used only when SolanaPortal can\'t build; assembled with our tip; route logged', async () => {
    const { ComputeBudgetProgram } = require('@solana/web3.js');
    const { JITO_TIP_ACCOUNTS } = require(src('jitoTip.js'));
    const bs58m = require('bs58');
    const B58 = bs58m.default || bs58m;
    const payer = Keypair.fromSecretKey(B58.decode(process.env.PRIVATE_KEY));
    const swapProgram = Keypair.generate().publicKey.toBase58();
    const lutKey = Keypair.generate().publicKey.toBase58();
    const lutAddrs = Array.from({ length: 4 }, () => Keypair.generate().publicKey.toBase58());
    const jIx = (programId, extra = []) => ({ programId, accounts: [{ pubkey: payer.publicKey.toBase58(), isSigner: true, isWritable: true }, ...extra], data: Buffer.from([1, 2, 3]).toString('base64') });
    const jupBuild = {
      inAmount: '100000000', outAmount: '123456', routePlan: [{ swapInfo: { label: 'Orca Whirlpool' } }, { swapInfo: { label: 'Meteora DLMM' } }],
      computeBudgetInstructions: [jIx(ComputeBudgetProgram.programId.toBase58())],
      setupInstructions: [jIx(swapProgram)],
      swapInstruction: jIx(swapProgram, lutAddrs.map((a) => ({ pubkey: a, isSigner: false, isWritable: true }))),
      cleanupInstruction: null, otherInstructions: [], tipInstruction: null,
      addressesByLookupTableAddress: { [lutKey]: lutAddrs },
      blockhashWithMetadata: { blockhash: Array.from(B58.decode('GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi')), lastValidBlockHeight: 1 }
    };
    const calls = [];
    let portalMode = 'down';
    let jupMode = 'ok';
    let sentTx = null;
    let jupUrl = null;
    const respond = (body, status = 200) => ({ ok: status < 400, status, statusText: '', text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
    global.fetch = async (url, opts) => {
      const host = new URL(url).host;
      calls.push(host);
      if (host.includes('solanaportal')) {
        if (portalMode === 'down') return respond('<!DOCTYPE html><html><title>526</title></html>', 526);
        const m = new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: '11111111111111111111111111111111', instructions: [SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: payer.publicKey, lamports: 1 })] }).compileToV0Message();
        return respond(JSON.stringify(Buffer.from(new VersionedTransaction(m).serialize()).toString('base64')));
      }
      if (host === 'api.jup.ag') {
        jupUrl = url;
        if (jupMode === 'nokey') return respond({ error: 'Unauthorized' }, 401);
        return respond(jupBuild);
      }
      if (opts && opts.body) {
        const b = JSON.parse(opts.body);
        if (b.method === 'sendTransaction') { sentTx = VersionedTransaction.deserialize(B58.decode(b.params[0])); return respond({ result: 'jitoSig' }); }
      }
      return respond({ result: 'x' });
    };
    const logs = [];
    const te = require(src('tradeExecutor.js'));
    const capture = (fn) => async (...a) => { const orig = console.log; console.log = (...m) => { logs.push(m.join(' ')); }; try { return await fn(...a); } finally { console.log = orig; } };
    const mint = Keypair.generate().publicKey.toBase58();
    const args = { mint, amountSol: 0.1, slippage: 20, tip: 0.001, dex: 'auto', venue: 'meteora' };
    const cfgJ = require(src('config.js'));
    check(JSON.stringify(cfgJ.JUPITER_FALLBACK) === '{"buy":false,"sell":false}' && JSON.stringify(cfgJ.USE_SOLANAPORTAL) === '{"buy":true,"sell":true}', 'defaults: Jupiter off, SolanaPortal on');

    // Jupiter off (default): SolanaPortal's failure is the trade's failure; Jupiter never asked.
    let offErr = null;
    try { await te.buyToken(args); } catch (e) { offErr = e; }
    check(offErr && /SolanaPortal responded 526/.test(offErr.message) && !calls.includes('api.jup.ag'), `Jupiter off: not used (${JSON.stringify(calls)})`);
    te._resetForTests();
    calls.length = 0;
    cfgJ.JUPITER_FALLBACK = { buy: true, sell: true };

    const sig = await capture(te.buyToken)(args);
    check(sig === 'jitoSig' && calls.includes('api.jup.ag'), `SolanaPortal down -> Jupiter used (${JSON.stringify(calls)})`);
    const q = new URL(jupUrl).searchParams;
    check(q.get('inputMint') === 'So11111111111111111111111111111111111111112' && q.get('outputMint') === mint && q.get('amount') === '100000000' && q.get('slippageBps') === '2000' && q.get('taker') === payer.publicKey.toBase58(), `Jupiter request (${jupUrl})`);
    const ixs = TransactionMessage.decompile(sentTx.message, { addressLookupTableAccounts: [new (require('@solana/web3.js').AddressLookupTableAccount)({ key: new PublicKey(lutKey), state: { deactivationSlot: BigInt('18446744073709551615'), lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, authority: undefined, addresses: lutAddrs.map((a) => new PublicKey(a)) } })] }).instructions;
    const progs = ixs.map((i) => i.programId.toBase58());
    const CB = ComputeBudgetProgram.programId.toBase58();
    check(progs[0] === CB && progs.filter((p) => p === CB).length === 1, `our compute limit only, Jupiter's compute budget dropped (${JSON.stringify(progs)})`);
    const last = ixs[ixs.length - 1];
    check(last.programId.equals(SystemProgram.programId) && JITO_TIP_ACCOUNTS.some((k) => k.equals(last.keys[1].pubkey)) && last.data.readBigUInt64LE(4) === 1_000_000n, 'Jito tip appended (0.001 SOL)');
    check(sentTx.message.addressTableLookups.length === 1 && sentTx.message.recentBlockhash === 'GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi', 'lookup table and Jupiter\'s blockhash used (no extra RPC)');
    check(logs.some((l) => /BUY txn sent via Jupiter backup \(route: Orca Whirlpool → Meteora DLMM; built in \d+ms\)/.test(l)), `route logged (${logs.filter((l) => /txn sent|Jupiter/.test(l)).join(' | ')})`);

    // SolanaPortal's server just failed: the next trade goes straight to Jupiter.
    calls.length = 0; logs.length = 0;
    await capture(te.buyToken)(args);
    check(!calls.includes('api.solanaportal.io') && calls.includes('api.jup.ag'), `SolanaPortal skipped for a while after a server failure (${JSON.stringify(calls)})`);
    check(logs.some((l) => /SolanaPortal skipped: its server failed \d+s ago/.test(l)), 'skip explained in the log');

    te._resetForTests();
    calls.length = 0; logs.length = 0;
    portalMode = 'ok';
    await capture(te.buyToken)(args);
    check(!calls.includes('api.jup.ag') && logs.some((l) => /BUY txn sent via SolanaPortal \(built in \d+ms\)/.test(l)), `SolanaPortal working -> Jupiter not touched (${JSON.stringify(calls)})`);

    portalMode = 'down'; jupMode = 'nokey';
    te._resetForTests();
    let err = null;
    try { await te.buyToken(args); } catch (e) { err = e; }
    check(err && /SolanaPortal failed .*Jupiter backup failed too .*JUPITER_API_KEY/.test(err.message), `both failing explained (${err && err.message})`);

    // SolanaPortal switched off: Jupiter straight away, SolanaPortal never contacted.
    te._resetForTests(); jupMode = 'ok'; portalMode = 'ok';
    cfgJ.USE_SOLANAPORTAL = { buy: false, sell: false };
    calls.length = 0; logs.length = 0;
    await capture(te.buyToken)(args);
    check(!calls.includes('api.solanaportal.io') && calls.includes('api.jup.ag') && logs.some((l) => /via Jupiter \(route: .*SolanaPortal is off for buys\)/.test(l)), `USE_SOLANAPORTAL=false -> Jupiter directly (${JSON.stringify(calls)})`);
    cfgJ.JUPITER_FALLBACK = { buy: false, sell: false };
    calls.length = 0;
    let noRoute = null;
    try { await te.buyToken(args); } catch (e) { noRoute = e; }
    check(noRoute && /No route for this buy/.test(noRoute.message) && calls.length === 0, `both off: clear "no route" error, nothing contacted (${noRoute && noRoute.message})`);
    cfgJ.USE_SOLANAPORTAL = { buy: true, sell: true };
    cfgJ.JUPITER_FALLBACK = { buy: true, sell: true };

    // Exits only: SolanaPortal/Jupiter build sells, never buys.
    te._resetForTests(); portalMode = 'ok';
    cfgJ.USE_SOLANAPORTAL = { buy: false, sell: true };
    cfgJ.JUPITER_FALLBACK = { buy: false, sell: true };
    calls.length = 0;
    let buyErr = null;
    try { await te.buyToken(args); } catch (e) { buyErr = e; }
    check(buyErr && /No route for this buy/.test(buyErr.message) && calls.length === 0, `sells-only: buy not routed (${buyErr && buyErr.message})`);
    const sellSig = await te.sellToken({ mint, amountTokens: '100', slippage: 20, tip: 0.001, dex: 'auto', venue: 'meteora' });
    check(sellSig === 'jitoSig' && calls.includes('api.solanaportal.io'), `sells-only: sell goes through SolanaPortal (${JSON.stringify(calls)})`);
    cfgJ.USE_SOLANAPORTAL = { buy: true, sell: true };
    cfgJ.JUPITER_FALLBACK = { buy: true, sell: true };

    calls.length = 0; logs.length = 0; jupMode = 'ok';
    const cfg = require(src('config.js'));
    const wasDirect = cfg.DIRECT_PUMPFUN_SWAP;
    cfg.DIRECT_PUMPFUN_SWAP = false;
    await capture(te.buyToken)({ ...args, venue: 'pumpfun' });
    cfg.DIRECT_PUMPFUN_SWAP = wasDirect;
    cfgJ.JUPITER_FALLBACK = { buy: false, sell: false };
    te._resetForTests();
    check(logs.some((l) => /DIRECT_PUMPFUN_SWAP is off/.test(l)), 'says when direct Pump.fun building is switched off');
  });

  await test('heliusSender: converts Jito-tipped transactions for Sender without touching anything else', async () => {
    const { ComputeBudgetProgram, AddressLookupTableAccount, TransactionInstruction } = require('@solana/web3.js');
    const { prepareForSender, SENDER_TIP_ACCOUNTS } = require(src('heliusSender.js'));
    const { JITO_TIP_ACCOUNTS } = require(src('jitoTip.js'));
    const SYS = SystemProgram.programId.toBase58();
    const CB = ComputeBudgetProgram.programId.toBase58();
    const payer = Keypair.generate();
    const senderTips = new Set(SENDER_TIP_ACCOUNTS.map((k) => k.toBase58()));
    const opts = { tipLamports: 1_000_000, priorityFeeLamports: 100_000 };

    // A stand-in swap: an unknown program with signer, writable and read-only
    // accounts, three of them loaded from an address lookup table.
    const lutAddrs = Array.from({ length: 6 }, () => Keypair.generate().publicKey);
    const lut = new AddressLookupTableAccount({
      key: Keypair.generate().publicKey,
      state: { deactivationSlot: BigInt('18446744073709551615'), lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, authority: undefined, addresses: lutAddrs }
    });
    const swap = (dataLen = 5) => new TransactionInstruction({
      programId: Keypair.generate().publicKey,
      keys: [
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: lutAddrs[0], isSigner: false, isWritable: true },
        { pubkey: lutAddrs[1], isSigner: false, isWritable: false },
        { pubkey: lutAddrs[2], isSigner: false, isWritable: true },
        { pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: false }
      ],
      data: Buffer.alloc(dataLen, 7)
    });
    const jitoTip = () => SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: JITO_TIP_ACCOUNTS[3], lamports: 500_000 });
    const limit = (u) => ComputeBudgetProgram.setComputeUnitLimit({ units: u });
    const price = (m) => ComputeBudgetProgram.setComputeUnitPrice({ microLamports: m });
    const build = (ixs, { legacy = false, luts = [] } = {}) => {
      const m = new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: '11111111111111111111111111111111', instructions: ixs });
      return new VersionedTransaction(legacy ? m.compileToLegacyMessage() : m.compileToV0Message(luts));
    };
    // What the network would see: sign, round-trip through bytes, decompile.
    const view = (tx, luts = []) => {
      const t = VersionedTransaction.deserialize(tx.serialize());
      t.sign([payer]);
      const t2 = VersionedTransaction.deserialize(t.serialize());
      return TransactionMessage.decompile(t2.message, { addressLookupTableAccounts: luts }).instructions.map((ix) => ({
        prog: ix.programId.toBase58(),
        keys: ix.keys.map((k) => `${k.pubkey.toBase58()}:${k.isSigner ? 's' : ''}${k.isWritable ? 'w' : ''}`),
        data: Buffer.from(ix.data)
      }));
    };
    const same = (a, b) => a && b && a.prog === b.prog && JSON.stringify(a.keys) === JSON.stringify(b.keys) && a.data.equals(b.data);
    const isPrice = (ix, micro) => ix && ix.prog === CB && ix.data.length === 9 && ix.data[0] === 3 && ix.data.readBigUInt64LE(1) === BigInt(micro);
    const isSenderTip = (ix) => ix && ix.prog === SYS && senderTips.has(ix.keys[1].split(':')[0]) && ix.keys[1].endsWith(':w') &&
      ix.keys[0] === `${payer.publicKey.toBase58()}:sw` && ix.data.readBigUInt64LE(4) === 1_000_000n;

    // [label, instructions, build options, expected price (micro-lamports/CU), whether a price ix is added]
    const cases = [
      ['v0 + lookup table, has limit & price', [limit(200_000), price(1000), swap(), jitoTip()], { luts: [lut] }, 500_000, false],
      ['v0 + lookup table, no compute budget at all (SolanaPortal-like)', [swap(), jitoTip()], { luts: [lut] }, 250_000, true],
      ['v0, limit but no price', [limit(300_000), swap(), jitoTip()], {}, 333_334, true],
      ['legacy, no compute budget', [swap(), jitoTip()], { legacy: true }, 250_000, true],
      ['legacy, has limit & price', [limit(200_000), price(1000), swap(), jitoTip()], { legacy: true }, 500_000, false]
    ];
    for (const [label, ixs, bopts, micro, added] of cases) {
      const tx = build(ixs, bopts);
      const originalBytes = Buffer.from(tx.serialize());
      const before = view(tx, bopts.luts || []);
      const r = prepareForSender(tx, opts);
      check(r.ok && r.addedPriorityFee === added, `${label}: converted (${JSON.stringify({ ok: r.ok, reason: r.reason, added: r.addedPriorityFee })})`);
      if (!r.ok) continue;
      check(Buffer.from(tx.serialize()).equals(originalBytes), `${label}: original transaction left untouched`);
      const after = view(r.tx, bopts.luts || []);
      const expectLen = before.length + (added ? 1 : 0);
      check(after.length === expectLen, `${label}: ${after.length} instructions (expected ${expectLen})`);
      const shifted = added ? after.slice(1) : after;
      if (added) check(isPrice(after[0], micro), `${label}: priority fee added first (${after[0] && after[0].data.toString('hex')})`);
      before.forEach((orig, i) => {
        const now = shifted[i];
        if (orig.prog === SYS && orig.keys[1].startsWith(JITO_TIP_ACCOUNTS[3].toBase58())) {
          check(isSenderTip(now), `${label}: Jito tip became a 0.001 SOL Sender tip`);
        } else if (orig.prog === CB && orig.data[0] === 3) {
          check(isPrice(now, micro), `${label}: priority fee raised to ${micro}`);
        } else {
          check(same(orig, now), `${label}: instruction ${i} (${orig.prog.slice(0, 6)}…) unchanged, accounts and flags included`);
        }
      });
    }

    const high = prepareForSender(build([price(9_000_000), swap(), jitoTip()]), opts);
    check(high.ok && isPrice(view(high.tx)[0], 9_000_000), 'a higher existing priority fee is kept');

    const noTip = prepareForSender(build([price(1), swap()]), opts);
    check(!noTip.ok && /tip/.test(noTip.reason), `no Jito tip -> not converted (${noTip.reason})`);

    // Already at the 1232-byte limit: adding the ComputeBudget program and an
    // instruction would overflow it, so it's left for Jito instead.
    const base = build([swap(0), jitoTip()]).serialize().length;
    const full = build([swap(1232 - base - 2), jitoTip()]);
    const fullSize = full.serialize().length;
    const big = prepareForSender(full, opts);
    check(fullSize <= 1232 && !big.ok && /too big/.test(big.reason), `full-size transaction not converted (size ${fullSize}; ${big.reason})`);
  });

  await test('tradeExecutor with SEND_VIA=sender: direct and SolanaPortal buys go to Sender', async () => {
    const script = path.join(root, 'sender-child.js');
    fs.writeFileSync(script, `
      const { Keypair, SystemProgram, ComputeBudgetProgram, TransactionMessage, VersionedTransaction } = require('@solana/web3.js');
      const bs58m = require('bs58'); const bs58 = bs58m.default || bs58m;
      const payer = Keypair.fromSecretKey(bs58.decode(process.env.PRIVATE_KEY));
      const { JITO_TIP_ACCOUNTS } = require(${JSON.stringify(src('jitoTip.js'))});
      let seenBuildArgs = null;
      const makeTx = (args, withPrice) => {
        const ixs = [ComputeBudgetProgram.setComputeUnitLimit({ units: args.computeUnitLimit || 200000 })];
        if (withPrice) ixs.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: args.priorityFeeMicroLamports || 0 }));
        ixs.push(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: payer.publicKey, lamports: 1 }));
        ixs.push(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: JITO_TIP_ACCOUNTS[0], lamports: Math.round(args.tipSol * 1e9) }));
        return new VersionedTransaction(new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: '11111111111111111111111111111111', instructions: ixs }).compileToV0Message());
      };
      class UnsupportedPumpfunTradeError extends Error {}
      const p = ${JSON.stringify(src('pumpfunDirect.js'))};
      require.cache[p] = { id: p, filename: p, loaded: true, exports: { UnsupportedPumpfunTradeError,
        buildPumpfunBuyTx: async (a) => { seenBuildArgs = a; return makeTx(a, true); }, buildPumpfunSellTx: async (a) => makeTx(a, true) } };
      const calls = [];
      global.fetch = async (url, opts) => {
        calls.push({ url, body: opts && opts.body ? JSON.parse(opts.body) : null });
        const ok = (b) => ({ ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify(b) });
        if (url.includes('solanaportal')) return ok(Buffer.from(makeTx({ tipSol: JSON.parse(opts.body).tip }, false).serialize()).toString('base64'));
        if (url.endsWith('/ping')) return ok({});
        return ok({ result: url.includes('sender') ? 'senderSig' : 'jitoSig' });
      };
      (async () => {
        const { buyToken } = require(${JSON.stringify(src('tradeExecutor.js'))});
        const args = { mint: Keypair.generate().publicKey.toBase58(), amountSol: 0.1, slippage: 20, tip: 0.0005, dex: 'auto', venue: 'pumpfun' };
        const direct = await buyToken(args);
        const sent = calls.find((c) => c.body && c.body.method === 'sendTransaction');
        const tx = VersionedTransaction.deserialize(Buffer.from(sent.body.params[0], 'base64'));
        const portal = await buyToken({ ...args, venue: 'meteora' });
        const portalSend = calls.filter((c) => c.body && c.body.method === 'sendTransaction').pop();
        const ptx = VersionedTransaction.deserialize(Buffer.from(portalSend.body.params[0], 'base64'));
        const pkeys = ptx.message.staticAccountKeys;
        const pFirst = ptx.message.compiledInstructions[0];
        console.log('RESULT' + JSON.stringify({
          direct, portal, sentUrl: sent.url, opts: sent.body.params[1],
          tipTo: tx.message.staticAccountKeys[tx.message.compiledInstructions[3].accountKeyIndexes[1]].toBase58(),
          tipLamports: Buffer.from(tx.message.compiledInstructions[3].data).readBigUInt64LE(4).toString(),
          buildArgs: { tipSol: seenBuildArgs.tipSol, cu: seenBuildArgs.computeUnitLimit, price: seenBuildArgs.priorityFeeMicroLamports },
          signed: tx.signatures[0].some((b) => b !== 0),
          pinged: calls.some((c) => c.url === 'http://fra-sender.helius-rpc.com/ping'),
          portalUrl: portalSend.url,
          portalFirstProgram: pkeys[pFirst.programIdIndex].toBase58(),
          portalFirstData: Buffer.from(pFirst.data).toString('hex')
        }));
        process.exit(0);
      })().catch((e) => { console.error(e); process.exit(1); });
    `);
    const r = spawnSync(process.execPath, [script], {
      cwd: root, env: { ...process.env, SEND_VIA: 'sender', DIRECT_PUMPFUN_SWAP: 'true' }, encoding: 'utf8', timeout: 20000
    });
    const line = (r.stdout || '').split('\n').find((l) => l.startsWith('RESULT'));
    check(line, `child ran (exit ${r.status}; ${(r.stderr || '').slice(-400)})`);
    if (!line) return;
    const out = JSON.parse(line.slice(6));
    const { SENDER_TIP_ACCOUNTS } = require(src('heliusSender.js'));
    check(out.direct === 'senderSig' && out.sentUrl === 'http://fra-sender.helius-rpc.com/fast', `direct buy sent to Sender Frankfurt (${out.direct} ${out.sentUrl})`);
    check(out.opts && out.opts.encoding === 'base64' && out.opts.skipPreflight === true && out.opts.maxRetries === 0, `Sender options (${JSON.stringify(out.opts)})`);
    check(SENDER_TIP_ACCOUNTS.some((k) => k.toBase58() === out.tipTo) && out.tipLamports === '1000000', `tip to a Sender account, 0.001 SOL (${out.tipTo} ${out.tipLamports})`);
    check(out.buildArgs.tipSol === 0.001 && out.buildArgs.cu === 300000 && out.buildArgs.price === 333334, `builder got Sender tip + priority fee (${JSON.stringify(out.buildArgs)})`);
    check(out.signed, 'signed after conversion');
    check(out.pinged, 'keep-alive ping sent to Sender');
    check(out.portal === 'senderSig' && out.portalUrl.includes('sender'), `SolanaPortal tx also goes to Sender (${out.portal} ${out.portalUrl})`);
    // Portal's tx had a 200k limit and no price: 0.0001 SOL over 200k CU = 500,000 micro-lamports (0x7a120).
    check(out.portalFirstProgram === 'ComputeBudget111111111111111111111111111111' && out.portalFirstData === '0320a1070000000000',
      `priority fee added to the SolanaPortal tx (${out.portalFirstProgram} ${out.portalFirstData})`);
  });

  await test('timeouts: fetchJson bounds headers AND a body that stalls mid-way', async () => {
    const http = require('http');
    const { fetchJson, TimeoutError } = require(src('timeouts.js'));
    const stubbed = global.fetch;
    global.fetch = NODE_FETCH; // real fetch against a local server
    const server = http.createServer((req, res) => {
      if (req.url === '/stall-body') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.write('{"result": "par'); // ...and never finishes
      } else if (req.url === '/stall-headers') {
        // never responds
      } else {
        res.end('{"result":"ok"}');
      }
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const ok = await fetchJson(`${base}/fine`, {}, 1000);
    check(ok.ok && ok.data && ok.data.result === 'ok', 'normal response parsed');
    for (const path of ['/stall-body', '/stall-headers']) {
      let err = null;
      const t0 = Date.now();
      try { await fetchJson(`${base}${path}`, {}, 300); } catch (e) { err = e; }
      check(err instanceof TimeoutError && Date.now() - t0 < 2000, `${path}: timed out in ${Date.now() - t0}ms (${err && err.message})`);
    }
    server.closeAllConnections && server.closeAllConnections();
    server.close();
    global.fetch = stubbed;
  });

  await test('txParser: a final tiny sell below MIN_TRADE_SOL is still seen (buys still filtered)', async () => {
    const { parseCopyTradeTransaction } = require(src('txParser.js'));
    const w = Keypair.generate().publicKey.toBase58();
    const mint = Keypair.generate().publicKey.toBase58();
    const dustSell = parseCopyTradeTransaction(
      parsedTx({ wallet: w, lamportsPre: 1e9, lamportsPost: 1e9 + 1_000_000 - 5000, pre: [tb(w, mint, 500e6)], post: [] }),
      w
    );
    check(dustSell && dustSell.trade === 'sell' && dustSell.sellPercent === 100, `0.001 SOL exit detected (${JSON.stringify(dustSell)})`);
    const dustBuy = parseCopyTradeTransaction(
      parsedTx({ wallet: w, lamportsPre: 1e9, lamportsPost: 1e9 - 2_039_280 - 5000, post: [tb(w, mint, 1)] }),
      w
    );
    check(dustBuy === null, 'rent-only "buy" (airdrop claim) still ignored');
  });

  await test('txParser: tokens leaving without a SOL sale become transfer events', async () => {
    const { parseCopyWalletEvents } = require(src('txParser.js'));
    const w = Keypair.generate().publicKey.toBase58();
    const other = Keypair.generate().publicKey.toBase58();
    const A = Keypair.generate().publicKey.toBase58();
    const B = Keypair.generate().publicKey.toBase58();

    // Sends 25% of token A to another wallet.
    const send = parseCopyWalletEvents(
      parsedTx({ wallet: w, lamportsPre: 1e9, lamportsPost: 1e9 - 5000, pre: [tb(w, A, 1000e6), tb(other, A, 0)], post: [tb(w, A, 750e6), tb(other, A, 250e6)] }),
      w
    );
    check(send.length === 1 && send[0].trade === 'transfer' && send[0].ca === A && Math.abs(send[0].sellPercent - 25) < 1e-9, `25% transfer out (${JSON.stringify(send)})`);

    // Burns the whole bag and closes the account (rent refund = small SOL gain -> it's a "sell").
    const burn = parseCopyWalletEvents(
      parsedTx({ wallet: w, lamportsPre: 1e9, lamportsPost: 1e9 + 2039280 - 5000, pre: [tb(w, A, 1000e6)], post: [] }),
      w
    );
    check(burn.length === 1 && burn[0].sellPercent === 100, `full burn/exit seen (${JSON.stringify(burn)})`);

    // Swaps token A into token B with no SOL leg: exit from A (B is ignored).
    const swap = parseCopyWalletEvents(
      parsedTx({ wallet: w, lamportsPre: 1e9, lamportsPost: 1e9 - 5000, pre: [tb(w, A, 1000e6)], post: [tb(w, A, 0), tb(w, B, 5000e6)] }),
      w
    );
    check(swap.some((e) => e.ca === A && e.trade === 'transfer' && e.sellPercent === 100) && !swap.some((e) => e.ca === B), `token-to-token swap = exit from A (${JSON.stringify(swap)})`);

    // A normal buy and a normal sell produce no extra transfer events.
    const buy = parseCopyWalletEvents(parsedTx({ wallet: w, lamportsPre: 10e9, lamportsPost: 9e9 - 5000, post: [tb(w, A, 1000e6)] }), w);
    check(buy.length === 1 && buy[0].trade === 'buy', 'plain buy -> one event');
    const sell = parseCopyWalletEvents(parsedTx({ wallet: w, lamportsPre: 1e9, lamportsPost: 1.5e9, pre: [tb(w, A, 1000e6)], post: [tb(w, A, 600e6)] }), w);
    check(sell.length === 1 && sell[0].trade === 'sell', 'plain sell -> one event');

    // Receiving tokens (no SOL spent) is not an event at all.
    const receive = parseCopyWalletEvents(parsedTx({ wallet: w, lamportsPre: 1e9, lamportsPost: 1e9 - 5000, post: [tb(w, A, 1000e6)] }), w);
    check(receive.length === 0, 'incoming transfer ignored');
  });

  await test('priceChecker: batches up to 30 tokens per request and attributes prices correctly', async () => {
    const { getPrices, getPriceOnChain } = require(src('priceChecker.js'));
    const WSOL = 'So11111111111111111111111111111111111111112';
    const mints = Array.from({ length: 35 }, () => Keypair.generate().publicKey.toBase58());
    const [m0, m1, m2] = mints;
    const urls = [];
    const stubbed = global.fetch;
    global.fetch = async (url) => {
      urls.push(String(url));
      const asked = String(url).split('/').pop().split(',');
      const pairs = [];
      for (const m of asked) {
        if (m === m1) continue; // not indexed yet
        pairs.push({ chainId: 'solana', baseToken: { address: m }, quoteToken: { address: WSOL }, priceUsd: '0.002', priceNative: '0.00002', liquidity: { usd: 5000 } });
      }
      // A more liquid pair for m0 (should win) and a pair where m2 is only the QUOTE token (must be ignored).
      if (asked.includes(m0)) pairs.push({ chainId: 'solana', baseToken: { address: m0 }, quoteToken: { address: WSOL }, priceUsd: '0.003', priceNative: '0.00003', liquidity: { usd: 90000 } });
      if (asked.includes(m2)) pairs.push({ chainId: 'solana', baseToken: { address: 'OtherToken' }, quoteToken: { address: m2 }, priceUsd: '999', priceNative: '1', liquidity: { usd: 1e9 } });
      return { ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify(pairs) };
    };
    const prices = await getPrices(mints);
    check(urls.length === 2, `35 tokens -> 2 requests (got ${urls.length})`);
    check(urls.every((u) => u.startsWith('https://api.dexscreener.com/tokens/v1/solana/') && u.split('/').pop().split(',').length <= 30), 'batch endpoint, <= 30 addresses each');
    check(prices.get(m0) && prices.get(m0).priceInUsd === 0.003, `most liquid pair wins (${JSON.stringify(prices.get(m0))})`);
    check(!prices.has(m1), 'unindexed token simply absent');
    check(prices.get(m2) && prices.get(m2).priceInUsd === 0.002, 'quote-side pair ignored');
    check(prices.get(m0).priceInSol === 0.00003, 'SOL price from SOL-quoted pair');
    check(prices.size === 34, `all others priced (${prices.size})`);

    global.fetch = async () => ({ ok: false, status: 429, statusText: 'Too Many Requests', text: async () => 'slow down' });
    const limited = await getPriceOnChain(m0);
    check(limited === null, 'rate limit -> null, no throw');
    global.fetch = stubbed;
  });

  await test('websocket: subscribes, emits parsed trades, resubscribes on rejection, stays down after disconnect', async () => {
    const { WebSocketServer } = require('ws');
    const port = Number(process.env.__WS_PORT);
    const wss = new WebSocketServer({ port });
    const w = process.env.COPY_WALLET;
    const mint = Keypair.generate().publicKey.toBase58();
    let connections = 0;
    let rejectNextSubscribe = false;
    wss.on('connection', (sock) => {
      connections += 1;
      sock.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.method !== 'logsSubscribe') return;
        if (rejectNextSubscribe) {
          rejectNextSubscribe = false;
          sock.send(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'Method not found' } }));
          return;
        }
        sock.send(JSON.stringify({ jsonrpc: '2.0', id: 1, result: 42 }));
        sock.send(JSON.stringify({ jsonrpc: '2.0', method: 'logsNotification', params: { result: { value: { signature: 'copySig1', err: null } } } }));
      });
    });

    const rpcPool = require(src('rpcPool.js'));
    rpcPool.withFailover = async (fn) => fn({
      getParsedTransaction: async () => parsedTx({ wallet: w, lamportsPre: 10e9, lamportsPost: 9e9 - 5000, post: [tb(w, mint, 1000e6)] })
    });

    const CopyEmitter = require(src('websocket.js'));
    const em = new CopyEmitter();
    const events = [];
    em.on('copyTrade', (e) => events.push(e));
    em.connect();
    const t0 = Date.now();
    while (events.length === 0 && Date.now() - t0 < 3000) await sleep(20);
    check(events.length === 1 && events[0].ca === mint && events[0].trade === 'buy', `trade emitted (${JSON.stringify(events)})`);

    // Subscription rejected -> client drops the useless connection and retries.
    rejectNextSubscribe = true;
    for (const c of wss.clients) c.terminate();
    const t1 = Date.now();
    while (connections < 3 && Date.now() - t1 < 14000) await sleep(50);
    check(connections >= 3, `reconnected after a rejected subscription (connections ${connections})`);

    em.disconnect();
    const before = connections;
    await sleep(6000);
    check(connections === before, `no reconnect after disconnect() (connections ${before} -> ${connections})`);
    wss.close();
  });

  await test('websocket: several copy wallets on the logs feed: one logsSubscribe each, every wallet\'s trades emitted', async () => {
    const { WebSocketServer } = require('ws');
    const config = require(src('config.js'));
    const port = Number(process.env.__WS_PORT);
    const wss = new WebSocketServer({ port });
    const w1 = Keypair.generate().publicKey.toBase58();
    const w2 = Keypair.generate().publicKey.toBase58();
    const mint = Keypair.generate().publicKey.toBase58();
    const saved = config.COPY_WALLETS;
    config.COPY_WALLETS = [w1, w2];
    const subs = [];
    wss.on('connection', (sock) => {
      sock.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.method !== 'logsSubscribe') return;
        subs.push({ id: msg.id, mentions: msg.params[0].mentions });
        sock.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: 50 + subs.length }));
        // The same transaction reaches both subscriptions: handled once.
        sock.send(JSON.stringify({ jsonrpc: '2.0', method: 'logsNotification', params: { subscription: 50 + subs.length, result: { value: { signature: 'w2Sig', err: null } } } }));
      });
    });
    const rpcPool = require(src('rpcPool.js'));
    const savedFailover = rpcPool.withFailover;
    let lookups = 0;
    rpcPool.withFailover = async (fn) => fn({
      getParsedTransaction: async () => { lookups += 1; return parsedTx({ wallet: w2, lamportsPre: 10e9, lamportsPost: 9e9 - 5000, post: [tb(w2, mint, 1000e6)] }); }
    });
    const CopyEmitter = require(src('websocket.js'));
    const em = new CopyEmitter();
    const events = [];
    em.on('copyTrade', (e) => events.push(e));
    try {
      em.connect();
      const t0 = Date.now();
      while ((events.length === 0 || subs.length < 2) && Date.now() - t0 < 3000) await sleep(20);
      await sleep(200);
      check(subs.length === 2 && subs[0].mentions[0] === w1 && subs[1].mentions[0] === w2 && subs[0].id !== subs[1].id, `one subscription per wallet (${JSON.stringify(subs)})`);
      check(events.length === 1 && events[0].wallet === w2 && events[0].trade === 'buy' && events[0].ca === mint, `second wallet's buy emitted once, tagged (${JSON.stringify(events)})`);
      check(lookups === 1, `looked up once (${lookups})`);
    } finally {
      em.disconnect();
      wss.close();
      rpcPool.withFailover = savedFailover;
      config.COPY_WALLETS = saved;
    }
  });

  await test('coin snapshot: market cap, curve and holder lines from our own buy', async () => {
    const { tradeEventLine, pumpLogs } = require('./pumpEvent');
    const { decodePumpTradeDetails } = require(src('fastPumpParser.js'));
    const M = 1_000_000n;
    const me = Keypair.generate().publicKey.toBase58();
    const mint = Keypair.generate().publicKey.toBase58();
    const creator = Keypair.generate().publicKey.toBase58();
    const ev = { mint, user: me, vSol: 40_000_000_000n, vTok: 800_000_000n * M, rSol: 1n, rTok: 593_100_000n * M, creator };
    const other = tradeEventLine({ ...ev, user: Keypair.generate().publicKey.toBase58(), vSol: 1n });
    const d = decodePumpTradeDetails(pumpLogs(other, tradeEventLine(ev)), me, mint);
    check(d && d.virtualSolReserves === 40_000_000_000n && d.realTokenReserves === 593_100_000n * M && d.creator === creator && d.solQuoted === true,
      `our event decoded, someone else's ignored (${JSON.stringify(d, (k, v) => (typeof v === 'bigint' ? v.toString() : v))})`);
    check(decodePumpTradeDetails(pumpLogs(tradeEventLine(ev)), me, Keypair.generate().publicKey.toBase58()) === null, 'other mint -> null');
    const spoof = ['Program Evi1111111111111111111111111111111111111 invoke [1]', tradeEventLine(ev), 'Program Evi1111111111111111111111111111111111111 success'];
    check(decodePumpTradeDetails(spoof, me, mint) === null, 'event printed by another program is ignored');
    const usdc = decodePumpTradeDetails(pumpLogs(tradeEventLine({ ...ev, quoteMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' })), me, mint);
    check(usdc && usdc.solQuoted === false, 'coin quoted in another token is flagged');

    // Stub the network so the snapshot's holder lookups hang forever.
    const coinPath = src('coinInfo.js');
    const stubs = {
      [src('rpcPool.js')]: { withFailover: () => new Promise(() => {}) },
      [src('priceChecker.js')]: { getSolUsd: async () => 100 }
    };
    const saved = {};
    for (const [p, exp] of Object.entries(stubs)) {
      saved[p] = require.cache[p];
      require.cache[p] = { id: p, filename: p, loaded: true, exports: exp };
    }
    delete require.cache[coinPath];
    try {
      const coinInfo = require(coinPath);
      const t0 = Date.now();
      const snap = await coinInfo.snapshot({ mint, pumpEvent: d, priceData: null });
      const took = Date.now() - t0;
      check(took < 3500, `slow holder lookups don't hold the message up for long (${took}ms)`);
      check(Math.abs(snap.mcapSol - 50) < 1e-9 && Math.abs(snap.mcapUsd - 5000) < 1e-6, `market cap from the event (${JSON.stringify(snap)})`);
      check(Math.abs(snap.curvePct - 25.2175) < 0.01, `curve progress (${snap.curvePct})`);
      check(snap.creatorPct === null && snap.top10Pct === null, 'holder figures left out when unavailable');
      check(coinInfo.describe(snap).join('|') === 'MC: $5.0k (50.0 SOL) · Curve: 25%', `lines (${coinInfo.describe(snap)})`);
      check(coinInfo.describe({ ...snap, mcapUsd: null, mcapSol: null, curvePct: null, creatorPct: 0.5, top10Pct: 31.26 }).join('|') ===
        'Creator holds 0.5% · Top 10: 31%', 'holder line formatting');
      const nonSol = coinInfo.fromTradeEvent({ ...d, solQuoted: false });
      check(nonSol.mcapSol === undefined, 'no SOL market cap for a coin quoted in another token');
      const big = coinInfo.fromTradeEvent(d, 2_000_000_000n * M);
      check(big.curvePct === undefined && Math.abs(big.mcapSol - 100) < 1e-9, 'non-standard supply: market cap scales, no curve %');
    } finally {
      for (const [p, mod] of Object.entries(saved)) {
        if (mod) require.cache[p] = mod;
        else delete require.cache[p];
      }
      delete require.cache[coinPath];
    }
  });

  await test('stockTokens: recognises stock quotes in a transaction, never the coin itself', async () => {
    const { isStockToken, stockLabel, findStockInTx } = require(src('stockTokens.js'));
    check(isStockToken('Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh') && stockLabel('Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh') === 'NVDAx', 'known xStock');
    check(isStockToken('XsNewStock1111111111111111111111111111111111'), 'unlisted xStock by prefix');
    check(isStockToken('PreweJYECqtQwBtpxHL171nL2K6umo692gTm7Q3rpgF'), 'PreStocks');
    check(!isStockToken('So11111111111111111111111111111111111111112') && !isStockToken('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'), 'SOL / USDC are not stocks');
    const coin = 'XsLooksLikeAStockButIsTheCoin11111111111111';
    const tb = (mint) => ({ mint, owner: 'pool', uiTokenAmount: { amount: '1', decimals: 6 } });
    const tx = (mints) => ({ meta: { preTokenBalances: mints.map(tb), postTokenBalances: [] } });
    check(findStockInTx(tx([coin, 'Xs3oZwbHvqis4NYcf4YKWmEia2eC84wSiVrcYcTqpH8']), coin) === 'Xs3oZwbHvqis4NYcf4YKWmEia2eC84wSiVrcYcTqpH8', 'stock vault in the trade found');
    check(findStockInTx(tx([coin, 'So11111111111111111111111111111111111111112']), coin) === null, 'coin itself (even with an Xs address) is never the quote');
  });

  await test('logger: RPC URLs are printed without API keys', async () => {
    const { redactUrl } = require(src('logger.js'));
    const a = redactUrl('wss://mainnet.helius-rpc.com/?api-key=00000000-test-4000-8000-000000000000');
    check(!a.includes('00000000-test') && a.includes('mainnet.helius-rpc.com'), `query key hidden (${a})`);
    const b = redactUrl('https://example.solana-mainnet.quiknode.pro/abcdef0123456789abcdef0123456789/');
    check(!b.includes('abcdef0123456789') && b.includes('quiknode.pro'), `path key hidden (${b})`);
  });

  await test('rateLimiter: evenly spaced, under the limit; trading calls go before background ones', async () => {
    const { createLimiter } = require(src('rateLimiter.js'));
    const lim = createLimiter(10);
    const order = [];
    const t0 = Date.now();
    const jobs = [];
    for (let i = 0; i < 15; i++) jobs.push(lim.acquire('low').then(() => order.push(['low', Date.now() - t0])));
    for (let i = 0; i < 5; i++) jobs.push(lim.acquire('high').then(() => order.push(['high', Date.now() - t0])));
    await Promise.all(jobs);
    const took = Date.now() - t0;
    check(took >= 1800 && took < 2600, `20 calls at 10/s took ${took}ms (one every ~100ms)`);
    // Spaced out, never bunched (Helius refuses bursts in the same instant).
    const times = order.map((o) => o[1]).sort((a, b) => a - b);
    const minGap = Math.min(...times.slice(1).map((t, i) => t - times[i]));
    check(minGap >= 90, `calls at least ~100ms apart (closest gap ${minGap}ms)`);
    const worst = Math.max(...times.map((t) => times.filter((u) => u >= t && u < t + 1000).length));
    check(worst <= 10, `at most 10 calls in any 1s window (saw ${worst})`);
    // The very first call goes at once; then queued trading calls jump the background ones.
    check(order[0][1] < 20, `first call not delayed (${order[0][1]}ms)`);
    const kinds = order.map((o) => o[0]);
    check(kinds.slice(1, 6).every((k) => k === 'high'), `queued trading calls served before background ones (${JSON.stringify(kinds)})`);
    // A burst after a quiet spell is spaced out too.
    await new Promise((r) => setTimeout(r, 1100));
    const b0 = Date.now();
    const burst = [];
    await Promise.all(Array.from({ length: 12 }, () => lim.acquire().then(() => burst.push(Date.now() - b0))));
    const inFirstSecond = burst.filter((t) => t < 990).length;
    check(inFirstSecond === 10, `burst of 12 after idle: ${inFirstSecond} in the first second (want 10)`);
    const free = createLimiter(0);
    const f0 = Date.now();
    await Promise.all(Array.from({ length: 100 }, () => free.acquire()));
    check(Date.now() - f0 < 50, 'RPC_MAX_RPS=0 means no limit');
  });

  await test('usageStats: counts calls and websocket data, estimates credits', async () => {
    const usage = require(src('usageStats.js'));
    usage.countRpc('getTransaction'); usage.countRpc('getTransaction'); usage.countRpc('getBalance');
    usage.countRefused();
    usage.countWs(500000); usage.countWs(500000); // 1 MB -> ~20 credits
    usage.countSkipped();
    usage.countWsKind('failed'); usage.countWsKind('failed');
    const line = usage.summary(usage._totals());
    check(/RPC calls 3 \(getTransaction 2, getBalance 1\)/.test(line), line);
    check(/refused 1/.test(line) && /messages, 1\.00 MB/.test(line) && /1 non-token/.test(line), line);
    check(/2 failed transactions/.test(line), line);
    check(/~23 credits \(RPC ~3, websocket ~20\)/.test(line), line);
    const rpcPool = require(src('rpcPool.js'));
    const conn = rpcPool.getConnection();
    check(String(conn._rpcRequest).includes('countRpc'), 'every HTTP request of the shared connection is counted');
  });

  await test('SolanaPortal error pages are summarised, not dumped', async () => {
    const { describePortalError } = require(src('tradeExecutor.js'));
    const page = '<!DOCTYPE html>\n<!--[if lt IE 7]> <html class="no-js ie6 oldie" lang="en-US"> <![endif]--><title>api.solanaportal.io | 526: Invalid SSL certificate</title>';
    const msg = describePortalError(526, page);
    check(/their server has an invalid security certificate/.test(msg) && !/DOCTYPE|<html/.test(msg), msg);
    check(/server problems \(HTTP 503\)/.test(describePortalError(503, 'x')), 'other 5xx');
    check(describePortalError(400, '{"error":"bad mint"}') === '{"error":"bad mint"}', 'API errors kept as-is');
    check(/web page "Blocked"/.test(describePortalError(403, '<html><title>Blocked</title></html>')), 'HTML 4xx summarised');
  });

  await test('direct Pump.fun builder: coin\'s own token program, ONE lookup per trade when warm (PREWARM)', async () => {
    // Clean process: the real builder, the network stubbed and counted.
    const script = `
      const BN = require('bn.js');
      const { PublicKey, Keypair, TransactionInstruction } = require('@solana/web3.js');
      const { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync } = require('@solana/spl-token');
      const sdk = require('@pump-fun/pump-sdk');
      const seen = {};
      const sdkPath = require.resolve('@pump-fun/pump-sdk');
      require.cache[sdkPath].exports = { ...sdk, getBuyTokenAmountFromSolAmount: () => new BN(1000), getSellSolAmountFromTokenAmount: () => new BN(1000) };
      let globalFetches = 0, feeFetches = 0;
      sdk.OnlinePumpSdk.prototype.fetchGlobal = async function () { globalFetches++; return {}; };
      sdk.OnlinePumpSdk.prototype.fetchFeeConfig = async function () { feeFetches++; return { feeTiers: [] }; };
      sdk.PUMP_SDK.decodeBondingCurve = () => ({ complete: false, isMayhemMode: false, isCashbackCoin: true, quoteMint: PublicKey.default });
      const ix = () => new TransactionInstruction({ programId: PublicKey.default, keys: [], data: Buffer.alloc(0) });
      sdk.PUMP_SDK.buyInstructions = async (a) => { seen.buyIx = a.tokenProgram.toBase58(); seen.ata = a.associatedUserAccountInfo && a.associatedUserAccountInfo.which; return [ix()]; };
      sdk.PUMP_SDK.sellInstructions = async (a) => { seen.sellIx = a.tokenProgram.toBase58(); seen.cashback = a.cashback; return [ix()]; };
      const owners = {};
      const mint22 = Keypair.generate().publicKey, mintClassic = Keypair.generate().publicKey;
      owners[mint22.toBase58()] = TOKEN_2022_PROGRAM_ID; owners[mintClassic.toBase58()] = TOKEN_PROGRAM_ID;
      const user = Keypair.generate().publicKey;
      const calls = [];
      const connection = {
        getMultipleAccountsInfo: async (keys) => {
          calls.push('multi:' + keys.length);
          return keys.map((k, i) => {
            const b = k.toBase58();
            if (i === 0) return { data: Buffer.alloc(8) }; // the curve
            if (owners[b]) { const data = Buffer.alloc(82); data.writeBigUInt64LE(10n ** 15n, 36); data.writeUInt8(6, 44); return { owner: owners[b], data }; }
            for (const m of [mint22, mintClassic]) {
              if (getAssociatedTokenAddressSync(m, user, true, TOKEN_PROGRAM_ID).toBase58() === b) return { which: 'classic' };
              if (getAssociatedTokenAddressSync(m, user, true, TOKEN_2022_PROGRAM_ID).toBase58() === b) return { which: '2022' };
            }
            return null;
          });
        },
        getAccountInfo: async () => { calls.push('info'); return null; },
        getLatestBlockhash: async () => { calls.push('blockhash'); return { blockhash: '11111111111111111111111111111111' }; },
      };
      const splPath = require.resolve('@solana/spl-token');
      require.cache[splPath].exports = { ...require('@solana/spl-token'), getMint: async () => { seen.getMint = true; return { decimals: 6, supply: 10n ** 15n }; } };
      const d = require(${JSON.stringify(src('pumpfunDirect.js'))});
      const prewarm = require(${JSON.stringify(src('prewarm.js'))});
      (async () => {
        // Cold: nothing warm yet.
        await d.buildPumpfunBuyTx({ connection, user, mint: mint22.toBase58(), solAmount: 0.01, slippagePct: 20 });
        const cold = { calls: [...calls], globalFetches };
        await d.buildPumpfunSellTx({ connection, user, mint: mint22.toBase58(), tokenAmountUi: '5', slippagePct: 20 });
        const t22 = { ...seen };
        // Warm: blockhash and global config prewarmed (the fee schedule is cached from the first build).
        prewarm._setForTests({ blockhash: '11111111111111111111111111111111', pumpGlobal: {} });
        calls.length = 0; globalFetches = 0;
        await d.buildPumpfunBuyTx({ connection, user, mint: mintClassic.toBase58(), solAmount: 0.01, slippagePct: 20 });
        const classic = { buyIx: seen.buyIx, ata: seen.ata, calls: [...calls] };
        calls.length = 0;
        await d.buildPumpfunBuyTx({ connection, user, mint: mintClassic.toBase58(), solAmount: 0.01, slippagePct: 20 });
        const again = [...calls];
        console.log(JSON.stringify({ cold, t22, classic, again, globalFetches, feeFetches, T22: TOKEN_2022_PROGRAM_ID.toBase58(), T: TOKEN_PROGRAM_ID.toBase58() }));
      })().catch((e) => { console.log('ERR ' + e.stack); });
    `;
    const r = spawnSync(process.execPath, ['-e', script], { cwd: root, encoding: 'utf8' });
    const line = (r.stdout || '').trim().split('\n').pop();
    let out = null;
    try { out = JSON.parse(line); } catch {}
    check(out, `builder ran (${r.stdout}${r.stderr})`);
    if (out) {
      const { t22, T22, T } = out;
      check(t22.buyIx === T22 && t22.ata === '2022', `Token-2022 buy built with Token-2022 and its token account (${JSON.stringify(t22)})`);
      check(t22.sellIx === T22 && !t22.getMint, 'Token-2022 sell too (decimals from the cached mint read, no extra lookup)');
      check(t22.cashback === true, 'cashback coins flagged on sells');
      check(out.classic.buyIx === T && out.classic.ata === 'classic', 'classic coins use the classic token program and account');
      check(JSON.stringify(out.cold.calls) === JSON.stringify(['multi:4', 'blockhash']) && out.cold.globalFetches === 1, `cold: curve+mint+accounts in one call, then the blockhash (${JSON.stringify(out.cold)})`);
      check(JSON.stringify(out.classic.calls) === JSON.stringify(['multi:4']), `warm, new coin: ONE call (${JSON.stringify(out.classic.calls)})`);
      check(JSON.stringify(out.again) === JSON.stringify(['multi:2']) && out.globalFetches === 0, `warm, known coin: ONE call for 2 accounts (${JSON.stringify(out.again)}, global fetched ${out.globalFetches}x)`);
      check(out.feeFetches === 1, `fee schedule fetched once (${out.feeFetches})`);
    }
  });

  await test('curve hint: the coin\'s curve, creator, mayhem flag and token program from the copy wallet\'s trade record', async () => {
    const { tradeEventLine, pumpBuyLogs, pumpLogs } = require('./pumpEvent');
    const { decodePumpCurveHint } = require(src('fastPumpParser.js'));
    const T = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
    const T22 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
    const me = Keypair.generate().publicKey.toBase58();
    const mint = Keypair.generate().publicKey.toBase58();
    const creator = Keypair.generate().publicKey.toBase58();
    const ev = { mint, user: me, sol: 1e9, tokens: 1e12, vSol: 40_000_000_000n, vTok: 800_000_000_000_000n, rSol: 10_000_000_000n, rTok: 520_000_000_000_000n, creator, creatorFeeBps: 30 };
    const h = decodePumpCurveHint(pumpBuyLogs(T22, tradeEventLine(ev)), me, mint);
    check(h && h.virtualSolReserves === '40000000000' && h.virtualTokenReserves === '800000000000000' && h.realTokenReserves === '520000000000000',
      `reserves after his buy (${JSON.stringify(h)})`);
    check(h && h.creator === creator && h.mayhemMode === false && h.creatorFeeBps === '30' && h.solQuoted === true, 'creator, mayhem flag, creator fee');
    check(h && h.tokenProgram === 'token-2022', 'Token-2022: the token program Pump.fun itself called');
    check(decodePumpCurveHint(pumpBuyLogs(T, tradeEventLine(ev)), me, mint).tokenProgram === 'spl-token', 'classic SPL Token');
    check(decodePumpCurveHint(pumpLogs(tradeEventLine(ev)), me, mint).tokenProgram === null, 'no token call seen -> unknown (the bot then looks it up)');
    const both = [`Program 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P invoke [1]`, `Program ${T} invoke [2]`, `Program ${T} success`, `Program ${T22} invoke [2]`, `Program ${T22} success`,
      tradeEventLine(ev), 'Program 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P success'];
    check(decodePumpCurveHint(both, me, mint).tokenProgram === null, 'both token programs -> unknown');
    // Via a router: router [1] -> ATA create (its own token call) [2], Pump.fun [2] -> token [3].
    const R = 'Rout3r1111111111111111111111111111111111111';
    const routed = [`Program ${R} invoke [1]`, `Program ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL invoke [2]`, `Program ${T} invoke [3]`, `Program ${T} success`,
      'Program ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL success', `Program 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P invoke [2]`, `Program ${T22} invoke [3]`, `Program ${T22} success`,
      tradeEventLine(ev), 'Program 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P success', `Program ${R} success`];
    check(decodePumpCurveHint(routed, me, mint).tokenProgram === 'token-2022', 'through a router: only Pump.fun\'s own calls count');
    check(decodePumpCurveHint(pumpBuyLogs(T, tradeEventLine({ ...ev, mayhem: true })), me, mint).mayhemMode === true, 'mayhem-mode coins flagged');
    check(decodePumpCurveHint(pumpBuyLogs(T, tradeEventLine({ ...ev, user: Keypair.generate().publicKey.toBase58() })), me, mint) === null, 'someone else\'s trade -> null');
    check(decodePumpCurveHint(pumpBuyLogs(T, tradeEventLine({ ...ev, quoteMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' })), me, mint).solQuoted === false, 'non-SOL coins flagged');
  });

  await test('zero-lookup Pump.fun buy: built from the copy wallet\'s trade record with NO network calls when warm', async () => {
    // Real SDK instructions; the network is stubbed and every call counted.
    const script = `
      const BN = require('bn.js');
      const { PublicKey, Keypair } = require('@solana/web3.js');
      const { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } = require('@solana/spl-token');
      const sdk = require('@pump-fun/pump-sdk');
      const feeRecipient = Keypair.generate().publicKey, reserved = Keypair.generate().publicKey;
      const pumpGlobal = {
        initialVirtualTokenReserves: new BN('1073000000000000'), initialVirtualSolReserves: new BN('30000000000'),
        initialRealTokenReserves: new BN('793100000000000'), tokenTotalSupply: new BN('1000000000000000'),
        feeBasisPoints: new BN(95), creatorFeeBasisPoints: new BN(30), creatorFeeConfigurable: false, mayhemModeEnabled: false,
        feeRecipient, feeRecipients: [feeRecipient], reservedFeeRecipient: reserved, reservedFeeRecipients: [reserved]
      };
      const tier = { marketCapLamportsThreshold: new BN(0), fees: { lpFeeBps: new BN(0), protocolFeeBps: new BN(95), creatorFeeBps: new BN(30) } };
      let feeFetches = 0;
      sdk.OnlinePumpSdk.prototype.fetchGlobal = async () => { calls.push('global'); return pumpGlobal; };
      sdk.OnlinePumpSdk.prototype.fetchFeeConfig = async () => { feeFetches++; return { feeTiers: [tier], stableFeeTiers: [], flatFees: tier.fees, exoticFlatFees: tier.fees }; };
      const vT = new BN('357666666666667'), vS = new BN('90000000000');
      const lookupCurve = { virtualTokenReserves: vT, virtualQuoteReserves: vS, realTokenReserves: new BN('77766666666667'), realQuoteReserves: new BN('60000000000'),
        tokenTotalSupply: pumpGlobal.tokenTotalSupply, complete: false, creator: Keypair.generate().publicKey, isMayhemMode: false, isCashbackCoin: false, quoteMint: PublicKey.default, creatorFeeBps: new BN(0) };
      sdk.PUMP_SDK.decodeBondingCurve = () => lookupCurve;
      let lastIxs = null, lastArgs = null;
      const realBuy = sdk.PUMP_SDK.buyInstructions.bind(sdk.PUMP_SDK);
      sdk.PUMP_SDK.buyInstructions = async (a) => { lastArgs = a; lastIxs = await realBuy(a); return lastIxs; };
      const calls = [];
      const connection = {
        getMultipleAccountsInfo: async (keys) => { calls.push('multi:' + keys.length); return keys.map((k, i) => {
          if (i === 0) return { data: Buffer.alloc(8) };
          if (i === 1) { const data = Buffer.alloc(82); data.writeBigUInt64LE(10n ** 15n, 36); data.writeUInt8(6, 44); return { owner: TOKEN_PROGRAM_ID, data }; }
          return null; }); },
        getAccountInfo: async () => { calls.push('info'); return null; },
        getLatestBlockhash: async () => { calls.push('blockhash'); return { blockhash: '11111111111111111111111111111111' }; },
      };
      const d = require(${JSON.stringify(src('pumpfunDirect.js'))});
      const prewarm = require(${JSON.stringify(src('prewarm.js'))});
      const user = Keypair.generate().publicKey;
      const creator = Keypair.generate().publicKey;
      const hintFor = (mint, extra = {}) => ({ mint: mint.toBase58(), virtualTokenReserves: vT.toString(), virtualSolReserves: vS.toString(), realTokenReserves: '77766666666667',
        realSolReserves: '60000000000', creator: creator.toBase58(), mayhemMode: false, creatorFeeBps: '30', tokenProgram: 'token-2022', solQuoted: true, at: Date.now(), ...extra });
      (async () => {
        prewarm._setForTests({ blockhash: '11111111111111111111111111111111', pumpGlobal });
        await d.warmFeeConfig(connection);
        const out = {};
        // 1) Fresh trade record, coin never seen: no calls at all.
        const m1 = Keypair.generate().publicKey;
        calls.length = 0;
        const tx = await d.buildPumpfunBuyTx({ connection, user, mint: m1.toBase58(), solAmount: 0.0003, slippagePct: 1, curveHint: hintFor(m1) });
        out.zero = { calls: [...calls], builtFrom: tx.builtFrom, quote: tx.quote && tx.quote.priceSol, coin: tx.coin, creator: creator.toBase58() };
        const [ata, buy] = lastIxs;
        const ataAddr = getAssociatedTokenAddressSync(m1, user, true, TOKEN_2022_PROGRAM_ID);
        out.ata = ata.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID) && ata.data.length === 1 && ata.data[0] === 1 && ata.keys[1].pubkey.equals(ataAddr) && ata.keys.some((k) => k.pubkey.equals(TOKEN_2022_PROGRAM_ID));
        const keys = buy.keys.map((k) => k.pubkey.toBase58());
        out.buy = buy.programId.toBase58() === '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P' && keys.includes(m1.toBase58()) && keys.includes(ataAddr.toBase58())
          && keys.includes(sdk.creatorVaultPda(creator).toBase58()) && keys.includes(feeRecipient.toBase58()) && keys.includes(TOKEN_2022_PROGRAM_ID.toBase58());
        // Priced on the trade record's curve: what the program will charge fits in 1% slippage.
        const cost = sdk.getBuySolAmountFromTokenAmount({ global: pumpGlobal, feeConfig: { feeTiers: [tier] }, mintSupply: pumpGlobal.tokenTotalSupply, bondingCurve: { ...lookupCurve, creator }, amount: lastArgs.amount });
        out.cost = cost.toString(); out.max1 = new BN(300000).add(new BN(300000).muln(10).divn(1000)).toString();
        // With a slot guard: it sits right after the compute budget, before the swap.
        const { maxSlotInstruction } = require(${JSON.stringify(src('slotGuard.js'))});
        const mg = Keypair.generate().publicKey;
        const gtx = await d.buildPumpfunBuyTx({ connection, user, mint: mg.toBase58(), solAmount: 0.0003, slippagePct: 1, computeUnitLimit: 300000, priorityFeeMicroLamports: 1000,
          curveHint: hintFor(mg), guardInstructions: [maxSlotInstruction(999)] });
        const keysG = gtx.message.staticAccountKeys.map((k) => k.toBase58());
        out.guard = { index: gtx.guardIxIndex, programs: gtx.message.compiledInstructions.map((ci) => keysG[ci.programIdIndex].slice(0, 6)) };
        // 2) Mayhem coin: fee recipient from the reserved list.
        const m2 = Keypair.generate().publicKey;
        await d.buildPumpfunBuyTx({ connection, user, mint: m2.toBase58(), solAmount: 0.0003, slippagePct: 1, curveHint: hintFor(m2, { mayhemMode: true }) });
        out.mayhemLookedUp = calls.includes('multi:4');
        // 3) Stale record / unclear token program / other coin: looked up instead.
        const fallbacks = [];
        for (const extra of [{ at: Date.now() - 10000 }, { tokenProgram: null }, { mint: Keypair.generate().publicKey.toBase58() }]) {
          const m = Keypair.generate().publicKey;
          calls.length = 0;
          const t = await d.buildPumpfunBuyTx({ connection, user, mint: m.toBase58(), solAmount: 0.0003, slippagePct: 1, curveHint: hintFor(m, extra) });
          fallbacks.push({ calls: [...calls], builtFrom: t.builtFrom || null });
        }
        out.fallbacks = fallbacks;
        // 4) A known coin (mint read earlier) whose record lacks the token program: still zero calls.
        const m3 = Keypair.generate().publicKey;
        await d.buildPumpfunBuyTx({ connection, user, mint: m3.toBase58(), solAmount: 0.0003, slippagePct: 1 });
        calls.length = 0;
        await d.buildPumpfunBuyTx({ connection, user, mint: m3.toBase58(), solAmount: 0.0003, slippagePct: 1, curveHint: hintFor(m3, { tokenProgram: null }) });
        out.known = { calls: [...calls], program: lastArgs.tokenProgram.toBase58() };
        out.feeFetches = feeFetches;
        // The SDK object is reused between trades (setting one up costs tens of ms of CPU).
        const users = new Set();
        sdk.OnlinePumpSdk.prototype.fetchGlobal = async function () { users.add(this); return pumpGlobal; };
        prewarm._setForTests({ pumpGlobal: null });
        for (let i = 0; i < 2; i++) {
          const m = Keypair.generate().publicKey;
          await d.buildPumpfunBuyTx({ connection, user, mint: m.toBase58(), solAmount: 0.0003, slippagePct: 1, curveHint: hintFor(m) });
        }
        out.sdkMade = users.size;
        prewarm._setForTests({ pumpGlobal });
        // Practice build: no network calls, signed, never sent; skipped when not warm.
        calls.length = 0;
        const practiceMs = await d.warmUpBuild(connection);
        out.practice = { ms: practiceMs, calls: [...calls] };
        prewarm._setForTests({ blockhash: null });
        out.practiceCold = await d.warmUpBuild(connection);
        console.log(JSON.stringify(out));
      })().catch((e) => { console.log('ERR ' + e.stack); });
    `;
    const r = spawnSync(process.execPath, ['-e', script], { cwd: root, encoding: 'utf8' });
    const line = (r.stdout || '').trim().split('\n').pop();
    let out = null;
    try { out = JSON.parse(line); } catch {}
    check(out, `builder ran (${r.stdout}${r.stderr})`);
    if (out) {
      check(out.zero.calls.length === 0 && /trade record, no lookups/.test(out.zero.builtFrom), `no network calls at all (${JSON.stringify(out.zero)})`);
      check(out.ata, 'your Token-2022 token account is created in the same tx (idempotent: harmless if it exists)');
      check(out.guard.index === 2 && out.guard.programs[2] === 'L2TExM' && out.guard.programs[0] === 'Comput' && out.guard.programs.slice(3).includes('6EF8rr'),
        `slot guard placed after the compute budget, before the swap (${JSON.stringify(out.guard)})`);
      check(out.buy, 'buy instruction has the coin, your account, the creator\'s vault, a fee recipient and Token-2022');
      check(BigInt(out.cost) <= BigInt(out.max1), `priced on his post-trade curve: cost fits in 1% slippage (${out.cost} <= ${out.max1})`);
      check(out.zero.quote > 0, 'quote attached for MAX_ENTRY_PREMIUM_PCT');
      // 90 SOL / 357.67M tokens x 1B supply = 251.6 SOL.
      check(out.zero.coin && Math.abs(out.zero.coin.mcapSol - 251.63) < 0.05 && out.zero.coin.creator === out.zero.creator,
        `market cap and creator attached for the instant filters (${JSON.stringify(out.zero.coin)})`);
      check(out.mayhemLookedUp, 'mayhem-mode coin seen for the first time: looked up (its supply sets the fee tier)');
      check(out.fallbacks.every((f) => f.calls[0] === 'multi:4' && f.builtFrom === null), `stale record, unclear token program, wrong coin: looked up (${JSON.stringify(out.fallbacks)})`);
      check(out.known.calls.length === 0 && out.known.program === 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', `known coin: token program from the cached mint read, no calls (${JSON.stringify(out.known)})`);
      check(out.feeFetches === 1, `fee schedule read once, by the warm-up (${out.feeFetches})`);
      check(out.sdkMade === 1, `Pump.fun's SDK set up once, not per trade (${out.sdkMade})`);
      check(typeof out.practice.ms === 'number' && out.practice.calls.length === 0, `practice build: no network calls (${JSON.stringify(out.practice)})`);
      check(out.practiceCold === null, 'practice build skipped when the blockhash is not warm');
    }
  });

  await test('slot clock: how far into a slot something happened (exact, or estimated from a nearby slot)', async () => {
    const slotClock = require(src('slotClock.js'));
    slotClock._resetForTests();
    check(slotClock.msInto(100, 5000) === null, 'nothing known: null');
    slotClock.record(100, 1000);
    slotClock.record(100, 1300); // a repeat notification doesn't move the start
    check(slotClock.msInto(100, 1250) === 250 && slotClock.startOf(100).estimated === false, 'exact');
    check(slotClock.msInto(102, 1900) === 100 && slotClock.startOf(102).estimated === true, 'estimated 2 slots on at 400 ms each');
    check(slotClock.msInto(150, 9999) === null, 'too far from anything known: null');
  });

  await test('slot guard: Lighthouse "slot <= X" instruction, same bytes as its own SDK', async () => {
    const { maxSlotInstruction, explainFailure, remember } = require(src('slotGuard.js'));
    const ix = maxSlotInstruction(453101301);
    // From lighthouse-sdk 2.1.0: getAssertSysvarClockInstruction({ logLevel: Silent,
    //   assertion: { __kind: 'Slot', value: 453101301n, operator: LessThanOrEqual } })
    check(ix.data.toString('hex') === '0f0000f5c6011b0000000005', `instruction data (${ix.data.toString('hex')})`);
    check(ix.programId.toBase58() === 'L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95' && ix.keys.length === 0, 'Lighthouse program, no accounts');
    remember('sigA', { maxSlot: 10, ixIndex: 2 });
    check(/landed after slot 10/.test(explainFailure('sigA', { InstructionError: [2, { Custom: 6001 }] }) || ''), 'guard failure explained');
    check(explainFailure('sigA', { InstructionError: [4, { Custom: 6001 }] }) === null, 'a failure in another instruction is not the guard');
    check(explainFailure('sigB', { InstructionError: [2, { Custom: 6001 }] }) === null, 'unguarded buys are not the guard');
  });

  await test('instant buy filters: market cap range, blocked creators, unknown market cap', async () => {
    const { checkCoinFilters, attachCoin } = require(src('buyQuote.js'));
    const bad = Keypair.generate().publicKey.toBase58();
    const f = { minMcapSol: 30, maxMcapSol: 100, blockedCreators: new Set([bad]) };
    const tx = (mcapSol, creator = null) => attachCoin({}, { mcapSol, creator });
    const why = (t, filter = f) => { try { checkCoinFilters(t, 'Pump.fun curve', filter); return null; } catch (e) { return e.coinFiltered ? e.setting : 'threw ' + e.message; } };
    check(why(tx(60)) === null, 'inside the range: bought');
    check(why(tx(100)) === null && why(tx(30)) === null, 'the limits themselves are allowed');
    check(why(tx(150)) === 'MAX_MARKET_CAP_SOL', 'above max: skipped');
    check(why(tx(20)) === 'MIN_MARKET_CAP_SOL', 'below min: skipped');
    check(why(tx(60, bad)) === 'BLOCKED_CREATORS', 'blocked creator: skipped');
    check(why(tx(null)) === 'MIN/MAX_MARKET_CAP_SOL' && why(null) === 'MIN/MAX_MARKET_CAP_SOL', 'market cap unknown with a cap filter on: skipped');
    const onlyBlock = { minMcapSol: null, maxMcapSol: null, blockedCreators: new Set([bad]) };
    check(why(null, onlyBlock) === null && why(tx(null), onlyBlock) === null, 'blocklist only: unknown coins still bought');
    check(why(tx(500), null) === null, 'no filters: anything goes');
  });

  await test('hand-built buys: fast curve test and address derivation agree with web3.js', async () => {
    const crypto = require('crypto');
    const raw = require(src('pumpBuyRaw.js'));
    let bad = 0;
    for (let i = 0; i < 3000; i++) {
      const b = crypto.randomBytes(32);
      if (raw.isOnCurve(b) !== PublicKey.isOnCurve(b)) bad += 1;
    }
    // Edge cases: y = 0, y = 1 (x = 0) with and without the sign bit, y >= p.
    const le = (n, sign = false) => { const h = n.toString(16).padStart(64, '0'); const b = Buffer.from(h, 'hex').reverse(); if (sign) b[31] |= 0x80; return b; };
    const P = 2n ** 255n - 19n;
    for (const [n, sign] of [[0n, false], [1n, false], [1n, true], [P - 1n, false], [P, false], [P + 5n, false], [P - 1n, true]]) {
      const b = le(n, sign);
      if (raw.isOnCurve(b) !== PublicKey.isOnCurve(b)) bad += 1;
    }
    check(bad === 0, `same on-curve answer as web3.js (${bad} differ)`);
    const ATA = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
    const T22 = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb').toBuffer();
    let diff = 0;
    for (let i = 0; i < 300; i++) {
      const u = Keypair.generate().publicKey.toBuffer();
      const m = Keypair.generate().publicKey.toBuffer();
      if (!raw.derive([u, T22, m], ATA.toBuffer()).equals(PublicKey.findProgramAddressSync([u, T22, m], ATA)[0].toBuffer())) diff += 1;
    }
    check(diff === 0, `same addresses as findProgramAddressSync (${diff} differ)`);
  });

  for (const via of ['sender', 'jito']) {
    await test(`hand-built buys (${via}): byte-identical to the SDK route, sent through buyToken, switched off if the layout changes`, async () => {
      const script = `
        Math.random = () => 0; // the same random picks on both routes
        const BN = require('bn.js');
        const crypto = require('crypto');
        const { PublicKey, Keypair, VersionedTransaction } = require('@solana/web3.js');
        const { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync } = require('@solana/spl-token');
        const bs58 = require('bs58').default || require('bs58');
        const sdk = require('@pump-fun/pump-sdk');
        const feeRecipient = Keypair.generate().publicKey, reserved = Keypair.generate().publicKey;
        const pumpGlobal = {
          initialVirtualTokenReserves: new BN('1073000000000000'), initialVirtualSolReserves: new BN('30000000000'),
          initialRealTokenReserves: new BN('793100000000000'), tokenTotalSupply: new BN('1000000000000000'),
          feeBasisPoints: new BN(95), creatorFeeBasisPoints: new BN(30), creatorFeeConfigurable: false, mayhemModeEnabled: false,
          feeRecipient, feeRecipients: [Keypair.generate().publicKey], reservedFeeRecipient: reserved, reservedFeeRecipients: [reserved]
        };
        const tier = { marketCapLamportsThreshold: new BN(0), fees: { lpFeeBps: new BN(0), protocolFeeBps: new BN(95), creatorFeeBps: new BN(30) } };
        sdk.OnlinePumpSdk.prototype.fetchFeeConfig = async () => ({ feeTiers: [tier], stableFeeTiers: [], flatFees: tier.fees, exoticFlatFees: tier.fees });
        const sent = [];
        globalThis.fetch = async (url, opts) => {
          const body = JSON.parse(opts.body);
          sent.push({ url: String(url), body });
          const result = body.method === 'sendTransaction' ? (${JSON.stringify(via)} === 'sender' ? bs58.encode(VersionedTransaction.deserialize(Buffer.from(body.params[0], 'base64')).signatures[0]) : 'jitoSig') : 'x';
          return { ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify({ jsonrpc: '2.0', id: 1, result }) };
        };
        const prewarm = require('./src/prewarm');
        const d = require('./src/pumpfunDirect');
        const te = require('./src/tradeExecutor');
        const computeBudget = require('./src/computeBudget');
        const raw = require('./src/pumpBuyRaw');
        const slotGuard = require('./src/slotGuard');
        const config = require('./src/config');
        const user = new PublicKey(config.PUBLIC_KEY);
        const vault = sdk.creatorVaultPda(Keypair.generate().publicKey).toBase58();
        const hintFor = (mint, prog) => { const curve = sdk.bondingCurvePda(mint); return { mint: mint.toBase58(), creatorVault: vault,
          txKeys: [curve, getAssociatedTokenAddressSync(mint, curve, true, prog), sdk.bondingCurveV2Pda(mint), feeRecipient].map(String) }; };
        (async () => {
          prewarm._setForTests({ blockhash: 'GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi', pumpGlobal });
          await d.warmFeeConfig({});
          computeBudget._resetForTests();
          const out = { same: [], practice: null };
          const fee = te.priorityFeeSol('buy', 0.25);
          const ceiling = config.PUMPFUN_COMPUTE_UNITS;
          out.practice = await te.practiceHandBuilt();
          for (const [prog, guarded, learned] of [[TOKEN_2022_PROGRAM_ID, true, false], [TOKEN_PROGRAM_ID, false, false], [TOKEN_2022_PROGRAM_ID, true, true], [TOKEN_PROGRAM_ID, true, true]]) {
            const mint = Keypair.generate().publicKey;
            const guardInstructions = guarded ? [slotGuard.maxSlotInstruction(777000)] : [];
            if (learned) {
              const kind = 'buy|' + (guarded ? 'L2TExM+' : '') + 'AToken+6EF8rr|' + (prog.equals(TOKEN_2022_PROGRAM_ID) ? 't22' : 'spl') + '|a18';
              for (let i = 0; i < 3; i++) { computeBudget.remember('s' + i + kind, kind, ceiling); computeBudget.observe('s' + i + kind, 61000 + i * 1000); }
            }
            const base = { connection: { id: 1 }, user, mint: mint.toBase58(), solAmount: 0.25, slippagePct: 20, tipSol: te.handBuiltPlan(fee, ceiling, config.SEND_VIA === 'sender' ? config.SENDER_TIP : config.JITO_TIP).tip ? (config.SEND_VIA === 'sender' ? config.SENDER_TIP : config.JITO_TIP) : 0,
              computeUnitLimit: ceiling, priorityFeeMicroLamports: fee > 0 ? Math.ceil((fee * 1e9 * 1e6) / ceiling) : 0, fastHint: hintFor(mint, prog), maxMcapSol: 300, minMcapSol: null, guardInstructions };
            const a = await d.buildPumpfunBuyTx(base);
            const fitA = computeBudget.fit(a, 'buy', Math.round(fee * 1e9));
            const sa = te.prepareAndSign(a, { feeSol: fee }).tx.serialize();
            const b = await d.buildPumpfunBuyTx({ ...base, handBuilt: te.handBuiltPlan(fee, ceiling, base.tipSol) });
            const sb = te.prepareAndSign(b, { feeSol: fee }).tx.serialize();
            out.same.push({ hand: !!b.handBuilt, equal: Buffer.from(sa).equals(Buffer.from(sb)), learned: fitA.learned, kindMatch: b.compute && b.compute.kind === fitA.kind && b.compute.limit === fitA.limit && b.compute.learned === fitA.learned, guard: b.guardIxIndex === a.guardIxIndex });
          }
          // Through buyToken, as a copy buy goes.
          const mint = Keypair.generate().publicKey;
          const coinFilter = { maxMcapSol: 300, minMcapSol: null, blockedCreators: null };
          const sig = await te.buyToken({ mint: mint.toBase58(), amountSol: 0.25, slippage: 20, tip: config.JITO_TIP, dex: 'pumpfun', venue: 'pumpfun', pool: 'pump-curve', fastHint: hintFor(mint, TOKEN_2022_PROGRAM_ID), coinFilter });
          const req = sent.filter((x) => x.body.method === 'sendTransaction').pop();
          const bytes = ${JSON.stringify(via)} === 'sender' ? Buffer.from(req.body.params[0], 'base64') : Buffer.from(bs58.decode(req.body.params[0]));
          const tx = VersionedTransaction.deserialize(bytes);
          const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), user.toBuffer()]);
          out.verifies = crypto.verify(null, Buffer.from(tx.message.serialize()), crypto.createPublicKey({ key: spki, format: 'der', type: 'spki' }), Buffer.from(tx.signatures[0]));
          const keys = tx.message.staticAccountKeys.map(String);
          const buyIx = tx.message.compiledInstructions.find((ix) => keys[ix.programIdIndex] === '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
          out.exactSolIn = buyIx && Buffer.from(buyIx.data).subarray(0, 8).toString('hex') === '38fc74089edfcd5f' && Buffer.from(buyIx.data).readBigUInt64LE(8) === 250000000n;
          out.sigMatches = ${JSON.stringify(via)} === 'sender' ? sig === bs58.encode(tx.signatures[0]) : true;
          out.url = req.url;
          // A Pump.fun upgrade the SDK knows about but this module doesn't: switched off, SDK route used.
          const orig = sdk.PUMP_SDK.buyInstructions.bind(sdk.PUMP_SDK);
          sdk.PUMP_SDK.buyInstructions = async (args) => { const ixs = await orig(args); const last = ixs[ixs.length - 1]; last.keys.push({ pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: false }); return ixs; };
          out.afterChange = await te.practiceHandBuilt();
          out.disabled = raw.status().disabled;
          const m2 = Keypair.generate().publicKey;
          const t2 = await d.buildPumpfunBuyTx({ connection: { id: 1 }, user, mint: m2.toBase58(), solAmount: 0.25, slippagePct: 20, tipSol: 0.001, computeUnitLimit: ceiling, fastHint: hintFor(m2, TOKEN_PROGRAM_ID), maxMcapSol: 300, minMcapSol: null, handBuilt: te.handBuiltPlan(fee, ceiling, 0.001) });
          out.fallback = !t2.handBuilt && /no lookup/.test(t2.builtFrom || '');
          console.log(JSON.stringify(out));
        })().catch((e) => console.log('ERR ' + e.stack));
      `;
      const env = { ...process.env, SHRED_FAST_BUY: 'true', MAX_MARKET_CAP_SOL: '300', BUY_PRIORITY_FEE_SOL: '0.0015', PUMPFUN_COMPUTE_UNITS: '130000' };
      if (via === 'sender') Object.assign(env, { SEND_VIA: 'sender', SENDER_TIP: '0.0016' });
      else delete env.SEND_VIA;
      const r = spawnSync(process.execPath, ['-e', script], { cwd: root, env, encoding: 'utf8' });
      const line = (r.stdout || '').trim().split('\n').filter((l) => l.startsWith('{') || l.startsWith('ERR')).pop() || '';
      let out = null;
      try { out = JSON.parse(line); } catch {}
      check(out, `ran (${(r.stdout || '').slice(-1500)}${(r.stderr || '').slice(-1500)})`);
      if (!out) return;
      check(out.practice && out.practice.ok === true, `startup self-check passed (${JSON.stringify(out.practice)})`);
      check(out.same.length === 4 && out.same.every((x) => x.hand && x.equal && x.kindMatch && x.guard), `same signed bytes as the SDK route, token programs, slot guard, learned limits (${JSON.stringify(out.same)})`);
      check(out.same[2].learned && out.same[3].learned, 'learned compute limits applied the same way');
      check(out.verifies && out.exactSolIn && out.sigMatches, `buyToken sent a valid hand-built buy (${JSON.stringify({ v: out.verifies, e: out.exactSolIn, s: out.sigMatches })})`);
      check(via === 'sender' ? /sender/.test(out.url) : /127\.0\.0\.1:1\/api\/v1\/transactions/.test(out.url), `sent the ${via} way (${out.url})`);
      check(out.afterChange === null && /layout changed/.test(out.disabled || ''), `a changed layout switches it off (${JSON.stringify(out.afterChange)}, ${out.disabled})`);
      check(out.fallback, 'then buys use the SDK route');
    });
  }

  {
    const bin = process.env.__FASTPATH_BIN;
    const have = bin && fs.existsSync(bin);
    await test(`FAST_PATH=rust: the Rust fast path checks out byte for byte, then buys from the shred feed itself${have ? '' : ' (SKIPPED: fastpath not built)'}`, async () => {
      if (!have) return;
      const script = `
        const http = require('http');
        const fs = require('fs');
        const path = require('path');
        const os = require('os');
        const crypto = require('crypto');
        const { spawn } = require('child_process');
        const { WebSocketServer } = require('ws');
        const BN = require('bn.js');
        const { PublicKey, Keypair, VersionedTransaction, TransactionMessage, TransactionInstruction } = require('@solana/web3.js');
        const { TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync } = require('@solana/spl-token');
        const bs58 = require('bs58').default || require('bs58');
        const sdk = require('@pump-fun/pump-sdk');
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const waitFor = async (fn, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = fn(); if (v) return v; await sleep(25); } return null; };
        const feeRecipient = Keypair.generate().publicKey, reserved = Keypair.generate().publicKey;
        const pumpGlobal = {
          initialVirtualTokenReserves: new BN('1073000000000000'), initialVirtualSolReserves: new BN('30000000000'),
          initialRealTokenReserves: new BN('793100000000000'), tokenTotalSupply: new BN('1000000000000000'),
          feeBasisPoints: new BN(95), creatorFeeBasisPoints: new BN(30), creatorFeeConfigurable: false, mayhemModeEnabled: false,
          feeRecipient, feeRecipients: [], reservedFeeRecipient: reserved, reservedFeeRecipients: [reserved]
        };
        const tier = { marketCapLamportsThreshold: new BN(0), fees: { lpFeeBps: new BN(0), protocolFeeBps: new BN(95), creatorFeeBps: new BN(30) } };
        sdk.OnlinePumpSdk.prototype.fetchFeeConfig = async () => ({ feeTiers: [tier], stableFeeTiers: [], flatFees: tier.fees, exoticFlatFees: tier.fees });
        (async () => {
          const out = {};
          // Stand-ins: the Helius preprocessed feed, Helius Sender, the RPC.
          const wss = new WebSocketServer({ port: 0 });
          await new Promise((r) => wss.on('listening', r));
          let feedSock = null;
          wss.on('connection', (sock) => sock.on('message', () => { feedSock = sock; sock.send(JSON.stringify({ jsonrpc: '2.0', id: 1, result: 5 })); }));
          const sent = [];
          const srv = http.createServer((req, res) => {
            let body = ''; req.on('data', (c) => (body += c));
            req.on('end', () => {
              if (req.url.startsWith('/ping')) { res.end('ok'); return; }
              let j = {}; try { j = JSON.parse(body); } catch {}
              if (j.method === 'sendTransaction') {
                const raw = Buffer.from(j.params[0], 'base64');
                sent.push({ url: req.url, raw, at: Date.now() });
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ jsonrpc: '2.0', id: j.id, result: bs58.encode(VersionedTransaction.deserialize(raw).signatures[0]) }));
                return;
              }
              res.end(JSON.stringify({ jsonrpc: '2.0', id: j.id, result: null }));
            });
          });
          await new Promise((r) => srv.listen(0, '127.0.0.1', r));
          const httpPort = srv.address().port;
          const linkPort = 20000 + Math.floor(Math.random() * 20000);
          const env = { ...process.env, FAST_PATH: 'rust', FAST_PATH_PORT: String(linkPort), SHRED_SOURCE: 'helius-preprocessed', SHRED_STREAM_URL: 'ws://127.0.0.1:' + wss.address().port,
            SEND_VIA: 'sender', SENDER_ENDPOINT: 'http://127.0.0.1:' + httpPort + '/fast', SOLANA_RPC: 'http://127.0.0.1:' + httpPort };
          Object.assign(process.env, env);
          const envFile = path.join(os.tmpdir(), 'fastpath-test-' + process.pid + '.env');
          fs.writeFileSync(envFile, Object.entries(env).filter(([k]) => /^[A-Z_]+$/.test(k)).map(([k, v]) => k + '=' + JSON.stringify(String(v))).join('\\n'));
          const rust = spawn(${JSON.stringify(bin)}, [], { env: { ...env, FASTPATH_ENV: envFile }, stdio: ['ignore', 'pipe', 'pipe'] });
          let rustLog = '';
          rust.stdout.on('data', (d) => (rustLog += d));
          rust.stderr.on('data', (d) => (rustLog += d));
          try {
            const prewarm = require('./src/prewarm');
            const d = require('./src/pumpfunDirect');
            const config = require('./src/config');
            const { FastPath } = require('./src/fastPath');
            prewarm._setForTests({ blockhash: 'GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi', pumpGlobal });
            await d.warmFeeConfig({});
            const copyWallet = new PublicKey(config.COPY_WALLET);
            let buying = true;
            const state = () => ({
              buying, rehearse: !buying, fastBuy: true, onlyFirstBuy: false,
              wallets: { [copyWallet.toBase58()]: { allowed: true, holdingsLoaded: true, held: [], exited: [] } },
              positions: [], sizing: { mode: 'fixed', fixed: 0.05 }, minTradeSol: 0.003, minCopyBuySol: null, maxBuySol: 11, roomSol: 15,
              spendableSol: 5, cooldownMs: 0, lastBuyAt: 0, openSlots: null, maxMcapSol: 300, minMcapSet: false, blockedVaults: [], quoteMints: [], quotePrefixes: [],
              maxSlotsBehind: 1, guardAvailable: true, farSlots: [], fees: { buyFeeSol: 0.0015, buyFeePct: 0, useSender: true, senderTip: config.SENDER_TIP, jitoTip: config.JITO_TIP, ceiling: config.PUMPFUN_COMPUTE_UNITS },
              computeLimits: {}
            });
            let fp = new FastPath({ port: linkPort, stateProvider: state });
            const txs = [];
            const claims = [];
            fp.on('tx', (m) => txs.push(m));
            fp.on('claim', (m) => { claims.push(m.his); out.claimAmount = m.amountSol; });
            fp.start();
            out.linked = !!(await waitFor(() => fp.hello, 10000));
            out.verified = !!(await waitFor(() => fp.verified, 8000));
            out.feedUp = !!(await waitFor(() => feedSock && fp.isUp(), 8000));
            // His buy: buy_exact_sol_in, with the curve's accounts in it.
            const vault = sdk.creatorVaultPda(Keypair.generate().publicKey);
            const meta = (pubkey, w = false) => ({ pubkey, isSigner: false, isWritable: w });
            const data = Buffer.alloc(25); Buffer.from('38fc74089edfcd5f', 'hex').copy(data); data.writeBigUInt64LE(400000000n, 8); data.writeBigUInt64LE(1n, 16);
            const buyIx = (mint) => {
              const curve = sdk.bondingCurvePda(mint);
              const keys = Array.from({ length: 18 }, () => meta(Keypair.generate().publicKey));
              keys[1] = meta(feeRecipient, true); keys[2] = meta(mint); keys[3] = meta(curve, true);
              keys[4] = meta(getAssociatedTokenAddressSync(mint, curve, true, TOKEN_2022_PROGRAM_ID), true);
              keys[6] = { pubkey: copyWallet, isSigner: true, isWritable: true }; keys[8] = meta(TOKEN_2022_PROGRAM_ID); keys[9] = meta(vault, true);
              keys[16] = meta(sdk.bondingCurveV2Pda(mint));
              return new TransactionInstruction({ programId: new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'), keys, data });
            };
            const mint1 = Keypair.generate().publicKey;
            const ix = buyIx(mint1);
            const frame = (ixs, slot) => {
              const vt = new VersionedTransaction(new TransactionMessage({ payerKey: copyWallet, recentBlockhash: '11111111111111111111111111111111', instructions: ixs }).compileToLegacyMessage());
              vt.signatures[0] = crypto.randomBytes(64);
              return { buf: Buffer.concat([Buffer.from([1]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(slot)); return b; })(), Buffer.from(vt.signatures[0]), Buffer.from(vt.serialize())]), sig: bs58.encode(vt.signatures[0]) };
            };
            const f1 = frame([ix], 5000);
            feedSock.send(f1.buf);
            const m1 = await waitFor(() => txs.find((t) => t.signature === f1.sig));
            out.status = m1 && m1.outcome.status;
            out.reason = m1 && m1.outcome.reason;
            const s1 = await waitFor(() => sent[0]);
            if (s1) {
              const tx = VersionedTransaction.deserialize(s1.raw);
              const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), new PublicKey(config.PUBLIC_KEY).toBuffer()]);
              out.verifies = crypto.verify(null, Buffer.from(tx.message.serialize()), crypto.createPublicKey({ key: spki, format: 'der', type: 'spki' }), Buffer.from(tx.signatures[0]));
              const k = tx.message.staticAccountKeys.map(String);
              const buy = tx.message.compiledInstructions.find((c) => k[c.programIdIndex] === '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
              out.spend = buy && Buffer.from(buy.data).readBigUInt64LE(8).toString();
              out.vaultOk = buy && k[buy.accountKeyIndexes[9]] === vault.toBase58();
              out.guarded = tx.message.compiledInstructions.some((c) => k[c.programIdIndex] === 'L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95' && Buffer.from(c.data).readBigUInt64LE(3) === 5001n);
              out.sigMatches = m1 && m1.outcome.signature === bs58.encode(tx.signatures[0]);
              out.toSender = s1.url.startsWith('/fast');
              out.readyMs = m1 && m1.marks && m1.marks.signed;
            }
            // The same transaction again (repeat): not bought twice.
            feedSock.send(f1.buf);
            await sleep(300);
            out.sentOnce = sent.length === 1;
            // His second buy of the same coin while ours is still in flight (not yet taken over): left to this bot.
            const f1b = frame([buyIx(mint1)], 5002);
            feedSock.send(f1b.buf);
            const m1b = await waitFor(() => txs.find((t) => t.signature === f1b.sig));
            out.secondSameCoin = m1b && m1b.outcome.status + ': ' + m1b.outcome.reason;
            out.claimed = claims.includes(f1.sig);
            // The link drops before this bot acknowledged the buy: resent on reconnect.
            fp.stop();
            await sleep(200);
            const fp2 = new FastPath({ port: linkPort, stateProvider: state });
            const txs2 = [];
            fp2.on('tx', (m) => txs2.push(m));
            fp2.start();
            const again = await waitFor(() => txs2.find((t) => t.signature === f1.sig && t.resent));
            out.resent = Boolean(again && again.outcome.status === 'bought' && again.outcome.signature === m1.outcome.signature);
            out.feedsInHello = Boolean(await waitFor(() => fp2.hello && fp2.isUp(), 3000));
            fp2.ack(m1.outcome.signature);
            fp2.saved(m1.outcome.signature);
            await sleep(200);
            fp2.stop();
            await sleep(100);
            const fp3 = new FastPath({ port: linkPort, stateProvider: state });
            const txs3 = [];
            fp3.on('tx', (m) => txs3.push(m));
            fp3.start();
            await waitFor(() => fp3.hello, 3000);
            await sleep(300);
            out.notResentAfterAck = !txs3.some((t) => t.resent);
            fp3.stop();
            // Paused with rehearsals: built and signed, not sent.
            fp = new FastPath({ port: linkPort, stateProvider: state });
            fp.on('tx', (m) => txs.push(m));
            fp.start();
            await waitFor(() => fp.hello && fp.verified, 8000);
            buying = false; fp.pushState(); await sleep(100);
            const f2 = frame([buyIx(Keypair.generate().publicKey)], 5100);
            feedSock.send(f2.buf);
            const m2 = await waitFor(() => txs.find((t) => t.signature === f2.sig));
            out.rehearsed = m2 && m2.outcome.status;
            out.rehearsedWhy = m2 && m2.outcome.reason;
            await sleep(200);
            out.notSentWhilePaused = sent.length === 1;
            // Something it can't buy (a transfer): handed to the Node bot as "none".
            buying = true; fp.pushState();
            const f3 = frame([require('@solana/web3.js').SystemProgram.transfer({ fromPubkey: copyWallet, toPubkey: Keypair.generate().publicKey, lamports: 1000 })], 5200);
            feedSock.send(f3.buf);
            const m3 = await waitFor(() => txs.find((t) => t.signature === f3.sig));
            out.transfer = m3 && m3.outcome.status;
            fp.stop();
          } catch (e) {
            out.err = e.stack;
          } finally {
            rust.kill();
            wss.close(); srv.close();
            try { fs.unlinkSync(envFile); } catch {}
          }
          out.rustLog = rustLog.slice(-1500);
          console.log(JSON.stringify(out));
          process.exit(0);
        })();
      `;
      const env = { ...process.env, SHRED_FAST_BUY: 'true', MAX_MARKET_CAP_SOL: '300', BUY_PRIORITY_FEE_SOL: '0.0015', PUMPFUN_COMPUTE_UNITS: '130000', SENDER_TIP: '0.0016', MAX_SLOTS_BEHIND: '1' };
      const r = spawnSync(process.execPath, ['-e', script], { cwd: root, env, encoding: 'utf8', timeout: 60000 });
      const line = (r.stdout || '').trim().split('\n').filter((l) => l.startsWith('{')).pop() || '';
      let out = null;
      try { out = JSON.parse(line); } catch {}
      check(out, `ran (${(r.stdout || '').slice(-1500)}${(r.stderr || '').slice(-1500)})`);
      if (!out) return;
      const ctx = ` [${out.err || ''} | rust: ${out.rustLog}]`;
      check(out.linked && out.verified && out.feedUp, `linked, checked identical, feed up (${out.linked}, ${out.verified}, ${out.feedUp})${ctx}`);
      check(out.status === 'bought', `bought it (${out.status}: ${out.reason})${ctx}`);
      check(out.verifies && out.sigMatches && out.toSender, 'signed by the wallet, sent to Sender, reported with its signature');
      check(out.spend === '50000000' && out.vaultOk && out.guarded, `0.05 SOL buy_exact_sol_in, his creator vault, slot guard at his slot + 1 (${out.spend}, ${out.vaultOk}, ${out.guarded})`);
      check(out.sentOnce, 'a repeated transaction is not bought twice');
      check(/declined: our own buy of this coin is still in flight/.test(out.secondSameCoin || ''), `a second buy of the same coin waits for the first (${out.secondSameCoin})`);
      check(out.claimed, 'claimed his transaction before sending');
      check(out.resent && out.feedsInHello, `an unacknowledged buy is resent after a reconnect, feed states come with the hello (${out.resent}, ${out.feedsInHello})`);
      check(out.notResentAfterAck, 'not resent once the position is saved');
      check(out.claimAmount === 0.05, `the claim carries the amount, so this bot counts it at once (${out.claimAmount})`);
      check(out.rehearsed === 'rehearsed' && out.notSentWhilePaused, `paused: rehearsed, nothing sent (${out.rehearsed}: ${out.rehearsedWhy})`);
      check(out.transfer === 'none', `a transfer is left to the Node bot (${out.transfer})`);
      check(typeof out.readyMs === 'number' && out.readyMs < 50, `ready to send within milliseconds of his trade arriving (${out.readyMs} ms)`);
    });
  }

  await test('SHRED_FAST_BUY: buy_exact_sol_in built from the shred transaction alone, max market cap enforced on-chain', async () => {
    const script = `
      const BN = require('bn.js');
      const { PublicKey, Keypair } = require('@solana/web3.js');
      const { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } = require('@solana/spl-token');
      const sdk = require('@pump-fun/pump-sdk');
      const feeRecipient = Keypair.generate().publicKey, reserved = Keypair.generate().publicKey;
      const pumpGlobal = {
        initialVirtualTokenReserves: new BN('1073000000000000'), initialVirtualSolReserves: new BN('30000000000'),
        initialRealTokenReserves: new BN('793100000000000'), tokenTotalSupply: new BN('1000000000000000'),
        feeBasisPoints: new BN(95), creatorFeeBasisPoints: new BN(30), creatorFeeConfigurable: false, mayhemModeEnabled: false,
        feeRecipient, feeRecipients: [feeRecipient], reservedFeeRecipient: reserved, reservedFeeRecipients: [reserved]
      };
      const tier = { marketCapLamportsThreshold: new BN(0), fees: { lpFeeBps: new BN(0), protocolFeeBps: new BN(95), creatorFeeBps: new BN(30) } };
      sdk.OnlinePumpSdk.prototype.fetchFeeConfig = async () => ({ feeTiers: [tier], stableFeeTiers: [], flatFees: tier.fees, exoticFlatFees: tier.fees });
      sdk.OnlinePumpSdk.prototype.fetchGlobal = async () => pumpGlobal;
      sdk.PUMP_SDK.decodeBondingCurve = () => ({ virtualTokenReserves: new BN('500000000000000'), virtualQuoteReserves: new BN('64000000000'), realTokenReserves: new BN('220000000000000'),
        realQuoteReserves: new BN('34000000000'), tokenTotalSupply: pumpGlobal.tokenTotalSupply, complete: false, creator: Keypair.generate().publicKey, isMayhemMode: false, isCashbackCoin: false, quoteMint: PublicKey.default, creatorFeeBps: new BN(0) });
      const calls = [];
      const connection = {
        getMultipleAccountsInfo: async (keys) => { calls.push('multi:' + keys.length); return keys.map((k, i) => {
          if (i === 0) return { data: Buffer.alloc(8) };
          if (i === 1) { const data = Buffer.alloc(82); data.writeBigUInt64LE(10n ** 15n, 36); data.writeUInt8(6, 44); return { owner: TOKEN_PROGRAM_ID, data }; }
          return null; }); },
        getLatestBlockhash: async () => { calls.push('blockhash'); return { blockhash: '11111111111111111111111111111111' }; },
      };
      const d = require(${JSON.stringify(src('pumpfunDirect.js'))});
      const prewarm = require(${JSON.stringify(src('prewarm.js'))});
      const user = Keypair.generate().publicKey;
      const creator = Keypair.generate().publicKey;
      const vault = sdk.creatorVaultPda(creator).toBase58();
      const hintFor = (mint, prog = TOKEN_2022_PROGRAM_ID, recipient = feeRecipient, extra = {}) => ({ mint: mint.toBase58(), creatorVault: vault,
        txKeys: [getAssociatedTokenAddressSync(mint, sdk.bondingCurvePda(mint), true, prog).toBase58(), recipient.toBase58(), Keypair.generate().publicKey.toBase58()], ...extra });
      const build = (mint, hint, extra = {}) => d.buildPumpfunBuyTx({ connection, user, mint: mint.toBase58(), solAmount: 0.5, slippagePct: 40, fastHint: hint, maxMcapSol: 200, minMcapSol: null, ...extra });
      (async () => {
        prewarm._setForTests({ blockhash: '11111111111111111111111111111111', pumpGlobal });
        await d.warmFeeConfig(connection);
        const out = {};
        const m1 = Keypair.generate().publicKey;
        calls.length = 0;
        const tx = await build(m1, hintFor(m1));
        out.calls = [...calls];
        out.builtFrom = tx.builtFrom;
        out.coin = tx.coin;
        const keys = tx.message.staticAccountKeys.map((k) => k.toBase58());
        const ixs = tx.message.compiledInstructions.map((ci) => ({ program: keys[ci.programIdIndex], accounts: ci.accountKeyIndexes.map((i) => keys[i]), data: Buffer.from(ci.data) }));
        const buy = ixs.find((i) => i.program === '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
        const ata = ixs.find((i) => i.program === ASSOCIATED_TOKEN_PROGRAM_ID.toBase58());
        out.disc = buy.data.subarray(0, 8).toString('hex');
        out.spend = buy.data.readBigUInt64LE(8).toString();
        out.minOut = buy.data.readBigUInt64LE(16).toString();
        out.vaultOk = buy.accounts[9] === vault;
        out.recipientOk = buy.accounts[1] === feeRecipient.toBase58();
        out.t22 = buy.accounts[8] === TOKEN_2022_PROGRAM_ID.toBase58() && ata && ata.accounts.includes(TOKEN_2022_PROGRAM_ID.toBase58());
        // The minimum = what the curve gives at exactly 200 SOL market cap (real SDK maths).
        const tokensAt = (mcapSol) => {
          const k = 30000000000n * 1073000000000000n;
          let vS = BigInt(Math.floor(Math.sqrt(mcapSol * 1e9 * Number(k) / 1e15)));
          const curve = { virtualTokenReserves: new BN((k / vS).toString()), virtualQuoteReserves: new BN(vS.toString()), realTokenReserves: new BN('793100000000000'),
            creator, isMayhemMode: false, quoteMint: PublicKey.default, creatorFeeBps: new BN(0) };
          return BigInt(sdk.getBuyTokenAmountFromSolAmount({ global: pumpGlobal, feeConfig: { feeTiers: [tier] }, mintSupply: pumpGlobal.tokenTotalSupply, bondingCurve: curve, amount: new BN(500000000), quoteMint: PublicKey.default }).toString());
        };
        out.at190 = tokensAt(190) >= BigInt(out.minOut);
        out.at200 = Number(tokensAt(200)) / Number(out.minOut);
        out.at215 = tokensAt(215) < BigInt(out.minOut);
        // Fallbacks to the normal build (one lookup).
        const fb = [];
        const m2 = Keypair.generate().publicKey;
        for (const [hint, extra] of [
          [hintFor(m2, TOKEN_2022_PROGRAM_ID, feeRecipient, { creatorVault: null }), {}],
          [hintFor(m2, TOKEN_2022_PROGRAM_ID, reserved), {}],
          [hintFor(m2, TOKEN_2022_PROGRAM_ID, Keypair.generate().publicKey), {}],
          [hintFor(m2), { minMcapSol: 30 }]
        ]) {
          calls.length = 0;
          const t = await build(m2, hint, extra);
          fb.push({ calls: [...calls], fast: /no lookup/.test(t.builtFrom || '') });
        }
        out.fb = fb;
        // A blocked creator is recognised by its vault.
        const m3 = Keypair.generate().publicKey;
        const tb = await build(m3, hintFor(m3, TOKEN_PROGRAM_ID), { blockedCreators: new Set([creator.toBase58()]) });
        out.blocked = tb.coin && tb.coin.creatorBlocked;
        // The slot guard (MAX_SLOTS_BEHIND) rides on a no-lookup buy too.
        const m4 = Keypair.generate().publicKey;
        const guard = require('./src/slotGuard').maxSlotInstruction(123456789);
        const tg = await build(m4, hintFor(m4, TOKEN_PROGRAM_ID), { guardInstructions: [guard] });
        const gKeys = tg.message.staticAccountKeys.map((k) => k.toBase58());
        const gIx = typeof tg.guardIxIndex === 'number' && tg.message.compiledInstructions[tg.guardIxIndex];
        out.guarded = /no lookup/.test(tg.builtFrom || '') && !!gIx && gKeys[gIx.programIdIndex] === guard.programId.toBase58() && Buffer.from(gIx.data).equals(guard.data);
        console.log(JSON.stringify(out));
      })().catch((e) => { console.log('ERR ' + e.stack); });
    `;
    const r = spawnSync(process.execPath, ['-e', script], { cwd: root, encoding: 'utf8' });
    const line = (r.stdout || '').trim().split('\n').pop();
    let out = null;
    try { out = JSON.parse(line); } catch {}
    check(out, `builder ran (${r.stdout}${r.stderr})`);
    if (out) {
      check(out.calls.length === 0 && /no lookup/.test(out.builtFrom), `no network calls (${JSON.stringify(out.calls)}; ${out.builtFrom})`);
      check(out.disc === '38fc74089edfcd5f' && out.spend === '500000000', `buy_exact_sol_in spending exactly 0.5 SOL (${out.disc}, ${out.spend})`);
      check(out.vaultOk && out.recipientOk && out.t22, 'creator vault from his transaction, a normal fee recipient, Token-2022 from the curve account');
      check(out.at190 && out.at215 && out.at200 >= 1 && out.at200 < 1.02, `minimum = tokens at a 200 SOL market cap: fills at 190, fails at 215 (${out.at200})`);
      check(out.coin && out.coin.capOnChain === true, 'marked: market cap enforced on-chain');
      check(out.fb.every((f) => !f.fast && f.calls.length === 1 && f.calls[0].startsWith('multi:')), `no vault / mayhem / unknown recipient / MIN_MARKET_CAP_SOL: normal build (${JSON.stringify(out.fb)})`);
      check(out.blocked === true, 'blocked creator recognised by its vault');
      check(out.guarded === true, 'slot guard included in a no-lookup buy');
    }
  });

  await test('QUOTE_TOKENS: a coin paired to the PUMP token is bought from the reserve (buy_exact_quote_in_v2) and sold with sell_v2', async () => {
    const script = `
      const BN = require('bn.js');
      const { PublicKey, Keypair, ComputeBudgetProgram } = require('@solana/web3.js');
      const { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } = require('@solana/spl-token');
      const sdk = require('@pump-fun/pump-sdk');
      const PUMP = new PublicKey('pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn');
      const feeRecipient = Keypair.generate().publicKey, reserved = Keypair.generate().publicKey;
      const pumpGlobal = { initialVirtualTokenReserves: new BN('1073000000000000'), initialVirtualSolReserves: new BN('30000000000'), initialVirtualQuoteReserves: new BN('30000000000'),
        initialRealTokenReserves: new BN('793100000000000'), tokenTotalSupply: new BN('1000000000000000'), feeBasisPoints: new BN(95), creatorFeeBasisPoints: new BN(30),
        creatorFeeConfigurable: false, mayhemModeEnabled: false, feeRecipient, feeRecipients: [feeRecipient], reservedFeeRecipient: reserved, reservedFeeRecipients: [reserved], whitelistedQuoteMints: [] };
      const tier = { marketCapLamportsThreshold: new BN(0), fees: { lpFeeBps: new BN(0), protocolFeeBps: new BN(95), creatorFeeBps: new BN(30) } };
      const exotic = { lpFeeBps: new BN(0), protocolFeeBps: new BN(100), creatorFeeBps: new BN(50) };
      const feeConfig = { feeTiers: [tier], stableFeeTiers: [], flatFees: tier.fees, exoticFlatFees: exotic };
      sdk.OnlinePumpSdk.prototype.fetchGlobal = async () => pumpGlobal;
      sdk.OnlinePumpSdk.prototype.fetchFeeConfig = async () => feeConfig;
      const creator = Keypair.generate().publicKey;
      let curveQuote = PUMP;
      const curve = () => ({ virtualTokenReserves: new BN('357666666666667'), virtualQuoteReserves: new BN('90000000000000'), realTokenReserves: new BN('77766666666667'), realQuoteReserves: new BN('60000000000000'),
        tokenTotalSupply: pumpGlobal.tokenTotalSupply, complete: false, creator, isMayhemMode: false, isCashbackCoin: false, quoteMint: curveQuote, creatorFeeBps: new BN(0) });
      sdk.PUMP_SDK.decodeBondingCurve = () => curve();
      const calls = [];
      const connection = {
        getMultipleAccountsInfo: async (keys) => { calls.push('multi'); return keys.map((k, i) => { if (i === 0) return { data: Buffer.alloc(8) }; if (i === 1) { const d = Buffer.alloc(82); d.writeBigUInt64LE(10n ** 15n, 36); d.writeUInt8(6, 44); return { owner: TOKEN_PROGRAM_ID, data: d }; } return null; }); },
        getAccountInfo: async () => { calls.push('info'); return { owner: TOKEN_PROGRAM_ID, data: Buffer.alloc(82) }; },
        getLatestBlockhash: async () => ({ blockhash: '11111111111111111111111111111111' })
      };
      const prewarm = require(${JSON.stringify(src('prewarm.js'))});
      const q = require(${JSON.stringify(src('quoteTokens.js'))});
      const d = require(${JSON.stringify(src('pumpfunDirect.js'))});
      const { maxSlotInstruction } = require(${JSON.stringify(src('slotGuard.js'))});
      const user = Keypair.generate().publicKey;
      const ixsOf = (tx) => { const keys = tx.message.staticAccountKeys.map((k) => k.toBase58()); return tx.message.compiledInstructions.map((ci) => ({ program: keys[ci.programIdIndex], accounts: ci.accountKeyIndexes.map((i) => keys[i]), data: Buffer.from(ci.data) })); };
      (async () => {
        prewarm._setForTests({ blockhash: '11111111111111111111111111111111', pumpGlobal });
        await d.warmFeeConfig(connection);
        const out = {};
        const LPR = 0.00005; // lamports per raw PUMP unit
        q._setForTests(PUMP.toBase58(), { lamportsPerRaw: LPR, balanceRaw: 10n ** 14n });
        const m = Keypair.generate().publicKey;
        const tx = await d.buildPumpfunBuyTx({ connection, user, mint: m.toBase58(), solAmount: 0.5, slippagePct: 40, tipSol: 0.001, computeUnitLimit: 100000, priorityFeeMicroLamports: 200000, guardInstructions: [maxSlotInstruction(123)] });
        out.size = tx.serialize().length;
        const ixs = ixsOf(tx);
        const buy = ixs.find((i) => i.program === '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
        out.disc = buy.data.subarray(0, 8).toString('hex');
        out.spend = buy.data.readBigUInt64LE(8).toString();
        out.minOut = buy.data.readBigUInt64LE(16).toString();
        const tokens = sdk.getBuyTokenAmountFromSolAmount({ global: pumpGlobal, feeConfig, mintSupply: pumpGlobal.tokenTotalSupply, bondingCurve: curve(), amount: new BN(out.spend), quoteMint: PUMP });
        out.expectedMin = tokens.muln(6000).divn(10000).toString();
        out.nKeys = buy.accounts.length;
        out.quoteMintKey = buy.accounts[2] === PUMP.toBase58();
        out.userQuoteAta = buy.accounts[15] === getAssociatedTokenAddressSync(PUMP, user, true, TOKEN_PROGRAM_ID).toBase58();
        out.curve = buy.accounts[10] === sdk.bondingCurvePda(m).toBase58();
        const cb = ixs.filter((i) => i.program === ComputeBudgetProgram.programId.toBase58());
        out.units = cb.find((i) => i.data[0] === 2).data.readUInt32LE(1);
        out.price = Number(cb.find((i) => i.data[0] === 3).data.readBigUInt64LE(1));
        out.guard = typeof tx.guardIxIndex === 'number';
        out.quoteTrade = tx.quoteTrade && tx.quoteTrade.label === 'PUMP' && tx.quoteTrade.spendRaw.toString() === out.spend;
        out.free = q.available(PUMP.toBase58()).toString();
        out.mcap = tx.coin && tx.coin.mcapSol;
        q.release(PUMP.toBase58(), BigInt(out.spend));
        // Reserve too small, price unknown, token not listed: not built.
        const fail = async (setup) => { setup(); try { await d.buildPumpfunBuyTx({ connection, user, mint: Keypair.generate().publicKey.toBase58(), solAmount: 0.5, slippagePct: 40 }); return 'built'; } catch (e) { return e.message; } };
        out.small = await fail(() => q._setForTests(PUMP.toBase58(), { lamportsPerRaw: LPR, balanceRaw: 10n ** 9n }));
        out.noPrice = await fail(() => q._setForTests(PUMP.toBase58(), { lamportsPerRaw: null, balanceRaw: 10n ** 14n }));
        out.unlisted = await fail(() => q._setForTests(PUMP.toBase58(), null));
        // Sell: sell_v2, paid out in PUMP (works whether or not PUMP is listed).
        q._setForTests(PUMP.toBase58(), { lamportsPerRaw: LPR, balanceRaw: 10n ** 14n });
        const stx = await d.buildPumpfunSellTx({ connection, user, mint: m.toBase58(), tokenAmountUi: '1000', slippagePct: 40, computeUnitLimit: 100000, priorityFeeMicroLamports: 200000 });
        const sx = ixsOf(stx);
        const sell = sx.find((i) => i.program === '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
        out.sellDisc = sell.data.subarray(0, 8).toString('hex');
        out.sellQuoteAta = sx.some((i) => i.program === 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL' && i.accounts.includes(getAssociatedTokenAddressSync(PUMP, user, true, TOKEN_PROGRAM_ID).toBase58()));
        out.sellTrade = stx.quoteTrade && stx.quoteTrade.lamportsPerRaw === LPR;
        console.log(JSON.stringify(out));
      })().catch((e) => console.log('ERR ' + e.stack));
    `;
    const r = spawnSync(process.execPath, ['-e', script], { cwd: root, encoding: 'utf8', env: { ...process.env, QUOTE_TOKENS: 'pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn' } });
    // Background warnings (the balance refresh can't reach an RPC here) may print after the result.
    const line = (r.stdout || '').trim().split('\n').reverse().find((l) => l.startsWith('{')) || '';
    let out = null;
    try { out = JSON.parse(line); } catch {}
    check(out, `builder ran (${r.stdout}${r.stderr})`);
    if (out) {
      check(out.disc === 'c2ab1c46684d5b2f' && out.nKeys === 27, `buy_exact_quote_in_v2 with the 27 accounts of buy_v2 (${out.disc}, ${out.nKeys})`);
      check(out.spend === String(Math.floor(0.5e9 / 0.00005)), `spends 0.5 SOL worth of PUMP at its price (${out.spend})`);
      check(out.minOut === out.expectedMin, `minimum tokens = the curve's amount less 40% slippage (${out.minOut} vs ${out.expectedMin})`);
      check(out.quoteMintKey && out.userQuoteAta && out.curve, 'PUMP as quote mint, paid from our PUMP account, on the coin\'s curve');
      check(out.units === 200000 && Math.abs(out.price * out.units - 200000 * 100000) <= out.units, `budget QUOTE_COMPUTE_UNITS, same total priority fee (${out.units} x ${out.price})`);
      check(out.guard && out.size <= 1232, `slot guard included, fits in one transaction (${out.size} bytes)`);
      check(out.quoteTrade && out.free === String(10n ** 14n - BigInt(out.spend)), `what it spends is set aside until sent (${out.free} free)`);
      check(out.mcap > 0, `market cap valued in SOL for the filters (${out.mcap})`);
      check(/reserve has .* needed for 0.5 SOL/.test(out.small), `reserve too small: not built (${out.small})`);
      check(/price isn't known/.test(out.noPrice), `no price: not built (${out.noPrice})`);
      check(/add pumpCmXq.* to QUOTE_TOKENS/.test(out.unlisted), `not listed: explained (${out.unlisted})`);
      check(out.sellDisc === '5df6823ce7e940b2' && out.sellQuoteAta && out.sellTrade, `sell_v2 into our PUMP account, valued at its price (${out.sellDisc})`);
    }
  });

  await test('SHRED_FAST_BUY never builds a SOL buy when his transaction involves a quote token', async () => {
    const q = require(src('quoteTokens.js'));
    check(q.mentionsQuoteMint(['abc', 'pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn']) === 'pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn', 'PUMP recognised');
    const other = Keypair.generate().publicKey.toBase58();
    check(q.mentionsQuoteMint([other]) === null || q.mentionsQuoteMint([other]).startsWith('Xs'), 'an ordinary account is not');
    q.noteQuoteMint(other);
    check(q.mentionsQuoteMint([other]) === other, 'a quote token seen once (by a lookup) is recognised from then on');
  });

  await test('direct Pump.fun buy is priced on the coin\'s real curve (no 6002 "too much SOL" after the price has risen)', async () => {
    // Real SDK maths; only the network reads are stubbed. The curve is at ~9x
    // its launch price, like a coin someone just bought 3 SOL of.
    const script = `
      const BN = require('bn.js');
      const { PublicKey, Keypair, TransactionInstruction } = require('@solana/web3.js');
      const { TOKEN_PROGRAM_ID, NATIVE_MINT } = require('@solana/spl-token');
      const sdk = require('@pump-fun/pump-sdk');
      const pumpGlobal = {
        initialVirtualTokenReserves: new BN('1073000000000000'), initialVirtualSolReserves: new BN('30000000000'),
        initialRealTokenReserves: new BN('793100000000000'), tokenTotalSupply: new BN('1000000000000000'),
        feeBasisPoints: new BN(95), creatorFeeBasisPoints: new BN(30), creatorFeeConfigurable: false, mayhemModeEnabled: false
      };
      const vT = new BN('357666666666667'), vS = new BN('90000000000'); // same k as launch, price x9
      const curve = { virtualTokenReserves: vT, virtualQuoteReserves: vS, realTokenReserves: new BN('793100000000000').sub(new BN('1073000000000000').sub(vT)),
        realQuoteReserves: new BN('60000000000'), tokenTotalSupply: pumpGlobal.tokenTotalSupply, complete: false,
        creator: Keypair.generate().publicKey, isMayhemMode: false, isCashbackCoin: false, quoteMint: PublicKey.default, creatorFeeBps: new BN(0) };
      sdk.OnlinePumpSdk.prototype.fetchGlobal = async () => pumpGlobal;
      sdk.OnlinePumpSdk.prototype.fetchFeeConfig = async () => { throw new Error('offline'); };
      sdk.PUMP_SDK.decodeBondingCurve = () => curve;
      let seen = null;
      sdk.PUMP_SDK.buyInstructions = async (a) => { seen = a; return [new TransactionInstruction({ programId: PublicKey.default, keys: [], data: Buffer.alloc(0) })]; };
      const connection = {
        getMultipleAccountsInfo: async (keys) => keys.map((k, i) => {
          if (i === 0) return { data: Buffer.alloc(8) };
          if (i === 1) { const data = Buffer.alloc(82); data.writeBigUInt64LE(10n ** 15n, 36); data.writeUInt8(6, 44); return { owner: TOKEN_PROGRAM_ID, data }; }
          return null;
        }),
        getLatestBlockhash: async () => ({ blockhash: '11111111111111111111111111111111' }),
      };
      const d = require(${JSON.stringify(src('pumpfunDirect.js'))});
      (async () => {
        const lamports = new BN(300000); // 0.0003 SOL
        const tx = await d.buildPumpfunBuyTx({ connection, user: Keypair.generate().publicKey, mint: Keypair.generate().publicKey.toBase58(), solAmount: 0.0003, slippagePct: 1 });
        // What the program will charge for the tokens we asked for, on the real curve:
        const cost = sdk.getBuySolAmountFromTokenAmount({ global: pumpGlobal, feeConfig: null, mintSupply: pumpGlobal.tokenTotalSupply, bondingCurve: curve, amount: seen.amount });
        const maxAt = (pct) => lamports.add(lamports.muln(Math.floor(pct * 10)).divn(1000));
        // The old quote (launch-price curve) for comparison:
        const oldAmount = sdk.getBuyTokenAmountFromSolAmount({ global: pumpGlobal, feeConfig: null, mintSupply: null, bondingCurve: curve, amount: lamports, quoteMint: NATIVE_MINT });
        const oldCost = sdk.getBuySolAmountFromTokenAmount({ global: pumpGlobal, feeConfig: null, mintSupply: pumpGlobal.tokenTotalSupply, bondingCurve: curve, amount: oldAmount });
        const paidPerToken = Number(cost.toString()) / 1e9 / (Number(seen.amount.toString()) / 1e6);
        console.log(JSON.stringify({ cost: cost.toString(), max1: maxAt(1).toString(), oldCost: oldCost.toString(), max99: maxAt(99).toString(), solAmount: seen.solAmount.toString(),
          quotePrice: tx.quote && tx.quote.priceSol, paidPerToken }));
      })().catch((e) => { console.log('ERR ' + e.stack); });
    `;
    const r = spawnSync(process.execPath, ['-e', script], { cwd: root, encoding: 'utf8' });
    const line = (r.stdout || '').trim().split('\n').pop();
    let out = null;
    try { out = JSON.parse(line); } catch {}
    check(out, `builder ran (${r.stdout}${r.stderr})`);
    if (out) {
      check(BigInt(out.oldCost) > BigInt(out.max99), `old launch-price quote would fail even at 99% (${out.oldCost} > ${out.max99})`);
      check(BigInt(out.cost) <= BigInt(out.max1), `new quote fits inside even 1% slippage (${out.cost} <= ${out.max1})`);
      check(BigInt(out.cost) * 100n >= BigInt(out.solAmount) * 98n, `and still spends ~all the SOL (${out.cost} of ${out.solAmount})`);
      // The quote attached for MAX_ENTRY_PREMIUM_PCT: price per token before
      // Pump.fun's ~1.25% fee, the basis the copy wallet's price is read on.
      const ratio = out.quotePrice / out.paidPerToken;
      check(ratio > 0.98 && ratio < 1, `quote is the fee-free price per token (${out.quotePrice} vs ${out.paidPerToken} incl. fees)`);
    }
  });

  // ---------------- shred stream ----------------
  const shredFx = (() => {
    const crypto = require('crypto');
    const EventEmitter = require('events');
    const { TransactionInstruction, AddressLookupTableAccount } = require('@solana/web3.js');
    const { bondingCurvePda } = require('@pump-fun/pump-sdk');
    const { canonicalPumpPoolPda } = require('@pump-fun/pump-swap-sdk');
    const PUMP = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
    const PUMP_AMM = new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');
    const WSOL = new PublicKey('So11111111111111111111111111111111111111112');
    const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
    const rnd = () => Keypair.generate().publicKey;
    const meta = (pubkey, isSigner = false, isWritable = true) => ({ pubkey, isSigner, isWritable });
    const copyWallet = new PublicKey(process.env.COPY_WALLET);
    function pumpIx(disc, mint, a, b, user = copyWallet) {
      const keys = Array.from({ length: 16 }, () => meta(rnd(), false, false));
      keys[2] = meta(mint, false, false);
      keys[3] = meta(bondingCurvePda(mint));
      keys[6] = meta(user, true, true);
      keys[11] = meta(PUMP, false, false);
      return new TransactionInstruction({ programId: PUMP, keys, data: Buffer.concat([Buffer.from(disc, 'hex'), u64(a), u64(b), Buffer.from([0])]) });
    }
    function ammIx(disc, mint, a, b, quote = WSOL) {
      const keys = Array.from({ length: 23 }, () => meta(rnd(), false, false));
      keys[0] = meta(canonicalPumpPoolPda(mint));
      keys[1] = meta(copyWallet, true, true);
      keys[3] = meta(mint, false, false);
      keys[4] = meta(quote, false, false);
      return new TransactionInstruction({ programId: PUMP_AMM, keys, data: Buffer.concat([Buffer.from(disc, 'hex'), u64(a), u64(b), Buffer.from([0])]) });
    }
    function routerIx(program, disc, mint, lamports) {
      const keys = [meta(copyWallet, true, true), meta(PUMP, false, false), meta(mint, false, false), meta(bondingCurvePda(mint)), meta(rnd()), meta(rnd())];
      return new TransactionInstruction({ programId: program, keys, data: Buffer.concat([Buffer.from(disc, 'hex'), Buffer.from([1]), u64(lamports), u64(987654321), u64(7)]) });
    }
    function txBytes(instructions, { payer = copyWallet, luts = null } = {}) {
      const msg = new TransactionMessage({ payerKey: payer, recentBlockhash: '11111111111111111111111111111111', instructions });
      const tx = new VersionedTransaction(luts ? msg.compileToV0Message(luts) : msg.compileToLegacyMessage());
      tx.signatures[0] = crypto.randomBytes(64);
      return { bytes: Buffer.from(tx.serialize()), signature: require('bs58').default ? require('bs58').default.encode(tx.signatures[0]) : require('bs58').encode(tx.signatures[0]) };
    }
    // A v1 (SIMD-0385) transaction, laid out as Anza's solana-message crate
    // writes it: message first (with a compute-limit and priority-fee config),
    // signatures last.
    function txBytesV1(instructions, { payer = copyWallet } = {}) {
      const m = new TransactionMessage({ payerKey: payer, recentBlockhash: '11111111111111111111111111111111', instructions }).compileToLegacyMessage();
      const keys = m.accountKeys;
      const ixs = m.instructions;
      const parts = [Buffer.from([0x81, m.header.numRequiredSignatures, m.header.numReadonlySignedAccounts, m.header.numReadonlyUnsignedAccounts])];
      const mask = Buffer.alloc(4); mask.writeUInt32LE(0b111); parts.push(mask); // priority fee + compute unit limit
      parts.push(crypto.randomBytes(32), Buffer.from([ixs.length, keys.length]));
      for (const k of keys) parts.push(k.toBuffer());
      parts.push(u64(12345)); const cu = Buffer.alloc(4); cu.writeUInt32LE(200000); parts.push(cu);
      const decode = (d) => (require('bs58').default || require('bs58')).decode(d);
      const datas = ixs.map((ix) => Buffer.from(decode(ix.data)));
      ixs.forEach((ix, i) => { const h = Buffer.alloc(4); h[0] = ix.programIdIndex; h[1] = ix.accounts.length; h.writeUInt16LE(datas[i].length, 2); parts.push(h); });
      ixs.forEach((ix, i) => { parts.push(Buffer.from(ix.accounts), datas[i]); });
      const sigs = Array.from({ length: m.header.numRequiredSignatures }, () => crypto.randomBytes(64));
      parts.push(...sigs);
      return { bytes: Buffer.concat(parts), signature: (require('bs58').default || require('bs58')).encode(sigs[0]) };
    }
    function entries(...groups) {
      return Buffer.concat([u64(groups.length), ...groups.map((txs) => Buffer.concat([u64(1), crypto.randomBytes(32), u64(txs.length), ...txs.map((t) => t.bytes)]))]);
    }
    function fakeEmitter() {
      const em = new EventEmitter();
      em.seenSignatures = new Set();
      em._markSeen = (s) => { if (em.seenSignatures.has(s)) return true; em.seenSignatures.add(s); return false; };
      em.events = [];
      em.failed = [];
      em.on('copyTrade', (e) => em.events.push(e));
      em.on('copyBuyFailed', (e) => em.failed.push(e));
      return em;
    }
    return { u64, rnd, meta, copyWallet, pumpIx, ammIx, routerIx, txBytes, txBytesV1, entries, fakeEmitter, PUMP, AddressLookupTableAccount, bondingCurvePda };
  })();
  const DISC = { buy: '66063d1201daebea', sell: '33e685a4017f83ad', buyExactSolIn: '38fc74089edfcd5f', buyExactQuoteIn: 'c62e1552b4d9e870' };

  await test('shreds: entries parsed, only the copy wallet\'s own transactions picked out (legacy and v0 with lookup tables)', async () => {
    const { signedTransactions, resolveKeys, parseTransaction } = require(src('shredTx.js'));
    const f = shredFx;
    const mint = f.rnd();
    const mine = f.txBytes([f.pumpIx(DISC.buyExactSolIn, mint, 500_000_000, 123)]);
    // v0 with a lookup table holding the mint and bonding curve
    const lutKey = f.rnd();
    const lut = new f.AddressLookupTableAccount({ key: lutKey, state: { deactivationSlot: BigInt('18446744073709551615'), lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, addresses: [f.rnd(), mint, f.bondingCurvePda(mint), f.rnd()] } });
    const mineV0 = f.txBytes([f.pumpIx(DISC.buyExactSolIn, mint, 250_000_000, 9)], { luts: [lut] });
    // Someone else's transaction that merely mentions the copy wallet
    const other = f.txBytes([f.pumpIx(DISC.buy, mint, 1, 2, f.rnd())], { payer: f.rnd() });
    const otherMentions = f.txBytes([f.pumpIx(DISC.buy, mint, 1, 2, f.rnd())].map((ix) => { ix.keys.push(f.meta(f.copyWallet, false, false)); return ix; }), { payer: f.rnd() });
    const buf = f.entries([other, mine], [otherMentions, mineV0]);
    const txs = signedTransactions(buf, f.copyWallet.toBuffer());
    check(txs.length === 2, `two of four transactions are the copy wallet's (got ${txs.length})`);
    check(txs[0].signature === mine.signature && txs[1].signature === mineV0.signature, 'signatures read');
    check(txs[0].version === 'legacy' && txs[1].version === 0, 'versions read');
    check(resolveKeys(txs[1], new Map()) === null, 'lookup table needed before keys are known');
    const tables = new Map([[lutKey.toBase58(), lut.state.addresses.map((a) => a.toBase58())]]);
    const keys = resolveKeys(txs[1], tables);
    check(keys && keys.includes(mint.toBase58()) && keys.includes(f.bondingCurvePda(mint).toBase58()), 'keys resolved through the lookup table');
    check(signedTransactions(f.entries([other]), f.copyWallet.toBuffer()).length === 0, 'messages without the wallet are skipped');
    // a parse of a truncated transaction fails cleanly
    let threw = false;
    try { parseTransaction(mine.bytes.subarray(0, 100), 0); } catch (e) { threw = /truncated/.test(e.message); }
    check(threw, 'truncated data reported, not misread');
    // speed: 3,000 unrelated transactions
    const many = f.entries(Array.from({ length: 3000 }, () => other));
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < 20; i++) signedTransactions(many, f.copyWallet.toBuffer());
    const ms = Number(process.hrtime.bigint() - t0) / 1e6 / 20;
    check(ms < 20, `skipping a 3,000-transaction message is fast (${ms.toFixed(2)} ms)`);
  });

  await test('shreds: v1 transactions (SIMD-0385, message first, signatures last) are read too', async () => {
    const { parseTransaction, signedTransactions, resolveKeys } = require(src('shredTx.js'));
    const { classify } = require(src('shredDecode.js'));
    const f = shredFx;
    const mint = f.rnd();
    const v1 = f.txBytesV1([f.pumpIx(DISC.buyExactSolIn, mint, 450_000_000, 5)]);
    const { tx, end } = parseTransaction(v1.bytes, 0);
    check(tx.version === 1 && end === v1.bytes.length && tx.signature === v1.signature, `v1 parsed to the end, signature from the tail (v${tx.version}, ${end}/${v1.bytes.length})`);
    const keys = resolveKeys(tx, new Map());
    const { intents } = classify(tx, keys, f.copyWallet.toBase58());
    check(intents.length === 1 && intents[0].side === 'buy' && intents[0].mint === mint.toBase58() && intents[0].solLamports === 450_000_000n, `buy decoded (${JSON.stringify(intents, (k, v) => (typeof v === 'bigint' ? v.toString() : v))})`);
    // Mixed with legacy in one entries message (Jito format).
    const legacy = f.txBytes([f.pumpIx(DISC.buyExactSolIn, f.rnd(), 1_000_000, 1)]);
    const got = signedTransactions(f.entries([legacy, v1]), f.copyWallet.toBuffer());
    check(got.length === 2 && got[1].version === 1, `legacy then v1 in one message (${got.map((t) => t.version).join(',')})`);
    let bad = null;
    const broken = Buffer.from(v1.bytes); broken.writeUInt32LE(0b100000, 4);
    try { parseTransaction(broken, 0); } catch (e) { bad = e; }
    check(bad && /unknown config bits/.test(bad.message), 'unknown v1 config bits rejected, not misread');
  });

  await test('shreds: Pump.fun and PumpSwap buys/sells decoded from the instruction; other users and non-SOL pools ignored', async () => {
    const { signedTransactions, resolveKeys } = require(src('shredTx.js'));
    const { classify } = require(src('shredDecode.js'));
    const f = shredFx;
    const W = f.copyWallet.toBase58();
    const one = (ix) => {
      const t = signedTransactions(f.entries([f.txBytes([ix])]), f.copyWallet.toBuffer())[0];
      return classify(t, resolveKeys(t, new Map()), W).intents;
    };
    const m = f.rnd();
    let r = one(f.pumpIx(DISC.buyExactSolIn, m, 500_000_000, 1000));
    check(r.length === 1 && r[0].side === 'buy' && r[0].mint === m.toBase58() && r[0].solLamports === 500_000_000n && !r[0].approx && r[0].pool === 'pump-curve', `buy_exact_sol_in (${JSON.stringify(r, (k, v) => typeof v === 'bigint' ? String(v) : v)})`);
    r = one(f.pumpIx(DISC.buy, m, 1000, 700_000_000));
    check(r[0].side === 'buy' && r[0].solLamports === 700_000_000n && r[0].approx && r[0].tokenRaw === 1000n, 'buy: max SOL cost, marked approximate');
    r = one(f.pumpIx(DISC.sell, m, 5000, 1));
    check(r[0].side === 'sell' && r[0].tokenRaw === 5000n, 'sell');
    r = one(f.pumpIx(DISC.buyExactSolIn, m, 1, 1, f.rnd()));
    check(r.length === 0, 'Pump.fun buy for another user ignored');
    r = one(f.ammIx(DISC.buyExactQuoteIn, m, 300_000_000, 5));
    check(r[0].side === 'buy' && r[0].pool === 'pumpswap' && r[0].solLamports === 300_000_000n, 'PumpSwap buy_exact_quote_in');
    r = one(f.ammIx(DISC.sell, m, 777, 1));
    check(r[0].side === 'sell' && r[0].pool === 'pumpswap', 'PumpSwap sell');
    r = one(f.ammIx(DISC.buy, m, 1, 1, f.rnd()));
    check(r.length === 0, 'PumpSwap pool not paired with SOL ignored');
  });

  await test('shreds: a router is learned from two confirmed buys, then its buys are read (first buys only)', async () => {
    const { signedTransactions, resolveKeys } = require(src('shredTx.js'));
    const { classify, RouterLearner } = require(src('shredDecode.js'));
    const f = shredFx;
    const W = f.copyWallet.toBase58();
    const file = path.join(root, 'data', `routers-${Date.now()}.json`);
    const learner = new RouterLearner(file);
    const router = f.rnd();
    const disc = 'aabbccddeeff0011';
    const tag = disc.slice(0, 2); // routers are keyed by their first data byte
    const run = (lamports, mint, held = false) => {
      const t = signedTransactions(f.entries([f.txBytes([f.routerIx(router, disc, mint, lamports)])]), f.copyWallet.toBuffer())[0];
      return classify(t, resolveKeys(t, new Map()), W, { learner, isHeld: () => held });
    };
    const m1 = f.rnd();
    let r = run(3_000_000_000, m1);
    check(r.intents.length === 0 && r.routerIxs.length === 1 && r.routerIxs[0].mint === m1.toBase58() && r.routerIxs[0].pool === 'pump-curve', 'unknown router: coin found, nothing copied yet');
    // confirmed feed: 3 SOL in, 2.9333 reached Pump.fun
    check(learner.observe(r.routerIxs[0], 'buy', 2.933333333) === null, 'one confirmed buy is not enough');
    const m2 = f.rnd();
    r = run(2_000_000_000, m2);
    check(learner.observe(r.routerIxs[0], 'buy', 1.955555555) === 'buy', 'learned after two');
    const m3 = f.rnd();
    r = run(5_000_000_000, m3);
    const sol = r.intents[0] && Number(r.intents[0].solLamports) / 1e9;
    check(r.intents.length === 1 && r.intents[0].side === 'buy' && r.intents[0].mint === m3.toBase58() && Math.abs(sol - 4.8889) < 0.01, `learned buy read (${sol} SOL)`);
    r = run(5_000_000_000, m3, true);
    check(r.intents.length === 0, 'not copied when the copy wallet already holds the coin');
    r = run(5_000_000_000, m3, null);
    check(r.intents.length === 0, 'not copied while its holdings are unknown');
    // persisted
    const again = new RouterLearner(file);
    check(again.status(router.toBase58(), tag) === 'buy', 'learning survives a restart');
    // a sell-only instruction
    const sdisc = '1122334455667788';
    learner.observe({ program: router.toBase58(), disc: sdisc, data: Buffer.alloc(16) }, 'sell', 0);
    check(learner.status(router.toBase58(), sdisc) === null, 'one sell not enough');
    learner.observe({ program: router.toBase58(), disc: sdisc, data: Buffer.alloc(16) }, 'sell', 0);
    check(learner.status(router.toBase58(), sdisc) === 'sell', 'sell instruction learned');
    // the same instruction for buys and sells: buys only for coins not held
    learner.observe({ program: router.toBase58(), disc: tag, data: Buffer.alloc(40) }, 'sell', 0);
    check(learner.status(router.toBase58(), tag) === 'mixed', 'mixed when it is also used to sell');
    fs.rmSync(file, { force: true });

    // A router with a 1-byte instruction tag and the amount right after it (no
    // 8-byte discriminator), like the one the streamer uses: its first 8 bytes
    // differ from trade to trade, but it is still learned.
    const tagRouter = f.rnd();
    const learner2 = new RouterLearner(null);
    const tagged = (lamports, mint, vault = f.rnd()) => {
      const data = Buffer.concat([Buffer.from([0x07]), f.u64(lamports), require('crypto').randomBytes(12)]);
      const keys = [f.meta(f.copyWallet, true, true), f.meta(f.PUMP, false, false), f.meta(mint, false, false), f.meta(f.bondingCurvePda(mint)), f.meta(vault), f.meta(f.rnd())];
      const ix = new (require('@solana/web3.js').TransactionInstruction)({ programId: tagRouter, keys, data });
      const t = signedTransactions(f.entries([f.txBytes([ix])]), f.copyWallet.toBuffer())[0];
      return classify(t, resolveKeys(t, new Map()), W, { learner: learner2, isHeld: () => false });
    };
    let q = tagged(3_000_000_000, f.rnd());
    learner2.observe(q.routerIxs[0], 'buy', 2.933333333);
    q = tagged(250_000_000, f.rnd());
    check(learner2.observe(q.routerIxs[0], 'buy', 0.244444444) === 'buy', '1-byte-tag router learned after two buys of different sizes');
    q = tagged(25_000_000, f.rnd());
    const s3 = q.intents[0] && Number(q.intents[0].solLamports) / 1e9;
    check(q.intents.length === 1 && Math.abs(s3 - 0.02444) < 0.0005, `and its next buy read from the shreds (${s3} SOL)`);
    // An odd buy (another variant of the instruction, amount elsewhere) doesn't
    // undo what was learned.
    const oddData = Buffer.concat([Buffer.from([0x07]), f.u64(1), require('crypto').randomBytes(20)]);
    learner2.observe({ program: tagRouter.toBase58(), disc: '07', data: oddData }, 'buy', 1.5);
    check(learner2.status(tagRouter.toBase58(), '07') === 'buy', 'one odd buy does not wipe the router out');
    // Where it keeps the coin's creator vault (for SHRED_FAST_BUY): learned
    // from his confirmed buys, then carried on the buys read from the shreds.
    check(q.intents[0].creatorVault === null, 'creator vault unknown before it is learned');
    const v1 = f.rnd(), v2 = f.rnd(), v3 = f.rnd();
    const keysOf = (r) => r.routerIxs[0].accountKeys;
    let vq = tagged(25_000_000, f.rnd(), v1);
    learner2.observeVault(tagRouter.toBase58(), '07', keysOf(vq), v1.toBase58());
    check(learner2.vaultIndex(tagRouter.toBase58(), '07') === null, 'one buy is not enough to learn the creator vault');
    vq = tagged(25_000_000, f.rnd(), v2);
    learner2.observeVault(tagRouter.toBase58(), '07', keysOf(vq), v2.toBase58());
    check(learner2.vaultIndex(tagRouter.toBase58(), '07') === 4, `creator vault position learned after two buys (${learner2.vaultIndex(tagRouter.toBase58(), '07')})`);
    vq = tagged(25_000_000, f.rnd(), v3);
    check(vq.intents[0] && vq.intents[0].creatorVault === v3.toBase58(), 'the next buy carries its creator vault');
    // A file from the old version whose offsets were wiped out is relearned.
    const oldFile = path.join(root, 'data', `routers-old-${Date.now()}.json`);
    fs.mkdirSync(path.dirname(oldFile), { recursive: true });
    fs.writeFileSync(oldFile, JSON.stringify({ routers: { [`${tagRouter.toBase58()}:07`]: { buys: 6, sells: 2, offsets: [], ratios: [] } } }));
    const learner3 = new RouterLearner(oldFile);
    const obs = (lamports, solAbs) => learner3.observe({ program: tagRouter.toBase58(), disc: '07', data: Buffer.concat([Buffer.from([0x07]), f.u64(lamports), Buffer.alloc(8)]) }, 'buy', solAbs);
    obs(3_000_000_000, 2.933333333);
    check(obs(250_000_000, 0.244444444) === 'buy', 'a router the old version had wiped out is learned again, its stale counts cleared');
    fs.rmSync(oldFile, { force: true });

    // One instruction for buys AND sells: two sells seen before any buy must
    // not make its buys look like sells (that would trigger early exits).
    const both = f.rnd().toBase58();
    const learner4 = new RouterLearner(null);
    learner4.observe({ program: both, disc: '09', data: Buffer.alloc(24) }, 'sell', 0);
    check(learner4.observe({ program: both, disc: '09', data: Buffer.alloc(24) }, 'sell', 0) === null, 'two sells alone: not taken for a sell-only instruction');
    // Buys of another variant (amount not in the data) don't block learning.
    const mk = (lamports) => ({ program: both, disc: '09', data: Buffer.concat([Buffer.from([9]), f.u64(lamports), Buffer.alloc(8)]) });
    const variant = { program: both, disc: '09', data: Buffer.concat([Buffer.from([9]), f.u64(123456789012), Buffer.alloc(8)]) };
    learner4.observe(variant, 'buy', 0.035);
    learner4.observe(variant, 'buy', 0.26);
    learner4.observe(variant, 'buy', 0.025);
    learner4.observe(mk(3_000_000_000), 'buy', 2.933333333);
    check(learner4.observe(mk(250_000_000), 'buy', 0.244444444) === 'mixed', 'learned from the 2 buys that contain the amount, despite 3 that do not');
    // Sell-only IS recognised once the program's buys use another instruction.
    learner4.observe({ program: both, disc: '0a', data: Buffer.alloc(24) }, 'sell', 0);
    check(learner4.observe({ program: both, disc: '0a', data: Buffer.alloc(24) }, 'sell', 0) === 'sell', 'separate sell instruction recognised');
  });

  await test('shreds: feed emits early buys once, dedupes with the websocket feed, flags failed originals, learns routers', async () => {
    const config = require(src('config.js'));
    const { ShredFeed, parseTarget } = require(src('shredFeed.js'));
    const f = shredFx;
    const em = f.fakeEmitter();
    const file = path.join(root, 'data', `routers-feed-${Date.now()}.json`);
    const failSig = { value: null };
    const feed = new ShredFeed({
      emitter: em,
      isHeld: () => false,
      routersFile: file,
      verifyDelaysMs: [30],
      checkStatus: async (sig) => (sig === failSig.value ? { err: { InstructionError: [2, { Custom: 6002 }] } } : { err: null, confirmationStatus: 'confirmed' })
    });
    const m = f.rnd();
    const buy = f.txBytes([f.pumpIx(DISC.buyExactSolIn, m, 400_000_000, 1)]);
    failSig.value = buy.signature;
    feed._onMessage({ slot: '777', entries: f.entries([buy]) });
    await sleep(80);
    const e = em.events[0];
    check(em.events.length === 1 && e.trade === 'buy' && e.shred && e.ca === m.toBase58() && e.solAmount === -0.4 && e.slot === 777 && e.dexs[0] === 'Pump.fun' && e.copyPriceSol === null, `early buy event (${JSON.stringify(e)})`);
    check(em.seenSignatures.has(buy.signature), 'marked seen so the websocket feed ignores it');
    const mk = e.marks || {};
    check(['t0', 'parsed', 'keys', 'classified', 'emit'].every((k) => typeof mk[k] === 'number') && mk.t0 <= mk.parsed && mk.parsed <= mk.keys && mk.keys <= mk.classified && mk.classified <= mk.emit && mk.tablesFetched === false, `step timings carried with the buy (${JSON.stringify(mk)})`);
    feed._onMessage({ slot: '777', entries: f.entries([buy]) });
    await sleep(20);
    check(em.events.length === 1, 'not emitted twice');
    check(em.failed.length === 1 && em.failed[0].signature === buy.signature && em.failed[0].mint === m.toBase58(), 'failed original reported');

    const seenFirst = f.txBytes([f.pumpIx(DISC.buyExactSolIn, f.rnd(), 400_000_000, 1)]);
    em.seenSignatures.add(seenFirst.signature);
    feed._onMessage({ slot: '778', entries: f.entries([seenFirst]) });
    await sleep(20);
    check(em.events.length === 1, 'nothing when the websocket feed saw it first');

    const dust = f.txBytes([f.pumpIx(DISC.buyExactSolIn, f.rnd(), 1000, 1)]);
    feed._onMessage({ slot: '779', entries: f.entries([dust]) });
    await sleep(20);
    check(em.events.length === 1, 'dust below MIN_TRADE_SOL ignored');

    // Sells: early exit only where the % sold doesn't matter.
    const sell = f.txBytes([f.pumpIx(DISC.sell, m, 100, 1)]);
    feed._onMessage({ slot: '780', entries: f.entries([sell]) });
    await sleep(20);
    check(em.events.length === 1, `no early exit in ${config.TRADE_TYPE} mode`);
    const saved = { t: config.TRADE_TYPE, f: config.FULL_EXIT_ON_COPY_SELL };
    config.TRADE_TYPE = 'STIERED';
    config.FULL_EXIT_ON_COPY_SELL = true;
    const sell2 = f.txBytes([f.pumpIx(DISC.sell, m, 100, 1)]);
    feed._onMessage({ slot: '781', entries: f.entries([sell2]) });
    await sleep(20);
    const x = em.events[1];
    check(x && x.trade === 'sell' && x.shredEarlyExit && x.sellPercent === 100, 'early exit with FULL_EXIT_ON_COPY_SELL');
    check(!em.seenSignatures.has(sell2.signature), 'sell left for the websocket feed to record');
    Object.assign(config, { TRADE_TYPE: saved.t, FULL_EXIT_ON_COPY_SELL: saved.f });

    // Router learned through the feed from confirmed (websocket) events.
    const router = f.rnd();
    const disc = '0102030405060708';
    for (const [lam, conf] of [[3_000_000_000, 2.9333], [1_500_000_000, 1.4667]]) {
      const mint = f.rnd();
      const t = f.txBytes([f.routerIx(router, disc, mint, lam)]);
      feed._onMessage({ slot: '790', entries: f.entries([t]) });
      await sleep(20);
      feed.learn({ signature: t.signature, trade: 'buy', ca: mint.toBase58(), solAmount: -conf });
    }
    const before = em.events.length;
    const rmint = f.rnd();
    const rt = f.txBytes([f.routerIx(router, disc, rmint, 2_000_000_000)]);
    feed._onMessage({ slot: '791', entries: f.entries([rt]) });
    await sleep(50);
    const re = em.events[before];
    check(re && re.trade === 'buy' && re.ca === rmint.toBase58() && Math.abs(re.solAmount + 1.9555) < 0.01, `router buy copied after learning (${JSON.stringify(re)})`);

    check(JSON.stringify(parseTarget('https://shreds.example.com:443')) === JSON.stringify({ target: 'shreds.example.com:443', secure: true }), 'https target');
    check(JSON.stringify(parseTarget('http://127.0.0.1:9999')) === JSON.stringify({ target: '127.0.0.1:9999', secure: false }), 'plain target');
    check(parseTarget('host.example:443').secure === true && parseTarget('host.example:9999').secure === false, 'scheme-less targets');
    let bad = false;
    try { parseTarget('not a url'); } catch { bad = true; }
    check(bad, 'bad address rejected');
    feed.stop();
    fs.rmSync(file, { force: true });
  });

  await test('shreds: connects over gRPC (ShredstreamProxy/SubscribeEntries), sends the token, reconnects after the server drops', async () => {
    const grpc = require('@grpc/grpc-js');
    const protoLoader = require('@grpc/proto-loader');
    const config = require(src('config.js'));
    const { ShredFeed } = require(src('shredFeed.js'));
    const f = shredFx;
    const def = protoLoader.loadSync(src('proto/shredstream.proto'), { keepCase: true, longs: String, defaults: true });
    const pkg = grpc.loadPackageDefinition(def).shredstream;
    const tokens = [];
    let calls = 0;
    const mints = [f.rnd(), f.rnd()];
    const server = new grpc.Server();
    server.addService(pkg.ShredstreamProxy.service, {
      SubscribeEntries(call) {
        calls += 1;
        tokens.push(call.metadata.get('x-token')[0]);
        const n = calls;
        const tx = f.txBytes([f.pumpIx(DISC.buyExactSolIn, mints[n - 1] || f.rnd(), 600_000_000, 1)]);
        call.write({ slot: String(5000 + n), entries: f.entries([tx]) });
        // first connection: the server drops it; the feed must come back
        if (n === 1) setTimeout(() => call.end(), 50);
      }
    });
    const port = await new Promise((res, rej) => server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (e, p) => (e ? rej(e) : res(p))));
    const saved = { url: config.SHRED_STREAM_URL, token: config.SHRED_STREAM_TOKEN };
    config.SHRED_STREAM_URL = `http://127.0.0.1:${port}`;
    config.SHRED_STREAM_TOKEN = 'secret-token';
    const em = f.fakeEmitter();
    const feed = new ShredFeed({ emitter: em, isHeld: () => false, routersFile: null, checkStatus: async () => ({ err: null, confirmationStatus: 'confirmed' }) });
    feed.start();
    const t0 = Date.now();
    while (em.events.length < 2 && Date.now() - t0 < 6000) await sleep(50);
    feed.stop();
    server.forceShutdown();
    Object.assign(config, { SHRED_STREAM_URL: saved.url, SHRED_STREAM_TOKEN: saved.token });
    check(tokens[0] === 'secret-token', `token sent as x-token (${tokens[0]})`);
    check(em.events.length === 2 && em.events[0].ca === mints[0].toBase58() && em.events[1].ca === mints[1].toBase58(), `buys from both connections (${em.events.length})`);
    check(em.events[0].slot === 5001 && em.events[1].slot === 5002, 'slot read');
    check(calls === 2, `reconnected after the stream ended (${calls} connections)`);
  });

  await test('shreds (helius-preprocessed): subscribes for the copy wallet, reads binary frames, stops if refused', async () => {
    const { WebSocketServer } = require('ws');
    const config = require(src('config.js'));
    const { ShredFeed, heliusPreprocessedUrl } = require(src('shredFeed.js'));
    const f = shredFx;
    const frame = (t, slot) => {
      const sig = require('bs58').default ? require('bs58').default.decode(t.signature) : require('bs58').decode(t.signature);
      return Buffer.concat([Buffer.from([0]), f.u64(slot), Buffer.from(sig), t.bytes]);
    };
    const wss = new WebSocketServer({ port: 0 });
    await new Promise((r) => wss.on('listening', r));
    const port = wss.address().port;
    const subs = [];
    let refuse = false;
    const mintMine = f.rnd();
    const mine = f.txBytes([f.pumpIx(DISC.buyExactSolIn, mintMine, 700_000_000, 1)]);
    const mintV1 = f.rnd();
    const mineV1 = f.txBytesV1([f.pumpIx(DISC.buyExactSolIn, mintV1, 300_000_000, 1)]);
    // someone else's transaction that mentions the copy wallet (matched by accountInclude)
    const theirs = f.txBytes([f.pumpIx(DISC.buy, f.rnd(), 1, 2, f.rnd())].map((ix) => { ix.keys.push(f.meta(f.copyWallet, false, false)); return ix; }), { payer: f.rnd() });
    wss.on('connection', (sock) => {
      sock.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        subs.push(msg);
        if (refuse) {
          sock.send(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'preprocessedSubscribe requires a paid plan' } }));
          return;
        }
        sock.send(JSON.stringify({ jsonrpc: '2.0', id: 1, result: 7 }));
        sock.send(frame(theirs, 4100));
        sock.send(frame(mine, 4101));
        sock.send(Buffer.concat([Buffer.from([1]), f.u64(4102), Buffer.alloc(64), mineV1.bytes])); // v1, schema version 1
        sock.send(Buffer.from([0, 1, 2])); // junk
      });
    });
    const saved = { s: config.SHRED_SOURCE, u: config.SHRED_STREAM_URL, t: config.SHRED_STREAM_TOKEN, r: config.SOLANA_RPC };
    config.SHRED_SOURCE = 'helius-preprocessed';
    config.SHRED_STREAM_URL = `ws://127.0.0.1:${port}`;
    const em = f.fakeEmitter();
    const feed = new ShredFeed({ emitter: em, routersFile: null, checkStatus: async () => ({ err: null, confirmationStatus: 'confirmed' }) });
    feed.start();
    const t0 = Date.now();
    while (em.events.length < 2 && Date.now() - t0 < 4000) await sleep(30);
    await sleep(100);
    check(subs[0] && subs[0].method === 'preprocessedSubscribe' && JSON.stringify(subs[0].params.accountInclude) === JSON.stringify([f.copyWallet.toBase58()])
      && subs[0].params.accountRequired.length === 0, `subscribed for the copy wallet (${JSON.stringify(subs[0])})`);
    check(em.events.length === 2 && em.events[0].ca === mintMine.toBase58() && em.events[0].solAmount === -0.7 && em.events[0].slot === 4101 && em.events[0].shred, `only its own buys copied (${JSON.stringify(em.events)})`);
    check(em.events[1] && em.events[1].ca === mintV1.toBase58() && em.events[1].slot === 4102 && em.events[1].signature === mineV1.signature, `its v1 buy copied too (${JSON.stringify(em.events[1])})`);
    check(feed.stats.messages === 4 && feed.stats.parseErrors === 1, `frames counted (${JSON.stringify(feed.stats)})`);
    feed.stop();

    // Credit safety: a flood of messages stops the feed.
    {
      const savedMax = config.SHRED_MAX_MSGS_PER_MIN;
      config.SHRED_MAX_MSGS_PER_MIN = 10;
      const em3 = f.fakeEmitter();
      const feed3 = new ShredFeed({ emitter: em3, routersFile: null });
      let stoppedWhy = null;
      feed3.on('stopped', (why) => { stoppedWhy = why; });
      const other = frame(theirs, 4200);
      for (let i = 0; i < 10; i++) feed3._onHeliusFrame(other);
      check(!feed3.stopped, 'up to the limit: still running');
      for (let i = 0; i < 5; i++) feed3._onHeliusFrame(other);
      check(feed3.stopped && /11 messages in \d+s, over SHRED_MAX_MSGS_PER_MIN=10/.test(stoppedWhy || ''), `over the limit within the minute: stopped (${stoppedWhy})`);
      config.SHRED_MAX_MSGS_PER_MIN = savedMax;
      // The breakdown says what is arriving and what could be excluded.
      const feed4 = new ShredFeed({ emitter: f.fakeEmitter(), routersFile: null });
      const spamProgram = f.rnd();
      for (let i = 0; i < 4; i++) {
        const ix = new (require('@solana/web3.js').TransactionInstruction)({ programId: spamProgram, keys: [f.meta(f.copyWallet, false, false)], data: Buffer.from([i]) });
        feed4._onHeliusFrame(frame(f.txBytes([ix], { payer: f.rnd() }), 4300));
      }
      feed4._onHeliusFrame(frame(theirs, 4301));
      feed4._onHeliusFrame(frame(theirs, 4301)); // a duplicate
      feed4._onHeliusFrame(frame(mine, 4302));
      await new Promise((r) => setImmediate(r)); // its own transaction is tallied after being handed on
      const bd = feed4._describeBreakdown();
      check(/1 from the copy wallet, 6 from others, 1 duplicate/.test(bd) && bd.includes(`${spamProgram.toBase58()} (in 67%)`),
        `breakdown names the spam program as an exclude candidate (${bd})`);
      check(!bd.includes(f.PUMP.toBase58()), 'never suggests excluding Pump.fun');
      feed4.stop();
    }

    // Refused (e.g. free plan): the feed stops instead of retrying.
    refuse = true;
    const em2 = f.fakeEmitter();
    const feed2 = new ShredFeed({ emitter: em2, routersFile: null });
    feed2.start();
    await sleep(1500);
    check(feed2.stopped && subs.length === 2, `stopped after the refusal, no retries (${subs.length} subscriptions)`);
    feed2.stop();
    wss.close();

    // URL: from SOLANA_RPC's Helius key, or the token.
    config.SHRED_STREAM_URL = '';
    config.SHRED_STREAM_TOKEN = '';
    config.SOLANA_RPC = 'https://mainnet.helius-rpc.com/?api-key=abc123';
    check(heliusPreprocessedUrl() === 'wss://beta.helius-rpc.com/?api-key=abc123', `key from SOLANA_RPC (${heliusPreprocessedUrl()})`);
    config.SHRED_STREAM_TOKEN = 'tok9';
    check(heliusPreprocessedUrl() === 'wss://beta.helius-rpc.com/?api-key=tok9', 'key from SHRED_STREAM_TOKEN');
    Object.assign(config, { SHRED_SOURCE: saved.s, SHRED_STREAM_URL: saved.u, SHRED_STREAM_TOKEN: saved.t, SOLANA_RPC: saved.r });
  });

  await test('shreds: several copy wallets: each one\'s buys are copied and tagged with it', async () => {
    const config = require(src('config.js'));
    const { ShredFeed } = require(src('shredFeed.js'));
    const { signedTransactions } = require(src('shredTx.js'));
    const f = shredFx;
    const saved = config.COPY_WALLETS;
    const w2 = Keypair.generate().publicKey;
    config.COPY_WALLETS = [f.copyWallet.toBase58(), w2.toBase58()];
    try {
      const em = f.fakeEmitter();
      const heldAsked = [];
      const feed = new ShredFeed({ emitter: em, routersFile: null, verifyDelaysMs: [], isHeld: (mint, wallet) => { heldAsked.push(wallet); return false; } });
      const m1 = f.rnd();
      const m2 = f.rnd();
      const t1 = f.txBytes([f.pumpIx(DISC.buyExactSolIn, m1, 300_000_000, 1)]);
      const t2 = f.txBytes([f.pumpIx(DISC.buyExactSolIn, m2, 200_000_000, 1, w2)], { payer: w2 });
      const stranger = f.rnd();
      const t3 = f.txBytes([f.pumpIx(DISC.buyExactSolIn, f.rnd(), 200_000_000, 1, stranger)], { payer: stranger });
      const picked = signedTransactions(f.entries([t1, t2, t3]), feed.walletBytesList).map((t) => t.signature);
      check(picked.length === 2 && picked.includes(t1.signature) && picked.includes(t2.signature), 'entries: both wallets\' transactions picked, nobody else\'s');
      // gRPC entries and Helius frames
      feed._onMessage({ slot: '900', entries: f.entries([t1]) });
      const bs = require('bs58').default || require('bs58');
      feed._onHeliusFrame(Buffer.concat([Buffer.from([1]), f.u64(901), Buffer.from(bs.decode(t2.signature)), t2.bytes]));
      await sleep(60);
      const e1 = em.events.find((e) => e.ca === m1.toBase58());
      const e2 = em.events.find((e) => e.ca === m2.toBase58());
      check(e1 && e1.wallet === config.COPY_WALLETS[0], `first wallet's buy tagged (${JSON.stringify(e1 && e1.wallet)})`);
      check(e2 && e2.wallet === w2.toBase58() && e2.solAmount === -0.2, `second wallet's buy tagged (${JSON.stringify(e2)})`);
      // A router amount no real buy could have (misread instruction variant): not copied.
      feed.learner = { status: () => 'buy', buyLamports: () => 9545n * 1_000_000_000n, vaultIndex: () => null, observe: () => null, describe: () => '' };
      const before = em.events.length;
      const weird = f.txBytes([f.routerIx(f.rnd(), 'aabbccddeeff0011', f.rnd(), 1_000_000_000)]);
      feed._onMessage({ slot: '902', entries: f.entries([weird]) });
      await sleep(40);
      check(em.events.length === before, `a 9545 SOL router buy is not copied (${JSON.stringify(em.events.slice(before))})`);
      feed.stop();
    } finally {
      config.COPY_WALLETS = saved;
    }
  });

  await test('websocket: several copy wallets: one transaction subscription for all, the signer\'s events tagged', async () => {
    const config = require(src('config.js'));
    const { copySigners } = require(src('websocket.js'));
    const saved = config.COPY_WALLETS;
    const a = Keypair.generate().publicKey;
    const b = Keypair.generate().publicKey;
    config.COPY_WALLETS = [a.toBase58(), b.toBase58()];
    try {
      const tx = (signer) => ({ transaction: { message: { accountKeys: [{ pubkey: signer, signer: true }, { pubkey: a, signer: false }] } } });
      check(JSON.stringify(copySigners(tx(b))) === JSON.stringify([b.toBase58()]), 'b signed: only b (a merely mentioned)');
      check(copySigners(tx(Keypair.generate().publicKey)).length === 0, 'signed by a stranger: nobody');
    } finally {
      config.COPY_WALLETS = saved;
    }
  });

  await test('shreds: a copied buy whose original never lands is reported', async () => {
    const { ShredFeed } = require(src('shredFeed.js'));
    const f = shredFx;
    const em = f.fakeEmitter();
    const feed = new ShredFeed({ emitter: em, routersFile: null, verifyDelaysMs: [10, 20, 30], checkStatus: async () => null });
    const m = f.rnd();
    feed._onMessage({ slot: '1', entries: f.entries([f.txBytes([f.pumpIx(DISC.buyExactSolIn, m, 500_000_000, 1)])]) });
    await sleep(150);
    check(em.failed.length === 1 && em.failed[0].neverLanded === true && em.failed[0].mint === m.toBase58(), `never-landed reported (${JSON.stringify(em.failed)})`);
    feed.stop();
  });

  // A Shreder-style decoded transaction (proto fields, snake_case) from wire bytes.
  function shrederMsg(t, slot, createdAtMs = Date.now()) {
    const { parseTransaction } = require(src('shredTx.js'));
    const bs = require('bs58').default || require('bs58');
    const { tx } = parseTransaction(t.bytes, 0);
    return {
      filters: ['copy'],
      transaction: {
        slot: String(slot),
        transaction: {
          signatures: [Buffer.from(bs.decode(t.signature))],
          message: {
            header: { num_required_signatures: tx.numSigners, num_readonly_signed_accounts: 0, num_readonly_unsigned_accounts: 0 },
            account_keys: tx.staticKeys.map((k) => Buffer.from(k)),
            recent_blockhash: Buffer.alloc(32),
            instructions: tx.instructions.map((ix) => ({ program_id_index: ix.programIdIndex, accounts: Buffer.from(ix.accounts), data: Buffer.from(ix.data) })),
            versioned: tx.version !== 'legacy',
            address_table_lookups: tx.lookups.map((l) => ({ account_key: Buffer.from(l.key), writable_indexes: Buffer.from(l.writable), readonly_indexes: Buffer.from(l.readonly) })),
            config: tx.version === 1 ? { priority_fee: '12345', compute_unit_limit: 200000 } : null
          }
        }
      },
      created_at: { seconds: String(Math.floor(createdAtMs / 1000)), nanos: (createdAtMs % 1000) * 1e6 }
    };
  }

  // A local Shreder (ShrederService/SubscribeTransactions) for the tests.
  async function shrederServer(onSubscribe) {
    const grpc = require('@grpc/grpc-js');
    const protoLoader = require('@grpc/proto-loader');
    const def = protoLoader.loadSync(src('proto/shreder.proto'), { keepCase: true, longs: String, defaults: true, oneofs: true });
    const pkg = grpc.loadPackageDefinition(def).shredstream;
    const server = new grpc.Server();
    const calls = [];
    server.addService(pkg.ShrederService.service, {
      SubscribeEntries: (call) => call.end(),
      SubscribeTransactions: (call) => {
        calls.push(call);
        call.on('data', (req) => onSubscribe(call, req));
        call.on('error', () => {});
      }
    });
    const port = await new Promise((res, rej) => server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (e, p) => (e ? rej(e) : res(p))));
    return { port, calls, close: () => server.forceShutdown(), grpc };
  }

  await test('shreds: Shreder decoded transactions are read like wire-format ones (legacy, v0 with tables, v1)', async () => {
    const { parseTransaction, fromDecoded, resolveKeys } = require(src('shredTx.js'));
    const f = shredFx;
    const mint = f.rnd();
    const lut = new f.AddressLookupTableAccount({ key: f.rnd(), state: { deactivationSlot: BigInt('18446744073709551615'), lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, authority: undefined, addresses: [f.bondingCurvePda(mint), f.rnd(), f.rnd()] } });
    for (const t of [
      f.txBytes([f.pumpIx(DISC.buyExactSolIn, mint, 500_000_000, 123)]),
      f.txBytes([f.pumpIx(DISC.buyExactSolIn, mint, 250_000_000, 9)], { luts: [lut] }),
      f.txBytesV1([f.pumpIx(DISC.buyExactSolIn, mint, 450_000_000, 5)])
    ]) {
      const wire = parseTransaction(t.bytes, 0).tx;
      const dec = fromDecoded(shrederMsg(t, 1).transaction.transaction);
      const tables = new Map([[lut.key.toBase58(), lut.state.addresses.map((a) => a.toBase58())]]);
      check(
        dec.signature === t.signature && dec.numSigners === wire.numSigners && dec.version === wire.version &&
          JSON.stringify(resolveKeys(dec, tables)) === JSON.stringify(resolveKeys(wire, tables)) &&
          JSON.stringify(dec.instructions.map((i) => [i.programIdIndex, i.accounts, i.data.toString('hex')])) === JSON.stringify(wire.instructions.map((i) => [i.programIdIndex, i.accounts, Buffer.from(i.data).toString('hex')])),
        `same as the wire-format read (${wire.version})`
      );
    }
    let threw = false;
    try {
      fromDecoded({ signatures: [], message: null });
    } catch {
      threw = true;
    }
    check(threw, 'a message-less transaction is refused (left to the websocket feed)');
  });

  await test('shreds: Shreder source subscribes for the copy wallets, copies their buys once, drops repeats', async () => {
    const config = require(src('config.js'));
    const { ShredFeeds } = require(src('shredFeed.js'));
    const f = shredFx;
    const mint = f.rnd();
    const mine = f.txBytes([f.pumpIx(DISC.buyExactSolIn, mint, 600_000_000, 1)]);
    const theirs = f.txBytes([f.pumpIx(DISC.buy, f.rnd(), 1, 2, f.rnd())].map((ix) => { ix.keys.push(f.meta(f.copyWallet, false, false)); return ix; }), { payer: f.rnd() });
    const mintV1 = f.rnd();
    const mineV1 = f.txBytesV1([f.pumpIx(DISC.buyExactSolIn, mintV1, 300_000_000, 1)]);
    const reqs = [];
    const srv = await shrederServer((call, req) => {
      reqs.push(req);
      call.sendMetadata(new srv.grpc.Metadata());
      call.write(shrederMsg(theirs, 5000));
      call.write(shrederMsg(mine, 5001, Date.now() - 3));
      call.write(shrederMsg(mine, 5001)); // "may be sent multiple times"
      call.write(shrederMsg(mineV1, 5002));
      call.write({ filters: ['copy'], transaction: { slot: '5003', transaction: { signatures: [], message: null } } }); // junk
    });
    const saved = { s: config.SHRED_SOURCE, ss: config.SHRED_SOURCES, u: config.SHREDER_URL, x: config.SHRED_EXCLUDE_ACCOUNTS };
    const excl = f.rnd().toBase58();
    Object.assign(config, { SHRED_SOURCE: 'shreder', SHRED_SOURCES: ['shreder'], SHREDER_URL: `http://127.0.0.1:${srv.port}`, SHRED_EXCLUDE_ACCOUNTS: [excl] });
    const em = f.fakeEmitter();
    const feeds = new ShredFeeds({ emitter: em, routersFile: null, checkStatus: async () => ({ err: null, confirmationStatus: 'confirmed' }) });
    const states = [];
    feeds.on('up', () => states.push('up'));
    feeds.on('down', () => states.push('down'));
    try {
      feeds.start();
      const t0 = Date.now();
      while (em.events.length < 2 && Date.now() - t0 < 5000) await sleep(30);
      await sleep(150);
      const r = reqs[0] && reqs[0].transactions && reqs[0].transactions.copy;
      check(r && JSON.stringify(r.account_include) === JSON.stringify([f.copyWallet.toBase58()]) && JSON.stringify(r.account_exclude) === JSON.stringify([excl]) && r.account_required.length === 0, `subscribed for the copy wallet (${JSON.stringify(reqs[0])})`);
      check(states[0] === 'up' && feeds.state === 'up', `connected = up, before any data (${states})`);
      check(em.events.length === 2 && em.events[0].ca === mint.toBase58() && em.events[0].solAmount === -0.6 && em.events[0].slot === 5001 && em.events[0].shred, `its own buy copied once (${JSON.stringify(em.events.map((e) => [e.ca, e.slot]))})`);
      check(em.events[1] && em.events[1].ca === mintV1.toBase58() && em.events[1].signature === mineV1.signature, 'its v1 buy too');
      const feed = feeds.feeds[0];
      check(feed.stats.messages === 5 && feed.stats.dupes === 1 && feed.stats.parseErrors === 1, `counted (${JSON.stringify(feed.stats)})`);
      check(feed.transit.length >= 3 && feed.transit.every((x) => x > -50 && x < 2000), `time from Shreder's timestamp measured (${feed.transit})`);
      check(/Shreder→here .*median/.test(feed._describeTransit()), 'transit described');
      // The server goes away: down, then back up on reconnect.
      srv.calls[0].emit('error', { code: srv.grpc.status.UNAVAILABLE, details: 'bye' });
      const t1 = Date.now();
      while (!states.includes('down') && Date.now() - t1 < 3000) await sleep(30);
      check(states.includes('down'), `down when the stream drops (${states})`);
      const t2 = Date.now();
      while (states[states.length - 1] !== 'up' && Date.now() - t2 < 5000) await sleep(50);
      check(states[states.length - 1] === 'up' && reqs.length === 2, `reconnected and subscribed again (${states}, ${reqs.length} subscriptions)`);
    } finally {
      feeds.stop();
      srv.close();
      Object.assign(config, { SHRED_SOURCE: saved.s, SHRED_SOURCES: saved.ss, SHREDER_URL: saved.u, SHRED_EXCLUDE_ACCOUNTS: saved.x });
    }
  });

  await test('shreds: Shreder and Helius side by side: first report wins, [Race] says which and by how much', async () => {
    const { WebSocketServer } = require('ws');
    const config = require(src('config.js'));
    const { ShredFeeds } = require(src('shredFeed.js'));
    const f = shredFx;
    const bs = require('bs58').default || require('bs58');
    const frame = (t, slot) => Buffer.concat([Buffer.from([1]), f.u64(slot), Buffer.from(bs.decode(t.signature)), t.bytes]);
    const a = f.txBytes([f.pumpIx(DISC.buyExactSolIn, f.rnd(), 400_000_000, 1)]); // Shreder first
    const b = f.txBytes([f.pumpIx(DISC.buyExactSolIn, f.rnd(), 500_000_000, 1)]); // Helius first
    const c = f.txBytes([f.pumpIx(DISC.buyExactSolIn, f.rnd(), 300_000_000, 1)]); // Helius only
    const sell = f.txBytes([f.pumpIx(DISC.sell, f.rnd(), 100, 1)]); // both: one early exit
    let shrederCall = null;
    const srv = await shrederServer((call) => {
      shrederCall = call;
      call.sendMetadata(new srv.grpc.Metadata());
    });
    const wss = new WebSocketServer({ port: 0 });
    await new Promise((r) => wss.on('listening', r));
    let heliusSock = null;
    wss.on('connection', (sock) => sock.on('message', () => { heliusSock = sock; sock.send(JSON.stringify({ jsonrpc: '2.0', id: 1, result: 9 })); }));
    const saved = { s: config.SHRED_SOURCE, ss: config.SHRED_SOURCES, u: config.SHREDER_URL, su: config.SHRED_STREAM_URL, t: config.TRADE_TYPE, fe: config.FULL_EXIT_ON_COPY_SELL };
    Object.assign(config, {
      SHRED_SOURCE: 'shreder,helius-preprocessed',
      SHRED_SOURCES: ['shreder', 'helius-preprocessed'],
      SHREDER_URL: `http://127.0.0.1:${srv.port}`,
      SHRED_STREAM_URL: `ws://127.0.0.1:${wss.address().port}`,
      TRADE_TYPE: 'STIERED',
      FULL_EXIT_ON_COPY_SELL: true
    });
    const em = f.fakeEmitter();
    const lines = [];
    const feeds = new ShredFeeds({ emitter: em, routersFile: null, verifyDelaysMs: [], raceOptions: { settleMs: 300, log: (m) => lines.push(m) } });
    try {
      feeds.start();
      const t0 = Date.now();
      while ((!shrederCall || !heliusSock || feeds.feeds.some((x) => x.state !== 'up')) && Date.now() - t0 < 5000) await sleep(30);
      check(feeds.state === 'up' && feeds.feeds.every((x) => x.state === 'up'), `both sources up (${feeds.feeds.map((x) => x.state)})`);
      shrederCall.write(shrederMsg(a, 7001));
      await sleep(60);
      heliusSock.send(frame(a, 7001));
      heliusSock.send(frame(b, 7002));
      await sleep(60);
      shrederCall.write(shrederMsg(b, 7002));
      heliusSock.send(frame(c, 7003));
      shrederCall.write(shrederMsg(sell, 7004));
      heliusSock.send(frame(sell, 7004));
      await sleep(600);
      const buys = em.events.filter((e) => e.trade === 'buy');
      check(buys.length === 3 && new Set(buys.map((e) => e.signature)).size === 3, `each buy copied once (${buys.length})`);
      check(em.events.filter((e) => e.shredEarlyExit).length === 1, `the sell acted on once (${em.events.filter((e) => e.shredEarlyExit).length})`);
      const short = (t) => `${t.signature.slice(0, 4)}…${t.signature.slice(-4)}`;
      const la = lines.find((l) => l.includes(short(a)));
      const lb = lines.find((l) => l.includes(short(b)));
      const lc = lines.find((l) => l.includes(short(c)));
      check(la && /Shreder first, Helius \+\d+(\.\d)? ms/.test(la) && /slot 7001/.test(la), `a: Shreder first (${la})`);
      const lead = la && Number(/\+([\d.]+) ms/.exec(la)[1]);
      check(lead >= 40 && lead < 1000, `lead measured (${lead} ms)`);
      check(lb && /Helius first, Shreder \+/.test(lb), `b: Helius first (${lb})`);
      check(lc && /only Helius reported it \(nothing from Shreder/.test(lc), `c: only Helius (${lc})`);
      feeds.race.logSummary();
      const sum = lines.find((l) => l.startsWith('[Race] Last'));
      check(sum && /Shreder first in 1 of 3 \(median lead/.test(sum) && /Helius first in 2 of 3/.test(sum) && /only Helius: 1/.test(sum), `summary (${sum})`);
      // One source drops: still up while the other works.
      for (const x of feeds.feeds) if (x.source === 'helius-preprocessed') heliusSock.terminate();
      await sleep(200);
      check(feeds.state === 'up', `still up on Shreder alone (${feeds.feeds.map((x) => x.state)})`);
    } finally {
      feeds.stop();
      srv.close();
      wss.close();
      Object.assign(config, { SHRED_SOURCE: saved.s, SHRED_SOURCES: saved.ss, SHREDER_URL: saved.u, SHRED_STREAM_URL: saved.su, TRADE_TYPE: saved.t, FULL_EXIT_ON_COPY_SELL: saved.fe });
    }
    check(lines.some((l) => l.startsWith('[Race] Whole run:')), 'whole-run summary at stop');
  });

  await test('FAST_PATH=rust: its transactions reach the bot (bought ones taken over, the rest handled here); own feed opens if it is unreachable', async () => {
    const EventEmitter = require('events');
    const { WebSocketServer } = require('ws');
    const config = require(src('config.js'));
    const { ShredFeeds } = require(src('shredFeed.js'));
    const { parseTransaction } = require(src('shredTx.js'));
    const f = shredFx;
    const bs = require('bs58').default || require('bs58');
    const toRust = (t) => {
      const { tx } = parseTransaction(t.bytes, 0);
      return {
        signature: tx.signature, numSigners: tx.numSigners, version: tx.version,
        staticKeys: tx.staticKeys.map((k) => Buffer.from(k).toString('base64')),
        instructions: tx.instructions.map((ix) => ({ programIdIndex: ix.programIdIndex, accounts: ix.accounts, data: Buffer.from(ix.data).toString('base64') })),
        lookups: []
      };
    };
    const fp = new EventEmitter();
    fp.feedStates = new Map();
    fp.connected = false;
    fp.isUp = () => fp.connected && [...fp.feedStates.values()].includes('up');
    fp.pushTables = () => {};
    fp.pushRouters = () => {};
    // A standby Helius feed (used only while the fast path is unreachable).
    const wss = new WebSocketServer({ port: 0 });
    await new Promise((r) => wss.on('listening', r));
    let standbySubs = 0;
    wss.on('connection', (sock) => sock.on('message', () => { standbySubs += 1; sock.send(JSON.stringify({ jsonrpc: '2.0', id: 1, result: 3 })); }));
    const saved = { s: config.SHRED_SOURCE, ss: config.SHRED_SOURCES, u: config.SHRED_STREAM_URL };
    Object.assign(config, { SHRED_SOURCE: 'helius-preprocessed', SHRED_SOURCES: ['helius-preprocessed'], SHRED_STREAM_URL: `ws://127.0.0.1:${wss.address().port}` });
    const em = f.fakeEmitter();
    const feeds = new ShredFeeds({ emitter: em, routersFile: null, verifyDelaysMs: [], fastPath: fp, fallbackMs: 200, isHeld: () => false });
    try {
      feeds.start();
      check(feeds.feeds[0].source === 'rust' && feeds.feeds[0].state === 'down', 'reads from the fast path, down until it links');
      const t0 = Date.now();
      while (!standbySubs && Date.now() - t0 < 3000) await sleep(30);
      check(standbySubs === 1 && feeds.standby.length === 1, `unreachable: its own Helius feed opened (${standbySubs})`);
      fp.connected = true;
      fp.feedStates.set('helius-preprocessed', 'up');
      fp.emit('linked');
      await sleep(100);
      check(feeds.standby.length === 0 && feeds.state === 'up', `linked: own feed closed again (${feeds.standby.length}, ${feeds.state})`);
      // Bought by the fast path: taken over, not bought again here.
      const m1 = f.rnd();
      const t1 = f.txBytes([f.pumpIx(DISC.buyExactSolIn, m1, 400_000_000, 1)]);
      fp.emit('tx', { source: 'helius-preprocessed', slot: 7000, at: 1, seenAt: Date.now(), signature: t1.signature, wallet: f.copyWallet.toBase58(), tx: toRust(t1), keys: null,
        outcome: { status: 'bought', signature: 'ourSig1', mint: m1.toBase58(), amountSol: 0.05, copySol: 0.4, via: 'Pump.fun' }, marks: { keys: 0.02, classified: 0.05, decide: 0.06 } });
      // Declined (e.g. a coin it can't be sure of): handled here as usual.
      const m2 = f.rnd();
      const t2 = f.txBytes([f.pumpIx(DISC.buyExactSolIn, m2, 300_000_000, 1)]);
      fp.emit('tx', { source: 'helius-preprocessed', slot: 7001, at: 2, seenAt: Date.now(), signature: t2.signature, wallet: f.copyWallet.toBase58(), tx: toRust(t2), keys: null,
        outcome: { status: 'declined', reason: 'within BUY_COOLDOWN_SEC of another buy', mint: m2.toBase58() }, marks: { keys: 0.02, classified: 0.05 } });
      await sleep(100);
      const e1 = em.events.find((e) => e.ca === m1.toBase58());
      const e2 = em.events.find((e) => e.ca === m2.toBase58());
      check(e1 && e1.fastSent && e1.fastSent.signature === 'ourSig1' && e1.solAmount === -0.4 && e1.shred && em.seenSignatures.has(t1.signature), `bought: passed on with what the fast path did (${JSON.stringify(e1)})`);
      check(e2 && !e2.fastSent && e2.solAmount === -0.3 && e2.slot === 7001, `declined: an ordinary early buy for this bot (${JSON.stringify(e2)})`);
      check(em.events.length === 2, 'one event each');
    } finally {
      feeds.stop();
      wss.close();
      Object.assign(config, { SHRED_SOURCE: saved.s, SHRED_SOURCES: saved.ss, SHRED_STREAM_URL: saved.u });
    }
  });

  await test('config: SHRED_SOURCE checked at startup', async () => {
    const base = { ...process.env };
    const run = (env) => spawnSync(process.execPath, ['-e', `const c=require(${JSON.stringify(src('config.js'))}); console.log(c.SHRED_SOURCE)`], { cwd: root, env: { ...base, ...env }, encoding: 'utf8' });
    let r = run({ SHRED_SOURCE: 'getblock' });
    check(r.status === 1 && /SHRED_SOURCE must be "jito-grpc", "helius-preprocessed" or "shreder"/.test(r.stderr), 'unknown source refused');
    r = run({ SHRED_SOURCE: 'shreder' });
    check(r.status === 1 && /needs SHREDER_URL/.test(r.stderr), 'shreder needs its address');
    r = run({ SHRED_SOURCE: 'shreder', SHREDER_URL: 'http://fra1.shreder.xyz:9991' });
    check(r.status === 0 && r.stdout.trim() === 'shreder', `shreder with an address (${r.stderr.trim().slice(0, 120)})`);
    r = run({ SHRED_SOURCE: 'Shreder, helius-preprocessed', SHREDER_URL: 'http://fra1.shreder.xyz:9991', SOLANA_RPC: 'https://mainnet.helius-rpc.com/?api-key=k1' });
    check(r.status === 0 && r.stdout.trim() === 'shreder,helius-preprocessed', `two sources side by side (${r.stdout.trim()} ${r.stderr.trim().slice(0, 120)})`);
    r = run({ SHRED_SOURCE: 'jito-grpc,helius-preprocessed', SHRED_STREAM_URL: 'http://127.0.0.1:9999' });
    check(r.status === 1 && /can't run together/.test(r.stderr), 'jito-grpc + helius refused (both use SHRED_STREAM_URL)');
    r = run({ SHRED_SOURCE: 'shreder', SHREDER_URL: 'http://bad host/x' });
    check(r.status === 1 && /SHREDER_URL .* isn't a valid address/.test(r.stderr), 'bad Shreder address refused');
    r = run({ SHRED_SOURCE: 'jito-grpc' });
    check(r.status === 1 && /needs SHRED_STREAM_URL/.test(r.stderr), 'jito-grpc needs an address');
    r = run({ SHRED_SOURCE: 'helius-preprocessed' });
    check(r.status === 1 && /needs a Helius API key/.test(r.stderr), 'helius needs a key');
    r = run({ SHRED_SOURCE: 'helius-preprocessed', SOLANA_RPC: 'https://mainnet.helius-rpc.com/?api-key=k1' });
    check(r.status === 0 && r.stdout.trim() === 'helius-preprocessed', `Helius SOLANA_RPC is enough (${r.stderr.trim().slice(0, 120)})`);
    r = run({ SHRED_STREAM_URL: 'http://127.0.0.1:9999' });
    check(r.status === 0 && r.stdout.trim() === 'jito-grpc', 'an address alone means jito-grpc (as before)');
    r = run({});
    check(r.status === 0 && r.stdout.trim() === '', 'off by default');
  });

  await test('MAX_ENTRY_PREMIUM_PCT: a built buy is refused when its quote is too far above the copy wallet\'s price', async () => {
    const { checkEntryPrice, EntryPriceTooHighError } = require(src('tradeExecutor.js'));
    const { attachQuote } = require(src('buyQuote.js'));
    const tx = attachQuote({}, { solIn: 0.15, tokensOut: 10000 }); // 0.000015 SOL per token
    let err = null;
    try { checkEntryPrice(tx, 'Pump.fun curve', { copyPriceSol: 0.00001, maxPct: 30 }); } catch (e) { err = e; }
    check(err instanceof EntryPriceTooHighError && Math.abs(err.premiumPct - 50) < 1e-9, `+50% refused at a 30% limit (${err && err.message})`);
    let ok = true;
    try { checkEntryPrice(tx, 'Pump.fun curve', { copyPriceSol: 0.00001, maxPct: 60 }); } catch { ok = false; }
    check(ok, '+50% allowed at a 60% limit');
    ok = true;
    try { checkEntryPrice({}, 'Raydium LaunchLab', { copyPriceSol: 0.00001, maxPct: 0 }); } catch { ok = false; }
    check(ok, 'no quote: buy goes ahead');
    ok = true;
    try { checkEntryPrice(tx, 'Pump.fun curve', null); } catch { ok = false; }
    check(ok, 'setting off: no check');
    check(!Object.keys(tx).includes('quote'), 'quote is not an enumerable field (never serialised)');
  });

  await test('direct Raydium: LaunchLab curve, CLMM and standard pools; picks the right one; clear reason when none', async () => {
    const script = `
      const BN = require('bn.js');
      const { PublicKey, Keypair } = require('@solana/web3.js');
      const sdkPath = require.resolve('@raydium-io/raydium-sdk-v2');
      const sdk = require('@raydium-io/raydium-sdk-v2');
      let launchStatus = 0;
      require.cache[sdkPath].exports = { ...sdk,
        LaunchpadPool: { decode: () => ({ status: launchStatus, mintDecimalsA: 6 }) },
        PoolUtils: { computeAmountOutFormat: (a) => { seen.quote = { amountIn: a.amountIn.toString(), tokenOut: a.tokenOut.address, slippage: a.slippage }; return { minAmountOut: { amount: { raw: new BN(777) } }, remainingAccounts: ['ta1'] }; } } };
      const SOL = 'So11111111111111111111111111111111111111112';
      const seen = {};
      const mint = Keypair.generate().publicKey.toBase58();
      const USD1 = Keypair.generate().publicKey.toBase58();
      let launchExists = true;
      let listed = [];
      const connection = { getAccountInfo: async () => (launchExists ? { owner: sdk.LAUNCHPAD_PROGRAM, data: Buffer.alloc(8) } : null) };
      const clmmPool = { id: 'clmmPool1', programId: sdk.CLMM_PROGRAM_ID.toBase58(), tvl: 50000, mintA: { address: SOL, decimals: 9 }, mintB: { address: mint, decimals: 6 } };
      const cpmmPool = { id: 'cpmmPool1', programId: sdk.CREATE_CPMM_POOL_PROGRAM.toBase58(), tvl: 9000, mintA: { address: SOL, decimals: 9 }, mintB: { address: mint, decimals: 6 } };
      const raydium = {
        api: { fetchPoolByMints: async (q) => { seen.apiType = q.type; return { data: listed }; } },
        launchpad: {
          buyToken: async (a) => { seen.lBuy = { mintA: a.mintA.toBase58(), mintB: a.mintB.toBase58(), buy: a.buyAmount.toString(), slip: a.slippage.toString(), v: a.txVersion }; return { transaction: {} }; },
          sellToken: async (a) => { seen.lSell = { sell: a.sellAmount.toString(), slip: a.slippage.toString() }; return { transaction: {} }; }
        },
        clmm: {
          getPoolInfoFromRpc: async (id) => ({ poolInfo: { ...clmmPool, id }, poolKeys: { k: 1 }, computePoolInfo: { observationId: 'obs1', exBitmapInfo: {} }, tickData: { [id]: {} } }),
          swap: async (a) => { seen.cSwap = { inputMint: a.inputMint, amountIn: a.amountIn.toString(), min: a.amountOutMin.toString(), obs: a.observationId, rem: a.remainingAccounts }; return { transaction: {} }; }
        },
        account: { fetchWalletTokenAccounts: async (o) => { seen.forced = o && o.forceUpdate; } },
        fetchEpochInfo: async () => ({ epoch: 1 })
      };
      const r = require(${JSON.stringify(src('raydiumDirect.js'))});
      r._setRaydiumForTests(raydium, connection);
      const user = Keypair.generate().publicKey;
      const out = {};
      (async () => {
        // 1. Coin still on its LaunchLab curve.
        let tx = await r.buildRaydiumBuyTx({ connection, user, mint, solAmount: 0.01, slippagePct: 20 });
        out.launchBuy = { label: tx.routeLabel, ...seen.lBuy };
        tx = await r.buildRaydiumSellTx({ connection, user, mint, tokenAmountUi: '5', slippagePct: 20 });
        out.launchSell = { label: tx.routeLabel, forced: seen.forced, ...seen.lSell };
        // 2. Curve finished; CLMM has more liquidity than CPMM.
        launchStatus = 2; listed = [cpmmPool, clmmPool];
        tx = await r.buildRaydiumBuyTx({ connection, user, mint, solAmount: 0.01, slippagePct: 20 });
        out.clmmBuy = { label: tx.routeLabel, apiType: seen.apiType, ...seen.cSwap, quote: seen.quote };
        tx = await r.buildRaydiumSellTx({ connection, user, mint, tokenAmountUi: '2.5', slippagePct: 20 });
        out.clmmSell = { label: tx.routeLabel, ...seen.cSwap };
        // 3. Only paired with another token.
        launchExists = false; listed = [{ ...cpmmPool, mintA: { address: USD1, decimals: 6 } }];
        try { await r.buildRaydiumBuyTx({ connection, user, mint, solAmount: 0.01, slippagePct: 20 }); out.none = 'built?!'; }
        catch (e) { out.none = { unsupported: e instanceof r.UnsupportedRaydiumTradeError, msg: e.message }; }
        console.log(JSON.stringify(out));
      })().catch((e) => console.log('ERR ' + e.stack));
    `;
    const r = spawnSync(process.execPath, ['-e', script], { cwd: root, encoding: 'utf8' });
    const line = (r.stdout || '').trim().split('\n').pop();
    let out = null;
    try { out = JSON.parse(line); } catch {}
    check(out, `builder ran (${r.stdout} ${r.stderr.slice(-400)})`);
    if (!out) return;
    const SOL = 'So11111111111111111111111111111111111111112';
    const lb = out.launchBuy;
    check(lb.label === 'Raydium LaunchLab' && lb.mintB === SOL && lb.buy === '10000000' && lb.slip === '2000' && lb.v === 0, `LaunchLab buy: 0.01 SOL, 20% = 2000 bps, v0 (${JSON.stringify(lb)})`);
    check(out.launchSell.label === 'Raydium LaunchLab' && out.launchSell.sell === '5000000' && out.launchSell.forced === true, `LaunchLab sell: exact raw amount, wallet accounts refreshed (${JSON.stringify(out.launchSell)})`);
    const cb = out.clmmBuy;
    check(cb.label === 'Raydium CLMM' && cb.apiType === 'all' && cb.inputMint === SOL && cb.amountIn === '10000000' && cb.min === '777' && cb.obs === 'obs1' && cb.rem[0] === 'ta1', `finished curve -> most liquid pool (CLMM), quoted min out used (${JSON.stringify(cb)})`);
    check(cb.quote && cb.quote.slippage === 0.2, `CLMM slippage as a fraction (${JSON.stringify(cb.quote)})`);
    check(out.clmmSell.label === 'Raydium CLMM' && out.clmmSell.amountIn === '2500000' && out.clmmSell.inputMint !== SOL, `CLMM sell uses the pool's decimals (${JSON.stringify(out.clmmSell)})`);
    check(out.none && out.none.unsupported && /no Raydium pool pairs it with SOL/.test(out.none.msg), `no SOL pool -> clear unsupported reason (${JSON.stringify(out.none)})`);
  });

  await test('PumpSwap: direct builder, picked from the copy trade, and used automatically once a curve graduates', async () => {
    const { detectPool } = require(src('dexMapper.js'));
    check(detectPool(['Pump.fun Amm']) === 'pumpswap' && detectPool(['Pump.fun']) === 'pump-curve' && detectPool(['Raydium Launchpad']) === 'launchlab' && detectPool(['Raydium Clmm']) === 'clmm' && detectPool(['Meteora Dlmm']) === null, 'pool type read from the copy wallet\'s transaction');
    const script = `
      const BN = require('bn.js');
      const { PublicKey, Keypair, TransactionInstruction } = require('@solana/web3.js');
      const { NATIVE_MINT } = require('@solana/spl-token');
      const seen = { curve: 0, swapState: 0 };
      const ix = () => new TransactionInstruction({ programId: PublicKey.default, keys: [], data: Buffer.alloc(0) });
      let quoteMint = NATIVE_MINT;
      const swapPath = require.resolve('@pump-fun/pump-swap-sdk');
      const swapSdk = require('@pump-fun/pump-swap-sdk');
      require.cache[swapPath].exports = { ...swapSdk,
        OnlinePumpAmmSdk: class { swapSolanaState(poolKey) { seen.swapState += 1; seen.poolKey = poolKey.toBase58(); return { pool: { quoteMint }, baseMintAccount: { decimals: 6 } }; } },
        PUMP_AMM_SDK: {
          buyQuoteInput: async (st, q, slip) => { seen.buy = { q: q.toString(), slip }; return [ix()]; },
          sellBaseInput: async (st, b, slip) => { seen.sell = { b: b.toString(), slip }; return [ix()]; }
        } };
      class UnsupportedPumpfunTradeError extends Error {}
      let curveMode = 'graduated';
      const pfPath = ${JSON.stringify(src('pumpfunDirect.js'))};
      require.cache[pfPath] = { id: pfPath, filename: pfPath, loaded: true, exports: { UnsupportedPumpfunTradeError,
        buildPumpfunBuyTx: async () => { seen.curve += 1; if (curveMode === 'graduated') { const e = new UnsupportedPumpfunTradeError('complete'); e.graduated = true; throw e; } return { curve: true }; },
        buildPumpfunSellTx: async () => { seen.curve += 1; return { curve: true }; } } };
      const route = require(${JSON.stringify(src('pumpRoute.js'))});
      const connection = { getLatestBlockhash: async () => ({ blockhash: '11111111111111111111111111111111' }) };
      const user = Keypair.generate().publicKey;
      const out = {};
      (async () => {
        const m1 = Keypair.generate().publicKey.toBase58();
        const args = (mint, extra) => ({ connection, user, mint, slippagePct: 20, tipSol: 0.001, computeUnitLimit: 300000, ...extra });
        // Copy wallet traded on PumpSwap: straight there, curve never tried.
        let tx = await route.buildPumpTx('buy', args(m1, { solAmount: 0.01 }), 'pumpswap');
        out.direct = { label: tx.routeLabel, curve: seen.curve, buy: seen.buy, poolKeyOk: seen.poolKey === swapSdk.canonicalPumpPoolPda(new PublicKey(m1)).toBase58() };
        // Held coin whose curve graduated: curve once, then PumpSwap; remembered.
        const m2 = Keypair.generate().publicKey.toBase58();
        seen.curve = 0;
        tx = await route.buildPumpTx('buy', args(m2, { solAmount: 0.01 }), 'pump-curve');
        const afterFirst = seen.curve;
        tx = await route.buildPumpTx('sell', args(m2, { tokenAmountUi: '1.5' }), 'pump-curve');
        out.graduated = { label: tx.routeLabel, curveTries: seen.curve, afterFirst, sell: seen.sell };
        // Still on the curve: curve builder used.
        curveMode = 'ok';
        const m3 = Keypair.generate().publicKey.toBase58();
        tx = await route.buildPumpTx('buy', args(m3, { solAmount: 0.01 }), 'pump-curve');
        out.curve = tx.curve === true;
        // Pool not paired with SOL: unsupported (caller falls back).
        quoteMint = Keypair.generate().publicKey;
        try { await route.buildPumpTx('buy', args(Keypair.generate().publicKey.toBase58(), { solAmount: 0.01 }), 'pumpswap'); out.nonSol = 'built?!'; }
        catch (e) { out.nonSol = { unsupported: route.isUnsupported(e), msg: e.message }; }
        console.log(JSON.stringify(out));
      })().catch((e) => console.log('ERR ' + e.stack));
    `;
    const r = spawnSync(process.execPath, ['-e', script], { cwd: root, encoding: 'utf8' });
    const line = (r.stdout || '').trim().split('\n').pop();
    let out = null;
    try { out = JSON.parse(line); } catch {}
    check(out, `ran (${r.stdout} ${r.stderr.slice(-400)})`);
    if (!out) return;
    check(out.direct.label === 'PumpSwap' && out.direct.curve === 0 && out.direct.buy.q === '10000000' && out.direct.buy.slip === 20 && out.direct.poolKeyOk, `PumpSwap trade -> PumpSwap builder directly, canonical pool (${JSON.stringify(out.direct)})`);
    check(out.graduated.label === 'PumpSwap' && out.graduated.afterFirst === 1 && out.graduated.curveTries === 1 && out.graduated.sell.b === '1500000', `graduated curve -> PumpSwap, remembered for the sell (${JSON.stringify(out.graduated)})`);
    check(out.curve === true, 'coin still on its curve uses the curve builder');
    check(out.nonSol && out.nonSol.unsupported && /not paired with SOL/.test(out.nonSol.msg), `non-SOL PumpSwap pool -> clear fallback (${JSON.stringify(out.nonSol)})`);
  });

  await test('fees, tips and token-account deposits are measured separately from the swap', async () => {
    const { measureWalletDeltas } = require(src('txParser.js'));
    const W = Keypair.generate().publicKey.toBase58();
    const M = Keypair.generate().publicKey.toBase58();
    const JITO = '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5';
    const keys = [{ pubkey: { toBase58: () => W } }, { pubkey: { toBase58: () => 'ata' } }];
    const tipIx = (l) => ({ program: 'system', parsed: { type: 'transfer', info: { source: W, destination: JITO, lamports: l } } });
    // Buy: 0.1 SOL into the swap, 0.0005 tip, 5000 fee, new token account (2039280 deposit).
    const buy = measureWalletDeltas({
      meta: { err: null, fee: 5000, preBalances: [1e9, 0], postBalances: [1e9 - 100_000_000 - 500_000 - 5000 - 2_039_280, 2_039_280],
        preTokenBalances: [], postTokenBalances: [{ accountIndex: 1, owner: W, mint: M, uiTokenAmount: { amount: '1000', decimals: 6 } }], innerInstructions: [] },
      transaction: { message: { accountKeys: keys, instructions: [tipIx(500_000)] } }
    }, W, M);
    check(buy.feeLamports === 5000 && buy.tipLamports === 500_000 && buy.rentLamports === 2_039_280, `buy costs split out (${JSON.stringify({ f: buy.feeLamports, t: buy.tipLamports, r: buy.rentLamports })})`);
    check(buy.lamportsDelta + buy.feeLamports + buy.tipLamports + buy.rentLamports === -100_000_000, 'swap amount = exactly 0.1 SOL');
    // Sell that also closes the token account: deposit refunded, not counted as proceeds.
    const sell = measureWalletDeltas({
      meta: { err: null, fee: 5000, preBalances: [1e9, 2_039_280], postBalances: [1e9 + 150_000_000 - 500_000 - 5000 + 2_039_280, 0],
        preTokenBalances: [{ accountIndex: 1, owner: W, mint: M, uiTokenAmount: { amount: '1000', decimals: 6 } }], postTokenBalances: [], innerInstructions: [] },
      transaction: { message: { accountKeys: keys, instructions: [tipIx(500_000)] } }
    }, W, M);
    check(sell.rentLamports === -2_039_280 && sell.lamportsDelta + sell.feeLamports + sell.tipLamports + sell.rentLamports === 150_000_000, `sell proceeds = exactly 0.15 SOL (${JSON.stringify({ d: sell.lamportsDelta, r: sell.rentLamports })})`);
  });

  await test('on-chain failures explained by route (slippage), raw error kept', async () => {
    const { explainTxError } = require(src('txErrors.js'));
    const e = { InstructionError: [2, { Custom: 6002 }] };
    check(/price rose more than your SLIPPAGE.*Pump\.fun.*\{"InstructionError"/.test(explainTxError(e, 'pump-curve')), explainTxError(e, 'pump-curve'));
    check(explainTxError(e, 'pumpswap') === JSON.stringify(e), 'same number on another program is not mislabelled');
    check(/PumpSwap/.test(explainTxError({ InstructionError: [3, { Custom: 6004 }] }, 'pumpswap')), 'PumpSwap slippage');
    check(explainTxError({ InstructionError: [1, 'IncorrectProgramId'] }, 'pumpfun') === '{"InstructionError":[1,"IncorrectProgramId"]}', 'unknown errors stay raw');
  });

  await test('leader locations: schedule, node addresses and IP locations are fetched, cached and used', async () => {
    const script = `
      const path = require('path');
      const src = (f) => path.join(process.cwd(), 'src', f);
      const rpcPool = require(src('rpcPool.js'));
      const slotClock = require(src('slotClock.js'));
      const asked = { leaders: null, batch: null };
      const pk = (s) => ({ toBase58: () => s });
      const conn = {
        getSlot: async () => 5000,
        getSlotLeaders: async (start, n) => { asked.leaders = [start, n]; return Array.from({ length: 200 }, (_, i) => pk(i < 100 ? 'TokVal' : 'AmsVal')); },
        getClusterNodes: async () => [
          { pubkey: 'AmsVal', gossip: '1.2.3.4:8001' },
          { pubkey: 'TokVal', gossip: '[2001:db8::1]:8001' },
          { pubkey: 'Other', gossip: null, tpu: '9.9.9.9:8003' }
        ]
      };
      rpcPool.withFailover = async (fn) => fn(conn);
      const reply = (data) => ({ ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify(data) });
      globalThis.fetch = async (url, opts = {}) => {
        if (url.includes('/json/')) return reply({ status: 'success', city: 'Frankfurt am Main', countryCode: 'DE', lat: 50.11, lon: 8.68 });
        if (url.includes('/batch')) {
          asked.batch = JSON.parse(opts.body);
          return reply([
            { status: 'success', query: '1.2.3.4', city: 'Amsterdam', countryCode: 'NL', lat: 52.37, lon: 4.9 },
            { status: 'success', query: '2001:db8::1', city: 'Tokyo', countryCode: 'JP', lat: 35.69, lon: 139.69 }
          ]);
        }
        throw new Error('unexpected ' + url);
      };
      slotClock.record(5000);
      const li = require(src('leaderInfo.js'));
      li.start();
      setTimeout(() => {
        const fs = require('fs');
        let cache = null;
        try { cache = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'data', 'leader-locations.json'), 'utf8')); } catch {}
        console.log(JSON.stringify({
          asked,
          ams: li.leaderOf(5100),
          tok: li.leaderOf(5000),
          none: li.leaderOf(999999),
          okAms: li.reachable(5100, 0),
          farTok: li.reachable(5000, 0),
          edge: li.reachable(5049, 1),
          edgeFar: li.reachable(5048, 1),
          cached: cache && Object.keys(cache.ips || {}).sort(),
          home: cache && cache.home && cache.home.label
        }));
        process.exit(0);
      }, 300);
    `;
    fs.mkdirSync(path.join(root, 'data'), { recursive: true });
    const r = spawnSync(process.execPath, ['-e', script], { cwd: root, encoding: 'utf8', env: { ...process.env, LEADER_INFO: 'true', LEADER_MAX_KM: '500' } });
    const line = (r.stdout || '').trim().split('\n').reverse().find((l) => l.startsWith('{')) || '';
    let out = null;
    try { out = JSON.parse(line); } catch {}
    check(out, `script ran (${(r.stderr || r.stdout || '').slice(-400)})`);
    if (!out) return;
    check(out.asked.leaders && out.asked.leaders[0] === 4950 && out.asked.leaders[1] === 5000, `schedule asked from just before the current slot (${JSON.stringify(out.asked.leaders)})`);
    check(JSON.stringify((out.asked.batch || []).sort()) === JSON.stringify(['1.2.3.4', '2001:db8::1']), `only the leaders' addresses looked up, IPv6 brackets and ports removed (${JSON.stringify(out.asked.batch)})`);
    check(out.ams && out.ams.city === 'Amsterdam' && out.ams.km > 330 && out.ams.km < 400, `Amsterdam leader ~365 km (${JSON.stringify(out.ams)})`);
    check(out.tok && out.tok.city === 'Tokyo' && out.tok.km > 9000, `Tokyo leader (${JSON.stringify(out.tok)})`);
    check(out.none === null, 'slot outside the schedule: unknown');
    check(out.okAms.ok && !out.farTok.ok && /Tokyo, JP/.test(out.farTok.why), `limit applied (${JSON.stringify(out.farTok)})`);
    check(out.edge.ok && !out.edgeFar.ok, 'a guard window reaching a nearby leader is not skipped; one that doesn\'t is');
    check(/and the next 1/.test(out.edgeFar.why || ''), `window named (${out.edgeFar.why})`);
    check(JSON.stringify(out.cached) === JSON.stringify(['1.2.3.4', '2001:db8::1']) && out.home === 'Frankfurt am Main, DE', `cached for the next start (${JSON.stringify(out.cached)}, ${out.home})`);
  });

  await test('npm run leaders: past buys matched to the copy wallet, outcomes, leaders and report', async () => {
    const { analyse, report } = require(path.join(__dirname, '..', 'scripts', 'leaders.js'));
    const crypto = require('crypto');
    const bs = require('bs58');
    const b58 = (bs.default || bs).encode;
    const disc = (n) => b58(crypto.createHash('sha256').update(`global:${n}`).digest().subarray(0, 8));
    const W = Keypair.generate().publicKey.toBase58();
    const C = Keypair.generate().publicKey.toBase58();
    const [M1, M2, M3, M4] = [1, 2, 3, 4].map(() => Keypair.generate().publicKey.toBase58());
    const PUMP = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
    const LH = 'L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95';
    const k = (s) => ({ pubkey: { toBase58: () => s } });
    const pid = (s) => ({ toBase58: () => s });
    const tx = ({ slot, time, owner, mint, delta = 0, err = null, ixs = [], keys = [] }) => ({
      slot,
      blockTime: time,
      meta: {
        err,
        preTokenBalances: mint ? [{ owner, mint, uiTokenAmount: { amount: '1000' } }] : [],
        postTokenBalances: mint ? [{ owner, mint, uiTokenAmount: { amount: String(1000 + delta) } }] : []
      },
      transaction: { message: { accountKeys: [owner, ...keys].map(k), instructions: ixs } }
    });
    const buyIx = { programId: pid(PUMP), data: disc('buy') };
    const sellIx = { programId: pid(PUMP), data: disc('sell') };
    const txs = {
      h1: tx({ slot: 100, time: 1000, owner: C, mint: M1, delta: 500, ixs: [buyIx] }),
      h2: tx({ slot: 200, time: 1100, owner: C, mint: M2, delta: 500, ixs: [buyIx] }),
      h3: tx({ slot: 300, time: 1200, owner: C, mint: M3, delta: 500, ixs: [buyIx] }),
      o1: tx({ slot: 100, time: 1000, owner: W, mint: M1, delta: 100, ixs: [buyIx] }), // same block
      o1s: tx({ slot: 103, time: 1001, owner: W, mint: M1, delta: -100, ixs: [sellIx] }), // its sell: not a buy
      o2: tx({ slot: 202, time: 1101, owner: W, mint: M2, delta: 100, ixs: [buyIx] }), // 2 slots late
      o2f: tx({ slot: 205, time: 1102, owner: W, keys: [M2], err: { InstructionError: [0, { Custom: 6003 }] }, ixs: [sellIx] }), // failed sell: ignored
      o3: tx({ slot: 301, time: 1200, owner: W, keys: [M3], err: { InstructionError: [2, { Custom: 1 }] }, ixs: [{ programId: pid('ComputeBudget111111111111111111111111111111') }, { programId: pid('ComputeBudget111111111111111111111111111111') }, { programId: pid(LH) }, buyIx] }), // guard cancel
      o4: tx({ slot: 400, time: 1300, owner: W, mint: M4, delta: 100, ixs: [buyIx] }) // he never bought it
    };
    const sigsOf = { [W]: ['o4', 'o3', 'o2f', 'o2', 'o1s', 'o1'], [C]: ['h3', 'h2', 'h1'] };
    const conn = {
      getSignaturesForAddress: async (pk, { before }) => {
        const list = sigsOf[pk.toBase58()];
        const start = before ? list.indexOf(before) + 1 : 0;
        return list.slice(start, start + 1000).map((sig) => ({ signature: sig, blockTime: txs[sig].blockTime, err: txs[sig].meta.err }));
      },
      getParsedTransaction: async (sig) => txs[sig],
      getBlock: async (slot) => ({ rewards: slot === 100 ? [{ pubkey: 'LeadA', rewardType: 'Fee' }] : slot === 200 ? [{ pubkey: 'LeadB', rewardType: 'Fee' }] : [] })
    };
    const res = await analyse({ conn, wallet: W, copyWallets: [C], limit: 50 });
    const by = Object.fromEntries(res.rows.map((r) => [r.mint, r]));
    check(res.rows.length === 3 && res.unmatched === 1, `3 matched, 1 unmatched (${res.rows.length}, ${res.unmatched})`);
    check(by[M1] && by[M1].outcome === 'same' && by[M1].leader === 'LeadA', `same block (${JSON.stringify(by[M1])})`);
    check(by[M2] && by[M2].outcome === 'late' && by[M2].ourSlot === 202 && by[M2].leader === 'LeadB', `late (${JSON.stringify(by[M2])})`);
    check(by[M3] && by[M3].outcome === 'late (cancelled)' && by[M3].leader === null, `guard cancel matched via its accounts (${JSON.stringify(by[M3])})`);
    const places = new Map([['LeadA', { ip: '1.2.3.4', city: 'Frankfurt am Main', cc: 'DE', km: 4, ping: 1.2 }], ['LeadB', { ip: '5.6.7.8', city: 'Tokyo', cc: 'JP', km: 9300, ping: null }]]);
    const text = report(res, places, 'Frankfurt am Main, DE');
    check(/In his block: 1 of 3 \(33%\)/.test(text), text);
    check(/≤100 km\s+1\/1/.test(text) && />1,500 km\s+0\/1/.test(text) && /unknown\s+0\/1/.test(text), text);
    check(/his slot 202|ours \+2/.test(text) && /cancelled/.test(text) && /Tokyo, JP \(~9,300 km\), no ping reply/.test(text), text);
    check(/Frankfurt am Main, DE \(~4 km\), ping 1\.2 ms/.test(text) && /By ping from this server:\n\s+≤5 ms\s+1\/1/.test(text) && /no ping reply\s+0\/1/.test(text), text);
    const { resolveInputs } = require(path.join(__dirname, '..', 'scripts', 'leaders.js'));
    const resolved = await resolveInputs({ getVoteAccounts: async () => ({ current: [{ votePubkey: 'VoteX', nodePubkey: 'NodeX' }], delinquent: [] }) }, ['VoteX', 'NodeY', '1.2.3.4']);
    check(resolved[0].identity === 'NodeX' && /vote account of NodeX/.test(resolved[0].note) && resolved[1].identity === 'NodeY' && resolved[2].ip === '1.2.3.4' && resolved[2].identity === null, `--ping inputs resolved (${JSON.stringify(resolved)})`);
    const { parseRtt } = require(src('ping.js'));
    check(parseRtt('rtt min/avg/max/mdev = 0.912/1.204/1.633/0.300 ms') === 0.9 && parseRtt('3 packets transmitted, 0 received, 100% packet loss') === null, 'ping summary parsed (fastest reply)');
  });

  await test('shreds: lookup tables the copy wallets used recently are pre-loaded at startup', async () => {
    const { ShredFeed } = require(src('shredFeed.js'));
    const rpcPool = require(src('rpcPool.js'));
    const saved = rpcPool.withFailover;
    const LT = Keypair.generate().publicKey;
    const addr = Keypair.generate().publicKey;
    const fetched = [];
    const txAsked = [];
    rpcPool.withFailover = async (fn) =>
      fn({
        getSignaturesForAddress: async () => [{ signature: 'ok1', err: null }, { signature: 'failed', err: { InstructionError: [0, 'x'] } }, { signature: 'ok2', err: null }],
        getParsedTransaction: async (sig, opts) => {
          txAsked.push(sig);
          if (!(opts && opts.maxSupportedTransactionVersion >= 1)) throw new Error('Transaction version (1) is not supported by the requesting client');
          return { transaction: { message: sig === 'ok1' ? { addressTableLookups: [{ accountKey: LT.toBase58(), writableIndexes: [0], readonlyIndexes: [] }] } : {} } };
        },
        getAddressLookupTable: async (pk) => {
          fetched.push(pk.toBase58());
          return { value: { state: { addresses: [addr] } } };
        }
      });
    try {
      const feed = new ShredFeed({ emitter: shredFx.fakeEmitter(), routersFile: null, checkStatus: async () => null });
      await feed._prewarmTables(5);
      const t = feed.tables.get(LT.toBase58());
      check(t && t[0] === addr.toBase58(), 'table loaded');
      check(JSON.stringify(txAsked) === JSON.stringify(['ok1', 'ok2']) && fetched.length === 1, `failed transactions skipped, table fetched once (${JSON.stringify({ txAsked, fetched })})`);
      await feed._prewarmTables(5);
      check(fetched.length === 1, 'a table already held is not fetched again');
    } finally {
      rpcPool.withFailover = saved;
    }
  });

  await test('host stats: event-loop delay, CPU and stolen CPU summarised', async () => {
    const hostStats = require(src('hostStats.js'));
    hostStats.start();
    await sleep(30);
    const until = Date.now() + 60;
    while (Date.now() < until) {} // a busy spell the event loop has to wait out
    await sleep(30);
    const s = hostStats.summary();
    hostStats.stop();
    check(/^\[Host\] Last <1 min: event-loop delay typical [\d.]+ ms, 99th percentile [\d.]+ ms, worst \d+ ms/.test(s), s);
    check(/the bot used \d+% of \d+ cores?/.test(s), `bot CPU share (${s})`);
    check(!hostStats.readCpu() || /CPU busy \d+%/.test(s), `machine CPU from /proc/stat (${s})`);
    const worst = Number((/worst (\d+) ms/.exec(s) || [])[1]);
    check(worst >= 40, `the 60 ms stall shows as the worst delay (${worst})`);
  });

  await test('shreds: router coin search by hash finds the same coin as a full derivation, fast', async () => {
    const { findPumpCoin, warmUp, PUMP } = require(src('shredDecode.js'));
    const { bondingCurvePda } = require('@pump-fun/pump-sdk');
    warmUp();
    const wallet = Keypair.generate().publicKey.toBase58();
    let ok = 0;
    const times = [];
    for (let i = 0; i < 40; i++) {
      const mint = Keypair.generate().publicKey;
      const others = Array.from({ length: 40 }, () => Keypair.generate().publicKey.toBase58());
      const keys = [wallet, ...others.slice(0, 25), mint.toBase58(), ...others.slice(25), bondingCurvePda(mint).toBase58(), PUMP];
      const t = process.hrtime.bigint();
      const c = findPumpCoin(keys, wallet);
      times.push(Number(process.hrtime.bigint() - t) / 1e6);
      if (c && c.mint === mint.toBase58() && c.pool === 'pump-curve') ok += 1;
    }
    times.sort((a, b) => a - b);
    check(ok === 40, `right coin every time (${ok}/40)`);
    check(times[20] < 4, `typically a few ms at most (median ${times[20].toFixed(2)} ms)`);
    const none = findPumpCoin([wallet, ...Array.from({ length: 10 }, () => Keypair.generate().publicKey.toBase58()), PUMP], wallet);
    check(none === null, 'no curve among the accounts: no coin');
  });

  await test('Helius Sender: a 429 (turned away, not forwarded) is retried with the same transaction', async () => {
    const { sendViaSender } = require(src('heliusSender.js'));
    const saved = global.fetch;
    const bodies = [];
    let replies = [429, 200];
    global.fetch = async (url, opts) => {
      bodies.push(opts.body);
      const status = replies.shift();
      const text = status === 200 ? JSON.stringify({ jsonrpc: '2.0', id: '1', result: 'sigOK' }) : '<html><body><h1>429 Too Many Requests</h1></body></html>';
      return { ok: status === 200, status, statusText: status === 200 ? 'OK' : 'Too Many Requests', text: async () => text };
    };
    try {
      const t = Date.now();
      const sig = await sendViaSender('dHg=');
      check(sig === 'sigOK' && bodies.length === 2 && new Set(bodies).size === 1, `sent twice, same transaction, then accepted (${bodies.length}, ${sig})`);
      check(Date.now() - t < 1000, 'retries are quick');
      replies = [429, 429, 429];
      bodies.length = 0;
      let err = null;
      try { await sendViaSender('dHg='); } catch (e) { err = e; }
      check(err && err.rateLimited && !err.ambiguous && bodies.length === 2, `still refused after a quick retry: flagged for the RPC fallback (${err && err.message.slice(0, 50)}, ${bodies.length})`);
      replies = [500];
      bodies.length = 0;
      err = null;
      try { await sendViaSender('dHg='); } catch (e) { err = e; }
      check(err && bodies.length === 1, 'other errors are not retried');
    } finally {
      global.fetch = saved;
    }
  });

  await test('Helius Sender refusing (429): the same signed transaction goes out through the RPC instead', async () => {
    const script = `
      const path = require('path');
      const src = (f) => path.join(process.cwd(), 'src', f);
      const { Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } = require('@solana/web3.js');
      const bs58m = require('bs58'); const bs58 = bs58m.default || bs58m;
      const rpcPool = require(src('rpcPool.js'));
      const sentRaw = [];
      rpcPool.withFailover = async (fn) => fn({ sendRawTransaction: async (raw, opts) => { sentRaw.push({ raw: Buffer.from(raw).toString('base64'), opts }); return bs58.encode(VersionedTransaction.deserialize(raw).signatures[0]); } });
      const senderBodies = [];
      globalThis.fetch = async (url, opts) => {
        if (String(url).includes('sender')) { senderBodies.push(JSON.parse(opts.body).params[0]); return { ok: false, status: 429, statusText: 'Too Many Requests', text: async () => '429' }; }
        throw new Error('unexpected ' + url);
      };
      const { JITO_TIP_ACCOUNTS } = require(src('jitoTip.js'));
      const payer = Keypair.fromSecretKey(bs58.decode(process.env.PRIVATE_KEY));
      const msg = new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: '11111111111111111111111111111111',
        instructions: [SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: JITO_TIP_ACCOUNTS[0], lamports: 1000000 })] }).compileToV0Message();
      const { signAndSendTx } = require(src('tradeExecutor.js'));
      signAndSendTx(new VersionedTransaction(msg), { feeSol: 0.0001 }).then((sig) => {
        console.log(JSON.stringify({ sig, senderTries: senderBodies.length, sameTx: senderBodies.length && sentRaw.length && senderBodies[0] === sentRaw[0].raw, opts: sentRaw[0] && sentRaw[0].opts }));
        process.exit(0);
      }).catch((e) => { console.log(JSON.stringify({ error: e.message })); process.exit(0); });
    `;
    const r = spawnSync(process.execPath, ['-e', script], { cwd: root, encoding: 'utf8', env: { ...process.env, SEND_VIA: 'sender' } });
    const line = (r.stdout || '').trim().split('\n').reverse().find((l) => l.startsWith('{')) || '';
    let out = null;
    try { out = JSON.parse(line); } catch {}
    check(out && !out.error, `sent (${line || (r.stderr || '').slice(-300)})`);
    if (!out || out.error) return;
    check(out.senderTries === 2, `Sender tried twice (${out.senderTries})`);
    check(out.sameTx && typeof out.sig === 'string' && out.sig.length > 40, 'the RPC got the very same signed transaction');
    check(out.opts && out.opts.skipPreflight === true && out.opts.maxRetries === 0, `sent without preflight or RPC retries (${JSON.stringify(out.opts)})`);
  });

  await test('on-chain errors: ProgramFailedToComplete explained as a likely compute shortfall', async () => {
    const { explainTxError } = require(src('txErrors.js'));
    const t = explainTxError({ InstructionError: [4, 'ProgramFailedToComplete'] }, 'pump-curve');
    check(/ran out of compute units/.test(t) && /PUMPFUN_COMPUTE_UNITS/.test(t) && /ProgramFailedToComplete/.test(t), t);
  });

  await test('AUTO_COMPUTE_UNITS: compute limits learned per kind of trade; the total fee is kept', async () => {
    const cb = require(src('computeBudget.js'));
    const cfg = require(src('config.js'));
    const { ComputeBudgetProgram, TransactionInstruction } = require('@solana/web3.js');
    cb._resetForTests();
    const payer = Keypair.generate().publicKey;
    const PUMPPK = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
    const make = (nAccounts) => {
      const keys = Array.from({ length: nAccounts }, () => ({ pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: true }));
      const msg = new TransactionMessage({
        payerKey: payer,
        recentBlockhash: '11111111111111111111111111111111',
        instructions: [
          ComputeBudgetProgram.setComputeUnitLimit({ units: 300000 }),
          ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 5000 }),
          new TransactionInstruction({ programId: PUMPPK, keys, data: Buffer.alloc(24) }),
          SystemProgram.transfer({ fromPubkey: payer, toPubkey: payer, lamports: 1000 })
        ]
      }).compileToV0Message();
      return new VersionedTransaction(msg);
    };
    const fee = 1_500_000; // 0.0015 SOL
    const t1 = make(16);
    const kind = cb.kindOf(t1, 'buy');
    check(kind === 'buy|6EF8rr|spl|a16', `kind (${kind})`);
    check(cb.limitOf(t1) === 300000, 'reads the limit');
    // Still learning: left alone.
    let f = cb.fit(t1, 'buy', fee);
    check(!f.learned && f.limit === 300000 && cb.limitOf(t1) === 300000, `not learned yet (${JSON.stringify(f)})`);
    ['s1', 's2', 's3'].forEach((sig, i) => { cb.remember(sig, kind, 300000); cb.observe(sig, [80000, 88000, 85000][i]); });
    const t2 = make(16);
    f = cb.fit(t2, 'buy', fee);
    const expect = Math.ceil(88000 * 1.1) + 3000;
    check(f.learned && f.limit === expect && cb.limitOf(t2) === expect, `learned limit ${f.limit} (expected ${expect})`);
    const priceIx = t2.message.compiledInstructions.find((ix) => ix.data[0] === 3);
    const price = Number(Buffer.from(priceIx.data).readBigUInt64LE(1));
    check(Math.abs((price * expect) / 1e6 - fee) < expect / 1e6 + 1, `total fee kept at ~${fee} lamports (${(price * expect) / 1e6})`);
    // Another kind (more accounts, e.g. a cashback coin) is learned separately.
    const t3 = make(18);
    check(!cb.fit(t3, 'buy', fee).learned && cb.limitOf(t3) === 300000, 'a different kind of trade keeps the full limit');
    // Ran out anyway: its kind gets more at once.
    cb.remember('s4', kind, expect, true);
    cb.ranOut('s4');
    const t4 = make(16);
    const f4 = cb.fit(t4, 'buy', fee);
    check(f4.limit > expect, `raised after running out (${f4.limit} > ${expect})`);
    check(cb.wasLearned('s4') && !cb.wasLearned('s1'), 'remembers which sends used a learned limit');
    // Never above the ceiling; off when switched off.
    ['c1', 'c2', 'c3'].forEach((sig) => { cb.remember(sig, kind, 300000); cb.observe(sig, 299000); });
    check(cb.fit(make(16), 'buy', fee).limit === 300000, 'never above the transaction\'s own limit');
    const saved = cfg.AUTO_COMPUTE_UNITS;
    cfg.AUTO_COMPUTE_UNITS = false;
    cb._resetForTests();
    ['d1', 'd2', 'd3'].forEach((sig) => { cb.remember(sig, kind, 300000); cb.observe(sig, 50000); });
    check(!cb.fit(make(16), 'buy', fee).learned, 'AUTO_COMPUTE_UNITS=false: always the full limit');
    cfg.AUTO_COMPUTE_UNITS = saved;
    cb._resetForTests();
  });

  process.stdout.write('\n__UNIT__' + JSON.stringify(results) + '\n');
  process.exit(0);
})();
