// test/mocks.js
//
// Replaces every network boundary of the bot with an in-memory simulation,
// by pre-seeding Node's require cache before src/index.js is loaded:
//   - src/tradeExecutor.js  (SolanaPortal / Jito / direct swaps)
//   - src/rpcPool.js        (Solana RPC: statuses, parsed txs, balances)
//   - src/priceChecker.js   (DexScreener)
//   - src/websocket.js      (copy-wallet trade feed)
//   - the Telegram Bot API (via fetch)
// A tiny "ledger" tracks our simulated wallet so balances, fills and
// proceeds are consistent with what the bot asked for.
const path = require('path');
const EventEmitter = require('events');
const { PublicKey, Keypair } = require('@solana/web3.js');

const SOL_USD = 100; // simulated SOL price: priceInSol = priceUsd / SOL_USD
const FEE_LAMPORTS = 5000;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function installMocks(rootDir, walletAddress) {
  const srcPath = (f) => path.join(rootDir, 'src', f);
  const { uiToRaw } = require(srcPath('amounts.js'));

  const ledger = {
    wallet: walletAddress,
    lamports: 1000n * 1_000_000_000n,
    tokens: new Map(), // mint -> raw BigInt
    decimals: 6,
    prices: new Map(), // mint -> priceUsd (number) | null
    txs: new Map(), // sig -> { state, err, lamportsDelta, tokenDelta, mint, visibleAt }
    counter: 0,
    buyQueue: [], // behaviours for upcoming buys: 'ok' | 'throw' | 'failOnChain' | 'noTokens' | {delayMs}
    sellQueue: [], // behaviours for upcoming sells: 'ok' | 'throw' | 'failOnChain' | 'timeout' | 'landLate'
    buyDelayMs: 0,
    quotePrices: new Map(), // mint -> quoted SOL per token (MAX_ENTRY_PREMIUM_PCT); unset = no quote
    lighthouseMissing: false,
    buyTimings: new Map(), // our buy signature -> { buildMs, sendMs, sentAt }
    computeUnits: null, // compute units our txs report using (null = not reported)
    copyHeldNow: new Set(), // mints the copy wallet holds right now (getParsedTokenAccountsByOwner)
    coinInfo: new Map(), // mint -> { mcapSol, creator } as a direct build would report it; unset = no direct build
    landedSlot: null, // slot reported for confirmed txs (null = not reported)
    copySlots: new Map(), // copy wallet's signature -> the slot it landed in (as the chain reports it)
    statusLookups: [], // signatures asked for in each getSignatureStatuses call
    processedForMs: 0, // our buys show as "processed" this long before "confirmed" (INSTANT_SELL)
    processedReads: 0, // token reads at "processed" (INSTANT_SELL)
    processedZeroReads: 0, // next N of them see no tokens yet (a node a moment behind)
    accountListeners: new Map(), // id -> { key, cb } (onAccountChange)
    accountPushMs: null, // our token account is pushed this long after a buy lands (null = no push)
    buyStatusDelayMs: 0, // our buys' status shows up this late
    buyLogs: null, // logMessages put on our own txs (e.g. a Pump.fun TradeEvent)
    holders: null, // { supplyRaw: BigInt, largest: [{ address, owner, amount: BigInt }], others: Map owner -> BigInt }
    tokenAccounts: new Map(), // mint -> fake token-account address (one per coin held)
    extraAccounts: [], // other token accounts in the wallet: { pubkey, mint, amount: BigInt, program: 'spl' | '2022' }
    closedAccounts: [], // addresses closed by the account cleaner
    closedPrograms: {}, // address -> token program used to close it
    closeTxs: 0,
    mintTaxBps: new Map(), // mint -> Token-2022 transfer fee (basis points); absent = plain SPL coin
    taxLookups: [], // mints whose account was looked up for a tax
    taxLookupFails: 0, // next N tax lookups throw
    parsedTxUnavailable: false,
    balanceFailures: 0, // next N balance reads throw (RPC outage)
    zeroGlitches: 0, // next N balance reads wrongly report no account (lagging node)
    sellFailuresByMint: new Map(), // mint -> next N sells of that mint throw
    calls: { buy: [], sell: [] },
    priceRequests: [] // mints asked for in each batched price request
  };

  function priceSol(mint) {
    const usd = ledger.prices.get(mint);
    return usd ? usd / SOL_USD : 0.00001;
  }

  function newSig(kind) {
    ledger.counter += 1;
    return `${kind}Sig${ledger.counter}`;
  }

  function pushTokenAccount(mint) {
    if (ledger.accountPushMs === null) return;
    const { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } = require('@solana/spl-token');
    const ata = getAssociatedTokenAddressSync(new PublicKey(mint), new PublicKey(ledger.wallet), true, TOKEN_PROGRAM_ID).toBase58();
    setTimeout(() => {
      for (const { key, cb } of ledger.accountListeners.values()) {
        if (key !== ata) continue;
        const data = Buffer.alloc(165);
        data.writeBigUInt64LE(ledger.tokens.get(mint) || 0n, 64);
        cb({ data, owner: TOKEN_PROGRAM_ID, lamports: 2039280 });
      }
    }, ledger.accountPushMs);
  }

  function settle(sig, rec) {
    ledger.txs.set(sig, rec);
    if (rec.state === 'confirmed') {
      ledger.lamports += BigInt(rec.lamportsDelta);
      ledger.tokens.set(rec.mint, (ledger.tokens.get(rec.mint) || 0n) + rec.tokenDelta);
      if (rec.tokenDelta > 0n) pushTokenAccount(rec.mint);
      if (rec.tokenDelta > 0n && ledger.tokenAccounts.get(rec.mint) === 'closed') ledger.tokenAccounts.delete(rec.mint); // re-opened by a buy
    }
  }

  // ---- tradeExecutor mock ----
  const tradeExecutor = {
    buyTiming: (sig) => ledger.buyTimings.get(sig) || null,
    // INSTANT_SELL: the coin's state read as the buy goes out.
    prewarmSell(mint) {
      ledger.calls.prewarmSell = (ledger.calls.prewarmSell || 0) + 1;
    },
    // FAST_PATH="rust": a buy the fast path sent, recorded here.
    noteExternalBuy(sig, t) {
      ledger.calls.external = (ledger.calls.external || 0) + 1;
      ledger.buyTimings.set(sig, { buildMs: t.buildMs, sendMs: t.sendMs, sentAt: t.sentAt });
    },
    // For tests: settle a buy as the fast path would have sent it (not counted as ours).
    async simulateFastBuy(mint, amountSol) {
      const sig = await tradeExecutor.buyToken({ mint, amountSol, tip: 0 });
      ledger.calls.buy.pop();
      return sig;
    },
    async buyToken(args) {
      if (args.dryRun) {
        // Rehearsal (paused): built and signed, nothing sent.
        ledger.calls.rehearsals = (ledger.calls.rehearsals || 0) + 1;
        if (args.coinFilter) {
          const { checkCoinFilters } = require(srcPath('buyQuote.js'));
          const coin = ledger.coinInfo.get(args.mint);
          checkCoinFilters(coin ? { coin } : null, 'Pump.fun curve', args.coinFilter, args.mint);
        }
        return { dryRun: true, buildMs: 7, signMs: 1, readyAt: Date.now(), label: 'Pump.fun curve' };
      }
      ledger.calls.buy.push({ ...args, at: Date.now() });
      // MAX_ENTRY_PREMIUM_PCT, as the real buyToken does it (before sending).
      if (args.priceCheck && ledger.quotePrices.has(args.mint)) {
        const { EntryPriceTooHighError } = require(srcPath('buyQuote.js'));
        const premiumPct = (ledger.quotePrices.get(args.mint) / args.priceCheck.copyPriceSol - 1) * 100;
        if (premiumPct > args.priceCheck.maxPct) {
          throw new EntryPriceTooHighError(`price is +${premiumPct.toFixed(1)}%`, { premiumPct, maxPct: args.priceCheck.maxPct });
        }
      }
      // Instant buy filters, as the real buyToken checks them (before sending).
      if (args.coinFilter) {
        const { checkCoinFilters } = require(srcPath('buyQuote.js'));
        const coin = ledger.coinInfo.get(args.mint);
        checkCoinFilters(coin ? { coin } : null, 'Pump.fun curve', args.coinFilter, args.mint);
      }
      let behaviour = ledger.buyQueue.length ? ledger.buyQueue.shift() : 'ok';
      if (ledger.buyDelayMs) await sleep(ledger.buyDelayMs);
      if (behaviour === 'throw') throw new Error('SolanaPortal responded 500 Internal Server Error');
      const sig = newSig('buy');
      ledger.buyTimings.set(sig, { buildMs: 40, sendMs: 20, sentAt: Date.now() });
      const lamportsSpent = BigInt(Math.round(args.amountSol * 1e9));
      const tip = BigInt(Math.round((args.tip || 0) * 1e9));
      const tokensUi = args.amountSol / priceSol(args.mint);
      const tokenDelta = behaviour === 'noTokens' ? 0n : uiToRaw(tokensUi.toFixed(ledger.decimals), ledger.decimals);
      // MAX_SLOTS_BEHIND: the real buy carries the slot guard as instruction 2
      // (after the compute budget); landing after maxSlot makes it fail there.
      const guard = args.slotGuard;
      if (guard) require(srcPath('slotGuard.js')).remember(sig, { maxSlot: guard.maxSlot, ixIndex: 2 });
      if (guard && typeof ledger.landedSlot === 'number' && ledger.landedSlot > guard.maxSlot) {
        settle(sig, { state: 'failed', err: { InstructionError: [2, { Custom: 6001 }] }, mint: args.mint, lamportsDelta: -FEE_LAMPORTS, tokenDelta: 0n });
      } else if (behaviour === 'failOnChain') {
        settle(sig, { state: 'failed', err: { InstructionError: [2, { Custom: 6002 }] }, mint: args.mint, lamportsDelta: -FEE_LAMPORTS, tokenDelta: 0n });
      } else {
        settle(sig, {
          state: 'confirmed',
          err: null,
          mint: args.mint,
          lamportsDelta: -Number(lamportsSpent + tip) - FEE_LAMPORTS,
          tipLamports: Number(tip),
          tokenDelta,
          ...(ledger.processedForMs ? { confirmedAt: Date.now() + ledger.processedForMs } : {}),
          ...(ledger.buyStatusDelayMs ? { visibleAt: Date.now() + ledger.buyStatusDelayMs } : {})
        });
      }
      if (behaviour === 'ambiguousLanded') {
        // The tx went out and lands, but the connection dropped before Jito answered.
        const e = new Error('Jito sendTransaction outcome unknown (socket hang up)');
        e.txSignature = sig;
        throw e;
      }
      return sig;
    },
    async sellToken(args) {
      ledger.calls.sell.push({ ...args, at: Date.now() });
      const behaviour = ledger.sellQueue.length ? ledger.sellQueue.shift() : 'ok';
      if (behaviour === 'throw') throw new Error('Jito sendTransaction failed: 429 Too Many Requests');
      const failN = ledger.sellFailuresByMint.get(args.mint) || 0;
      if (failN > 0) {
        ledger.sellFailuresByMint.set(args.mint, failN - 1);
        throw new Error('Jito sendTransaction failed: 429 Too Many Requests');
      }
      const amountRaw = uiToRaw(args.amountTokens, ledger.decimals);
      const held = ledger.tokens.get(args.mint) || 0n;
      if (amountRaw > held) throw new Error(`Insufficient SPL token balance (have ${held}, need ${amountRaw})`);
      if (amountRaw <= 0n) throw new Error('Amount must be greater than zero');
      const sig = newSig('sell');
      const proceeds = Math.round((Number(amountRaw) / 10 ** ledger.decimals) * priceSol(args.mint) * 1e9);
      const tip = Math.round((args.tip || 0) * 1e9);
      const rec = {
        state: 'confirmed',
        err: null,
        mint: args.mint,
        lamportsDelta: proceeds - tip - FEE_LAMPORTS,
        tipLamports: tip,
        tokenDelta: -amountRaw
      };
      if (behaviour === 'failOnChain') {
        settle(sig, { state: 'failed', err: { InstructionError: [3, { Custom: 6003 }] }, mint: args.mint, lamportsDelta: -FEE_LAMPORTS, tokenDelta: 0n });
      } else if (behaviour === 'timeout') {
        ledger.txs.set(sig, { state: 'pending' }); // never lands
      } else if (behaviour === 'ambiguousLanded') {
        settle(sig, rec);
        const e = new Error('Jito sendTransaction outcome unknown (socket hang up)');
        e.txSignature = sig;
        throw e;
      } else if (behaviour === 'ambiguousLandsSoon') {
        // The send call errors and the sale only shows up (status AND balance)
        // a moment later, as on a lagging RPC node.
        ledger.txs.set(sig, { state: 'pending' });
        setTimeout(() => settle(sig, rec), 300);
        const e = new Error('Sender outcome unknown (socket hang up)');
        e.txSignature = sig;
        throw e;
      } else if (behaviour === 'landLate') {
        // Lands on-chain, but only becomes visible after the bot's confirm
        // timeout — simulates a slow landing.
        settle(sig, rec);
        ledger.txs.set(sig, { ...rec, state: 'confirmed', visibleAt: Date.now() + 1e9 });
      } else {
        settle(sig, rec);
      }
      return sig;
    }
  };

  function computeLimitData(units) {
    const b = Buffer.alloc(5);
    b[0] = 2;
    b.writeUInt32LE(units, 1);
    const bs = require('bs58');
    return (bs.default || bs).encode(b);
  }

  // ---- RPC mock ----
  function tokenBalanceEntries(mint, raw) {
    return [{ owner: ledger.wallet, mint, uiTokenAmount: { amount: raw.toString(), decimals: ledger.decimals } }];
  }
  const fakeConn = {
    // The slot guard's program (Lighthouse) is deployed unless a test says otherwise.
    async getAccountInfo(pk) {
      if (pk.toBase58() === 'L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95') return ledger.lighthouseMissing ? null : { executable: true, data: Buffer.alloc(0) };
      return null;
    },
    async getSignatureStatuses(sigs) {
      ledger.statusLookups.push([...sigs]);
      return {
        value: sigs.map((sig) => {
          if (ledger.copySlots.has(sig)) return { confirmationStatus: 'confirmed', slot: ledger.copySlots.get(sig), err: null };
          const rec = ledger.txs.get(sig);
          if (!rec || rec.state === 'pending' || (rec.visibleAt && Date.now() < rec.visibleAt)) return null;
          const status = rec.confirmedAt && Date.now() < rec.confirmedAt ? 'processed' : 'confirmed';
          return { confirmationStatus: status, slot: ledger.landedSlot, err: rec.state === 'failed' ? rec.err : null };
        })
      };
    },
    async getParsedTransaction(sig, opts = {}) {
      // A real RPC refuses version-1 transactions unless the caller accepts them.
      if (!(opts.maxSupportedTransactionVersion >= 1)) throw new Error('Transaction version (1) is not supported by the requesting client');
      if (ledger.parsedTxUnavailable) return null;
      const rec = ledger.txs.get(sig);
      if (!rec || rec.state === 'pending') return null;
      const pre = 50_000_000_000;
      return {
        slot: 1000,
        meta: {
          err: rec.state === 'failed' ? rec.err : null,
          fee: FEE_LAMPORTS,
          preBalances: [pre],
          postBalances: [pre + rec.lamportsDelta],
          preTokenBalances: tokenBalanceEntries(rec.mint, 10n ** 12n),
          postTokenBalances: tokenBalanceEntries(rec.mint, 10n ** 12n + rec.tokenDelta),
          logMessages: ledger.buyLogs || [],
          ...(ledger.computeUnits ? { computeUnitsConsumed: ledger.computeUnits } : {})
        },
        transaction: {
          signatures: [sig],
          message: {
            accountKeys: [{ pubkey: { toBase58: () => ledger.wallet } }],
            instructions: [
              // The compute budget, unparsed (base58 data) as a real RPC returns it.
              ...(ledger.computeUnits ? [{ programId: { toBase58: () => 'ComputeBudget111111111111111111111111111111' }, accounts: [], data: computeLimitData(300000) }] : []),
              // The Jito tip, as a real parsed transaction shows it.
              ...(rec.tipLamports
                ? [{ program: 'system', parsed: { type: 'transfer', info: { source: ledger.wallet, destination: '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5', lamports: rec.tipLamports } } }]
                : [])
            ]
          }
        }
      };
    },
    async getParsedTokenAccountsByOwner(owner, { mint, programId }) {
      if (programId) {
        // Every token account in the wallet for one token program (account cleaner).
        const is2022 = programId.toBase58() === 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
        const entry = (pubkey, m, amount) => ({
          pubkey: new PublicKey(pubkey),
          account: { lamports: 2039280, data: { parsed: { info: { mint: m, state: 'initialized', tokenAmount: { amount: amount.toString(), decimals: ledger.decimals } } } } }
        });
        const out = [];
        if (owner.toBase58() !== ledger.wallet) {
          // The copy wallet's coins (ONLY_COPY_FIRST_BUY startup snapshot).
          if (!is2022) for (const m of ledger.copyHoldings || []) out.push(entry(Keypair.generate().publicKey.toBase58(), m, 5000000n));
          return { value: out };
        }
        if (!is2022) {
          for (const [m, amount] of ledger.tokens) {
            if (ledger.tokenAccounts.get(m) === 'closed') continue;
            if (!ledger.tokenAccounts.has(m)) ledger.tokenAccounts.set(m, Keypair.generate().publicKey.toBase58());
            out.push(entry(ledger.tokenAccounts.get(m), m, amount));
          }
        }
        for (const a of ledger.extraAccounts) {
          if ((a.program === '2022') === is2022 && !ledger.closedAccounts.includes(a.pubkey)) out.push(entry(a.pubkey, a.mint, a.amount));
        }
        return { value: out };
      }
      if (owner.toBase58() !== ledger.wallet) {
        // The copy wallet holding a coin right now (a duplicate of its buy landed).
        if (owner.toBase58() === process.env.COPY_WALLET && mint && ledger.copyHeldNow.has(mint.toBase58())) {
          return { value: [{ account: { data: { parsed: { info: { tokenAmount: { amount: '5000000', decimals: ledger.decimals } } } } } }] };
        }
        // Someone else's balance (e.g. the coin's creator).
        const amt = ledger.holders && ledger.holders.others && ledger.holders.others.get(owner.toBase58());
        if (amt === undefined || amt === null) return { value: [] };
        return { value: [{ account: { data: { parsed: { info: { tokenAmount: { amount: amt.toString(), decimals: ledger.decimals } } } } } }] };
      }
      if (ledger.balanceFailures > 0) {
        ledger.balanceFailures -= 1;
        throw new Error('503 Service Unavailable');
      }
      if (ledger.zeroGlitches > 0) {
        ledger.zeroGlitches -= 1;
        return { value: [] };
      }
      const m = mint.toBase58();
      if (!ledger.tokens.has(m)) return { value: [] };
      return {
        value: [{ account: { data: { parsed: { info: { tokenAmount: { amount: ledger.tokens.get(m).toString(), decimals: ledger.decimals } } } } } }]
      };
    }
  };
  let listenerSeq = 0;
  fakeConn.onAccountChange = (pk, cb) => {
    const id = ++listenerSeq;
    ledger.accountListeners.set(id, { key: pk.toBase58(), cb });
    return id;
  };
  fakeConn.removeAccountChangeListener = async (id) => {
    ledger.accountListeners.delete(id);
  };
  // Our token accounts and coin mints, as raw accounts (INSTANT_SELL reads them at "processed").
  fakeConn.getMultipleAccountsInfo = async (keys) => {
    const { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } = require('@solana/spl-token');
    const owner = new PublicKey(ledger.wallet);
    const zero = ledger.processedZeroReads > 0;
    if (zero) ledger.processedZeroReads -= 1;
    ledger.processedReads += 1;
    return keys.map((k) => {
      const key = k.toBase58();
      for (const [m, amount] of ledger.tokens) {
        if (key === m) {
          const data = Buffer.alloc(82);
          data.writeUInt8(ledger.decimals, 44);
          return { owner: TOKEN_PROGRAM_ID, data, lamports: 1461600 };
        }
        if (key === getAssociatedTokenAddressSync(new PublicKey(m), owner, true, TOKEN_PROGRAM_ID).toBase58()) {
          if (zero) return null;
          const data = Buffer.alloc(165);
          data.writeBigUInt64LE(amount, 64);
          return { owner: TOKEN_PROGRAM_ID, data, lamports: 2039280 };
        }
      }
      return null;
    });
  };
  fakeConn.getTokenSupply = async () => {
    if (!ledger.holders) throw new Error('getTokenSupply not mocked for this test');
    return { value: { amount: ledger.holders.supplyRaw.toString(), decimals: ledger.decimals } };
  };
  fakeConn.getTokenLargestAccounts = async () => {
    if (!ledger.holders) throw new Error('getTokenLargestAccounts not mocked for this test');
    return { value: ledger.holders.largest.map((h) => ({ address: h.address, amount: h.amount.toString() })) };
  };
  fakeConn.getMultipleParsedAccounts = async (keys) => {
    const byAddr = new Map((ledger.holders ? ledger.holders.largest : []).map((h) => [h.address, h.owner]));
    return { value: keys.map((k) => (byAddr.has(k.toBase58()) ? { data: { parsed: { info: { owner: byAddr.get(k.toBase58()) } } } } : null)) };
  };
  fakeConn.getParsedAccountInfo = async (pk) => {
    const m = pk.toBase58();
    ledger.taxLookups.push(m);
    if (ledger.taxLookupFails > 0) {
      ledger.taxLookupFails -= 1;
      throw new Error('503 Service Unavailable');
    }
    if (!ledger.mintTaxBps.has(m)) {
      return { value: { owner: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'), data: { parsed: { type: 'mint', info: { decimals: ledger.decimals } } } } };
    }
    const bps = ledger.mintTaxBps.get(m);
    const fee = (b) => ({ epoch: 1, maximumFee: 1e15, transferFeeBasisPoints: b });
    return {
      value: {
        owner: new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'),
        data: { parsed: { type: 'mint', info: { decimals: ledger.decimals, extensions: [{ extension: 'transferFeeConfig', state: { olderTransferFee: fee(0), newerTransferFee: fee(bps), withheldAmount: 0 } }] } } }
      }
    };
  };
  fakeConn.getBalance = async () => Number(ledger.lamports);
  fakeConn.getLatestBlockhash = async () => ({ blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 1 });
  // Account cleaner's close transactions: simulated like preflight (refused
  // if any account still holds tokens), then "landed".
  fakeConn.sendRawTransaction = async (bytes) => {
    const { VersionedTransaction } = require('@solana/web3.js');
    const tx = VersionedTransaction.deserialize(bytes);
    const keys = tx.message.staticAccountKeys.map((k) => k.toBase58());
    const closeIxs = tx.message.compiledInstructions.filter((ix) => ix.data[0] === 9); // CloseAccount
    const targets = closeIxs.map((ix) => keys[ix.accountKeyIndexes[0]]);
    for (const ix of closeIxs) {
      // Deposit must go back to the bot's own wallet, signed by it.
      if (keys[ix.accountKeyIndexes[1]] !== ledger.wallet || keys[ix.accountKeyIndexes[2]] !== ledger.wallet) throw new Error('close must refund to and be signed by the wallet');
      ledger.closedPrograms[keys[ix.accountKeyIndexes[0]]] = keys[ix.programIdIndex];
    }
    for (const addr of targets) {
      const held = [...ledger.tokenAccounts].find(([, a]) => a === addr);
      const extra = ledger.extraAccounts.find((a) => a.pubkey === addr);
      const amount = held ? ledger.tokens.get(held[0]) : extra ? extra.amount : null;
      if (amount === null || amount === undefined || amount > 0n) throw new Error('Transaction simulation failed: Non-native account can only be closed if its balance is zero');
    }
    for (const addr of targets) {
      const held = [...ledger.tokenAccounts].find(([, a]) => a === addr);
      if (held) {
        ledger.tokenAccounts.set(held[0], 'closed');
        ledger.tokens.delete(held[0]);
      }
      ledger.closedAccounts.push(addr);
    }
    ledger.closeTxs += 1;
    const sig = newSig('close');
    ledger.txs.set(sig, { state: 'confirmed', lamportsDelta: 0, tokenDelta: 0n });
    return sig;
  };
  const rpcPool = {
    getConnection: () => fakeConn,
    withFailover: async (fn) => fn(fakeConn),
    getWsUrl: () => 'ws://fake',
    getHttpUrl: () => 'http://fake',
    hasFallbacks: () => false,
    rotate: () => false
  };

  // ---- price mock ----
  const priceChecker = {
    async getPrices(mints) {
      ledger.priceRequests.push([...mints]);
      const out = new Map();
      for (const m of mints) {
        const usd = ledger.prices.get(m);
        if (usd) out.set(m, { priceInUsd: usd, priceInSol: usd / SOL_USD });
      }
      return out;
    },
    async getPriceOnChain(mint) {
      const usd = ledger.prices.get(mint);
      if (!usd) return null;
      return { priceInUsd: usd, priceInSol: usd / SOL_USD };
    },
    async getSolUsd() {
      return SOL_USD;
    },
    sleep
  };

  // ---- websocket mock ----
  class FakeEmitter extends EventEmitter {
    constructor() {
      super();
      this.seenSignatures = new Set(); // as the real feed: shared with the shred stream
    }
    _markSeen(signature) {
      if (this.seenSignatures.has(signature)) return true;
      this.seenSignatures.add(signature);
      return false;
    }
    connect() {
      global.__emitter = this;
    }
    disconnect() {
      this.disconnected = true;
    }
  }

  // ---- Telegram Bot API mock (intercepts fetch to api.telegram.org) ----
  // Any OTHER outbound fetch is an error: every network boundary is mocked,
  // so a real network call would mean something slipped past the mocks.
  const telegram = { sent: [], answered: [], updates: [], nextUpdateId: 1, failSends: false, rateLimitSends: 0, failAnswers: false, networkDown: false, getUpdatesOffsets: [] };
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (!u.startsWith('https://api.telegram.org/')) throw new Error(`unexpected real network call to ${u}`);
    if (telegram.networkDown) throw new TypeError('fetch failed');
    const method = u.split('/').pop();
    const body = JSON.parse(opts.body || '{}');
    const reply = (ok, result, description) => {
      const payload = ok ? { ok: true, result } : { ok: false, description };
      return { ok, status: ok ? 200 : 400, statusText: ok ? 'OK' : 'Bad Request', text: async () => JSON.stringify(payload), json: async () => payload };
    };
    if (method === 'getUpdates') {
      telegram.getUpdatesOffsets.push(body.offset);
      if (body.offset < 0) {
        // Telegram: return the newest update and forget everything before it.
        const last = telegram.updates[telegram.updates.length - 1];
        telegram.updates.length = 0;
        return reply(true, last ? [last] : []);
      }
      const start = Date.now();
      while (telegram.updates.length === 0 && Date.now() - start < 300) {
        if (opts.signal && opts.signal.aborted) {
          const e = new Error('aborted');
          e.name = 'AbortError';
          throw e;
        }
        await sleep(10);
      }
      return reply(true, telegram.updates.splice(0).filter((x) => x.update_id >= (body.offset || 0)));
    }
    if (method === 'sendMessage') {
      if (telegram.rateLimitSends > 0) {
        telegram.rateLimitSends -= 1;
        const payload = { ok: false, error_code: 429, description: 'Too Many Requests: retry after 1', parameters: { retry_after: 1 } };
        return { ok: false, status: 429, statusText: 'Too Many Requests', text: async () => JSON.stringify(payload), json: async () => payload };
      }
      if (telegram.failSends) return reply(false, null, 'Too Many Requests: retry after 5');
      telegram.sent.push({ chatId: body.chat_id, text: body.text, opts: body.reply_markup ? { reply_markup: body.reply_markup } : undefined });
      return reply(true, {});
    }
    if (method === 'answerCallbackQuery') {
      if (telegram.failAnswers) return reply(false, null, 'Bad Request: query is too old and response timeout expired');
      telegram.answered.push(body);
      return reply(true, true);
    }
    return reply(false, null, 'Not Found');
  };
  telegram.bot = {
    simulateText(text, chat, from) {
      telegram.updates.push({ update_id: telegram.nextUpdateId++, message: { text, chat, from } });
    },
    simulateCallback(data, chat, from) {
      telegram.updates.push({
        update_id: telegram.nextUpdateId++,
        callback_query: { id: `cb${telegram.nextUpdateId}`, data, from, message: chat ? { chat } : undefined }
      });
    }
  };

  const seed = (resolvedPath, exportsObj) => {
    require.cache[resolvedPath] = {
      id: resolvedPath,
      filename: resolvedPath,
      loaded: true,
      exports: exportsObj,
      children: [],
      paths: []
    };
  };
  seed(srcPath('tradeExecutor.js'), tradeExecutor);
  seed(srcPath('rpcPool.js'), rpcPool);
  seed(srcPath('priceChecker.js'), priceChecker);
  seed(srcPath('websocket.js'), FakeEmitter);

  return { ledger, telegram, fakeConn, SOL_USD };
}

module.exports = { installMocks, sleep };
