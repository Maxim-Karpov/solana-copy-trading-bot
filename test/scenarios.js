// test/scenarios.js
//
// End-to-end scenarios: each runs the real src/index.js (with network
// boundaries mocked by test/mocks.js) in its own process and checks the
// resulting positions file, simulated wallet, and calls made.

// A second copy wallet for the multi-wallet scenario (fixed, so the test
// runner and the bot process agree on it).
const SECOND_WALLET = require('@solana/web3.js').Keypair.fromSeed(new Uint8Array(32).fill(7)).publicKey.toBase58();
const TIERS = '[{"maxSol":0.5,"buyAmount":0.05},{"maxSol":2,"buyAmount":0.15},{"maxSol":null,"buyAmount":0.3}]';

function seedPosition(overrides) {
  return {
    id: overrides.id,
    time: new Date().toISOString(),
    status: 'active',
    dex: 'auto',
    venue: 'pumpfun',
    parent_signature: 'seed',
    current_price: overrides.entry_price,
    highest_price: overrides.entry_price,
    trailing_stop_price: null,
    trailing_stop_activated: false,
    trailing_stop_distance: null,
    trailing_stop_activation: null,
    ...overrides
  };
}

module.exports = {
  safe_buy_then_take_profit: {
    async run(h) {
      const m = h.newMint();
      h.ledger.prices.set(m, 0.001);
      h.buy(m, 1.0);
      const pos = await h.waitFor(() => h.active().find((p) => p.mint === m), 'position opened');
      h.check(pos.token_amount === '10000.000000', `token_amount exact from buy tx (got ${pos.token_amount})`);
      h.check(pos.decimals === 6, 'decimals stored on position');
      h.check(pos.venue === 'pumpfun' && pos.dex === 'auto', `venue=pumpfun, dex=auto (got ${pos.venue}/${pos.dex})`);
      h.check(h.ledger.calls.buy[0].venue === 'pumpfun', 'buyToken receives detected venue even with PREFERRED_DEX=auto');
      h.approx(pos.cost_basis_sol, 0.101005, 1e-9, 'cost basis = SOL spent + tip + fee');
      h.check(pos.entry_price === 0.001, 'entry price recorded');

      h.ledger.prices.set(m, 0.0016); // +60% -> TP (50%)
      const closed = await h.waitFor(
        () => h.byMint(m).find((p) => p.status === 'closed' && p.realized_pnl_sol !== 0),
        'TP close with realized PnL'
      );
      h.check(closed.close_reason === 'TP', `close_reason TP (got ${closed.close_reason})`);
      h.check(h.ledger.calls.sell.length === 1, `exactly one sell (got ${h.ledger.calls.sell.length})`);
      h.check(h.ledger.calls.sell[0].amountTokens === '10000.000000', `sold exact amount (got ${h.ledger.calls.sell[0].amountTokens})`);
      // PNL_EXCLUDE_FEES (default): swap amounts only, 0.16 out - 0.1 in = 0.06.
      h.approx(closed.realized_pnl_sol, 0.06, 1e-9, 'realized PnL from the swaps, fees/tips left out');
      h.approx(pos.swap_cost_sol, 0.1, 1e-9, 'swap cost = 0.1 SOL (tip and fee left out)');
      h.check((h.ledger.tokens.get(m) || 0n) === 0n, 'no tokens left in wallet');
    }
  },

  pnl_including_fees_when_switched_off: {
    env: { PNL_EXCLUDE_FEES: 'false' },
    async run(h) {
      const m = h.newMint();
      h.ledger.prices.set(m, 0.001);
      h.buy(m, 1.0);
      const pos = await h.waitFor(() => h.active().find((p) => p.mint === m), 'position opened');
      h.approx(pos.swap_cost_sol, 0.1, 1e-9, 'swap cost (no fee/tip) tracked alongside the full cost');
      h.ledger.prices.set(m, 0.0016);
      const closed = await h.waitFor(() => h.byMint(m).find((p) => p.status === 'closed' && p.realized_pnl_sol !== 0), 'TP close');
      // proceeds 0.16 - tip 0.001 - fee 0.000005 = 0.158995; cost 0.101005
      h.approx(closed.realized_pnl_sol, 0.05799, 1e-9, 'realized PnL from actual SOL in/out, fees included');
    }
  },

  missing_entry_price_does_not_insta_sell: {
    async run(h) {
      const m = h.newMint(); // no price yet (DexScreener hasn't indexed it)
      h.buy(m, 1.0);
      const pos = await h.waitFor(() => h.active().find((p) => p.mint === m), 'position opened');
      h.check(pos.entry_price === 0, 'entry 0 when no price at buy time');
      h.ledger.prices.set(m, 0.001);
      await h.waitFor(() => h.active().find((p) => p.mint === m && p.entry_price === 0.001), 'entry adopted from first price');
      await h.sleep(1000);
      h.check(h.ledger.calls.sell.length === 0, `no instant TP sell (sells: ${h.ledger.calls.sell.length})`);
      h.check(h.active().some((p) => p.mint === m), 'position still open');
    }
  },

  failed_sell_keeps_position_open_and_retries: {
    async run(h) {
      const m = h.newMint();
      h.ledger.prices.set(m, 0.001);
      h.buy(m, 1.0);
      await h.waitFor(() => h.active().find((p) => p.mint === m), 'position opened');
      h.ledger.sellQueue.push('throw', 'throw', 'throw');
      h.ledger.prices.set(m, 0.0005); // -50% -> SL
      await h.waitFor(() => h.ledger.calls.sell.length >= 3, 'three failed attempts');
      await h.sleep(100);
      const mid = h.byMint(m)[0];
      h.check(mid.status === 'active', `position NOT marked closed while its sell failed (status ${mid.status})`);
      const closed = await h.waitFor(() => h.byMint(m).find((p) => p.status === 'closed'), 'closed after cooldown retry');
      h.check(closed.close_reason === 'SL', `close_reason SL (got ${closed.close_reason})`);
      await h.sleep(500);
      h.check(h.ledger.calls.sell.length === 4, `3 failed + 1 successful sell (got ${h.ledger.calls.sell.length})`);
      h.check((h.ledger.tokens.get(m) || 0n) === 0n, 'tokens actually sold');
    }
  },

  onchain_failed_sell_is_retried: {
    async run(h) {
      const m = h.newMint();
      h.ledger.prices.set(m, 0.001);
      h.buy(m, 1.0);
      await h.waitFor(() => h.active().find((p) => p.mint === m), 'position opened');
      h.ledger.sellQueue.push('failOnChain');
      h.ledger.prices.set(m, 0.0005);
      const closed = await h.waitFor(() => h.byMint(m).find((p) => p.status === 'closed'), 'closed');
      h.check(h.ledger.calls.sell.length === 2, `failed-on-chain sell not treated as done; retried once (sells ${h.ledger.calls.sell.length})`);
      h.check(closed.close_signature === 'sellSig3', `closed with the successful sell's signature (got ${closed.close_signature})`);
      h.check((h.ledger.tokens.get(m) || 0n) === 0n, 'tokens actually sold');
    }
  },

  failed_buys_open_no_position: {
    async run(h) {
      const [a, b, c, d] = [h.newMint(), h.newMint(), h.newMint(), h.newMint()];
      for (const x of [a, b, c, d]) h.ledger.prices.set(x, 0.001);
      h.ledger.buyQueue.push('failOnChain', 'throw', 'noTokens');
      h.buy(a, 1);
      await h.sleep(300);
      h.buy(b, 1);
      await h.sleep(300);
      h.buy(c, 1);
      await h.sleep(1500);
      h.check(h.active().length === 0, `no phantom positions from failed buys (active: ${h.active().length})`);
      h.buy(d, 1);
      await h.waitFor(() => h.active().find((p) => p.mint === d), 'bot still healthy: next buy works');
    }
  },

  risk_caps_hold_under_concurrent_buys: {
    env: { TRADE_TYPE: 'EXACT', MAX_BUY_AMOUNT: '11', MAX_TOTAL_EXPOSURE: '15' },
    async run(h) {
      h.ledger.buyDelayMs = 300;
      const mints = [h.newMint(), h.newMint(), h.newMint()];
      mints.forEach((x) => h.ledger.prices.set(x, 0.001));
      mints.forEach((x) => h.buy(x, 20)); // three simultaneous 20 SOL copy buys
      await h.waitFor(() => h.active().length >= 2, 'positions opened');
      await h.sleep(800);
      const amounts = h.ledger.calls.buy.map((c) => c.amountSol);
      h.check(amounts[0] === 11, `first buy clamped to MAX_BUY_AMOUNT (got ${amounts[0]})`);
      h.check(amounts.length === 2, `third buy skipped: no room left (buys: ${JSON.stringify(amounts)})`);
      const total = amounts.reduce((s, x) => s + x, 0);
      h.check(total <= 15 + 1e-9, `total requested ${total} <= MAX_TOTAL_EXPOSURE`);
    }
  },

  no_multi_buy_blocks_concurrent_same_mint: {
    async run(h) {
      h.ledger.buyDelayMs = 200;
      const m = h.newMint();
      h.ledger.prices.set(m, 0.001);
      h.buy(m, 1);
      h.buy(m, 1);
      await h.waitFor(() => h.active().find((p) => p.mint === m), 'position opened');
      await h.sleep(800);
      h.check(h.ledger.calls.buy.length === 1, `only one buy for the same mint (got ${h.ledger.calls.buy.length})`);
      h.check(h.byMint(m).length === 1, 'one position');
    }
  },

  multi_buy_adds_to_one_position: {
    env: { ENABLE_MULTI_BUY: 'true' },
    async run(h) {
      const m = h.newMint();
      h.ledger.prices.set(m, 0.001);
      h.buy(m, 1);
      h.buy(m, 1);
      await h.waitFor(() => h.active().find((p) => p.mint === m && p.buy_count === 2), 'second buy added');
      const all = h.byMint(m);
      h.check(all.length === 1, `one position, not a duplicate (got ${all.length})`);
      h.check(all[0].token_amount === '20000.000000', `tokens summed exactly, no double count (got ${all[0].token_amount})`);
      h.approx(all[0].buy_amount, 0.2, 1e-12, 'buy_amount summed');
      h.approx(all[0].cost_basis_sol, 0.20201, 1e-9, 'cost basis summed');
    }
  },

  stiered_partial_then_full_back_to_back: {
    env: { TRADE_TYPE: 'STIERED', TIER_BUY_CONFIG: TIERS },
    async run(h) {
      const m = h.newMint();
      h.ledger.prices.set(m, 0.001);
      h.buy(m, 1.0); // tier: 0.5-2 SOL -> 0.15 SOL -> 15000 tokens
      const pos = await h.waitFor(() => h.active().find((p) => p.mint === m), 'position opened');
      h.check(pos.token_amount === '15000.000000', `tiered buy size (got ${pos.token_amount})`);
      h.sell(m, 40);
      h.sell(m, 100); // arrives while the partial is still in flight
      const closed = await h.waitFor(() => h.byMint(m).find((p) => p.status === 'closed'), 'fully closed');
      const sold = h.ledger.calls.sell.map((c) => c.amountTokens);
      h.check(JSON.stringify(sold) === JSON.stringify(['6000.000000', '9000.000000']), `40% then the rest, none dropped (got ${JSON.stringify(sold)})`);
      h.check(closed.close_reason === 'STIERED copy-sell (full)', `close_reason (got ${closed.close_reason})`);
      h.check((h.ledger.tokens.get(m) || 0n) === 0n, 'nothing left in wallet');
    }
  },

  stiered_sell_arriving_mid_buy_is_applied: {
    env: { TRADE_TYPE: 'STIERED', TIER_BUY_CONFIG: TIERS },
    async run(h) {
      h.ledger.buyDelayMs = 400;
      const m = h.newMint();
      h.ledger.prices.set(m, 0.001);
      h.buy(m, 1.0);
      await h.sleep(50);
      h.sell(m, 50); // copy wallet sells half while our buy is still confirming
      await h.waitFor(() => h.ledger.calls.sell.length === 1, 'sell executed after buy');
      const pos = await h.waitFor(() => h.active().find((p) => p.mint === m && p.token_amount === '7500.000000'), 'half remains');
      h.check(Boolean(pos), 'position halved');
      h.approx(pos.cost_basis_sol, 0.151005 / 2, 1e-9, 'cost basis halved');
    }
  },

  exact_sell_processed_before_buy_skips_buy: {
    env: { TRADE_TYPE: 'EXACT' },
    async run(h) {
      const m = h.newMint();
      h.ledger.prices.set(m, 0.001);
      h.sell(m, 100, { slot: 200 }); // their sell (later slot) is processed first
      await h.sleep(100);
      h.buy(m, 0.2, { slot: 100 });
      await h.sleep(1000);
      h.check(h.ledger.calls.buy.length === 0, `no buy of a token the copy wallet already exited (buys ${h.ledger.calls.buy.length})`);
      h.check(h.active().length === 0, 'no stranded position');
    }
  },

  stiered_out_of_order_partial_applied: {
    env: { TRADE_TYPE: 'STIERED', TIER_BUY_CONFIG: TIERS },
    async run(h) {
      const m = h.newMint();
      h.ledger.prices.set(m, 0.001);
      h.sell(m, 50, { slot: 200 });
      await h.sleep(100);
      h.buy(m, 1.0, { slot: 100 });
      const pos = await h.waitFor(() => h.active().find((p) => p.mint === m && p.token_amount === '7500.000000'), 'bought then halved');
      h.check(Boolean(pos) && h.ledger.calls.sell.length === 1, 'one partial sell applied');
    }
  },

  exact_copy_sell_closes_full: {
    env: { TRADE_TYPE: 'EXACT' },
    async run(h) {
      const m = h.newMint();
      h.ledger.prices.set(m, 0.001);
      h.buy(m, 0.2);
      await h.waitFor(() => h.active().find((p) => p.mint === m), 'position opened');
      h.sell(m, 30); // EXACT dumps 100% on any sell
      const closed = await h.waitFor(() => h.byMint(m).find((p) => p.status === 'closed'), 'closed');
      h.check(closed.close_reason === 'EXACT copy-sell', `close_reason (got ${closed.close_reason})`);
      h.check(h.ledger.calls.sell[0].amountTokens === '20000.000000', 'sold everything');
    }
  },

  exact_failed_exit_is_persisted_and_retried: {
    env: { TRADE_TYPE: 'EXACT' },
    async run(h) {
      const m = h.newMint();
      h.ledger.prices.set(m, 0.001);
      h.buy(m, 0.2);
      await h.waitFor(() => h.active().find((p) => p.mint === m), 'position opened');
      h.ledger.sellQueue.push('throw', 'throw', 'throw');
      h.sell(m, 100);
      await h.waitFor(() => h.ledger.calls.sell.length >= 3, 'three failures');
      await h.sleep(50);
      const mid = h.byMint(m)[0];
      h.check(mid.status === 'active' && mid.pending_exit === 'EXACT copy-sell', `exit intent persisted (status ${mid.status}, pending_exit ${mid.pending_exit})`);
      const closed = await h.waitFor(() => h.byMint(m).find((p) => p.status === 'closed'), 'retried and closed');
      h.check(closed.pending_exit === null, 'pending_exit cleared');
    }
  },

  exact_position_still_exits_after_mode_switch: {
    env: { TRADE_TYPE: 'SAFE' },
    setup(h) {
      const m = h.newMint();
      h.state.m = m;
      h.ledger.tokens.set(m, 5000n * 10n ** 6n);
      h.writePositions([
        seedPosition({ id: 'exact-1', mint: m, trade_mode: 'EXACT', token_amount: '5000.000000', decimals: 6, buy_amount: 0.05, cost_basis_sol: 0.05, entry_price: 0.001 })
      ]);
    },
    async run(h) {
      h.sell(h.state.m, 100);
      const closed = await h.waitFor(() => h.byMint(h.state.m).find((p) => p.status === 'closed'), 'EXACT position closed under SAFE config');
      h.check(closed.close_reason === 'EXACT copy-sell', 'routed by the position\'s own trade_mode');
    }
  },

  legacy_position_without_decimals_can_close: {
    setup(h) {
      const m = h.newMint();
      h.state.m = m;
      h.ledger.tokens.set(m, 5000n * 10n ** 6n);
      h.ledger.prices.set(m, 0.0005); // -50% vs entry -> SL
      h.writePositions([
        seedPosition({ id: 'legacy-1', mint: m, trade_mode: 'SAFE', token_amount: '5000', buy_amount: 0.05, entry_price: 0.001, stop_loss_pct: 20, take_profit_pct: 50 })
      ]);
    },
    async run(h) {
      const closed = await h.waitFor(() => h.byMint(h.state.m).find((p) => p.status === 'closed'), 'legacy position closed');
      h.check(h.ledger.calls.sell[0].amountTokens === '5000.000000', `exact amount (got ${h.ledger.calls.sell[0].amountTokens})`);
      h.check(closed.decimals === 6, 'decimals backfilled from chain');
    }
  },

  buy_message_shows_market_cap_and_holders: {
    env: { TELEGRAM_BOT_TOKEN: 'test-token', TELEGRAM_CHAT_ID: '777' },
    async run(h) {
      const { Keypair, PublicKey } = require('@solana/web3.js');
      const { tradeEventLine, pumpLogs, PUMP } = require('./pumpEvent');
      const M = 1_000_000n; // 6 decimals
      const m = h.newMint();
      const creator = Keypair.generate().publicKey.toBase58();
      const curveOwner = PublicKey.findProgramAddressSync([Buffer.from('bonding-curve'), new PublicKey(m).toBuffer()], new PublicKey(PUMP))[0].toBase58();
      const wallet = () => Keypair.generate().publicKey.toBase58();
      const acct = () => Keypair.generate().publicKey.toBase58();
      h.ledger.prices.set(m, 0.001);
      // Our buy's TradeEvent: 40 SOL / 800M tokens virtual -> 50 SOL market
      // cap ($5.0k at $100/SOL); 593.1M of 793.1M curve tokens left -> 25% done.
      h.ledger.buyLogs = pumpLogs(tradeEventLine({
        mint: m, user: h.ledger.wallet, sol: 1e9, tokens: 1, vSol: 40_000_000_000n, vTok: 800_000_000n * M,
        rSol: 10_000_000_000n, rTok: 593_100_000n * M, creator
      }));
      // Holders: the bonding curve (program-owned, not counted), then wallets.
      h.ledger.holders = {
        supplyRaw: 1_000_000_000n * M,
        largest: [
          { address: acct(), owner: curveOwner, amount: 593_100_000n * M },
          { address: acct(), owner: wallet(), amount: 50_000_000n * M },
          { address: acct(), owner: wallet(), amount: 30_000_000n * M },
          { address: acct(), owner: creator, amount: 20_000_000n * M }
        ],
        others: new Map([[creator, 20_000_000n * M]])
      };
      h.buy(m, 1.0);
      const msg = await h.waitFor(() => h.telegram.sent.find((s) => s.text.includes('BUY')), 'buy notification');
      h.check(msg.text.includes('MC: $5.0k (50.0 SOL) · Curve: 25%'), `market cap and curve line (${msg.text})`);
      h.check(msg.text.includes('Creator holds 2.0% · Top 10: 10%'), `creator and top-10 line (${msg.text})`);
    }
  },

  buy_message_still_sent_when_holder_lookup_fails: {
    env: { TELEGRAM_BOT_TOKEN: 'test-token', TELEGRAM_CHAT_ID: '777' },
    async run(h) {
      const m = h.newMint();
      h.ledger.prices.set(m, 0.001);
      // No buyLogs, no holders: every lookup fails or finds nothing.
      h.buy(m, 1.0);
      const msg = await h.waitFor(() => h.telegram.sent.find((s) => s.text.includes('BUY')), 'buy notification');
      h.check(!msg.text.includes('MC:') && !msg.text.includes('Top 10'), `no coin lines when nothing is known (${msg.text})`);
      await h.waitFor(() => h.telegram.sent.find((s) => s.opts && s.opts.reply_markup && /open position/.test(s.text)), 'positions list still follows');
    }
  },

  keep_button_stops_following_copy_sells: {
    env: { TELEGRAM_BOT_TOKEN: 'test-token', TELEGRAM_CHAT_ID: '777', TRADE_TYPE: 'STIERED', TIER_BUY_CONFIG: TIERS },
    async run(h) {
      const me = { chat: { id: 777, type: 'private' }, from: { id: 777 } };
      const m = h.newMint();
      h.ledger.prices.set(m, 0.001);
      h.buy(m, 1.0);
      const pos = await h.waitFor(() => h.active().find((p) => p.mint === m), 'position opened');
      const list = await h.waitFor(() => h.telegram.sent.find((s) => s.opts && s.opts.reply_markup && /open position/.test(s.text)), 'positions list');
      const row = list.opts.reply_markup.inline_keyboard[0];
      h.check(row.length === 3 && row[2].callback_data === `keep:${pos.id}` && /Keep/.test(row[2].text), `row has a Keep button (${JSON.stringify(row)})`);

      h.telegram.bot.simulateCallback(`keep:${pos.id}`, me.chat, me.from);
      await h.waitFor(() => h.telegram.sent.some((s) => s.text.startsWith('📌 Keeping it')), 'keep confirmation');
      await h.waitFor(() => h.active().find((p) => p.id === pos.id && p.keep === true), 'keep saved');
      const relist = await h.waitFor(() => [...h.telegram.sent].reverse().find((s) => s.opts && s.opts.reply_markup && s.text.includes('📌 kept')), 'list shows kept');
      h.check(relist.opts.reply_markup.inline_keyboard[0][2].callback_data === `follow:${pos.id}`, 'kept position offers Follow');

      // The copy wallet sells everything: we keep ours, and say so.
      h.sell(m, 100);
      await h.waitFor(() => h.telegram.sent.some((s) => s.text.includes("You're keeping your position")), 'not-following notice');
      await h.sleep(300);
      h.check(h.ledger.calls.sell.length === 0 && h.active().some((p) => p.id === pos.id), 'nothing sold while kept');

      // Follow again: the next copy sell is mirrored.
      h.telegram.bot.simulateCallback(`follow:${pos.id}`, me.chat, me.from);
      await h.waitFor(() => h.telegram.sent.some((s) => s.text.startsWith('▶ Following again')), 'follow confirmation');
      h.sell(m, 50);
      await h.waitFor(() => h.ledger.calls.sell.length === 1, 'copy sell mirrored after Follow');
      h.check(h.ledger.calls.sell[0].amountTokens === '7500.000000', `mirrored 50% (${h.ledger.calls.sell[0].amountTokens})`);
    }
  },

  keep_cancels_a_pending_copy_exit: {
    env: { TELEGRAM_BOT_TOKEN: 'test-token', TELEGRAM_CHAT_ID: '777', TRADE_TYPE: 'STIERED', TIER_BUY_CONFIG: TIERS },
    async run(h) {
      const me = { chat: { id: 777, type: 'private' }, from: { id: 777 } };
      const m = h.newMint();
      h.ledger.prices.set(m, 0.001);
      h.buy(m, 1.0);
      const pos = await h.waitFor(() => h.active().find((p) => p.mint === m), 'position opened');
      // Every sell attempt fails on-chain; Keep is tapped after the first one,
      // while the bot is still retrying.
      h.ledger.sellQueue.push(...Array(20).fill('failOnChain'));
      h.sell(m, 100);
      await h.waitFor(() => h.ledger.calls.sell.length >= 1, 'first sell attempt');
      h.telegram.bot.simulateCallback(`keep:${pos.id}`, me.chat, me.from);
      await h.waitFor(() => h.active().find((p) => p.id === pos.id && p.keep === true && !p.pending_exit), 'Keep cancels the pending exit');
      await h.sleep(300); // let an attempt already on its way finish
      const sellsBefore = h.ledger.calls.sell.length;
      await h.sleep(1500); // several retry delays and cooldowns
      h.check(sellsBefore <= 2, `retries stopped once Keep was tapped (${sellsBefore} attempts)`);
      h.check(h.ledger.calls.sell.length === sellsBefore && h.active().some((p) => p.id === pos.id), `no retry after Keep (${sellsBefore} -> ${h.ledger.calls.sell.length})`);
      h.check(!h.telegram.sent.some((s) => s.text.includes('Could not sell')), 'no failure alert for a sell you cancelled');
    }
  },

  buy_message_compares_entry_with_copy_wallet: {
    env: { TELEGRAM_BOT_TOKEN: 'test-token', TELEGRAM_CHAT_ID: '777', TRADE_TYPE: 'STIERED', TIER_BUY_CONFIG: TIERS },
    async run(h) {
      const { tradeEventLine, pumpLogs } = require('./pumpEvent');
      // Exact: our Pump.fun trade record says 0.15 SOL for 10,000 tokens
      // (0.000015 SOL each); the copy wallet paid 0.000012 -> +25.0%.
      const m1 = h.newMint();
      h.ledger.prices.set(m1, 0.001);
      h.ledger.buyLogs = pumpLogs(tradeEventLine({ mint: m1, user: h.ledger.wallet, sol: 150_000_000, tokens: 10_000_000_000, vSol: 30e9, vTok: 1e15 }));
      h.buy(m1, 1.0, { copyPriceSol: 0.000012, copyPriceExact: true });
      const msg1 = await h.waitFor(() => h.telegram.sent.find((s) => s.text.includes('BUY') && s.text.includes(m1.slice(0, 4))), 'first buy message');
      h.check(msg1.text.includes('Entry: +25.0% vs copy wallet'), `exact comparison (${msg1.text.replace(/\n/g, ' | ')})`);
      const p1 = h.active().find((p) => p.mint === m1);
      h.check(p1 && Math.abs(p1.entry_vs_copy_pct - 25) < 1e-6, `saved on the position (${p1 && p1.entry_vs_copy_pct})`);

      // Approximate (not a Pump.fun record): 0.15 SOL for 15,000 tokens
      // (0.00001 each) vs a copy price of 0.0000125 -> -20.0%, marked ≈.
      const m2 = h.newMint();
      h.ledger.prices.set(m2, 0.001);
      h.ledger.buyLogs = null;
      h.buy(m2, 1.0, { copyPriceSol: 0.0000125, copyPriceExact: false });
      const msg2 = await h.waitFor(() => h.telegram.sent.find((s) => s.text.includes('BUY') && s.text.includes(m2.slice(0, 4))), 'second buy message');
      h.check(msg2.text.includes('Entry: ≈−20.0% vs copy wallet'), `approximate comparison (${msg2.text.replace(/\n/g, ' | ')})`);
    }
  },

  empty_token_account_closed_after_full_sell: {
    env: { TRADE_TYPE: 'STIERED', TIER_BUY_CONFIG: TIERS, CLEANUP_DELAY_MS: '200', CLEANUP_FIRST_SWEEP_MS: '600000' },
    async run(h) {
      const m = h.newMint();
      h.ledger.prices.set(m, 0.001);
      h.buy(m, 1.0);
      await h.waitFor(() => h.active().find((p) => p.mint === m), 'position opened');
      h.sell(m, 50);
      await h.waitFor(() => h.ledger.calls.sell.length === 1, 'half sold');
      await h.sleep(600);
      h.check(h.ledger.closedAccounts.length === 0, 'account NOT closed while the position is still open');
      h.sell(m, 100);
      await h.waitFor(() => h.byMint(m).find((p) => p.status === 'closed'), 'position closed');
      await h.waitFor(() => h.ledger.closedAccounts.length === 1, 'its empty token account closed shortly after');
      h.check(h.ledger.tokenAccounts.get(m) === 'closed', 'the closed account is that coin\'s');

      // Copy wallet buys the same coin again later: works as normal.
      h.buy(m, 1.0);
      await h.waitFor(() => h.active().find((p) => p.mint === m), 're-buy after the account was closed');
    }
  },

  account_sweep_closes_only_empty_accounts: {
    env: { TRADE_TYPE: 'STIERED', TIER_BUY_CONFIG: TIERS, CLEANUP_DELAY_MS: '600000', CLEANUP_FIRST_SWEEP_MS: '800' },
    async run(h) {
      const { Keypair } = require('@solana/web3.js');
      const addr = () => Keypair.generate().publicKey.toBase58();
      const old1 = addr(), old2022 = addr(), notEmpty = addr(), wsol = addr();
      h.ledger.extraAccounts.push(
        { pubkey: old1, mint: h.newMint(), amount: 0n, program: 'spl' }, // a coin traded before
        { pubkey: old2022, mint: h.newMint(), amount: 0n, program: '2022' }, // a Token-2022 coin traded before
        { pubkey: notEmpty, mint: h.newMint(), amount: 5n, program: 'spl' }, // still holds a few tokens
        { pubkey: wsol, mint: 'So11111111111111111111111111111111111111112', amount: 0n, program: 'spl' } // wrapped SOL
      );
      const m = h.newMint();
      h.ledger.prices.set(m, 0.001);
      h.buy(m, 1.0);
      await h.waitFor(() => h.active().find((p) => p.mint === m), 'position opened');
      await h.waitFor(() => h.ledger.closeTxs >= 1, 'startup sweep ran');
      await h.sleep(300);
      const closed = new Set(h.ledger.closedAccounts);
      h.check(closed.has(old1) && closed.has(old2022), `both empty accounts closed (${[...closed]})`);
      h.check(h.ledger.closedPrograms[old1] === 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' &&
        h.ledger.closedPrograms[old2022] === 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', `each closed with its own token program (${JSON.stringify(h.ledger.closedPrograms)})`);
      h.check(!closed.has(notEmpty), 'account with tokens left alone');
      h.check(!closed.has(wsol), 'wrapped-SOL account left alone');
      h.check(h.ledger.tokenAccounts.get(m) !== 'closed' && h.active().some((p) => p.mint === m), 'held coin untouched');
    }
  },

  account_cleanup_can_be_turned_off: {
    env: { TRADE_TYPE: 'STIERED', TIER_BUY_CONFIG: TIERS, CLOSE_EMPTY_ACCOUNTS: 'false', CLEANUP_DELAY_MS: '100', CLEANUP_FIRST_SWEEP_MS: '300' },
    async run(h) {
      const { Keypair } = require('@solana/web3.js');
      h.ledger.extraAccounts.push({ pubkey: Keypair.generate().publicKey.toBase58(), mint: h.newMint(), amount: 0n, program: 'spl' });
      const m = h.newMint();
      h.ledger.prices.set(m, 0.001);
      h.buy(m, 1.0);
      await h.waitFor(() => h.active().find((p) => p.mint === m), 'position opened');
      h.sell(m, 100);
      await h.waitFor(() => h.byMint(m).find((p) => p.status === 'closed'), 'position closed');
      await h.sleep(1200);
      h.check(h.ledger.closeTxs === 0, `nothing closed when CLOSE_EMPTY_ACCOUNTS=false (${h.ledger.closeTxs})`);
    }
  },

  max_token_tax_skips_taxed_coins: {
    env: { TELEGRAM_BOT_TOKEN: 'test-token', TELEGRAM_CHAT_ID: '777', MAX_TOKEN_TAX_PCT: '1' },
    async run(h) {
      const ray = { dexs: ['Raydium CPMM'] };
      const taxed = h.newMint(), light = h.newMint(), plain = h.newMint(), pump = h.newMint(), unknown = h.newMint();
      for (const m of [taxed, light, plain, pump, unknown]) h.ledger.prices.set(m, 0.001);
      h.ledger.mintTaxBps.set(taxed, 500); // 5%
      h.ledger.mintTaxBps.set(light, 50); // 0.5%

      h.buy(taxed, 1.0, ray);
      await h.waitFor(() => h.telegram.sent.some((s) => s.text.includes('5% transfer tax')), 'skip notice');
      h.check(!h.ledger.calls.buy.some((b) => b.mint === taxed), '5% coin not bought');

      h.buy(light, 1.0, ray);
      await h.waitFor(() => h.active().find((p) => p.mint === light), '0.5% coin bought');
      const msg = await h.waitFor(() => h.telegram.sent.find((s) => s.text.includes('BUY') && s.text.includes(light.slice(0, 4))), 'buy message');
      h.check(msg.text.includes('Tax: 0.5% on every buy/sell'), `tax shown in buy message (${msg.text.replace(/\n/g, ' | ')})`);

      h.buy(plain, 1.0, ray);
      await h.waitFor(() => h.active().find((p) => p.mint === plain), 'untaxed coin bought');

      // Pump.fun coins can't carry a transfer fee: no lookup before buying.
      h.buy(pump, 1.0);
      await h.waitFor(() => h.active().find((p) => p.mint === pump), 'Pump.fun coin bought');
      const pumpBuyAt = h.ledger.calls.buy.find((b) => b.mint === pump).at;
      h.check(h.ledger.taxLookups.filter((m) => m === pump).length <= 1, 'Pump.fun coin not checked before the buy');

      // Lookup fails: buy anyway (and say so in the logs).
      h.ledger.taxLookupFails = 1;
      h.buy(unknown, 1.0, ray);
      await h.waitFor(() => h.active().find((p) => p.mint === unknown), 'bought when the tax check failed');
      h.check(pumpBuyAt > 0, 'sanity');
    }
  },

  stock_paired_coins_exempt_from_tax_cap: {
    env: { TELEGRAM_BOT_TOKEN: 'test-token', TELEGRAM_CHAT_ID: '777', MAX_TOKEN_TAX_PCT: '1' },
    async run(h) {
      const NVDAX = 'Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh';
      const m = h.newMint();
      h.ledger.prices.set(m, 0.001);
      h.ledger.mintTaxBps.set(m, 500); // 5% tax, but priced in a stock
      h.buy(m, 1.0, { dexs: ['Raydium CPMM'], pairedStock: NVDAX });
      await h.waitFor(() => h.active().find((p) => p.mint === m), 'stock-paired coin bought despite its tax');
      const msg = await h.waitFor(() => h.telegram.sent.find((s) => s.text.includes('BUY')), 'buy message');
      h.check(msg.text.includes('Paired to: NVDAx (stock)'), `stock shown (${msg.text.replace(/\n/g, ' | ')})`);
      h.check(msg.text.includes('Tax: 5.0% on every buy/sell'), 'its tax is still shown');
      h.check(h.active().find((p) => p.mint === m).paired_stock === NVDAX, 'saved on the position');
    }
  },

  low_balance_skips_buys_until_topped_up: {
    env: { TELEGRAM_BOT_TOKEN: 'test-token', TELEGRAM_CHAT_ID: '777', BALANCE_REFRESH_MS: '200' },
    async run(h) {
      h.ledger.lamports = 0n; // empty wallet
      await h.sleep(400); // first balance read
      const m1 = h.newMint();
      h.ledger.prices.set(m1, 0.001);
      h.buy(m1, 1.0);
      await h.waitFor(() => h.telegram.sent.some((s) => s.text.includes('Wallet balance too low')), 'low-balance alert');
      h.check(h.ledger.calls.buy.length === 0, 'no buy sent from an empty wallet');
      const m2 = h.newMint();
      h.ledger.prices.set(m2, 0.001);
      h.buy(m2, 1.0);
      await h.sleep(300);
      h.check(h.telegram.sent.filter((s) => s.text.includes('Wallet balance too low')).length === 1, 'alert not repeated');

      h.ledger.lamports = 5n * 1_000_000_000n; // topped up
      await h.sleep(500);
      const m3 = h.newMint();
      h.ledger.prices.set(m3, 0.001);
      h.buy(m3, 1.0);
      await h.waitFor(() => h.active().find((p) => p.mint === m3), 'buys again after top-up');
    }
  },

  starts_paused_until_resume_tapped: {
    env: { TELEGRAM_BOT_TOKEN: 'test-token', TELEGRAM_CHAT_ID: '777', START_PAUSED: 'true' },
    async run(h) {
      const me = { chat: { id: 777, type: 'private' }, from: { id: 777 } };
      const started = await h.waitFor(() => h.telegram.sent.find((s) => s.text.includes('Bot started')), 'startup message');
      h.check(started.text.includes('PAUSED'), `says it's paused (${started.text})`);
      const btn = started.opts.reply_markup.inline_keyboard.flat().find((b) => b.callback_data === 'resume');
      h.check(Boolean(btn), 'startup message has a Resume button');

      const m1 = h.newMint();
      h.ledger.prices.set(m1, 0.001);
      h.buy(m1, 1.0);
      await h.sleep(500);
      h.check(h.ledger.calls.buy.length === 0, 'no buy while paused');

      h.telegram.bot.simulateCallback('resume', me.chat, me.from);
      await h.waitFor(() => h.telegram.sent.some((s) => s.text.startsWith('▶️ Resumed')), 'resumed');
      const m2 = h.newMint();
      h.ledger.prices.set(m2, 0.001);
      h.buy(m2, 1.0);
      await h.waitFor(() => h.active().find((p) => p.mint === m2), 'buys after Resume');
    }
  },

  start_paused_ignored_without_telegram: {
    env: { START_PAUSED: 'true' },
    async run(h) {
      const m = h.newMint();
      h.ledger.prices.set(m, 0.001);
      h.buy(m, 1.0);
      await h.waitFor(() => h.active().find((p) => p.mint === m), 'buys normally (nothing could resume it otherwise)');
    }
  },

  compute_budget_nearly_used_up_warns: {
    async run(h) {
      const m = h.newMint();
      h.ledger.prices.set(m, 0.001);
      h.ledger.computeUnits = 290000; // of the 300,000 the mock reports as budgeted
      h.buy(m, 1.0);
      const line = await h.waitFor(() => h.logs.find((l) => l.includes('of its compute budget')), 'warned');
      h.check(/used 97% of its compute budget.*Raise PUMPFUN_COMPUTE_UNITS to about 350,000/.test(line), line);
    }
  },

  slot_guard_cancels_late_buys_on_chain: {
    env: { MAX_SLOTS_BEHIND: '0', TELEGRAM_BOT_TOKEN: 'test-token', TELEGRAM_CHAT_ID: '777' },
    async run(h) {
      await h.waitFor(() => h.logs.some((l) => l.includes('Slot guard on: buys cancel themselves on-chain if they land more than 0 slot(s)')), 'guard announced');
      h.check(h.logs.some((l) => l.includes('MAX_SLOTS_BEHIND=0 without a shred feed')), 'warned that it needs shreds');
      // Same block: bought.
      const m1 = h.newMint();
      h.ledger.prices.set(m1, 0.001);
      h.ledger.landedSlot = 5000;
      h.ledger.computeUnits = 87654;
      h.buy(m1, 1.0, { slot: 5000, seenAt: Date.now() });
      await h.waitFor(() => h.active().find((p) => p.mint === m1), 'same-block buy kept');
      await h.waitFor(() => h.logs.some((l) => l.includes('used 87,654 compute units of the 300,000 budgeted (29%); most used by one trade this run: 87,654')), 'compute units logged');
      h.check(!h.logs.some((l) => l.includes('of its compute budget')), 'no warning with plenty of room');
      const call = h.ledger.calls.buy.find((c) => c.mint === m1);
      h.check(call.slotGuard && call.slotGuard.maxSlot === 5000 && call.slotGuard.slotsAllowed === 0, `guard passed to the buy (${JSON.stringify(call.slotGuard)})`);
      // One block late: the guard cancels it on-chain; no position, explained.
      const m2 = h.newMint();
      h.ledger.prices.set(m2, 0.001);
      h.ledger.landedSlot = 6001;
      h.buy(m2, 1.0, { slot: 6000, seenAt: Date.now() });
      await h.waitFor(() => h.logs.some((l) => l.includes(`of ${m2} cancelled: it would have landed after slot 6000 (MAX_SLOTS_BEHIND)`)), 'late buy cancelled and explained');
      await h.sleep(200);
      h.check(!h.active().some((p) => p.mint === m2), 'no position for the cancelled buy');
      h.check(!h.logs.some((l) => l.includes('FAILED on-chain')), 'not reported as an ordinary failure');
    }
  },

  shred_buy_timing_and_same_block_rate: {
    env: { MAX_SLOTS_BEHIND: '0', TELEGRAM_BOT_TOKEN: 'test-token', TELEGRAM_CHAT_ID: '777' },
    async run(h) {
      const slotClock = require(require('path').join(process.cwd(), 'src', 'slotClock.js'));
      await h.waitFor(() => h.logs.some((l) => l.includes('Slot guard on')), 'started');
      // Slot 8000 started 120 ms before we saw his buy; we land in it.
      const m1 = h.newMint();
      h.ledger.prices.set(m1, 0.001);
      const seen1 = Date.now();
      slotClock.record(8000, seen1 - 120);
      h.ledger.landedSlot = 8000;
      h.buy(m1, 1.0, { slot: 8000, seenAt: seen1, shred: true });
      await h.waitFor(() => h.logs.some((l) => l.includes('[Timing]') && l.includes('landed in his block')), 'timing line for the same-block buy');
      const line1 = h.logs.find((l) => l.includes('[Timing]') && l.includes('landed in his block'));
      h.check(/his trade reached the bot 1\d\d ms into his slot, ours went out at \d+ ms/.test(line1) && /In his block this run: 1 of 1 \(100%\)/.test(line1), line1);
      h.check(/building 40/.test(line1) && /Sender answered in 20 ms/.test(line1), `steps shown (${line1})`);
      h.check(!/deciding [\d.]+ =/.test(line1), 'no step split without step timings');
      // With the shred feed's step timings: "deciding" is split up.
      const { performance } = require('perf_hooks');
      const m1b = h.newMint();
      h.ledger.prices.set(m1b, 0.001);
      const seen1b = Date.now();
      slotClock.record(8050, seen1b - 100);
      h.ledger.landedSlot = 8050;
      const p0 = performance.now();
      h.buy(m1b, 1.0, { slot: 8050, seenAt: seen1b, shred: true, marks: { t0: p0 - 30, parsed: p0 - 29.5, keys: p0 - 5, tablesFetched: true, classified: p0 - 4.5, emit: p0 - 4 } });
      const lineB = await h.waitFor(() => h.logs.find((l) => l.includes('[Timing]') && l.includes(`${m1b.slice(0, 4)}…${m1b.slice(-4)}`)), 'timing line with steps');
      h.check(/deciding \d+ = reading his tx 25 \(had to fetch a lookup table\), finding the coin 0\.5, handing over [\d.]+, checks [\d.]+; building 40 ms; Sender answered/.test(lineB), lineB);
      h.check(!h.logs.some((l) => l.includes('Received copyTrade') && l.includes('"marks"')), 'step timings not dumped into the log');
      const tg = await h.waitFor(() => h.telegram.sent.find((s) => s.text.includes('BUY') && s.text.includes('In his block this run')), 'rate in the Telegram buy message');
      h.check(!!tg, 'Telegram shows the rate');
      // Next one lands a slot late: cancelled by the guard, counted as late.
      const m2 = h.newMint();
      h.ledger.prices.set(m2, 0.001);
      const seen2 = Date.now();
      slotClock.record(8100, seen2 - 350);
      h.ledger.landedSlot = 8101;
      h.buy(m2, 1.0, { slot: 8100, seenAt: seen2, shred: true });
      await h.waitFor(() => h.logs.some((l) => l.includes('[Timing]') && l.includes('1 slot(s) late')), 'timing line for the late buy');
      const line2 = h.logs.find((l) => l.includes('[Timing]') && l.includes('1 slot(s) late'));
      h.check(/In his block this run: 2 of 3 \(67%\)/.test(line2) && /when we made it, \d+ ms when we didn't/.test(line2), line2);
      // Websocket-fed buys aren't counted.
      const m3 = h.newMint();
      h.ledger.prices.set(m3, 0.001);
      h.ledger.landedSlot = 8200;
      h.buy(m3, 1.0, { slot: 8200 });
      await h.waitFor(() => h.active().find((p) => p.mint === m3), 'websocket buy');
      await h.sleep(200);
      h.check(h.logs.filter((l) => l.includes('[Timing]')).length === 3, 'only shred buys are timed');
    }
  },

  leader_location_in_timing_and_far_leader_skip: {
    env: { MAX_SLOTS_BEHIND: '0', LEADER_INFO: 'true', LEADER_MAX_KM: '500', LEADER_GEO_URL: 'http://127.0.0.1:1' },
    async run(h) {
      const src = (f) => require(require('path').join(process.cwd(), 'src', f));
      const slotClock = src('slotClock.js');
      const leaderInfo = src('leaderInfo.js');
      await h.waitFor(() => h.logs.some((l) => l.includes('Slot guard on')), 'started');
      h.check(h.logs.some((l) => l.includes('slot leader within 500 km')), 'limit shown at startup');
      leaderInfo._setForTests({
        home: { lat: 50.11, lon: 8.68, label: 'Frankfurt' },
        leaders: { 9000: 'FraLeader', 9100: 'AmsLeader', 9200: 'TokLeader', 9300: 'NoGeoLeader' },
        places: {
          FraLeader: { city: 'Frankfurt am Main', cc: 'DE', lat: 50.12, lon: 8.73 },
          AmsLeader: { city: 'Amsterdam', cc: 'NL', lat: 52.37, lon: 4.9 },
          TokLeader: { city: 'Tokyo', cc: 'JP', lat: 35.69, lon: 139.69 },
          NoGeoLeader: null
        }
      });
      const shredBuy = (slot, landed) => {
        const m = h.newMint();
        h.ledger.prices.set(m, 0.001);
        slotClock.record(slot, Date.now() - 50);
        h.ledger.landedSlot = landed;
        h.buy(m, 1.0, { slot, seenAt: Date.now(), shred: true });
        return m;
      };
      const timingLine = (m) => h.logs.find((l) => l.includes('[Timing]') && l.includes(`${m.slice(0, 4)}…${m.slice(-4)}`));

      // 1. Leader in Frankfurt: bought, and the timing line says where it was.
      const m1 = shredBuy(9000, 9000);
      await h.waitFor(() => timingLine(m1), 'timing line (Frankfurt)');
      h.check(/leader in Frankfurt am Main, DE \(~4 km\)/.test(timingLine(m1)) && /by leader distance: ≤100 km 1\/1/.test(timingLine(m1)), timingLine(m1));

      // 2. Amsterdam (~365 km, inside the 500 km limit): bought; lands a slot late here.
      const m2 = shredBuy(9100, 9101);
      await h.waitFor(() => timingLine(m2), 'timing line (Amsterdam)');
      h.check(/leader in Amsterdam, NL \(~3\d\d km\)/.test(timingLine(m2)) && /≤100 km 1\/1, 100–1,500 km 0\/1/.test(timingLine(m2)), timingLine(m2));

      // 3. Tokyo: not sent at all.
      const buysBefore = h.ledger.calls.buy.length;
      const m3 = shredBuy(9200, 9200);
      await h.waitFor(() => h.logs.some((l) => l.includes(`Skipping buy of ${m3}`)), 'far leader skipped');
      const skipLine = h.logs.find((l) => l.includes(`Skipping buy of ${m3}`));
      h.check(/leader of his slot is in Tokyo, JP, ~9,\d{3} km away \(LEADER_MAX_KM=500\)/.test(skipLine) && /Nothing was sent/.test(skipLine), skipLine);
      await h.sleep(200);
      h.check(h.ledger.calls.buy.length === buysBefore, 'no buy sent for the far leader');

      // 4. Location unknown: never a reason to skip; the skip is counted.
      const m4 = shredBuy(9300, 9300);
      await h.waitFor(() => timingLine(m4), 'timing line (unknown location)');
      h.check(/leader NoGe…ader \(location unknown\)/.test(timingLine(m4)) && /1 skipped \(leader too far\)/.test(timingLine(m4)), timingLine(m4));
    }
  },

  fast_path_buy_is_taken_over_as_a_position: {
    env: { TRADE_TYPE: 'SAFE', BUY_AMOUNT: '0.05' },
    async run(h) {
      const te = require(require('path').join(process.cwd(), 'src', 'tradeExecutor.js'));
      const m = h.newMint();
      h.ledger.prices.set(m, 0.001);
      const sig = await te.simulateFastBuy(m, 0.05);
      const fastSent = { status: 'bought', signature: sig, mint: m, amountSol: 0.05, copySol: 1.2, buildMs: 0.31, sendMs: 1.7, sentAt: Date.now(), via: 'Pump.fun', guard: null, compute: null };
      h.buy(m, 1.2, { shred: true, seenAt: Date.now() - 3, fastSent, marks: { t0: 0, parsed: 0, keys: 0.05, classified: 0.1, handler: 0.1, decide: 0.12 } });
      const pos = await h.waitFor(() => h.active().find((p) => p.mint === m), 'position opened from the fast path buy');
      h.check(pos && pos.buy_signature === sig, `the fast path's signature is the position's buy (${pos && pos.buy_signature})`);
      h.check(h.ledger.calls.buy.length === 0, 'this bot did not buy it again');
      h.check(h.ledger.calls.external === 1, 'recorded as an external buy (timing, guard, compute)');
      h.check(h.logs.some((l) => l.includes('The Rust fast path bought 0.05 SOL')), 'logged as bought by the fast path');
      // Rehearsed (paused) by the fast path: a timing line, nothing else.
      const m2 = h.newMint();
      h.buy(m2, 1.0, { shred: true, seenAt: Date.now() - 2, slot: 9900, fastSent: { status: 'rehearsed', mint: m2, amountSol: 0.05, buildMs: 0.28, readyMs: 0.4 }, marks: { t0: 0, parsed: 0, keys: 0.05, classified: 0.1, handler: 0.1, decide: 0.12 } });
      await h.sleep(300);
      h.check(h.logs.some((l) => l.includes('[Timing] REHEARSAL') && l.includes('(Rust fast path)')), 'rehearsal timing line');
      h.check(!h.active().some((p) => p.mint === m2) && h.ledger.calls.buy.length === 0, 'no position, nothing bought');
    }
  },

  paused_bot_rehearses_shred_buys_without_sending: {
    env: { START_PAUSED: 'true', MAX_SLOTS_BEHIND: '0', TELEGRAM_BOT_TOKEN: 'test-token', TELEGRAM_CHAT_ID: '777' },
    async run(h) {
      const slotClock = require(require('path').join(process.cwd(), 'src', 'slotClock.js'));
      const { performance } = require('perf_hooks');
      await h.waitFor(() => h.logs.some((l) => l.includes('Slot guard on')), 'started');
      h.check(h.logs.some((l) => l.includes('Buying is PAUSED')), 'paused at start');
      const m = h.newMint();
      h.ledger.prices.set(m, 0.001);
      slotClock.record(9500, Date.now() - 80);
      const p0 = performance.now();
      h.buy(m, 1.0, { slot: 9500, seenAt: Date.now(), shred: true, marks: { t0: p0 - 3, parsed: p0 - 2.9, keys: p0 - 2, tablesFetched: false, emit: p0 - 1.5 } });
      const line = await h.waitFor(() => h.logs.find((l) => l.includes('[Timing] REHEARSAL')), 'rehearsal timing line');
      h.check(
        /REHEARSAL \(paused, not sent\) \w{4}…\w{4}: his trade reached the bot \d+ ms into his slot, ours was ready to send at \d+ ms; \d+ ms from seeing to ready-to-send \(deciding [\d.]+ = reading his tx [\d.]+, handing over [\d.]+, checks [\d.]+; building 7; signing 1 ms\)\. Rehearsals this run: 1; median seeing→ready \d+ ms\./.test(line),
        line
      );
      await h.sleep(300);
      h.check(h.ledger.calls.buy.length === 0 && h.ledger.calls.rehearsals === 1, `nothing sent (${h.ledger.calls.buy.length} buys, ${h.ledger.calls.rehearsals} rehearsals)`);
      h.check(!h.byMint(m).length, 'no position');
      h.check(!h.logs.some((l) => l.includes('Waiting for confirmation')), 'no confirmation wait');

      // A buy the websocket feed reported (not the shreds): not rehearsed.
      const m2 = h.newMint();
      h.ledger.prices.set(m2, 0.001);
      h.buy(m2, 1.0, { slot: 9600 });
      await h.waitFor(() => h.logs.some((l) => l.includes(`Buying is paused; not copying the buy of ${m2}`)), 'websocket buy just skipped');
      h.check(h.ledger.calls.rehearsals === 1, 'only shred buys are rehearsed');
    }
  },

  rehearse_only_bot_never_buys_even_without_telegram: {
    env: { REHEARSE_ONLY: 'true', START_PAUSED: 'false' },
    async run(h) {
      await h.waitFor(() => h.logs.some((l) => l.includes('REHEARSE_ONLY: this bot NEVER buys')), 'announced');
      const m = h.newMint();
      h.ledger.prices.set(m, 0.001);
      h.buy(m, 1.0, { slot: 9700, seenAt: Date.now(), shred: true });
      await h.waitFor(() => h.logs.some((l) => l.includes('[Timing] REHEARSAL')), 'rehearsed');
      const m2 = h.newMint();
      h.ledger.prices.set(m2, 0.001);
      h.buy(m2, 1.0, { slot: 9701 });
      await h.waitFor(() => h.logs.some((l) => l.includes(`not copying the buy of ${m2}`)), 'websocket buy not copied');
      await h.sleep(200);
      h.check(h.ledger.calls.buy.length === 0, `nothing bought (${h.ledger.calls.buy.length})`);
    }
  },

  slot_guard_off_when_its_program_is_missing: {
    env: { MAX_SLOTS_BEHIND: '1', TELEGRAM_BOT_TOKEN: 'test-token', TELEGRAM_CHAT_ID: '777' },
    setup(h) { h.ledger.lighthouseMissing = true; },
    async run(h) {
      await h.waitFor(() => h.telegram.sent.some((s) => s.text.includes('MAX_SLOTS_BEHIND is OFF')), 'alerted');
      const m = h.newMint();
      h.ledger.prices.set(m, 0.001);
      h.buy(m, 1.0, { slot: 7000 });
      await h.waitFor(() => h.active().find((p) => p.mint === m), 'buys continue, unguarded');
      h.check(!h.ledger.calls.buy[0].slotGuard, 'no guard sent');
    }
  },

  instant_buy_filters_market_cap_creator_and_his_buy_size: {
    env: { MIN_MARKET_CAP_SOL: '30', MAX_MARKET_CAP_SOL: '100', MIN_COPY_BUY_SOL: '0.5', BLOCKED_CREATORS: '7iVnZ32MmVCh9sBiBYewgtXDrUiqtw3R1RPhxVJWv4P7', TELEGRAM_BOT_TOKEN: 'test-token', TELEGRAM_CHAT_ID: '777' },
    async run(h) {
      const [ok, high, low, blocked, unknown, small] = Array.from({ length: 6 }, () => h.newMint());
      for (const m of [ok, high, low, blocked, unknown, small]) h.ledger.prices.set(m, 0.001);
      h.ledger.coinInfo.set(ok, { mcapSol: 60, creator: null });
      h.ledger.coinInfo.set(high, { mcapSol: 150, creator: null });
      h.ledger.coinInfo.set(low, { mcapSol: 20, creator: null });
      h.ledger.coinInfo.set(blocked, { mcapSol: 50, creator: '7iVnZ32MmVCh9sBiBYewgtXDrUiqtw3R1RPhxVJWv4P7' });
      h.ledger.coinInfo.set(small, { mcapSol: 50, creator: null });
      h.buy(ok, 1.0);
      h.buy(high, 1.0);
      h.buy(low, 1.0);
      h.buy(blocked, 1.0);
      h.buy(unknown, 1.0);
      h.buy(small, 0.2);
      await h.waitFor(() => h.active().find((p) => p.mint === ok), 'coin inside the market-cap range bought');
      await h.waitFor(() => h.logs.some((l) => l.includes(`Skipping buy of ${high}: market cap 150 SOL is above MAX_MARKET_CAP_SOL (100)`)), 'too high skipped');
      await h.waitFor(() => h.logs.some((l) => l.includes(`Skipping buy of ${low}: market cap 20.0 SOL is below MIN_MARKET_CAP_SOL (30)`)), 'too low skipped');
      await h.waitFor(() => h.logs.some((l) => l.includes(`Skipping buy of ${blocked}`) && l.includes('BLOCKED_CREATORS')), 'blocked creator skipped');
      await h.waitFor(() => h.logs.some((l) => l.includes(`Skipping buy of ${unknown}`) && l.includes("can't be read instantly")), 'unknown market cap skipped');
      await h.waitFor(() => h.logs.some((l) => l.includes('below MIN_COPY_BUY_SOL (0.5)')), 'small copy buy ignored');
      await h.sleep(300);
      h.check(h.active().length === 1, `only the in-range coin was bought (${h.active().map((p) => p.mint).join(',')})`);
      h.check(!h.ledger.calls.buy.some((c) => c.mint === small), 'small copy buy never reached the buy step');
      h.check(h.telegram.sent.some((s) => s.text.includes('above your max (100 SOL)')), 'Telegram says why it skipped');
      h.check(h.logs.some((l) => l.includes('buy filters=market cap 30-100 SOL, his buy >= 0.5 SOL, 1 blocked creator(s)')), 'startup line lists the filters');
    }
  },

  slots_behind_uses_his_landed_slot_and_curve_hint_reaches_builder: {
    async run(h) {
      const m = h.newMint();
      h.ledger.prices.set(m, 0.001);
      h.ledger.landedSlot = 2005;
      // The processed feed said slot 2004, but his trade actually landed in 2002.
      h.ledger.copySlots.set('copyHinted', 2002);
      const curveHint = { mint: m, virtualTokenReserves: '800000000000000', virtualSolReserves: '40000000000', at: Date.now() };
      h.emit({ signature: 'copyHinted', dexs: ['Pump.fun'], ca: m, trade: 'buy', solAmount: -1, tokenAmount: 1000, sellPercent: null, slot: 2004, curveHint });
      await h.waitFor(() => h.active().find((p) => p.mint === m), 'position opened');
      const call = h.ledger.calls.buy[0];
      h.check(call.curveHint && call.curveHint.virtualSolReserves === '40000000000', 'the trade record reaches buyToken');
      h.check(h.ledger.statusLookups.some((l) => l.length === 2 && l[1] === 'copyHinted'), 'his signature is checked in the same call as ours');
      await h.waitFor(() => h.logs.some((l) => l.includes('3 slot(s) after the copy wallet (2002 -> 2005; the feed reported his trade at slot 2004, it landed in 2002)')), 'slots behind measured from where his trade landed');
    }
  },

  telegram_sell_button_flow: {
    env: { TELEGRAM_BOT_TOKEN: 'test-token', TELEGRAM_CHAT_ID: '777' },
    async run(h) {
      const me = { chat: { id: 777, type: 'private' }, from: { id: 777 } };
      const m = h.newMint();
      h.ledger.prices.set(m, 0.001);
      h.ledger.landedSlot = 1004; // the copy buy below is at slot 1001
      h.buy(m, 1.0, { seenAt: Date.now() });
      const pos = await h.waitFor(() => h.active().find((p) => p.mint === m), 'position opened');
      const buyMsg = await h.waitFor(() => h.telegram.sent.find((s) => s.text.includes('BUY')), 'buy notification');
      h.check(/Landed 3 slots behind the copy wallet \(~1\.2s\); bot took \d+ms to send/.test(buyMsg.text),
        `buy message reports slots behind and reaction time (${buyMsg.text})`);

      // The positions list (with sell buttons) arrives by itself after the buy.
      const list = await h.waitFor(() => h.telegram.sent.find((s) => s.opts && s.opts.reply_markup && /open position/.test(s.text)), 'positions list sent automatically after buy');
      const row = list.opts.reply_markup.inline_keyboard[0];
      h.check(row.length === 2 && row[0].callback_data === `sell50:${pos.id}` && row[1].callback_data === `sell:${pos.id}`,
        `row has Sell 50% and Sell all for the position (${JSON.stringify(row)})`);
      h.check(list.text.includes('1. ') && list.text.includes(pos.mint.slice(0, 4)), `list text describes the position (${list.text})`);
      const buyMsgIdx = h.telegram.sent.findIndex((s) => s.text.includes('BUY'));
      h.check(buyMsgIdx >= 0 && buyMsgIdx < h.telegram.sent.indexOf(list), 'buy notification comes first, then the list');

      // /positions still works on demand.
      const before = h.telegram.sent.length;
      h.telegram.bot.simulateText('/positions', me.chat, me.from);
      await h.waitFor(() => h.telegram.sent.slice(before).some((s) => s.opts && s.opts.reply_markup), '/positions on demand');

      // Someone else (e.g. in a group chat) taps it: refused, nothing sold.
      h.telegram.bot.simulateCallback(`sell:${pos.id}`, { id: 777, type: 'group' }, { id: 999 });
      await h.sleep(300);
      h.check(h.ledger.calls.sell.length === 0, 'unauthorized tap sells nothing');

      // Owner taps "Sell 50%".
      h.telegram.bot.simulateCallback(`sell50:${pos.id}`, me.chat, me.from);
      await h.waitFor(() => h.active().find((p) => p.mint === m && p.token_amount === '5000.000000'), 'half sold');
      await h.waitFor(() => h.telegram.sent.some((s) => s.text.startsWith('✅') && s.text.includes('50.00%')), '50% success reply');
      h.check(h.ledger.calls.sell[0].amountTokens === '5000.000000', `sold exactly half (${h.ledger.calls.sell[0].amountTokens})`);

      // Then "Sell all", with Telegram rejecting answerCallbackQuery ("query is too old").
      h.telegram.failAnswers = true;
      h.telegram.bot.simulateCallback(`sell:${pos.id}`, me.chat, me.from);
      await h.waitFor(() => h.byMint(m).find((p) => p.status === 'closed'), 'rest sold via button');
      await h.waitFor(() => h.telegram.sent.some((s) => s.text.startsWith('✅ Sold')), 'success reply');
      h.check(h.telegram.sent.some((s) => s.text.includes('SELL (Telegram manual sell)') && s.text.includes('PnL')), 'PnL notification sent');
      h.check(h.ledger.calls.sell[1].amountTokens === '5000.000000', 'sold the remaining half');

      h.telegram.bot.simulateCallback(`sell:${pos.id}`, me.chat, me.from); // tap again
      await h.waitFor(() => h.telegram.sent.some((s) => s.text.includes('already closed')), 'second tap reports already closed');
      h.check(h.ledger.calls.sell.length === 2, `exactly two sells (got ${h.ledger.calls.sell.length})`);
    }
  },

  telegram_failed_manual_half_sell_is_not_auto_retried: {
    env: { TELEGRAM_BOT_TOKEN: 'test-token', TELEGRAM_CHAT_ID: '777', TRADE_TYPE: 'STIERED', TIER_BUY_CONFIG: TIERS },
    async run(h) {
      const me = { chat: { id: 777, type: 'private' }, from: { id: 777 } };
      const m = h.newMint();
      h.ledger.prices.set(m, 0.001);
      h.buy(m, 1.0);
      const pos = await h.waitFor(() => h.active().find((p) => p.mint === m), 'position opened');
      h.ledger.sellQueue.push('throw', 'throw', 'throw');
      h.telegram.bot.simulateCallback(`sell50:${pos.id}`, me.chat, me.from);
      await h.waitFor(() => h.telegram.sent.some((s) => s.text.startsWith('⚠️')), 'failure reported');
      await h.sleep(1500); // longer than the retry cooldown
      h.check(h.ledger.calls.sell.length === 3, `no automatic retry of a manual sell (sells ${h.ledger.calls.sell.length})`);
      const p = h.active().find((x) => x.mint === m);
      h.check(p && p.pending_sell_pct == null && p.token_amount === '15000.000000', 'position unchanged, nothing queued');
    }
  },

  telegram_stop_command: {
    env: { TELEGRAM_BOT_TOKEN: 'test-token', TELEGRAM_CHAT_ID: '777' },
    setup(h) {
      // A /stop left over from before this start (Telegram re-delivers
      // unacknowledged updates): must be ignored, not stop the new session.
      h.telegram.updates.push({ update_id: 90, message: { text: '/stop', chat: { id: 777, type: 'private' }, from: { id: 777 } } });
      h.telegram.nextUpdateId = 91;
    },
    async run(h) {
      const me = { chat: { id: 777, type: 'private' }, from: { id: 777 } };
      const m = h.newMint();
      h.ledger.prices.set(m, 0.001);
      h.buy(m, 1.0);
      await h.waitFor(() => h.active().find((p) => p.mint === m), 'position opened');
      h.check(!h.telegram.sent.some((s) => s.text.startsWith('Stop the bot?')), 'stale /stop from before startup ignored');

      h.telegram.bot.simulateText('/stop', { id: 777, type: 'group' }, { id: 999 }); // not you
      await h.sleep(300);
      h.check(!h.telegram.sent.some((s) => s.text.startsWith('Stop the bot?')), 'unauthorized /stop ignored');

      h.telegram.bot.simulateText('/stop', me.chat, me.from);
      const confirm = await h.waitFor(() => h.telegram.sent.find((s) => s.text.startsWith('Stop the bot?')), 'confirmation asked');
      h.check(/1 position\(s\) are open\. Stopping does NOT sell them/.test(confirm.text), `warns positions stay open (${confirm.text})`);
      const [yes, cancel] = confirm.opts.reply_markup.inline_keyboard[0];

      h.telegram.bot.simulateCallback(cancel.callback_data, me.chat, me.from);
      await h.waitFor(() => h.telegram.sent.some((s) => s.text.includes('keeps running')), 'cancel acknowledged');

      h.telegram.bot.simulateCallback(`stop:${Date.now() - 10 * 60 * 1000}`, me.chat, me.from); // an old button
      await h.waitFor(() => h.telegram.sent.some((s) => s.text.includes('expired')), 'expired button refused');

      h.state.stopUpdateId = h.telegram.nextUpdateId;
      h.telegram.bot.simulateCallback(yes.callback_data, me.chat, me.from);
      await h.sleep(10000); // onExit fires first
    },
    onExit(h, code) {
      h.check(code === 0, `clean exit (got ${code})`);
      h.check(h.telegram.sent.some((s) => s.text.startsWith('🛑 Stopping')), 'stopping acknowledged');
      const final = h.telegram.sent.find((s) => s.text.startsWith('🛑 Bot stopped'));
      h.check(final && /1 position\(s\) still open and NOT sold/.test(final.text), `final message sent (${final && final.text})`);
      h.check(h.active().length === 1, 'position left open, not sold');
      h.check(h.ledger.calls.sell.length === 0, 'nothing sold');
      h.check(global.__emitter.disconnected === true, 'trade feed disconnected');
      const acked = h.telegram.getUpdatesOffsets.some((o) => o > h.state.stopUpdateId);
      h.check(acked, `the /stop tap was acknowledged so it won't be re-delivered next start (${JSON.stringify(h.telegram.getUpdatesOffsets.slice(-3))})`);
    }
  },

  telegram_close_all_positions: {
    env: { TELEGRAM_BOT_TOKEN: 'test-token', TELEGRAM_CHAT_ID: '777' },
    async run(h) {
      const me = { chat: { id: 777, type: 'private' }, from: { id: 777 } };
      const mints = [h.newMint(), h.newMint(), h.newMint()];
      mints.forEach((m) => h.ledger.prices.set(m, 0.001));
      for (const m of mints) {
        h.buy(m, 1.0);
        await h.waitFor(() => h.active().find((p) => p.mint === m), 'position opened');
      }
      await h.sleep(300);
      const list = [...h.telegram.sent].reverse().find((s) => s.opts && s.opts.reply_markup && /open position/.test(s.text));
      const rows = list.opts.reply_markup.inline_keyboard;
      const last = rows[rows.length - 1];
      h.check(last.some((b) => b.callback_data === 'closeallask') && last.some((b) => b.callback_data === 'pause'), `Pause + Close all buttons at the bottom (${JSON.stringify(last)})`);

      h.telegram.bot.simulateCallback('closeallask', me.chat, me.from);
      const confirm = await h.waitFor(() => h.telegram.sent.find((s) => s.text.startsWith('Sell ALL 3')), 'confirmation asked');
      const [yes, cancel] = confirm.opts.reply_markup.inline_keyboard[0];

      h.telegram.bot.simulateCallback(cancel.callback_data, me.chat, me.from);
      await h.waitFor(() => h.telegram.sent.some((s) => s.text === 'OK, nothing sold.'), 'cancel works');
      h.check(h.ledger.calls.sell.length === 0, 'cancel sells nothing');

      h.telegram.bot.simulateCallback('closeallask', { id: 777, type: 'group' }, { id: 999 }); // not you
      await h.sleep(200);

      h.ledger.sellFailuresByMint.set(mints[1], 3); // this position's sell fails every attempt at first
      h.telegram.bot.simulateCallback(yes.callback_data, me.chat, me.from);
      const summary = await h.waitFor(() => h.telegram.sent.find((s) => /Closed \d of 3|Closed all/.test(s.text)), 'summary sent', 15000);
      h.check(/Closed 2 of 3/.test(summary.text) && /retried automatically/.test(summary.text), `partial failure reported (${summary.text})`);
      await h.waitFor(() => h.active().length === 0, 'failed one retried and closed', 15000);
      h.check(mints.every((m) => (h.ledger.tokens.get(m) || 0n) === 0n), 'every position sold');
    }
  },

  skip_rebuys_full_mode: {
    env: { TRADE_TYPE: 'STIERED', TIER_BUY_CONFIG: TIERS, SKIP_REBUYS: 'full', ENABLE_MULTI_BUY: 'true' },
    async run(h) {
      const [a, b] = [h.newMint(), h.newMint()];
      [a, b].forEach((m) => h.ledger.prices.set(m, 0.001));
      // Coin A: they sell everything, then buy back -> ignored.
      h.buy(a, 1.0);
      await h.waitFor(() => h.active().find((p) => p.mint === a), 'A opened');
      h.sell(a, 100);
      await h.waitFor(() => h.byMint(a).find((p) => p.status === 'closed'), 'A closed');
      h.buy(a, 1.0);
      // Coin B: they only sell part, then add -> still copied (full mode).
      h.buy(b, 1.0);
      await h.waitFor(() => h.active().find((p) => p.mint === b), 'B opened');
      h.sell(b, 40);
      await h.waitFor(() => h.active().find((p) => p.mint === b && p.token_amount === '9000.000000'), 'B partially sold');
      h.buy(b, 1.0);
      await h.waitFor(() => h.active().find((p) => p.mint === b && p.buy_count === 2), 'B rebuy copied');
      await h.sleep(500);
      const buysA = h.ledger.calls.buy.filter((c) => c.mint === a).length;
      h.check(buysA === 1, `rebuy of fully-exited coin ignored (buys of A: ${buysA})`);
      h.check(h.active().every((p) => p.mint !== a), 'no new position in A');
      const saved = h.exitedMints();
      h.check(saved.includes(`${process.env.COPY_WALLET}:${a}`) && !saved.some((x) => x.endsWith(b)), `exit remembered on disk for A only (${JSON.stringify(saved.map((x) => x.slice(0, 4)))})`);
    }
  },

  max_open_positions_caps_new_buys: {
    env: { MAX_OPEN_POSITIONS: '2', TRADE_TYPE: 'EXACT', ENABLE_MULTI_BUY: 'true' },
    async run(h) {
      const [a, b, c, d] = [h.newMint(), h.newMint(), h.newMint(), h.newMint()];
      [a, b, c, d].forEach((m) => h.ledger.prices.set(m, 0.001));
      // Three buys at once: only two places.
      h.buy(a, 0.2);
      h.buy(b, 0.2);
      h.buy(c, 0.2);
      await h.waitFor(() => h.active().length === 2, 'two positions opened');
      await h.sleep(600);
      h.check(h.ledger.calls.buy.length === 2 && h.active().length === 2, `third buy skipped, nothing sent for it (buys ${h.ledger.calls.buy.length})`);
      h.check(h.logs.some((l) => l.includes('the most allowed by MAX_OPEN_POSITIONS (2)')), 'skip explained in the log');
      // Adding to a coin already held isn't a new position.
      const held = h.active()[0].mint;
      h.buy(held, 0.2);
      await h.waitFor(() => h.active().find((p) => p.mint === held && p.buy_count === 2), 'add-on to a held coin still copied at the cap');
      // A place frees up when one closes.
      h.sell(held, 100);
      await h.waitFor(() => h.active().length === 1, 'one closed');
      h.buy(d, 0.2);
      await h.waitFor(() => h.active().find((p) => p.mint === d), 'next buy copied once there is room');
    }
  },

  buy_cooldown_skips_a_second_buy_soon_after: {
    env: { BUY_COOLDOWN_SEC: '2', TRADE_TYPE: 'EXACT' },
    async run(h) {
      const [a, b, c, d] = [h.newMint(), h.newMint(), h.newMint(), h.newMint()];
      [a, b, c, d].forEach((m) => h.ledger.prices.set(m, 0.001));
      // A buy that never went out doesn't start the cooldown.
      h.ledger.buyQueue.push('throw');
      h.buy(a, 0.2);
      await h.waitFor(() => h.ledger.calls.buy.length === 1, 'first buy attempted (fails before sending)');
      await h.sleep(100);
      h.buy(b, 0.2);
      await h.waitFor(() => h.active().find((p) => p.mint === b), 'next buy copied: nothing was sent before it');
      // Within the cooldown of b's buy: skipped, nothing sent.
      h.buy(c, 0.2);
      await h.sleep(400);
      h.check(!h.ledger.calls.buy.some((x) => x.mint === c), 'buy within the cooldown not sent');
      h.check(h.logs.some((l) => l.includes(`Skipping buy of ${c}`) && l.includes('(BUY_COOLDOWN_SEC=2)')), 'skip explained');
      // After it: copied again.
      await h.sleep(1800);
      h.buy(d, 0.2);
      await h.waitFor(() => h.active().find((p) => p.mint === d), 'buy after the cooldown copied');
    }
  },

  missed_copy_sell_caught_by_holdings_check: {
    env: { TRADE_TYPE: 'EXACT', HOLD_CHECK_MS: '300', HOLD_CHECK_MIN_AGE_MS: '0', MIRROR_TRANSFERS: 'false' },
    async run(h) {
      const [m, kept] = [h.newMint(), h.newMint()];
      [m, kept].forEach((x) => h.ledger.prices.set(x, 0.001));
      h.ledger.copyHeldNow.add(m);
      h.ledger.copyHeldNow.add(kept);
      h.buy(m, 0.2);
      h.buy(kept, 0.2);
      await h.waitFor(() => h.active().length === 2, 'both bought');
      await h.sleep(800);
      h.check(h.active().length === 2, 'kept while the copy wallet still holds them');
      // He sold m, but the sell never reached the bot.
      h.ledger.copyHeldNow.delete(m);
      // He moved `kept` to another wallet (seen; MIRROR_TRANSFERS off): not an exit.
      h.transfer(kept, 100);
      await h.sleep(100);
      h.ledger.copyHeldNow.delete(kept);
      await h.waitFor(() => h.byMint(m).find((p) => p.status === 'closed'), 'position exited after the missed sell');
      h.check(h.logs.some((l) => l.includes('its sell never reached the bot')), 'explained in the log');
      await h.sleep(800);
      h.check(h.active().some((p) => p.mint === kept), 'a coin he moved out (transfers not mirrored) is not sold');
    }
  },

  several_copy_wallets_each_position_follows_its_own: {
    env: (base) => ({ COPY_WALLET: `${base.COPY_WALLET}, ${SECOND_WALLET}`, TRADE_TYPE: 'EXACT', ENABLE_MULTI_BUY: 'true', SKIP_REBUYS: 'full' }),
    async run(h) {
      const w1 = process.env.COPY_WALLET.split(',')[0].trim();
      const w2 = SECOND_WALLET;
      const [a, b] = [h.newMint(), h.newMint()];
      [a, b].forEach((m) => h.ledger.prices.set(m, 0.001));
      h.buy(a, 0.2, { wallet: w1 });
      h.buy(b, 0.2, { wallet: w2 });
      await h.waitFor(() => h.active().length === 2, 'both wallets\' buys copied');
      const pa = h.active().find((p) => p.mint === a);
      const pb = h.active().find((p) => p.mint === b);
      h.check(pa.copy_wallet === w1 && pb.copy_wallet === w2, 'each position remembers whose buy opened it');
      // The other wallet buying a coin we hold: not added.
      h.buy(a, 0.2, { wallet: w2 });
      await h.sleep(500);
      h.check(h.ledger.calls.buy.filter((x) => x.mint === a).length === 1, 'another wallet\'s buy of a held coin not copied');
      // The other wallet selling it: ignored; its own wallet selling: closed.
      h.sell(a, 100, { wallet: w2 });
      await h.sleep(500);
      h.check(h.active().some((p) => p.mint === a), 'position kept when a different wallet sells');
      h.check(h.logs.some((l) => l.includes(`your position follows`)), 'explained in the log');
      h.sell(b, 100, { wallet: w2 });
      await h.waitFor(() => h.byMint(b).find((p) => p.status === 'closed'), 'closed when its own wallet sells');
      // SKIP_REBUYS is per wallet: w2 exited a, but w1 still holds it; w2 exited b, w1 may still buy b.
      h.buy(b, 0.2, { wallet: w1 });
      await h.waitFor(() => h.active().find((p) => p.mint === b && p.copy_wallet === w1), 'a coin one wallet exited is still copied for another');
      h.sell(a, 100, { wallet: w1 });
      await h.waitFor(() => h.byMint(a).find((p) => p.status === 'closed'), 'first wallet\'s sell closes its position');
    }
  },

  skip_rebuys_any_mode: {
    env: { SKIP_REBUYS: 'any', ENABLE_MULTI_BUY: 'true' },
    async run(h) {
      const m = h.newMint();
      h.ledger.prices.set(m, 0.001);
      h.buy(m, 1.0);
      await h.waitFor(() => h.active().find((p) => p.mint === m), 'opened');
      h.sell(m, 25); // SAFE position ignores the sell itself, but it still counts as an exit
      await h.sleep(300);
      h.buy(m, 1.0);
      await h.sleep(800);
      h.check(h.ledger.calls.buy.length === 1, `add-on after a partial sell ignored in "any" mode (buys ${h.ledger.calls.buy.length})`);
    }
  },

  skip_rebuys_remembered_across_restart: {
    env: { TRADE_TYPE: 'EXACT', SKIP_REBUYS: 'full' },
    setup(h) {
      h.state.old = h.newMint(); // exited in a previous session
      h.writePositions([], { exitedMints: [h.state.old] });
    },
    async run(h) {
      h.ledger.prices.set(h.state.old, 0.001);
      h.buy(h.state.old, 0.2);
      await h.sleep(800);
      h.check(h.ledger.calls.buy.length === 0, 'exit from a previous session still honoured');
    }
  },

  rebuys_copied_when_option_off: {
    env: { TRADE_TYPE: 'EXACT' },
    async run(h) {
      const m = h.newMint();
      h.ledger.prices.set(m, 0.001);
      h.buy(m, 0.2);
      await h.waitFor(() => h.active().find((p) => p.mint === m), 'opened');
      h.sell(m, 100);
      await h.waitFor(() => h.byMint(m).find((p) => p.status === 'closed'), 'closed');
      h.buy(m, 0.2);
      await h.waitFor(() => h.active().find((p) => p.mint === m), 'rebuy copied (default off)');
    }
  },

  telegram_pause_and_resume: {
    env: { TELEGRAM_BOT_TOKEN: 'test-token', TELEGRAM_CHAT_ID: '777', TRADE_TYPE: 'EXACT' },
    async run(h) {
      const me = { chat: { id: 777, type: 'private' }, from: { id: 777 } };
      const [a, b, c] = [h.newMint(), h.newMint(), h.newMint()];
      [a, b, c].forEach((m) => h.ledger.prices.set(m, 0.001));
      h.buy(a, 0.2);
      await h.waitFor(() => h.active().find((p) => p.mint === a), 'A opened');

      h.telegram.bot.simulateText('/pause', me.chat, me.from);
      await h.waitFor(() => h.telegram.sent.some((s) => s.text.startsWith('⏸ Paused')), 'pause acknowledged');
      h.check(h.rawData().paused === true, 'paused state saved to disk');

      h.buy(b, 0.2); // copy wallet buys while paused -> skipped
      await h.sleep(600);
      h.check(!h.byMint(b).length && h.ledger.calls.buy.length === 1, `no buy while paused (buys ${h.ledger.calls.buy.length})`);

      h.sell(a, 100); // exits still mirrored while paused
      await h.waitFor(() => h.byMint(a).find((p) => p.status === 'closed'), 'copy-sell still works while paused');

      const before = h.telegram.sent.length;
      h.telegram.bot.simulateText('/positions', me.chat, me.from);
      const list = await h.waitFor(() => h.telegram.sent.slice(before).find((s) => s.opts && s.opts.reply_markup && /open position/.test(s.text)), 'list');
      h.check(list.text.includes('PAUSED'), `list shows paused status (${list.text})`);
      const resumeBtn = list.opts.reply_markup.inline_keyboard.flat().find((x) => x.callback_data === 'resume');
      h.check(Boolean(resumeBtn), 'Resume button offered');

      h.telegram.bot.simulateCallback('resume', me.chat, me.from);
      await h.waitFor(() => h.telegram.sent.some((s) => s.text.startsWith('▶️ Resumed')), 'resumed');
      h.check(h.rawData().paused === false, 'resume saved to disk');
      h.buy(c, 0.2);
      await h.waitFor(() => h.active().find((p) => p.mint === c), 'buys copied again after resume');
      h.check(!h.byMint(b).length, 'the buy missed while paused is not replayed');
    }
  },

  paused_state_survives_restart: {
    env: { TRADE_TYPE: 'EXACT', TELEGRAM_BOT_TOKEN: 'test-token', TELEGRAM_CHAT_ID: '777', START_PAUSED: 'false' },
    setup(h) {
      h.writePositions([], { paused: true });
    },
    async run(h) {
      const m = h.newMint();
      h.ledger.prices.set(m, 0.001);
      h.buy(m, 0.2);
      await h.sleep(800);
      h.check(h.ledger.calls.buy.length === 0, 'still paused after restart');
    }
  },

  saved_pause_lifted_without_telegram: {
    env: { TRADE_TYPE: 'EXACT' },
    setup(h) {
      h.writePositions([], { paused: true });
    },
    async run(h) {
      const m = h.newMint();
      h.ledger.prices.set(m, 0.001);
      h.buy(m, 0.2);
      await h.waitFor(() => h.active().find((p) => p.mint === m), 'buys work: no Telegram means no way to resume, so the old pause is lifted');
      h.check(h.rawData().paused === false, 'pause cleared on disk');
    }
  },

  telegram_rate_limit_message_resent_not_lost: {
    env: { TELEGRAM_BOT_TOKEN: 'test-token', TELEGRAM_CHAT_ID: '777' },
    async run(h) {
      const me = { chat: { id: 777, type: 'private' }, from: { id: 777 } };
      await h.sleep(300);
      h.telegram.rateLimitSends = 1;
      const before = h.telegram.sent.length;
      h.telegram.bot.simulateText('/help', me.chat, me.from);
      await h.waitFor(() => h.telegram.sent.slice(before).some((m) => /\/positions/.test(m.text)), 'message sent after Telegram asked to wait', 5000);
      h.check(h.logs.some((l) => l.includes('Telegram asked to slow down')), 'the wait is logged');
    }
  },

  telegram_old_taps_ignored_even_if_first_call_fails: {
    env: { TELEGRAM_BOT_TOKEN: 'test-token', TELEGRAM_CHAT_ID: '777', START_PAUSED: 'false' },
    setup(h) {
      // A /pause sent while the bot was offline, and no network at startup.
      h.telegram.bot.simulateText('/pause', { id: 777, type: 'private' }, { id: 777 });
      h.telegram.networkDown = true;
    },
    async run(h) {
      await h.sleep(300);
      h.telegram.networkDown = false;
      await h.waitFor(() => h.logs.some((l) => l.includes('Ignored Telegram messages/taps sent while the bot was offline')), 'old updates discarded once the network is back', 6000);
      await h.sleep(500);
      h.check(h.rawData().paused !== true, 'the old /pause was not acted on');
    }
  },

  telegram_outage_never_crashes_bot: {
    env: { TELEGRAM_BOT_TOKEN: 'test-token', TELEGRAM_CHAT_ID: '777' },
    setup(h) {
      h.telegram.failSends = true;
      h.telegram.failAnswers = true;
    },
    async run(h) {
      const me = { chat: { id: 777, type: 'private' }, from: { id: 777 } };
      await h.sleep(200);
      h.telegram.bot.simulateText('/positions', me.chat, me.from);
      h.telegram.bot.simulateCallback('sell:nonexistent', me.chat, me.from);
      h.telegram.bot.simulateCallback('sell:x', undefined, me.from); // malformed update
      await h.sleep(300);
      h.telegram.networkDown = true; // full outage: polling errors + backoff
      const m = h.newMint();
      h.ledger.prices.set(m, 0.001);
      h.buy(m, 1.0);
      await h.waitFor(() => h.active().find((p) => p.mint === m), 'bot keeps trading through Telegram errors');
      await h.sleep(1500);
      h.telegram.networkDown = false;
      h.telegram.failSends = false;
      h.telegram.bot.simulateText('/positions', me.chat, me.from);
      await h.waitFor(() => h.telegram.sent.find((s) => s.opts && s.opts.reply_markup && /open position/.test(s.text)), 'polling recovers after the outage', 10000);
    }
  },

  tp_and_telegram_sell_same_moment_sell_once: {
    env: { TELEGRAM_BOT_TOKEN: 'test-token', TELEGRAM_CHAT_ID: '777' },
    async run(h) {
      const me = { chat: { id: 777, type: 'private' }, from: { id: 777 } };
      const m = h.newMint();
      h.ledger.prices.set(m, 0.001);
      h.buy(m, 1.0);
      const pos = await h.waitFor(() => h.active().find((p) => p.mint === m), 'position opened');
      h.ledger.prices.set(m, 0.002); // TP
      h.telegram.bot.simulateCallback(`sell:${pos.id}`, me.chat, me.from);
      await h.waitFor(() => h.byMint(m).find((p) => p.status === 'closed'), 'closed');
      await h.sleep(1200);
      h.check(h.ledger.calls.sell.length === 1, `one sell despite two triggers (got ${h.ledger.calls.sell.length})`);
    }
  },

  selling_mode_continues_past_a_failure: {
    env: { BOT_MODE: 'SELLING' },
    setup(h) {
      const ms = [h.newMint(), h.newMint(), h.newMint()];
      h.state.ms = ms;
      ms.forEach((m) => {
        h.ledger.tokens.set(m, 1000n * 10n ** 6n);
        h.ledger.prices.set(m, 0.001);
      });
      h.writePositions(ms.map((m, i) =>
        seedPosition({ id: `p${i}`, mint: m, trade_mode: 'SAFE', token_amount: '1000.000000', decimals: 6, buy_amount: 0.01, cost_basis_sol: 0.01, entry_price: 0.001, stop_loss_pct: 20, take_profit_pct: 50 })
      ));
      h.ledger.sellQueue.push('ok', 'throw', 'throw', 'throw', 'ok');
    },
    onExit(h, code) {
      const [a, b, c] = h.state.ms.map((m) => h.byMint(m)[0]);
      h.check(code === 1, `exit code 1 when something couldn't be sold (got ${code})`);
      h.check(a.status === 'closed', 'first position sold');
      h.check(b.status === 'active', 'failed position left OPEN, not marked closed');
      h.check(c.status === 'closed', 'liquidation continued past the failure');
    }
  },

  shutdown_waits_for_in_flight_buy: {
    async run(h) {
      h.ledger.buyDelayMs = 800;
      const m = h.newMint();
      h.ledger.prices.set(m, 0.001);
      h.buy(m, 1.0);
      await h.sleep(100);
      process.emit('SIGTERM');
      const other = h.newMint();
      h.buy(other, 1.0); // arrives after shutdown began: must be ignored
      await h.sleep(5000); // onExit fires first
    },
    onExit(h, code) {
      h.check(code === 0, `clean exit code (got ${code})`);
      h.check(h.active().length === 1, `in-flight buy completed and was recorded before exit (active ${h.active().length})`);
      h.check(h.ledger.calls.buy.length === 1, `no new buys after shutdown began (buys ${h.ledger.calls.buy.length})`);
      h.check(global.__emitter.disconnected === true, 'trade feed disconnected');
    }
  },

  partial_sell_that_lands_late_is_not_repeated: {
    env: { TRADE_TYPE: 'STIERED', TIER_BUY_CONFIG: TIERS },
    async run(h) {
      const m = h.newMint();
      h.ledger.prices.set(m, 0.001);
      h.buy(m, 1.0);
      await h.waitFor(() => h.active().find((p) => p.mint === m), 'position opened');
      h.ledger.sellQueue.push('landLate');
      h.sell(m, 40);
      const pos = await h.waitFor(
        () => h.active().find((p) => p.mint === m && p.token_amount === '9000.000000'),
        'remaining recorded after late landing',
        10000
      );
      h.check(Boolean(pos), '60% remains');
      h.check(h.ledger.calls.sell.length === 1, `late-landing sell not sent twice (sells ${h.ledger.calls.sell.length})`);
    }
  },

  ambiguous_partial_send_is_not_repeated: {
    env: { TRADE_TYPE: 'STIERED', TIER_BUY_CONFIG: TIERS },
    async run(h) {
      const m = h.newMint();
      h.ledger.prices.set(m, 0.001);
      h.buy(m, 1.0);
      await h.waitFor(() => h.active().find((p) => p.mint === m), 'position opened');
      h.ledger.sellQueue.push('ambiguousLanded'); // sell lands, but the send call errors
      h.sell(m, 40);
      await h.waitFor(() => h.active().find((p) => p.mint === m && p.token_amount === '9000.000000'), '60% remains');
      await h.sleep(500);
      h.check(h.ledger.calls.sell.length === 1, `landed sell not sent a second time (sells ${h.ledger.calls.sell.length})`);
      h.check(h.ledger.tokens.get(m) === 9000n * 10n ** 6n, `wallet holds exactly 60% (${h.ledger.tokens.get(m)})`);
    }
  },

  ambiguous_partial_send_followed_until_it_lands: {
    env: { TRADE_TYPE: 'STIERED', TIER_BUY_CONFIG: TIERS },
    async run(h) {
      const m = h.newMint();
      h.ledger.prices.set(m, 0.001);
      h.buy(m, 1.0);
      await h.waitFor(() => h.active().find((p) => p.mint === m), 'position opened');
      h.ledger.sellQueue.push('ambiguousLandsSoon'); // lands, but neither status nor balance show it for 300 ms
      h.sell(m, 40);
      await h.waitFor(() => h.active().find((p) => p.mint === m && p.token_amount === '9000.000000'), '60% remains');
      await h.sleep(600);
      h.check(h.ledger.calls.sell.length === 1, `sold once, not twice (sells ${h.ledger.calls.sell.length})`);
      h.check(h.ledger.tokens.get(m) === 9000n * 10n ** 6n, `wallet holds exactly 60% (${h.ledger.tokens.get(m)})`);
    }
  },

  stale_amount_close_sells_everything: {
    env: { TRADE_TYPE: 'EXACT', ENABLE_MULTI_BUY: 'true' },
    async run(h) {
      const m = h.newMint();
      h.ledger.prices.set(m, 0.001);
      h.buy(m, 0.2);
      await h.waitFor(() => h.active().find((p) => p.mint === m), 'opened');
      // Second buy lands but its fill can't be read: the stored amount is stale.
      h.ledger.parsedTxUnavailable = true;
      h.ledger.balanceFailures = 3;
      h.buy(m, 0.2);
      await h.waitFor(() => h.active().find((p) => p.mint === m && p.needs_reconcile), 'add-on recorded with an unknown fill');
      h.ledger.parsedTxUnavailable = false;
      h.sell(m, 100);
      await h.waitFor(() => h.byMint(m).find((p) => p.status === 'closed'), 'closed');
      h.check((h.ledger.tokens.get(m) || 0n) === 0n, `nothing left in the wallet (${h.ledger.tokens.get(m)})`);
    }
  },

  ambiguous_buy_send_is_followed_and_tracked: {
    async run(h) {
      const m = h.newMint();
      h.ledger.prices.set(m, 0.001);
      h.ledger.buyQueue.push('ambiguousLanded');
      h.buy(m, 1.0);
      const pos = await h.waitFor(() => h.active().find((p) => p.mint === m), 'position recorded despite send error');
      h.check(pos.token_amount === '10000.000000', `tokens tracked (got ${pos.token_amount})`);
      h.check(h.ledger.calls.buy.length === 1, 'no second buy sent');
    }
  },

  confirmed_buy_survives_rpc_outage_via_reconcile: {
    async run(h) {
      const m = h.newMint();
      h.ledger.prices.set(m, 0.001);
      h.ledger.parsedTxUnavailable = true; // can't read our own buy tx
      h.ledger.balanceFailures = 8; // fallback balance reads fail too (3 at buy time, then a few reconcile attempts)
      h.buy(m, 1.0);
      const pos = await h.waitFor(() => h.active().find((p) => p.mint === m), 'position recorded, not lost', 12000);
      h.check(pos.needs_reconcile === true, 'flagged for reconcile');
      h.approx(pos.cost_basis_sol, 0.1, 1e-12, 'counts toward exposure');
      const rec = await h.waitFor(() => h.active().find((p) => p.mint === m && p.needs_reconcile === false), 'reconciled from chain');
      h.check(rec.token_amount === '10000.000000', `amount filled in (got ${rec.token_amount})`);
      h.ledger.parsedTxUnavailable = false;
      h.ledger.prices.set(m, 0.002); // TP still works afterwards
      await h.waitFor(() => h.byMint(m).find((p) => p.status === 'closed'), 'closes normally');
    }
  },

  buy_sent_but_never_saved_is_recovered_after_a_restart: {
    env: { TRADE_TYPE: 'EXACT', PENDING_FIRST_MS: '100', PENDING_SWEEP_MS: '300', PENDING_BUY_GIVE_UP_MS: '1500' },
    setup(h) {
      // A previous run sent three buys and stopped before saving any position:
      // one landed, one failed on-chain, one never showed up.
      h.writePositions([]);
      h.mintLanded = h.newMint();
      h.mintFailed = h.newMint();
      h.mintLost = h.newMint();
      h.ledger.txs.set('LANDEDsig', { state: 'confirmed', mint: h.mintLanded, lamportsDelta: -105000000, tokenDelta: 10n ** 10n });
      h.ledger.tokens.set(h.mintLanded, 10n ** 10n);
      h.ledger.txs.set('FAILEDsig', { state: 'failed', err: { InstructionError: [4, 'Custom'] }, mint: h.mintFailed, lamportsDelta: 0, tokenDelta: 0n });
      const fs = require('fs');
      const path = require('path');
      const rec = (signature, mint) => ({ signature, mint, sol: 0.1, at: Date.now(), wallet: h.ledger.wallet, venue: 'pumpfun', dex: 'pumpfun', pool: null, parent: 'copyX', mode: 'EXACT' });
      fs.writeFileSync(path.join(path.dirname(h.posFile), 'pending-buys.json'), JSON.stringify([rec('LANDEDsig', h.mintLanded), rec('FAILEDsig', h.mintFailed), rec('LOSTsig', h.mintLost)]));
    },
    async run(h) {
      const pos = await h.waitFor(() => h.active().find((p) => p.mint === h.mintLanded), 'the landed buy comes back as a position');
      h.check(pos.buy_signature === 'LANDEDsig' && pos.needs_reconcile === true, `flagged to read its amount from the wallet (${JSON.stringify({ sig: pos.buy_signature, rec: pos.needs_reconcile })})`);
      h.check(!h.active().find((p) => p.mint === h.mintFailed || p.mint === h.mintLost), 'the failed and lost ones open nothing');
      const rec = await h.waitFor(() => h.active().find((p) => p.mint === h.mintLanded && p.needs_reconcile === false), 'amount read from the wallet');
      h.check(rec.token_amount === '10000.000000', `amount ${rec.token_amount}`);
      await h.waitFor(() => {
        try {
          return JSON.parse(require('fs').readFileSync(require('path').join(require('path').dirname(h.posFile), 'pending-buys.json'), 'utf8')).length === 0;
        } catch { return false; }
      }, 'every note cleared (recovered, failed, and the one that never showed up after the wait)', 6000);
    }
  },

  late_earlier_buy_does_not_reopen_exited_position: {
    env: { TRADE_TYPE: 'EXACT' },
    async run(h) {
      const m = h.newMint();
      h.ledger.prices.set(m, 0.001);
      h.buy(m, 0.2, { slot: 100 });
      await h.waitFor(() => h.active().find((p) => p.mint === m), 'position opened');
      h.sell(m, 100, { slot: 104 });
      await h.waitFor(() => h.byMint(m).find((p) => p.status === 'closed'), 'closed by copy sell');
      h.buy(m, 0.2, { slot: 102 }); // their earlier second buy, processed late
      await h.sleep(800);
      h.check(h.ledger.calls.buy.length === 1, `stale buy skipped (buys ${h.ledger.calls.buy.length})`);
      h.check(h.active().length === 0, 'no position re-opened');
    }
  },

  failed_partial_sell_is_remembered_and_retried: {
    env: { TRADE_TYPE: 'STIERED', TIER_BUY_CONFIG: TIERS },
    async run(h) {
      const m = h.newMint();
      h.ledger.prices.set(m, 0.001);
      h.buy(m, 1.0);
      await h.waitFor(() => h.active().find((p) => p.mint === m), 'position opened');
      h.ledger.sellQueue.push('throw', 'throw', 'throw');
      h.sell(m, 40);
      await h.waitFor(() => h.active().find((p) => p.mint === m && Math.abs(p.pending_sell_pct - 40) < 1e-9), 'pending 40% persisted');
      const pos = await h.waitFor(
        () => h.active().find((p) => p.mint === m && p.token_amount === '9000.000000' && p.pending_sell_pct == null),
        'retried after cooldown'
      );
      h.check(Boolean(pos), 'partial eventually executed once');
      h.check(h.ledger.calls.sell.length === 4, `3 failures + 1 success (sells ${h.ledger.calls.sell.length})`);
    }
  },

  stale_tracked_amount_and_zero_balance_glitch: {
    setup(h) {
      const m = h.newMint();
      h.state.m = m;
      h.ledger.tokens.set(m, 3000n * 10n ** 6n); // wallet holds less than tracked
      h.ledger.prices.set(m, 0.0005); // SL
      h.ledger.zeroGlitches = 1; // first balance re-read wrongly shows nothing
      h.writePositions([
        seedPosition({ id: 'stale-1', mint: h.state.m, trade_mode: 'SAFE', token_amount: '5000.000000', decimals: 6, buy_amount: 0.05, cost_basis_sol: 0.05, entry_price: 0.001, stop_loss_pct: 20, take_profit_pct: 50 })
      ]);
    },
    async run(h) {
      const closed = await h.waitFor(() => h.byMint(h.state.m).find((p) => p.status === 'closed'), 'closed');
      const amounts = h.ledger.calls.sell.map((c) => c.amountTokens);
      h.check(amounts[amounts.length - 1] === '3000.000000', `sold what is actually held (${JSON.stringify(amounts)})`);
      h.check(!/nothing left/.test(closed.close_reason), `a single zero reading didn't mark it closed unsold (${closed.close_reason})`);
      h.check(h.ledger.tokens.get(h.state.m) === 0n, 'wallet emptied');
    }
  },

  stiered_mirrors_transfers_out: {
    env: { TRADE_TYPE: 'STIERED', TIER_BUY_CONFIG: TIERS },
    async run(h) {
      const m = h.newMint();
      h.ledger.prices.set(m, 0.001);
      h.buy(m, 1.0);
      await h.waitFor(() => h.active().find((p) => p.mint === m), 'position opened');
      h.transfer(m, 40); // copy wallet sends 40% of its bag to another wallet
      const pos = await h.waitFor(() => h.active().find((p) => p.mint === m && p.token_amount === '9000.000000'), '40% mirrored');
      h.check(Boolean(pos), 'partial transfer mirrored as a 40% sell');
      h.transfer(m, 100); // then moves out the rest
      const closed = await h.waitFor(() => h.byMint(m).find((p) => p.status === 'closed'), 'fully exited');
      h.check(closed.close_reason === 'STIERED copy-transfer (full)', `close_reason (got ${closed.close_reason})`);
      h.check((h.ledger.tokens.get(m) || 0n) === 0n, 'wallet emptied');
    }
  },

  full_exit_on_first_copy_sell: {
    env: { TRADE_TYPE: 'STIERED', TIER_BUY_CONFIG: TIERS, FULL_EXIT_ON_COPY_SELL: 'true' },
    async run(h) {
      const m = h.newMint();
      h.ledger.prices.set(m, 0.001);
      h.buy(m, 1.0);
      await h.waitFor(() => h.active().find((p) => p.mint === m), 'position opened');
      h.sell(m, 30); // copy wallet sells 30%: we sell everything
      const closed = await h.waitFor(() => h.byMint(m).find((p) => p.status === 'closed'), 'fully closed on the first sell');
      const sold = h.ledger.calls.sell.map((c) => c.amountTokens);
      h.check(JSON.stringify(sold) === JSON.stringify(['15000.000000']), `one sell of the whole position (got ${JSON.stringify(sold)})`);
      h.check(closed.close_reason === 'STIERED copy-sell (first sell, full exit)', `close_reason (got ${closed.close_reason})`);
      // A transfer out counts too.
      const m2 = h.newMint();
      h.ledger.prices.set(m2, 0.001);
      h.buy(m2, 1.0);
      await h.waitFor(() => h.active().find((p) => p.mint === m2), 'second position opened');
      h.transfer(m2, 25);
      const closed2 = await h.waitFor(() => h.byMint(m2).find((p) => p.status === 'closed'), 'closed on a partial transfer');
      h.check(closed2.close_reason === 'STIERED copy-transfer (first sell, full exit)', `close_reason (got ${closed2.close_reason})`);
      h.check((h.ledger.tokens.get(m) || 0n) === 0n && (h.ledger.tokens.get(m2) || 0n) === 0n, 'wallet emptied');
    }
  },

  only_first_buy_skips_coins_copy_wallet_already_held: {
    env: { TRADE_TYPE: 'STIERED', TIER_BUY_CONFIG: TIERS },
    setup(h) {
      h.ledger.heldAtStartMint = h.newMint();
      h.ledger.copyHoldings = [h.ledger.heldAtStartMint];
    },
    async run(h) {
      await h.sleep(300); // startup snapshot of the copy wallet's coins
      // 1. A coin it already held when the bot started: its buy is skipped.
      const held = h.ledger.heldAtStartMint;
      h.ledger.prices.set(held, 0.001);
      h.buy(held, 1.0);
      // 2. Its transaction shows it already held the coin: skipped.
      const m2 = h.newMint();
      h.ledger.prices.set(m2, 0.001);
      h.buy(m2, 1.0, { copyHeldBefore: true });
      // 3. A genuine first buy is copied...
      const m3 = h.newMint();
      h.ledger.prices.set(m3, 0.001);
      h.ledger.buyQueue.push('failOnChain'); // ...but ours fails on-chain
      h.buy(m3, 1.0, { copyHeldBefore: false });
      await h.waitFor(() => h.ledger.calls.buy.length === 1, 'first buy attempted');
      await h.sleep(300);
      // 4. Its second buy of m3 (no balance info, as in processed mode): skipped.
      h.buy(m3, 0.5);
      await h.sleep(800);
      const bought = h.ledger.calls.buy.map((c) => c.mint);
      h.check(JSON.stringify(bought) === JSON.stringify([m3]), `only the genuine first buy was attempted (got ${JSON.stringify(bought)})`);
      // 5. After a full exit, a new first buy counts again.
      h.sell(m3, 100);
      await h.sleep(200);
      h.buy(m3, 1.0);
      await h.waitFor(() => h.ledger.calls.buy.length === 2, 'fresh first buy after a full exit is copied');
    }
  },

  entry_premium_cap_skips_buys_priced_too_far_above_copy_wallet: {
    env: { TELEGRAM_BOT_TOKEN: 'test-token', TELEGRAM_CHAT_ID: '777', TRADE_TYPE: 'STIERED', TIER_BUY_CONFIG: TIERS, MAX_ENTRY_PREMIUM_PCT: '30' },
    async run(h) {
      // 1. Quote 50% above the copy wallet's price: skipped, nothing sent.
      const m1 = h.newMint();
      h.ledger.prices.set(m1, 0.001);
      h.ledger.quotePrices.set(m1, 0.000015);
      h.buy(m1, 1.0, { copyPriceSol: 0.00001, copyPriceExact: true });
      const note = await h.waitFor(() => h.telegram.sent.find((s) => s.text.includes('Skipped') && s.text.includes(m1.slice(0, 4))), 'skip message');
      h.check(/\+50% above the copy wallet's \(your max is 30%\)/.test(note.text), `skip message (${note.text})`);
      h.check(h.ledger.calls.buy[0].priceCheck && h.ledger.calls.buy[0].priceCheck.maxPct === 30, 'limit passed to the buy');
      // 2. Quote 10% above: bought.
      const m2 = h.newMint();
      h.ledger.prices.set(m2, 0.001);
      h.ledger.quotePrices.set(m2, 0.000011);
      h.buy(m2, 1.0, { copyPriceSol: 0.00001, copyPriceExact: true });
      await h.waitFor(() => h.active().find((p) => p.mint === m2), 'within the limit: bought');
      // 3. Copy wallet's price unknown: bought without the check.
      const m3 = h.newMint();
      h.ledger.prices.set(m3, 0.001);
      h.buy(m3, 1.0);
      await h.waitFor(() => h.active().find((p) => p.mint === m3), 'no copy price: bought');
      h.check(h.ledger.calls.buy[2].priceCheck === null, 'no check without a copy price');
      h.check(!h.byMint(m1).length, 'no position for the skipped coin');
      h.check(h.active().every((p) => !p.sell_after_at), 'SELL_AFTER_SECONDS off by default');
    }
  },

  sell_after_seconds_sells_whole_position: {
    env: { TRADE_TYPE: 'STIERED', TIER_BUY_CONFIG: TIERS, SELL_AFTER_SECONDS: '1' },
    async run(h) {
      const m = h.newMint();
      h.ledger.prices.set(m, 0.001);
      h.ledger.sellQueue.push('throw'); // first timed sell fails, is retried
      const t0 = Date.now();
      h.buy(m, 1.0, { copyPriceSol: 0.00001 });
      const pos = await h.waitFor(() => h.active().find((p) => p.mint === m), 'position opened');
      h.check(pos.sell_after_at > t0, 'sell time saved on the position');
      h.check(h.ledger.calls.buy[0].priceCheck === null, 'MAX_ENTRY_PREMIUM_PCT off by default');
      const closed = await h.waitFor(() => h.byMint(m).find((p) => p.status === 'closed'), 'closed by the timer', 8000);
      h.check(closed.close_reason === 'SELL_AFTER_SECONDS (1s)', `close reason (${closed.close_reason})`);
      h.check(h.ledger.calls.sell[0].at - t0 >= 900, `not sold before the time (${h.ledger.calls.sell[0].at - t0}ms)`);
      h.check(h.ledger.calls.sell.length === 2 && h.ledger.calls.sell[1].amountTokens === h.ledger.calls.sell[0].amountTokens, 'failed timed sell retried, whole position');

      // A copy-sell before the time still applies.
      const m2 = h.newMint();
      h.ledger.prices.set(m2, 0.001);
      h.buy(m2, 1.0);
      await h.waitFor(() => h.active().find((p) => p.mint === m2), 'second position opened');
      h.sell(m2, 100);
      const c2 = await h.waitFor(() => h.byMint(m2).find((p) => p.status === 'closed'), 'closed by copy-sell');
      h.check(/copy-sell/.test(c2.close_reason), `copy-sell closed it first (${c2.close_reason})`);
      await h.sleep(1300);
      h.check(h.ledger.calls.sell.filter((c) => c.mint === m2).length === 1, 'no second sell from the timer');
    }
  },

  instant_sell_sells_as_soon_as_the_buy_lands: {
    env: { TRADE_TYPE: 'STIERED', TIER_BUY_CONFIG: TIERS, INSTANT_SELL: 'true', SELL_AFTER_SECONDS: '30' },
    async run(h) {
      // 1. The buy is "processed" for 800 ms before it confirms: the sell goes
      // out in that window, before the position is even recorded.
      const m = h.newMint();
      h.ledger.prices.set(m, 0.001);
      h.ledger.processedForMs = 800;
      h.ledger.processedZeroReads = 1; // the first read comes from a node a moment behind
      h.buy(m, 1.0);
      const sell = await h.waitFor(() => h.ledger.calls.sell[0], 'instant sell sent');
      const afterBuy = sell.at - h.ledger.calls.buy[0].at;
      h.check(afterBuy < 600, `sold before the buy confirmed (${afterBuy}ms after it)`);
      h.check(!h.byMint(m).length, 'sold before the position was recorded');
      h.check(h.ledger.processedReads >= 2, `a read that saw no tokens yet was retried (${h.ledger.processedReads} reads)`);
      const closed = await h.waitFor(() => h.byMint(m).find((p) => p.status === 'closed'), 'position closed', 6000);
      h.check(closed.close_reason === 'INSTANT_SELL', `close reason (${closed.close_reason})`);
      h.check(/^sellSig/.test(closed.close_signature || ''), `closed by the early sell (${closed.close_signature})`);
      h.check(h.ledger.calls.sell.length === 1, `no second sell (${h.ledger.calls.sell.length})`);
      h.check((h.ledger.tokens.get(m) || 0n) === 0n, `whole buy sold (${h.ledger.tokens.get(m)} left)`);
      h.check(!closed.sell_after_at, 'SELL_AFTER_SECONDS ignored');
      h.check(typeof closed.realized_pnl_sol === 'number', 'PnL recorded');

      // 2. The early sell fails on-chain: the position's close sells again.
      const m2 = h.newMint();
      h.ledger.prices.set(m2, 0.001);
      h.ledger.sellQueue.push('failOnChain');
      h.buy(m2, 1.0);
      const c2 = await h.waitFor(() => h.byMint(m2).find((p) => p.status === 'closed'), 'second position closed', 8000);
      const sells2 = h.ledger.calls.sell.filter((c) => c.mint === m2);
      h.check(sells2.length === 2, `failed early sell followed by a normal one (${sells2.length} sells)`);
      h.check(c2.close_reason === 'INSTANT_SELL' && (h.ledger.tokens.get(m2) || 0n) === 0n, `sold in full (${c2.close_reason})`);
    }
  },

  instant_sell_fires_when_our_tokens_are_pushed: {
    env: { TRADE_TYPE: 'STIERED', TIER_BUY_CONFIG: TIERS, INSTANT_SELL: 'true' },
    async run(h) {
      // The buy's status takes 700 ms to show; the token account is pushed after 30 ms.
      const m = h.newMint();
      h.ledger.prices.set(m, 0.001);
      h.ledger.buyStatusDelayMs = 700;
      h.ledger.accountPushMs = 30;
      const readsBefore = h.ledger.processedReads;
      h.buy(m, 1.0);
      const sell = await h.waitFor(() => h.ledger.calls.sell[0], 'instant sell sent');
      const after = sell.at - h.ledger.calls.buy[0].at;
      h.check(after < 400, `sold on the push, long before the status showed (${after}ms after the buy)`);
      h.check(h.logs.some((l) => /INSTANT_SELL: buy \w+… landed .*\(its tokens arrived\); selling it now/.test(l)), 'says what triggered it');
      h.check(h.ledger.processedReads === readsBefore, 'no extra balance read: the pushed account carried it');
      const closed = await h.waitFor(() => h.byMint(m).find((p) => p.status === 'closed'), 'position closed', 6000);
      h.check(closed.close_reason === 'INSTANT_SELL' && h.ledger.calls.sell.length === 1, `closed by that sell (${closed.close_reason}, ${h.ledger.calls.sell.length} sells)`);
      h.check(h.ledger.accountListeners.size === 0, `subscriptions ended (${h.ledger.accountListeners.size} left)`);
    }
  },

  dca_even_sells_in_equal_slices: {
    env: { TRADE_TYPE: 'STIERED', TIER_BUY_CONFIG: TIERS, INSTANT_SELL: 'true', DCA_SELLING: 'DCA_even', DCA_SLICES: '4', DCA_SECONDS: '2', DCA_FIRST_PCT: '25' },
    async run(h) {
      const m = h.newMint();
      h.ledger.prices.set(m, 0.001);
      h.buy(m, 1.0);
      const closed = await h.waitFor(() => h.byMint(m).find((p) => p.status === 'closed'), 'position closed after the slices', 12000);
      const sells = h.ledger.calls.sell.filter((c) => c.mint === m);
      h.check(sells.length === 5, `first part + 4 slices (${sells.length} sells)`);
      h.check(!sells[0].cheap && sells.slice(1).every((c) => c.cheap === true), 'the first part is the usual fast sell, the slices go the cheap way');
      const amounts = sells.map((c) => Number(c.amountTokens));
      const total = amounts.reduce((a, b) => a + b, 0);
      h.check(Math.abs(amounts[0] / total - 0.25) < 0.001, `first part 25% (${(amounts[0] / total * 100).toFixed(2)}%)`);
      h.check(amounts.slice(1).every((a) => Math.abs(a / total - 0.1875) < 0.001), `equal slices of the rest (${amounts.slice(1).map((a) => (a / total * 100).toFixed(2)).join(', ')}%)`);
      const gaps = sells.slice(2).map((c, i) => c.at - sells[i + 1].at);
      h.check(gaps.every((g) => g > 300 && g < 900), `slices spread evenly, about 500 ms apart (${gaps.join(', ')} ms)`);
      h.check((h.ledger.tokens.get(m) || 0n) === 0n, `everything sold (${h.ledger.tokens.get(m)} left)`);
      h.check(typeof closed.realized_pnl_sol === 'number', 'PnL recorded');
      h.check(!closed.dca, 'no leftover DCA state');
    }
  },

  dca_left_sells_a_share_of_what_is_left: {
    env: { TRADE_TYPE: 'STIERED', TIER_BUY_CONFIG: TIERS, INSTANT_SELL: 'true', DCA_SELLING: 'DCA_left', DCA_SLICES: '3', DCA_SECONDS: '1', DCA_FIRST_PCT: '25', DCA_LEFT_PCT: '25' },
    async run(h) {
      const m = h.newMint();
      h.ledger.prices.set(m, 0.001);
      h.buy(m, 1.0);
      await h.waitFor(() => h.byMint(m).find((p) => p.status === 'closed'), 'position closed after the slices', 12000);
      const sells = h.ledger.calls.sell.filter((c) => c.mint === m);
      const a = sells.map((c) => Number(c.amountTokens));
      const total = a.reduce((x, y) => x + y, 0);
      const pct = a.map((x) => (x / total) * 100);
      // 25%, then 25% of the remaining 75% = 18.75%, then 25% of 56.25% = 14.06%, then the rest (42.19%).
      h.check(sells.length === 4, `first part + 3 slices (${sells.length})`);
      h.check(Math.abs(pct[0] - 25) < 0.01 && Math.abs(pct[1] - 18.75) < 0.01 && Math.abs(pct[2] - 14.0625) < 0.01, `shares (${pct.map((x) => x.toFixed(2)).join(', ')}%)`);
      h.check(Math.abs(pct[3] - 42.1875) < 0.05, `the last slice takes what is left (${pct[3].toFixed(2)}%)`);
      h.check((h.ledger.tokens.get(m) || 0n) === 0n, 'nothing left behind');
    }
  },

  dca_stops_and_sells_the_rest_when_the_copy_wallet_sells: {
    env: { TRADE_TYPE: 'STIERED', TIER_BUY_CONFIG: TIERS, INSTANT_SELL: 'true', DCA_SELLING: 'DCA_even', DCA_SLICES: '9', DCA_SECONDS: '9', DCA_FIRST_PCT: '25' },
    async run(h) {
      const m = h.newMint();
      h.ledger.prices.set(m, 0.001);
      h.buy(m, 1.0);
      await h.waitFor(() => h.ledger.calls.sell.filter((c) => c.mint === m).length >= 2, 'first slice sent', 8000);
      h.sell(m, 100);
      const closed = await h.waitFor(() => h.byMint(m).find((p) => p.status === 'closed'), 'closed after the copy wallet sold', 8000);
      const sells = h.ledger.calls.sell.filter((c) => c.mint === m);
      const last = sells[sells.length - 1];
      h.check(!last.cheap, 'the rest went the usual fast way');
      h.check(/copy-sell/.test(closed.close_reason), `close reason (${closed.close_reason})`);
      h.check(sells.length < 8, `the remaining slices never went out (${sells.length} sells)`);
      await h.sleep(1500);
      h.check(h.ledger.calls.sell.filter((c) => c.mint === m).length === sells.length, 'nothing sent after the exit');
      h.check((h.ledger.tokens.get(m) || 0n) === 0n, 'everything sold');
    }
  },

  dca_slice_that_fails_hands_over_to_one_normal_sell: {
    env: { TRADE_TYPE: 'STIERED', TIER_BUY_CONFIG: TIERS, INSTANT_SELL: 'true', DCA_SELLING: 'DCA_even', DCA_SLICES: '3', DCA_SECONDS: '1', DCA_FIRST_PCT: '25' },
    async run(h) {
      const m = h.newMint();
      h.ledger.prices.set(m, 0.001);
      h.ledger.sellQueue.push('ok'); // the first part
      h.ledger.sellQueue.push('failOnChain'); // the first slice
      h.buy(m, 1.0);
      const closed = await h.waitFor(() => h.byMint(m).find((p) => p.status === 'closed'), 'position closed', 12000);
      const sells = h.ledger.calls.sell.filter((c) => c.mint === m);
      h.check(sells.length === 3, `first part, the failed slice, then one sell of the rest (${sells.length})`);
      h.check(sells[1].cheap === true && !sells[2].cheap, 'the rest went the usual way');
      h.check((h.ledger.tokens.get(m) || 0n) === 0n, 'everything sold');
      h.check(/DCA/.test(closed.close_reason), `close reason (${closed.close_reason})`);
    }
  },

  dca_off_by_default_sells_the_whole_position_at_once: {
    env: { TRADE_TYPE: 'STIERED', TIER_BUY_CONFIG: TIERS, INSTANT_SELL: 'true' },
    async run(h) {
      const m = h.newMint();
      h.ledger.prices.set(m, 0.001);
      h.buy(m, 1.0);
      await h.waitFor(() => h.byMint(m).find((p) => p.status === 'closed'), 'position closed', 8000);
      h.check(h.ledger.calls.sell.filter((c) => c.mint === m).length === 1, 'one sell');
    }
  },

  shred_buy_whose_original_failed_is_sold: {
    env: { TELEGRAM_BOT_TOKEN: 'test-token', TELEGRAM_CHAT_ID: '777', TRADE_TYPE: 'STIERED', TIER_BUY_CONFIG: TIERS },
    async run(h) {
      // 1. Failure reported after our position is open.
      const m1 = h.newMint();
      h.ledger.prices.set(m1, 0.001);
      h.buy(m1, 1.0, { signature: 'shredBuy1', shred: true });
      await h.waitFor(() => h.active().find((p) => p.mint === m1), 'position opened');
      global.__emitter.emit('copyBuyFailed', { signature: 'shredBuy1', mint: m1 });
      const c1 = await h.waitFor(() => h.byMint(m1).find((p) => p.status === 'closed'), 'sold after the original failed');
      h.check(/copy wallet's buy failed/.test(c1.close_reason), `close reason (${c1.close_reason})`);
      h.check(h.telegram.sent.some((m) => /failed on-chain after we copied it early; selling ours/.test(m.text)), 'Telegram told');
      // 2. Failure reported while our buy is still confirming.
      const m2 = h.newMint();
      h.ledger.prices.set(m2, 0.001);
      h.ledger.buyDelayMs = 400;
      h.buy(m2, 1.0, { signature: 'shredBuy2', shred: true });
      await h.sleep(100);
      global.__emitter.emit('copyBuyFailed', { signature: 'shredBuy2', mint: m2 });
      const c2 = await h.waitFor(() => h.byMint(m2).find((p) => p.status === 'closed'), 'sold as soon as it opened');
      h.check(/copy wallet's buy failed/.test(c2.close_reason), `close reason (${c2.close_reason})`);
      h.ledger.buyDelayMs = 0;
      // 3. Another coin's failure doesn't touch this one.
      const m3 = h.newMint();
      h.ledger.prices.set(m3, 0.001);
      h.buy(m3, 1.0, { signature: 'shredBuy3', shred: true });
      await h.waitFor(() => h.active().find((p) => p.mint === m3), 'third position opened');
      global.__emitter.emit('copyBuyFailed', { signature: 'someOtherSig', mint: m3 });
      await h.sleep(400);
      h.check(h.active().some((p) => p.mint === m3), 'unrelated failure ignored');
      // 4. A failed DUPLICATE: the copied transaction failed, but another of
      //    the copy wallet's transactions bought the coin. We keep ours.
      const m4 = h.newMint();
      h.ledger.prices.set(m4, 0.001);
      h.buy(m4, 1.0, { signature: 'shredBuy4', shred: true });
      await h.waitFor(() => h.active().find((p) => p.mint === m4), 'fourth position opened');
      h.ledger.copyHeldNow.add(m4);
      global.__emitter.emit('copyBuyFailed', { signature: 'shredBuy4', mint: m4 });
      await h.waitFor(() => h.logs.some((l) => l.includes('but it holds the coin (another of its transactions bought it); keeping our position')), 'duplicate recognised');
      await h.sleep(300);
      h.check(h.active().some((p) => p.mint === m4), 'position kept when the copy wallet holds the coin anyway');
    }
  },

  shred_buy_not_sent_once_original_known_failed: {
    env: { TRADE_TYPE: 'STIERED', TIER_BUY_CONFIG: TIERS },
    async run(h) {
      const m = h.newMint();
      h.ledger.prices.set(m, 0.001);
      global.__emitter.emit('copyBuyFailed', { signature: 'shredBuyLate', mint: m });
      await h.sleep(200);
      h.buy(m, 1.0, { signature: 'shredBuyLate', shred: true });
      await h.waitFor(() => h.logs.some((l) => l.includes("the copy wallet's buy shredBuyLate has already failed")), 'skip explained');
      h.check(h.ledger.calls.buy.length === 0, 'nothing sent for a buy whose original already failed');
    }
  },

  shred_early_exit_waits_for_real_pct_on_mirroring_position: {
    env: { TRADE_TYPE: 'STIERED', TIER_BUY_CONFIG: TIERS, FULL_EXIT_ON_COPY_SELL: 'false', ONLY_COPY_FIRST_BUY: 'false' },
    async run(h) {
      const m = h.newMint();
      h.ledger.prices.set(m, 0.001);
      h.buy(m, 1.0);
      await h.waitFor(() => h.active().find((p) => p.mint === m), 'position opened');
      h.emit({ signature: 'shredSellP', dexs: ['Pump.fun'], ca: m, trade: 'sell', solAmount: 0, tokenAmount: -1, sellPercent: 100, shred: true, shredEarlyExit: true, slot: 99999 });
      await h.sleep(400);
      h.check(h.ledger.calls.sell.length === 0, 'early exit (unknown %) does not dump a position that mirrors partial sells');
      h.sell(m, 40, { signature: 'shredSellP' });
      await h.waitFor(() => h.active().find((p) => p.mint === m && p.token_amount === '9000.000000'), 'the real 40% mirrored from the confirmed sell');
    }
  },

  partial_sell_error_is_remembered_for_retry: {
    env: { TRADE_TYPE: 'STIERED', TIER_BUY_CONFIG: TIERS },
    async run(h) {
      const m = h.newMint();
      h.ledger.prices.set(m, 0.001);
      h.ledger.parsedTxUnavailable = true;
      h.ledger.balanceFailures = 1000; // balance reads keep failing (RPC outage)
      h.buy(m, 1.0);
      await h.waitFor(() => h.active().find((p) => p.mint === m && p.needs_reconcile), 'opened with an unknown fill', 12000);
      h.ledger.parsedTxUnavailable = false;
      h.sell(m, 50); // its balance read throws
      await h.waitFor(() => h.active().find((p) => p.mint === m && Number(p.pending_sell_pct) > 0), 'the sell is remembered after the error');
      h.ledger.balanceFailures = 0;
      await h.waitFor(() => h.active().find((p) => p.mint === m && p.token_amount === '7500.000000' && !(Number(p.pending_sell_pct) > 0)), 'and done once the RPC recovers', 15000);
    }
  },

  shred_failed_original_alert_only_when_disabled: {
    env: { TELEGRAM_BOT_TOKEN: 'test-token', TELEGRAM_CHAT_ID: '777', TRADE_TYPE: 'STIERED', TIER_BUY_CONFIG: TIERS, SHRED_SELL_IF_COPY_FAILED: 'false' },
    async run(h) {
      const m = h.newMint();
      h.ledger.prices.set(m, 0.001);
      h.buy(m, 1.0, { signature: 'shredBuyX', shred: true });
      await h.waitFor(() => h.active().find((p) => p.mint === m), 'position opened');
      global.__emitter.emit('copyBuyFailed', { signature: 'shredBuyX', mint: m });
      await h.waitFor(() => h.telegram.sent.some((s) => /You still hold it/.test(s.text)), 'alert sent');
      await h.sleep(300);
      h.check(h.active().some((p) => p.mint === m) && h.ledger.calls.sell.length === 0, 'kept, not sold');
    }
  },

  shred_early_exit_then_websocket_records_the_sell: {
    env: { TRADE_TYPE: 'STIERED', TIER_BUY_CONFIG: TIERS, FULL_EXIT_ON_COPY_SELL: 'true', SKIP_REBUYS: 'full', ONLY_COPY_FIRST_BUY: 'false' },
    async run(h) {
      const m = h.newMint();
      h.ledger.prices.set(m, 0.001);
      h.buy(m, 1.0);
      await h.waitFor(() => h.active().find((p) => p.mint === m), 'position opened');
      h.emit({ signature: 'shredSell1', dexs: ['Pump.fun'], ca: m, trade: 'sell', solAmount: 0, tokenAmount: -1, sellPercent: 100, shred: true, shredEarlyExit: true, slot: 99999 });
      const closed = await h.waitFor(() => h.byMint(m).find((p) => p.status === 'closed'), 'sold on the early exit');
      h.check(/early, shreds/.test(closed.close_reason), `close reason (${closed.close_reason})`);
      // The websocket feed then reports the real sell: 30%, so (SKIP_REBUYS=full)
      // the copy wallet hasn't exited and a later buy is still copied.
      h.sell(m, 30, { signature: 'shredSell1' });
      await h.sleep(200);
      h.buy(m, 1.0);
      await h.waitFor(() => h.ledger.calls.buy.length === 2, 'rebuy copied: the early exit was not recorded as a full exit');
    }
  },

  shred_stream_end_to_end: {
    env: { TELEGRAM_BOT_TOKEN: 'test-token', TELEGRAM_CHAT_ID: '777', TRADE_TYPE: 'STIERED', TIER_BUY_CONFIG: TIERS, SHRED_STREAM_URL: 'http://127.0.0.1:18797', SHRED_STREAM_TOKEN: 'tok', SHRED_DOWN_ALERT_MS: '400' },
    setup(h) {
      // A local ShredStream server the bot connects to at startup.
      const grpc = require('@grpc/grpc-js');
      const protoLoader = require('@grpc/proto-loader');
      const pkg = grpc.loadPackageDefinition(protoLoader.loadSync(require('path').join(process.cwd(), 'src', 'proto', 'shredstream.proto'), { keepCase: true, longs: String, defaults: true })).shredstream;
      const server = new grpc.Server();
      server.addService(pkg.ShredstreamProxy.service, { SubscribeEntries(call) { h.state.call = call; } });
      server.bindAsync('127.0.0.1:18797', grpc.ServerCredentials.createInsecure(), () => {});
      h.state.server = server;
    },
    async run(h) {
      const crypto = require('crypto');
      const bs58m = require('bs58');
      const bs58 = bs58m.default || bs58m;
      const { PublicKey, Keypair, TransactionInstruction, TransactionMessage, VersionedTransaction } = require('@solana/web3.js');
      const { bondingCurvePda } = require('@pump-fun/pump-sdk');
      const PUMP = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
      const W = new PublicKey(process.env.COPY_WALLET);
      const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
      const rnd = () => Keypair.generate().publicKey;
      const tx = (ix) => {
        const t = new VersionedTransaction(new TransactionMessage({ payerKey: W, recentBlockhash: '11111111111111111111111111111111', instructions: [ix] }).compileToLegacyMessage());
        t.signatures[0] = crypto.randomBytes(64);
        return { bytes: Buffer.from(t.serialize()), sig: bs58.encode(t.signatures[0]) };
      };
      const push = (t, slot) => h.state.call.write({ slot: String(slot), entries: Buffer.concat([u64(1), u64(1), crypto.randomBytes(32), u64(1), t.bytes]) });
      const pumpBuy = (mint, lamports) => {
        const keys = Array.from({ length: 16 }, () => ({ pubkey: rnd(), isSigner: false, isWritable: false }));
        keys[2] = { pubkey: mint, isSigner: false, isWritable: false };
        keys[6] = { pubkey: W, isSigner: true, isWritable: true };
        return new TransactionInstruction({ programId: PUMP, keys, data: Buffer.concat([Buffer.from('38fc74089edfcd5f', 'hex'), u64(lamports), u64(1), Buffer.from([0])]) });
      };
      const router = rnd();
      const routerBuy = (mint, lamports) => new TransactionInstruction({
        programId: router,
        keys: [{ pubkey: W, isSigner: true, isWritable: true }, { pubkey: PUMP, isSigner: false, isWritable: false }, { pubkey: mint, isSigner: false, isWritable: false }, { pubkey: bondingCurvePda(mint), isSigner: false, isWritable: true }],
        data: Buffer.concat([Buffer.from('f00df00df00df00d', 'hex'), u64(lamports), u64(42)])
      });

      await h.waitFor(() => h.state.call, 'bot connected to the shred stream', 8000);
      h.check(h.state.call.metadata.get('x-token')[0] === 'tok', 'token sent');
      await h.sleep(400); // copy wallet's holdings snapshot

      // 1. A direct Pump.fun buy in the shreds is copied.
      const m1 = rnd();
      h.ledger.prices.set(m1.toBase58(), 0.001);
      const t1 = tx(pumpBuy(m1, 1_000_000_000));
      push(t1, 9001);
      await h.waitFor(() => h.active().find((p) => p.mint === m1.toBase58()), 'shred buy copied');
      const call1 = h.ledger.calls.buy[0];
      h.check(call1.venue === 'pumpfun' && call1.pool === 'pump-curve', `routed to the Pump.fun curve builder (${call1.venue}/${call1.pool})`);
      h.check(global.__emitter.seenSignatures.has(t1.sig), 'marked seen for the websocket feed');

      // 2. Router: two buys reach the bot only through the websocket feed:
      //    not bought (SHRED_BUYS_ONLY) but they teach it; the third comes from the shreds.
      for (const [lam, conf] of [[3_000_000_000, 2.9333], [2_000_000_000, 1.9556]]) {
        const m = rnd();
        h.ledger.prices.set(m.toBase58(), 0.001);
        const t = tx(routerBuy(m, lam));
        push(t, 9002);
        await h.sleep(150);
        h.buy(m.toBase58(), conf, { signature: t.sig });
        await h.sleep(300);
        h.check(!h.active().some((p) => p.mint === m.toBase58()), 'websocket-only buy not copied (SHRED_BUYS_ONLY)');
      }
      h.check(h.ledger.calls.buy.length === 1, `only the shred buy was attempted so far (${h.ledger.calls.buy.length})`);
      const m4 = rnd();
      h.ledger.prices.set(m4.toBase58(), 0.001);
      push(tx(routerBuy(m4, 1_500_000_000)), 9003);
      await h.waitFor(() => h.active().find((p) => p.mint === m4.toBase58()), 'learned router buy copied from the shreds');

      // 3. The feed goes down: Telegram is told, and buys stay off.
      h.state.server.forceShutdown();
      await h.waitFor(() => h.telegram.sent.some((m) => /Shred feed down/.test(m.text)), 'feed-down alert', 6000);
      const m5 = rnd();
      h.ledger.prices.set(m5.toBase58(), 0.001);
      h.buy(m5.toBase58(), 1.0);
      await h.sleep(300);
      h.check(!h.active().some((p) => p.mint === m5.toBase58()), 'no websocket buys while the shred feed is down');
    }
  },

  shred_buys_only_off_buys_from_either_feed: {
    env: { TRADE_TYPE: 'STIERED', TIER_BUY_CONFIG: TIERS, SHRED_STREAM_URL: 'http://127.0.0.1:1', SHRED_BUYS_ONLY: 'false' },
    async run(h) {
      const m = h.newMint();
      h.ledger.prices.set(m, 0.001);
      h.buy(m, 1.0);
      await h.waitFor(() => h.active().find((p) => p.mint === m), 'websocket buy copied with SHRED_BUYS_ONLY=false');
    }
  },

  only_first_buy_off_copies_every_buy: {
    env: { TRADE_TYPE: 'STIERED', TIER_BUY_CONFIG: TIERS, ONLY_COPY_FIRST_BUY: 'false' },
    async run(h) {
      const m = h.newMint();
      h.ledger.prices.set(m, 0.001);
      h.buy(m, 1.0, { copyHeldBefore: true });
      await h.waitFor(() => h.ledger.calls.buy.length === 1, 'buy copied even though it already held the coin');
    }
  },

  exact_treats_any_transfer_out_as_exit: {
    env: { TRADE_TYPE: 'EXACT' },
    async run(h) {
      const m = h.newMint();
      h.ledger.prices.set(m, 0.001);
      h.buy(m, 0.2);
      await h.waitFor(() => h.active().find((p) => p.mint === m), 'position opened');
      h.transfer(m, 30);
      const closed = await h.waitFor(() => h.byMint(m).find((p) => p.status === 'closed'), 'closed');
      h.check(closed.close_reason === 'EXACT copy-transfer', `close_reason (got ${closed.close_reason})`);
      h.check(h.ledger.calls.sell[0].amountTokens === '20000.000000', 'sold everything, like any EXACT exit');
    }
  },

  transfers_ignored_when_mirroring_disabled: {
    env: { TRADE_TYPE: 'STIERED', TIER_BUY_CONFIG: TIERS, MIRROR_TRANSFERS: 'false' },
    async run(h) {
      const m = h.newMint();
      h.ledger.prices.set(m, 0.001);
      h.buy(m, 1.0);
      await h.waitFor(() => h.active().find((p) => p.mint === m), 'position opened');
      h.transfer(m, 100);
      await h.sleep(800);
      h.check(h.ledger.calls.sell.length === 0, `no sell on transfer (sells ${h.ledger.calls.sell.length})`);
      h.check(h.active().some((p) => p.mint === m), 'position still open');
      h.sell(m, 100); // a real sell still exits
      await h.waitFor(() => h.byMint(m).find((p) => p.status === 'closed'), 'real sell still mirrored');
    }
  },

  late_buy_after_transfer_out_is_skipped: {
    env: { TRADE_TYPE: 'EXACT' },
    async run(h) {
      const m = h.newMint();
      h.ledger.prices.set(m, 0.001);
      h.transfer(m, 100, { slot: 300 }); // moved out (later slot) — processed first
      await h.sleep(100);
      h.buy(m, 0.2, { slot: 250 });
      await h.sleep(800);
      h.check(h.ledger.calls.buy.length === 0, `no buy into a token they already moved out (buys ${h.ledger.calls.buy.length})`);
    }
  },

  prices_fetched_in_one_batch_per_tick: {
    async run(h) {
      const mints = [h.newMint(), h.newMint(), h.newMint(), h.newMint()];
      mints.forEach((m) => h.ledger.prices.set(m, 0.001));
      mints.forEach((m) => h.buy(m, 1.0));
      await h.waitFor(() => h.active().length === 4, 'four positions');
      h.ledger.priceRequests.length = 0;
      await h.sleep(1100); // ~4 polling ticks at 250ms
      const reqs = h.ledger.priceRequests;
      h.check(reqs.length >= 2 && reqs.length <= 6, `about one request per tick (got ${reqs.length})`);
      h.check(reqs.every((r) => r.length === 4), `each request covers all 4 positions (${JSON.stringify(reqs.map((r) => r.length))})`);
    }
  },

  trailing_stop_with_zero_activation: {
    env: {
      ENABLE_TRAILING_STOP: 'true',
      TRAILING_STOP_DISTANCE: '10',
      TRAILING_STOP_ACTIVATION: '0',
      TAKE_PROFIT: '1000',
      STOP_LOSS: '90'
    },
    async run(h) {
      const m = h.newMint();
      h.ledger.prices.set(m, 0.001);
      h.buy(m, 1.0);
      const pos = await h.waitFor(() => h.active().find((p) => p.mint === m), 'position opened');
      h.check(pos.trailing_stop_activation === 0, `activation 0 kept, not turned into null (got ${pos.trailing_stop_activation})`);
      h.ledger.prices.set(m, 0.0013);
      await h.waitFor(() => h.active().find((p) => p.mint === m && p.highest_price === 0.0013), 'peak tracked');
      h.ledger.prices.set(m, 0.00115); // 11.5% below peak
      const closed = await h.waitFor(() => h.byMint(m).find((p) => p.status === 'closed'), 'TSL close');
      h.check(closed.close_reason === 'TSL', `close_reason TSL (got ${closed.close_reason})`);
    }
  }
};
