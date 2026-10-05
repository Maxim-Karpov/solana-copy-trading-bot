// test/unit_processed.js — DETECTION_COMMITMENT=processed fast path, run in a
// scratch copy of the bot (cwd) with that setting on. Uses a real local
// websocket server and real Pump.fun TradeEvents encoded by the official SDK.
const path = require('path');
const { Keypair, PublicKey } = require('@solana/web3.js');
const BN = require('bn.js');
const { PUMP_SDK } = require('@pump-fun/pump-sdk');

const root = process.cwd();
const src = (f) => path.join(root, 'src', f);
const results = [];
let current = null;
const check = (cond, msg) => { if (!cond) current.failures.push(msg); };
async function test(name, fn) {
  current = { name, failures: [] };
  try { await fn(); } catch (e) { current.failures.push('threw: ' + (e.stack || e)); }
  results.push(current);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PUMP = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const COPY = process.env.COPY_WALLET;
const pk = () => Keypair.generate().publicKey;

function tradeEventLine({ mint, user, sol, tokens, isBuy }) {
  const z = new BN(0);
  const body = PUMP_SDK.offlinePumpProgram.coder.types.encode('tradeEvent', {
    mint: new PublicKey(mint), solAmount: new BN(String(sol)), tokenAmount: new BN(String(tokens)), isBuy,
    user: new PublicKey(user), timestamp: new BN(1700000000), virtualSolReserves: z, virtualTokenReserves: z,
    realSolReserves: z, realTokenReserves: z, feeRecipient: pk(), feeBasisPoints: z, fee: z, creator: pk(),
    creatorFeeBasisPoints: z, creatorFee: z, trackVolume: false, totalUnclaimedTokens: z, totalClaimedTokens: z,
    currentSolVolume: z, lastUpdateTimestamp: z, ixName: isBuy ? 'buy' : 'sell', mayhemMode: false,
    cashbackFeeBasisPoints: z, cashback: z, buybackFeeBasisPoints: z, buybackFee: z, shareholders: [],
    quoteMint: pk(), quoteAmount: z, virtualQuoteReserves: z, realQuoteReserves: z, holderRewardsBps: z, holderRewards: z
  });
  const disc = Buffer.from('bddb7fd34ee661ee', 'hex');
  return 'Program data: ' + Buffer.concat([disc, body]).toString('base64');
}
const pumpLogs = (...dataLines) => [
  `Program ComputeBudget111111111111111111111111111111 invoke [1]`,
  `Program ComputeBudget111111111111111111111111111111 success`,
  `Program ${PUMP} invoke [1]`,
  'Program log: Instruction: Buy',
  ...dataLines,
  `Program ${PUMP} consumed 40000 of 200000 compute units`,
  `Program ${PUMP} success`
];

(async () => {
  await test('fastPumpParser: reads the copy wallet\'s trades, ignores others, spoofs and truncated logs', async () => {
    const { decodePumpTradesFromLogs } = require(src('fastPumpParser.js'));
    const mint = pk().toBase58();
    const mine = tradeEventLine({ mint, user: COPY, sol: 250000000, tokens: 1234567890, isBuy: true });
    const theirs = tradeEventLine({ mint, user: pk().toBase58(), sol: 1, tokens: 1, isBuy: true });
    const t = decodePumpTradesFromLogs(pumpLogs(theirs, mine), COPY);
    check(t.length === 1 && t[0].mint === mint && t[0].solLamports === 250000000n && t[0].tokenRaw === 1234567890n && t[0].isBuy,
      `decoded (${JSON.stringify(t, (k, v) => (typeof v === 'bigint' ? v.toString() : v))})`);

    const spoof = ['Program Evi1111111111111111111111111111111111111 invoke [1]', mine, 'Program Evi1111111111111111111111111111111111111 success'];
    check(decodePumpTradesFromLogs(spoof, COPY).length === 0, 'event printed by another program is ignored');
    check(decodePumpTradesFromLogs([...pumpLogs(mine), 'Log truncated'], COPY) === null, 'truncated logs -> null (use full path)');
  });

  // --- websocket, processed mode ---
  const { WebSocketServer } = require('ws');
  const port = Number(process.env.__WS_PORT);
  const wss = new WebSocketServer({ port });
  let subscribeCommitment = null;
  const subscribeMethods = [];
  let txSubParams = null;
  let rejectTxSub = false;
  let sock = null;
  wss.on('connection', (s) => {
    sock = s;
    s.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      subscribeMethods.push(msg.method);
      if (msg.method === 'transactionSubscribe') {
        txSubParams = msg.params;
        if (rejectTxSub) s.send(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'Method not found' } }));
        else s.send(JSON.stringify({ jsonrpc: '2.0', id: 1, result: 8 }));
        return;
      }
      if (msg.method === 'logsSubscribe') {
        subscribeCommitment = msg.params[1].commitment;
        s.send(JSON.stringify({ jsonrpc: '2.0', id: 1, result: 7 }));
      }
    });
  });
  const notify = (signature, logs, slot) =>
    sock.send(JSON.stringify({ jsonrpc: '2.0', method: 'logsNotification', params: { result: { context: { slot }, value: { signature, err: null, logs } } } }));

  const rpcPool = require(src('rpcPool.js'));
  const calls = { getParsedTransaction: 0, balance: [] };
  let balanceReply = null;
  let parsedTxReply = null;
  rpcPool.withFailover = async (fn) => fn({
    getParsedTransaction: async (sig, opts) => { calls.getParsedTransaction += 1; calls.txOpts = opts; return parsedTxReply; },
    getParsedTokenAccountsByOwner: async (owner, filter, commitment) => {
      calls.balance.push({ owner: owner.toBase58(), commitment });
      return balanceReply;
    }
  });

  const CopyEmitter = require(src('websocket.js'));
  const em = new CopyEmitter();
  const events = [];
  em.on('copyTrade', (e) => events.push(e));
  em.connect();
  const t0 = Date.now();
  while (!subscribeCommitment && Date.now() - t0 < 3000) await sleep(20);

  const waitEvents = async (n, ms = 3000) => {
    const s = Date.now();
    while (events.length < n && Date.now() - s < ms) await sleep(10);
  };
  const tokenAcct = (amount) => ({ account: { data: { parsed: { info: { tokenAmount: { amount: String(amount), decimals: 6 } } } } } });

  await test('processed mode: subscribes at "processed"', async () => {
    check(subscribeCommitment === 'processed', `commitment ${subscribeCommitment}`);
  });

  await test('processed mode: Pump.fun buy emitted straight from the logs, no transaction fetch', async () => {
    const mint = pk().toBase58();
    events.length = 0;
    calls.getParsedTransaction = 0;
    const tStart = Date.now();
    notify('fastBuy1', pumpLogs(tradeEventLine({ mint, user: COPY, sol: 500000000, tokens: 1000000000, isBuy: true })), 5000);
    await waitEvents(1);
    const e = events[0];
    check(e && e.trade === 'buy' && e.ca === mint && Math.abs(e.solAmount + 0.5) < 1e-12 && e.slot === 5000 && e.dexs[0] === 'Pump.fun',
      `buy event (${JSON.stringify(e)})`);
    check(calls.getParsedTransaction === 0, `no getTransaction round trip (${calls.getParsedTransaction})`);
    check(Date.now() - tStart < 500, `fast (${Date.now() - tStart}ms)`);
    check(e && Math.abs(e.copyPriceSol - 0.0005) < 1e-15 && e.copyPriceExact === true, `exact copy price 0.5 SOL / 1000 tokens (${e && e.copyPriceSol})`);
    check(e && e.curveHint && e.curveHint.mint === mint && typeof e.curveHint.at === 'number' && typeof e.curveHint.virtualSolReserves === 'string',
      `his trade record travels with the event, for a no-lookup build (${JSON.stringify(e && e.curveHint)})`);
  });

  await test('confirmed path: Pump.fun buy price read exactly from the transaction\'s logs', async () => {
    const mint = pk().toBase58();
    events.length = 0;
    parsedTxReply = {
      slot: 7500,
      meta: {
        err: null, fee: 5000, preBalances: [10e9], postBalances: [9.3e9], innerInstructions: [],
        preTokenBalances: [], postTokenBalances: [{ owner: COPY, mint, uiTokenAmount: { amount: '2000000000', decimals: 6 } }],
        logMessages: pumpLogs(tradeEventLine({ mint, user: COPY, sol: 600000000, tokens: 2000000000, isBuy: true }))
      },
      transaction: { signatures: ['truncBuy'], message: { accountKeys: [{ pubkey: new PublicKey(COPY) }], instructions: [] } }
    };
    notify('truncBuy', ['Log truncated'], 7500); // forces the full-transaction path
    await waitEvents(1);
    const e = events[0];
    // Wallet spent 0.7 SOL in total (fees, account rent...), but the swap itself was 0.6 SOL for 2000 tokens.
    check(e && e.trade === 'buy' && Math.abs(e.copyPriceSol - 0.0003) < 1e-15 && e.copyPriceExact === true, `swap price from logs, not balance change (${JSON.stringify(e)})`);
    calls.getParsedTransaction = 0;
  });

  await test('processed mode: sell % from the copy wallet\'s balance at the processed stage', async () => {
    const mint = pk().toBase58();
    events.length = 0;
    calls.balance.length = 0;
    balanceReply = { context: { slot: 6000 }, value: [tokenAcct(600e6)] }; // 600 left after selling 400
    notify('fastSell1', pumpLogs(tradeEventLine({ mint, user: COPY, sol: 200000000, tokens: 400e6, isBuy: false })), 6000);
    await waitEvents(1);
    const e = events[0];
    check(e && e.trade === 'sell' && Math.abs(e.sellPercent - 40) < 1e-9 && e.tokenAmount < 0, `40% sell (${JSON.stringify(e)})`);
    check(calls.balance[0] && calls.balance[0].owner === COPY && calls.balance[0].commitment === 'processed', `balance read at processed (${JSON.stringify(calls.balance[0])})`);
    check(calls.getParsedTransaction === 0, 'no getTransaction round trip');
  });

  await test('processed mode: stale balance (node behind the trade) -> falls back to the confirmed path', async () => {
    const mint = pk().toBase58();
    events.length = 0;
    calls.getParsedTransaction = 0;
    balanceReply = { context: { slot: 6999 }, value: [tokenAcct(1000e6)] }; // hasn't seen the sell yet
    parsedTxReply = {
      slot: 7000,
      meta: { err: null, fee: 5000, preBalances: [1e9], postBalances: [1.2e9], preTokenBalances: [{ owner: COPY, mint, uiTokenAmount: { amount: '1000000000', decimals: 6 } }], postTokenBalances: [{ owner: COPY, mint, uiTokenAmount: { amount: '0', decimals: 6 } }], innerInstructions: [] },
      transaction: { signatures: ['fastSell2'], message: { accountKeys: [{ pubkey: new PublicKey(COPY) }], instructions: [] } }
    };
    notify('fastSell2', pumpLogs(tradeEventLine({ mint, user: COPY, sol: 200000000, tokens: 1000e6, isBuy: false })), 7000);
    await waitEvents(1);
    const e = events[0];
    check(calls.getParsedTransaction >= 1, 'used the full transaction');
    check(calls.txOpts && calls.txOpts.maxSupportedTransactionVersion >= 1, `asks for version-1 transactions too (${JSON.stringify(calls.txOpts)})`);
    check(events.length === 1 && e.trade === 'sell' && e.sellPercent === 100, `correct 100% from the confirmed tx, emitted once (${JSON.stringify(events)})`);
  });

  await test('processed mode: non-Pump.fun transaction still handled via the confirmed path', async () => {
    const mint = pk().toBase58();
    events.length = 0;
    calls.getParsedTransaction = 0;
    parsedTxReply = {
      slot: 8000,
      meta: { err: null, fee: 5000, preBalances: [10e9], postBalances: [9e9 - 5000], preTokenBalances: [{ owner: 'poolVault', mint: 'Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh', uiTokenAmount: { amount: '100', decimals: 8 } }], postTokenBalances: [{ owner: COPY, mint, uiTokenAmount: { amount: '5000000', decimals: 6 } }, { owner: 'poolVault', mint: 'Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh', uiTokenAmount: { amount: '200', decimals: 8 } }], innerInstructions: [] },
      transaction: { signatures: ['rayBuy'], message: { accountKeys: [{ pubkey: new PublicKey(COPY) }], instructions: [] } }
    };
    notify('rayBuy', ['Program 675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8 invoke [1]', 'Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA invoke [2]', 'Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA success', 'Program 675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8 success'], 8000);
    await waitEvents(1);
    check(calls.getParsedTransaction >= 1 && events[0] && events[0].trade === 'buy' && events[0].ca === mint, `fallback worked (${JSON.stringify(events)})`);
    check(events[0] && Math.abs(events[0].copyPriceSol - Math.abs(events[0].solAmount) / 5) < 1e-12 && events[0].copyPriceExact === false, `approximate copy price from balance changes (${events[0] && events[0].copyPriceSol})`);
    check(events[0] && events[0].pairedStock === 'Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh', `stock pairing detected from the pool vault (${events[0] && events[0].pairedStock})`);
  });

  await test('no transaction lookup for activity that never touches a token (plain SOL transfer, tips)', async () => {
    events.length = 0;
    calls.getParsedTransaction = 0;
    for (let k = 0; k < 5; k++) {
      notify(`solOnly${k}`, ['Program 11111111111111111111111111111111 invoke [1]', 'Program 11111111111111111111111111111111 success'], 9000 + k);
    }
    await sleep(1500);
    check(calls.getParsedTransaction === 0 && events.length === 0, `no lookups (${calls.getParsedTransaction}) and no events (${events.length})`);
    const { cannotBeTokenActivity } = require(src('websocket.js'));
    check(cannotBeTokenActivity(['Program 11111111111111111111111111111111 invoke [1]']) === true, 'SOL-only logs skipped');
    check(cannotBeTokenActivity(['Program X invoke [1]', 'Program TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb invoke [2]']) === false, 'Token-2022 activity fetched');
    check(cannotBeTokenActivity(['Program 11111111111111111111111111111111 invoke [1]', 'Log truncated']) === false, 'truncated logs fetched');
    check(cannotBeTokenActivity(undefined) === false && cannotBeTokenActivity([]) === false, 'missing logs fetched');
  });

  await test('spam signed by someone else: looked up once, then look-alikes skipped; forgotten if the copy wallet signs one', async () => {
    const SPAM = ['Program DKspam1111111111111111111111111111111111 invoke [1]', 'Program log: Instruction: Route',
      'Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA invoke [2]', 'Program log: Instruction: TransferChecked',
      'Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA success', 'Program data: abc', 'Program DKspam1111111111111111111111111111111111 success'];
    const other = pk();
    const reply = (signerIsCopy) => ({
      slot: 9100,
      meta: { err: null, fee: 5000, preBalances: [1e9, 1e9], postBalances: [1e9 - 5000, 1e9], preTokenBalances: [], postTokenBalances: [], innerInstructions: [], logMessages: SPAM },
      transaction: { signatures: ['x'], message: { accountKeys: [
        { pubkey: signerIsCopy ? new PublicKey(COPY) : other, signer: true },
        { pubkey: signerIsCopy ? other : new PublicKey(COPY), signer: false }
      ], instructions: [] } }
    });
    events.length = 0;
    calls.getParsedTransaction = 0;
    parsedTxReply = reply(false);
    notify('spam0', SPAM, 9100);
    await sleep(700);
    check(calls.getParsedTransaction === 1, `first one looked up (${calls.getParsedTransaction})`);
    for (let k = 1; k <= 25; k++) notify(`spam${k}`, SPAM, 9100 + k);
    await sleep(1500);
    check(calls.getParsedTransaction === 2, `25 look-alikes: only the 20th spot-checked (${calls.getParsedTransaction} lookups)`);
    check(events.length === 0, 'no events from spam');
    // The copy wallet signs a transaction of that shape: spot-check catches it, shape forgotten.
    parsedTxReply = reply(true);
    for (let k = 26; k <= 40; k++) notify(`spamB${k}`, SPAM, 9200 + k);
    await sleep(1500);
    const before = calls.getParsedTransaction;
    check(before === 3, `next spot-check made (${before})`);
    notify('afterForget', SPAM, 9300);
    await sleep(700);
    check(calls.getParsedTransaction === before + 1, 'after the copy wallet signed one, look-alikes are looked up again');
    const { logShape } = require(src('websocket.js'));
    check(logShape(SPAM) === logShape([...SPAM.slice(0, 5), 'Program data: zzz', SPAM[6]]), 'shape ignores event data');

    // Look-alikes of a swap on a known exchange, or of a plain token transfer,
    // are never skipped: the copy wallet's own sells/transfers look the same.
    for (const [label, logs] of [
      ['PumpSwap swap', ['Program pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA invoke [1]', 'Program log: Instruction: Sell', 'Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA invoke [2]', 'Program log: Instruction: TransferChecked']],
      ['plain transfer', ['Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA invoke [1]', 'Program log: Instruction: TransferChecked']]
    ]) {
      parsedTxReply = { ...reply(false), meta: { ...reply(false).meta, logMessages: logs } };
      const n0 = calls.getParsedTransaction;
      for (let k = 0; k < 5; k++) notify(`${label}${k}`, logs, 9400 + k);
      await sleep(1200);
      check(calls.getParsedTransaction - n0 === 5, `${label}: every one looked up (${calls.getParsedTransaction - n0} of 5)`);
    }
  });

  // --- DETECTION_FEED=transaction (Helius transactionSubscribe) ---
  em.disconnect();
  await sleep(100);
  const cfg = require(src('config.js'));
  cfg.DETECTION_FEED = 'transaction';
  const spamAccount = pk().toBase58();
  cfg.SHRED_EXCLUDE_ACCOUNTS = [spamAccount];
  const txNotify = (signature, tx, slot) =>
    sock.send(JSON.stringify({ jsonrpc: '2.0', method: 'transactionNotification', params: { subscription: 8, result: { signature, slot, transaction: tx } } }));
  // jsonParsed as it arrives over the wire: keys and program ids are strings.
  const wireTx = ({ signer, mint, logs = [] }) => ({
    version: 0,
    meta: { err: null, fee: 5000, preBalances: [10e9, 1e9], postBalances: [9e9 - 5000, 1e9], preTokenBalances: [],
      postTokenBalances: [{ accountIndex: 2, owner: COPY, mint, uiTokenAmount: { amount: '5000000', decimals: 6 } }],
      innerInstructions: [{ index: 0, instructions: [{ programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', parsed: { type: 'transfer' } }] }], logMessages: logs },
    transaction: { signatures: ['sig'], message: {
      accountKeys: [{ pubkey: signer, signer: true, writable: true, source: 'transaction' }, { pubkey: signer === COPY ? pk().toBase58() : COPY, signer: false, writable: true, source: 'transaction' }, { pubkey: pk().toBase58(), signer: false, writable: true, source: 'transaction' }],
      instructions: [{ programId: 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo', accounts: [], data: '' }] } }
  });

  await test('transaction feed: subscribes with failed transactions filtered out; trades need no lookup; spam dropped', async () => {
    subscribeMethods.length = 0;
    const em2 = new CopyEmitter();
    const ev2 = [];
    em2.on('copyTrade', (e) => ev2.push(e));
    em2.connect();
    const s0 = Date.now();
    while (!txSubParams && Date.now() - s0 < 3000) await sleep(20);
    check(subscribeMethods[0] === 'transactionSubscribe', `method ${JSON.stringify(subscribeMethods)}`);
    check(txSubParams && txSubParams[0].failed === false && txSubParams[0].accountInclude[0] === COPY, `filter ${JSON.stringify(txSubParams && txSubParams[0])}`);
    check(txSubParams && JSON.stringify(txSubParams[0].accountExclude) === JSON.stringify([spamAccount]), `spam accounts excluded too (${JSON.stringify(txSubParams && txSubParams[0])})`);
    check(txSubParams && txSubParams[1].commitment === 'processed' && txSubParams[1].encoding === 'jsonParsed' && txSubParams[1].transactionDetails === 'full', `options ${JSON.stringify(txSubParams && txSubParams[1])}`);
    await sleep(100);
    calls.getParsedTransaction = 0;
    const mint = pk().toBase58();
    txNotify('meteoraBuy', wireTx({ signer: COPY, mint }), 9500);
    for (let k = 0; k < 10; k++) txNotify(`spamT${k}`, wireTx({ signer: pk().toBase58(), mint: pk().toBase58() }), 9501);
    const s1 = Date.now();
    while (ev2.length < 1 && Date.now() - s1 < 2000) await sleep(10);
    await sleep(200);
    check(ev2.length === 1 && ev2[0].trade === 'buy' && ev2[0].ca === mint && ev2[0].slot === 9500, `one buy event (${JSON.stringify(ev2)})`);
    check(ev2[0] && ev2[0].dexs.includes('Meteora Dlmm'), `venue identified (${ev2[0] && ev2[0].dexs})`);
    check(ev2[0] && Math.abs(ev2[0].copyPriceSol - Math.abs(ev2[0].solAmount) / 5) < 1e-12, 'copy price from the transaction');
    check(calls.getParsedTransaction === 0, `no lookups (${calls.getParsedTransaction})`);
    check(ev2[0] && ev2[0].copyHeldBefore === false, 'first buy: copy wallet held none of the coin before');
    const heldTx = wireTx({ signer: COPY, mint });
    heldTx.meta.preTokenBalances = [{ accountIndex: 2, owner: COPY, mint, uiTokenAmount: { amount: '1000', decimals: 6 } }];
    txNotify('addOnBuy', heldTx, 9600);
    const s2 = Date.now();
    while (ev2.length < 2 && Date.now() - s2 < 2000) await sleep(10);
    check(ev2[1] && ev2[1].copyHeldBefore === true, `later buy: already held (read from its transaction) (${JSON.stringify(ev2[1] && ev2[1].copyHeldBefore)})`);
    em2.disconnect();
    await sleep(100);
  });

  await test('transaction feed refused (free plan / other provider): falls back to the logs feed', async () => {
    cfg.DETECTION_FEED = 'transaction';
  const spamAccount = pk().toBase58();
  cfg.SHRED_EXCLUDE_ACCOUNTS = [spamAccount];
    rejectTxSub = true;
    subscribeMethods.length = 0;
    const em3 = new CopyEmitter();
    em3.connect();
    const s0 = Date.now();
    while (!subscribeMethods.includes('logsSubscribe') && Date.now() - s0 < 9000) await sleep(50);
    check(subscribeMethods[0] === 'transactionSubscribe' && subscribeMethods.includes('logsSubscribe'), `fell back (${JSON.stringify(subscribeMethods)})`);
    check(em3.feed === 'logs', `feed now ${em3.feed}`);
    em3.disconnect();
    rejectTxSub = false;
    cfg.DETECTION_FEED = 'logs';
  });

  em.disconnect();
  wss.close();
  process.stdout.write('\n__UNIT__' + JSON.stringify(results) + '\n');
  process.exit(0);
})();
