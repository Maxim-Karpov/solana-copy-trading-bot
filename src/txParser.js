// src/txParser.js
//
// Parses a confirmed Solana transaction (fetched via getParsedTransaction)
// into the same event shape the bot's copyTrade handler already expects,
// without relying on any third-party indexer (CoinVera, Helius, etc.) —
// just the raw transaction data any standard Solana RPC node returns.
//
// Instead of writing a bespoke instruction decoder per DEX, this looks at
// the copied wallet's own balance changes, which works the same way
// regardless of which DEX program actually executed the swap:
//   - Net SOL change (with the network fee added back) tells us how much
//     SOL the wallet spent or received.
//   - Net SPL token balance change for the wallet's own token account(s),
//     ignoring wrapped SOL, tells us which mint and how many tokens moved.
//   - A BUY is: SOL decreased AND a token balance increased.
//   - A SELL is: SOL increased AND a token balance decreased.
//
// The DEX label is best-effort, derived from which known program IDs show
// up in the transaction's instructions (see DEX_PROGRAM_LABELS below).
// Getting the DEX label wrong doesn't affect buy/sell detection or amounts
// — worst case it falls back to a generic 'Jupiter' label, which
// dexMapper.js's own fallback already normalizes to 'jupiter' for routing.

const config = require('./config');

const WSOL_MINT = 'So11111111111111111111111111111111111111112';
const JUPITER_PROGRAM_ID = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';

// Verified against each protocol's own docs / a block explorer at the time
// this was written. Program IDs can change if a protocol deploys a new
// version — check https://solscan.io if trades stop being recognized, and
// add new entries here as needed.
const DEX_PROGRAM_LABELS = {
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P': 'Pump.fun',        // bonding-curve buys/sells
  'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA': 'Pump.fun Amm',    // PumpSwap, post-graduation
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8': 'Raydium Ammv4',
  'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C': 'Raydium Cpmm',
  'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK': 'Raydium Clmm',
  'LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj': 'Raydium Launchpad',
  'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc': 'Orca Whirlpool',
  'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo': 'Meteora Dlmm',
  [JUPITER_PROGRAM_ID]: 'Jupiter',
};

/** Flatten top-level + inner instruction program IDs, in encounter order. */
function collectProgramIds(parsedTx) {
  const ids = [];

  const topLevel = (parsedTx.transaction && parsedTx.transaction.message.instructions) || [];
  for (const ix of topLevel) {
    if (ix.programId) ids.push(ix.programId.toBase58());
  }

  const inner = (parsedTx.meta && parsedTx.meta.innerInstructions) || [];
  for (const group of inner) {
    for (const ix of group.instructions || []) {
      if (ix.programId) ids.push(ix.programId.toBase58());
    }
  }

  return ids;
}

/**
 * Pick a human-readable DEX label from the program IDs touched by this
 * transaction. Prefers a specific AMM/bonding-curve program over the
 * generic Jupiter router, since Jupiter is usually just the top-level
 * wrapper around one of these when a trade is routed through it.
 */
function identifyDex(programIds) {
  for (const pid of programIds) {
    if (pid !== JUPITER_PROGRAM_ID && DEX_PROGRAM_LABELS[pid]) {
      return DEX_PROGRAM_LABELS[pid];
    }
  }
  if (programIds.includes(JUPITER_PROGRAM_ID)) {
    return DEX_PROGRAM_LABELS[JUPITER_PROGRAM_ID];
  }
  // Unrecognized program: dexMapper's own fallback normalizes this string
  // to 'jupiter' anyway, so this is a safe default rather than a guess.
  return 'Jupiter';
}

/**
 * The copy wallet's balance changes in one transaction: net SOL (fee added
 * back, WSOL counted as SOL), per-mint raw token deltas, and per-mint
 * pre-transaction balances. Null if the tx failed or doesn't involve it.
 */
function analyzeWalletTx(parsedTx, walletAddress) {
  if (!parsedTx || !parsedTx.meta || parsedTx.meta.err) {
    return null; // failed or missing transaction
  }

  const accountKeys = parsedTx.transaction.message.accountKeys;
  const walletIndex = accountKeys.findIndex(
    (k) => k.pubkey.toBase58() === walletAddress
  );
  if (walletIndex === -1) {
    return null; // shouldn't happen given we subscribed with `mentions`, but be defensive
  }

  const { preBalances, postBalances, preTokenBalances, postTokenBalances, fee } = parsedTx.meta;

  // Net lamport change for the wallet, adding the network fee back if this
  // wallet paid it (always account index 0), to isolate the swap's own SOL
  // leg from the incidental transaction fee.
  let lamportsChange = (postBalances[walletIndex] || 0) - (preBalances[walletIndex] || 0);
  if (walletIndex === 0 && typeof fee === 'number') {
    lamportsChange += fee;
  }
  // Tips and token-account deposits aren't part of the swap either: a
  // 0.05 SOL buy that also opened the coin's account (~0.002 SOL) and tipped
  // 0.001 SOL is a 0.05 SOL buy (buy sizing and MIN_TRADE_SOL go by it).
  {
    const costs = measureTradingCosts(parsedTx, walletAddress, walletIndex);
    lamportsChange += costs.tipLamports + costs.rentLamports;
  }

  // Net SPL token balance change(s) for this wallet's own token accounts.
  // Wrapped SOL is tracked separately and counted as SOL: most swaps wrap
  // and unwrap within the same transaction (so WSOL nets to zero and the
  // lamport change above already has the full SOL leg), but a wallet that
  // keeps a *persistent* WSOL account settles trades in WSOL — without this,
  // its SOL leg would look like ~0 and its buys/sells would be missed.
  const deltasByMint = new Map(); // mint -> { deltaRaw: BigInt, decimals }
  // Separately-tracked pre-trade balances, so we can express a sell as a
  // percentage of what the wallet held *before* this transaction (used by
  // STIERED mode to mirror how much of their stack the copy wallet sold).
  const preRawByMint = new Map(); // mint -> BigInt
  let wsolDeltaRaw = 0n;

  const applyBalances = (list, sign) => {
    for (const tb of list || []) {
      if (tb.owner !== walletAddress) continue;
      if (tb.mint === WSOL_MINT) {
        wsolDeltaRaw += sign * BigInt(tb.uiTokenAmount.amount);
        continue;
      }
      const raw = BigInt(tb.uiTokenAmount.amount);
      const decimals = tb.uiTokenAmount.decimals;
      const existing = deltasByMint.get(tb.mint) || { deltaRaw: 0n, decimals };
      existing.deltaRaw += sign * raw;
      existing.decimals = decimals;
      deltasByMint.set(tb.mint, existing);

      if (sign === -1n) {
        preRawByMint.set(tb.mint, (preRawByMint.get(tb.mint) || 0n) + raw);
      }
    }
  };

  applyBalances(preTokenBalances, -1n);
  applyBalances(postTokenBalances, 1n);

  return {
    signature: parsedTx.transaction.signatures[0],
    // Slot the tx landed in — lets index.js tell whether a sell happened
    // after a buy even if the two events were processed out of order.
    slot: typeof parsedTx.slot === 'number' ? parsedTx.slot : null,
    solAmount: (lamportsChange + Number(wsolDeltaRaw)) / 1e9,
    deltasByMint,
    preRawByMint
  };
}

/**
 * How much of its pre-transaction holding of `mint` the wallet gave up, as
 * a percentage. No visibility into the pre-balance -> 100% (full exit), the
 * safe assumption for mirroring.
 */
function percentOfHolding(a, mint, decreasedRaw) {
  const preRaw = a.preRawByMint.get(mint) || 0n;
  if (preRaw <= 0n) return 100;
  return Math.min(100, (Number(decreasedRaw) / Number(preRaw)) * 100);
}

/** The buy/sell (vs SOL) in an analyzed tx, or null. */
function classifyTrade(a, parsedTx) {
  const { solAmount, deltasByMint } = a;

  // Pick the mint with the largest absolute UI-amount delta as "the" traded
  // token. In the common single-hop swap case there's exactly one non-zero
  // entry; a multi-hop route could touch more than one, and we take the
  // dominant leg.
  let tradedMint = null;
  let tradedDeltaRaw = 0n;
  let tradedDecimals = 0;
  let bestAbsUi = 0;

  for (const [mint, { deltaRaw, decimals }] of deltasByMint.entries()) {
    if (deltaRaw === 0n) continue;
    const absUi = Math.abs(Number(deltaRaw) / 10 ** decimals);
    if (absUi > bestAbsUi) {
      bestAbsUi = absUi;
      tradedMint = mint;
      tradedDeltaRaw = deltaRaw;
      tradedDecimals = decimals;
    }
  }

  if (!tradedMint) {
    return null; // no non-WSOL token balance changed for this wallet — not a swap we recognize
  }

  const tokenAmount = Number(tradedDeltaRaw) / 10 ** tradedDecimals;

  let trade;
  if (solAmount < 0 && tokenAmount > 0) {
    trade = 'buy';
  } else if (solAmount > 0 && tokenAmount < 0) {
    trade = 'sell';
  } else {
    // Doesn't match a simple buy/sell pattern (e.g. a token transfer with no
    // SOL leg, an LP add/remove).
    return null;
  }

  // Guard against dust/rent-only "buys" — e.g. the copied wallet paying
  // ~0.002 SOL of its own rent to open a token account while claiming an
  // airdrop, which would otherwise technically match the buy pattern above
  // even though nothing was actually bought.
  // Deliberately NOT applied to sells: when a token has crashed, the copy
  // wallet's final exit can return less than MIN_TRADE_SOL — and that's
  // exactly the sell EXACT/STIERED positions need to see, or our mirrored
  // position would be left open with no exit signal.
  if (trade === 'buy' && Math.abs(solAmount) < config.MIN_TRADE_SOL) {
    return null;
  }

  // For a sell, how much of the wallet's *pre-trade* holding of this mint it
  // just sold — STIERED mirrors that percentage.
  const sellPercent = trade === 'sell' ? percentOfHolding(a, tradedMint, -tradedDeltaRaw) : null;

  const dex = identifyDex(collectProgramIds(parsedTx));

  return {
    signature: a.signature,
    slot: a.slot,
    dexs: [dex],
    ca: tradedMint,
    trade,
    solAmount,
    tokenAmount,
    sellPercent,
  };
}

/**
 * Parse a getParsedTransaction(...) result into a buy/sell copyTrade event,
 * or null if this transaction isn't a recognizable buy/sell by
 * `walletAddress` (e.g. a plain transfer, a failed tx, an LP action).
 */
function parseCopyTradeTransaction(parsedTx, walletAddress) {
  const a = analyzeWalletTx(parsedTx, walletAddress);
  return a ? classifyTrade(a, parsedTx) : null;
}

/**
 * Every event in one copy-wallet transaction that matters for mirroring:
 * the buy/sell (if any), plus a 'transfer' event for each OTHER token whose
 * balance went DOWN without being sold for SOL — sent to another wallet,
 * burned, swapped into a different token, or handed to another program. For
 * a position that mirrors the copy wallet's exits, any of those means the
 * copy wallet no longer holds that share of the token, so it's treated like
 * a sell of the same percentage (see MIRROR_TRANSFERS).
 */
function parseCopyWalletEvents(parsedTx, walletAddress) {
  const a = analyzeWalletTx(parsedTx, walletAddress);
  if (!a) return [];
  const primary = classifyTrade(a, parsedTx);
  const events = primary ? [primary] : [];

  for (const [mint, { deltaRaw, decimals }] of a.deltasByMint.entries()) {
    if (deltaRaw >= 0n) continue;
    if (primary && primary.ca === mint) continue;
    events.push({
      signature: a.signature,
      slot: a.slot,
      dexs: [],
      ca: mint,
      trade: 'transfer',
      solAmount: a.solAmount,
      tokenAmount: Number(deltaRaw) / 10 ** decimals,
      sellPercent: percentOfHolding(a, mint, -deltaRaw),
    });
  }
  return events;
}

/**
 * Exact effect of one of OUR OWN transactions on our wallet, for a given
 * mint: raw lamport change (NOT fee-adjusted — this is the true
 * out-of-pocket SOL including network fee, Jito tip and any token-account
 * rent) plus WSOL change, and raw token change. Used to record exactly how
 * many tokens a buy delivered and what it really cost, and what a sell
 * really returned, instead of estimating from prices or wallet balances.
 * Returns null if the transaction is missing, failed, or doesn't involve
 * the wallet.
 */
function measureWalletDeltas(parsedTx, walletAddress, mint) {
  if (!parsedTx || !parsedTx.meta || parsedTx.meta.err) return null;

  const accountKeys = parsedTx.transaction.message.accountKeys;
  const walletIndex = accountKeys.findIndex((k) => k.pubkey.toBase58() === walletAddress);
  if (walletIndex === -1) return null;

  const { preBalances, postBalances, preTokenBalances, postTokenBalances } = parsedTx.meta;
  let lamportsDelta = (postBalances[walletIndex] || 0) - (preBalances[walletIndex] || 0);

  let tokenDeltaRaw = 0n;
  let wsolDeltaRaw = 0n;
  let decimals = null;
  const apply = (list, sign) => {
    for (const tb of list || []) {
      if (tb.owner !== walletAddress) continue;
      if (tb.mint === WSOL_MINT) {
        wsolDeltaRaw += sign * BigInt(tb.uiTokenAmount.amount);
      } else if (tb.mint === mint) {
        tokenDeltaRaw += sign * BigInt(tb.uiTokenAmount.amount);
        decimals = tb.uiTokenAmount.decimals;
      }
    }
  };
  apply(preTokenBalances, -1n);
  apply(postTokenBalances, 1n);

  lamportsDelta += Number(wsolDeltaRaw);
  const costs = measureTradingCosts(parsedTx, walletAddress, walletIndex);
  return { lamportsDelta, tokenDeltaRaw, decimals, ...costs };
}

/**
 * What the wallet paid in a transaction ON TOP OF the swap itself (lamports):
 *   feeLamports  - network fee incl. priority fee (when the wallet pays it)
 *   tipLamports  - Jito / Helius Sender tips
 *   rentLamports - net token-account deposits (refundable rent): + when an
 *                  account was opened, - when one was closed and refunded
 * The pool's own trading fee and any token transfer tax are NOT counted:
 * they're part of the price the swap got. lamportsDelta + these = the SOL
 * that went into (negative) or came out of (positive) the swap itself.
 */
function measureTradingCosts(parsedTx, walletAddress, walletIndex) {
  const meta = parsedTx.meta || {};
  const feeLamports = walletIndex === 0 ? Number(meta.fee || 0) : 0; // index 0 is the fee payer

  const { JITO_TIP_ACCOUNTS } = require('./jitoTip');
  const { SENDER_TIP_ACCOUNTS } = require('./heliusSender');
  const tipSet = new Set([...JITO_TIP_ACCOUNTS, ...SENDER_TIP_ACCOUNTS].map((k) => (typeof k === 'string' ? k : k.toBase58())));
  let tipLamports = 0;
  const outer = (parsedTx.transaction && parsedTx.transaction.message && parsedTx.transaction.message.instructions) || [];
  const inner = (meta.innerInstructions || []).flatMap((g) => g.instructions || []);
  for (const ix of [...outer, ...inner]) {
    const p = ix && ix.parsed;
    if (!p || ix.program !== 'system' || p.type !== 'transfer' || !p.info) continue;
    if (p.info.source === walletAddress && tipSet.has(p.info.destination)) tipLamports += Number(p.info.lamports || 0);
  }

  // Token accounts of the wallet opened (deposit paid) or closed (deposit
  // refunded) in this transaction. A wrapped-SOL account's lamports also hold
  // the wrapped SOL itself, which isn't deposit.
  let rentLamports = 0;
  const pre = new Map();
  const post = new Map();
  for (const tb of meta.preTokenBalances || []) if (tb.owner === walletAddress) pre.set(tb.accountIndex, tb);
  for (const tb of meta.postTokenBalances || []) if (tb.owner === walletAddress) post.set(tb.accountIndex, tb);
  const pb = meta.preBalances || [];
  const qb = meta.postBalances || [];
  for (const [idx, tb] of post) {
    if (pre.has(idx) || !(pb[idx] === 0 || pb[idx] === undefined)) continue;
    const wrapped = tb.mint === WSOL_MINT ? Number(tb.uiTokenAmount.amount) : 0;
    rentLamports += Math.max(0, (qb[idx] || 0) - wrapped);
  }
  for (const [idx, tb] of pre) {
    if (post.has(idx) || (qb[idx] || 0) !== 0) continue;
    const wrapped = tb.mint === WSOL_MINT ? Number(tb.uiTokenAmount.amount) : 0;
    rentLamports -= Math.max(0, (pb[idx] || 0) - wrapped);
  }
  return { feeLamports, tipLamports, rentLamports };
}

// Newest Solana transaction format we can read. Wallets and trading tools
// started sending "version 1" transactions; an RPC refuses to return them
// unless we say we can handle them. (Our @solana/web3.js reads v1.)
const MAX_TX_VERSION = 1;

module.exports = {
  MAX_TX_VERSION,
  parseCopyTradeTransaction,
  parseCopyWalletEvents,
  measureWalletDeltas,
  collectProgramIds,
  identifyDex,
  WSOL_MINT,
  JUPITER_PROGRAM_ID,
  DEX_PROGRAM_LABELS
};
