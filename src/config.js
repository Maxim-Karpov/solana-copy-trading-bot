// src/config.js
// Settings: .env in the bot folder, or copybot.env next to the bot folder
// (see src/envFile.js). Values already in the environment win.
const ENV_FILE = require('./envFile').findEnvFile();
if (ENV_FILE) require('dotenv').config({ path: ENV_FILE });
const { exit } = require('process');
const { Keypair, PublicKey } = require('@solana/web3.js');
const { parseTierConfig } = require('./tieredBuy');
const { redactUrl } = require('./logger');

let bs58;
{
  const imported = require('bs58');
  bs58 = imported.default ? imported.default : imported;
}

function fail(message) {
  console.error(`[config] ERROR: ${message}`);
  exit(1);
}

function requiredEnv(key) {
  const val = process.env[key];
  if (!val) fail(`Missing environment variable ${key}`);
  return val;
}

/**
 * Parse a numeric env var and refuse to start on garbage. A plain
 * parseFloat() turns a typo like "1O" or "abc" into NaN, and every
 * comparison against NaN is false — which would silently switch off
 * whatever check that number feeds (a risk cap that never clamps, a
 * stop-loss that never fires).
 */
/** "true" | "false" | "sells" | "buys" -> { buy, sell } (invalid -> null, reported below). */
function sidesEnv(key, def) {
  const raw = process.env[key];
  const v = String(raw === undefined || raw === '' ? def : raw).trim().toLowerCase();
  if (['true', 'on', 'yes', 'both', 'all'].includes(v)) return { buy: true, sell: true };
  if (['false', 'off', 'no', 'none'].includes(v)) return { buy: false, sell: false };
  if (['sells', 'sell', 'exits', 'sells-only'].includes(v)) return { buy: false, sell: true };
  if (['buys', 'buy', 'buys-only'].includes(v)) return { buy: true, sell: false };
  return null;
}

function parseLatLon(raw) {
  if (!raw || !raw.trim()) return null;
  const m = raw.trim().match(/^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/);
  if (!m || Math.abs(Number(m[1])) > 90 || Math.abs(Number(m[2])) > 180) {
    fail(`LEADER_HOME must be "latitude,longitude", e.g. "50.11,8.68" (got "${raw}")`);
  }
  return { lat: Number(m[1]), lon: Number(m[2]) };
}

function numEnv(key, { required = false, def, min, max, minExclusive = false, integer = false } = {}) {
  const raw = process.env[key];
  // Spaces only counts as empty (Number(" ") would be 0, silently a
  // strictest-possible setting).
  if (raw === undefined || raw.trim() === '') {
    if (required) fail(`Missing environment variable ${key}`);
    return def;
  }
  const n = Number(raw);
  if (!Number.isFinite(n)) fail(`${key} must be a number (got "${raw}")`);
  if (integer && !Number.isInteger(n)) fail(`${key} must be a whole number (got "${raw}")`);
  if (min !== undefined && (minExclusive ? n <= min : n < min)) {
    fail(`${key} must be ${minExclusive ? 'greater than' : 'at least'} ${min} (got ${n})`);
  }
  if (max !== undefined && n > max) fail(`${key} must be at most ${max} (got ${n})`);
  return n;
}

/**
 * Derive a websocket RPC URL from an http(s) one by swapping the scheme,
 * e.g. https://mainnet.helius-rpc.com/?api-key=X -> wss://mainnet.helius-rpc.com/?api-key=X.
 * This is the standard convention most Solana RPC providers use (Helius,
 * QuickNode, Triton, Alchemy, the public mainnet-beta endpoint, etc.) —
 * same host/path/query, just ws(s):// instead of http(s)://.
 */
function deriveWsUrl(httpUrl) {
  if (httpUrl.startsWith('https://')) return 'wss://' + httpUrl.slice('https://'.length);
  if (httpUrl.startsWith('http://')) return 'ws://' + httpUrl.slice('http://'.length);
  fail(`SOLANA_RPC must start with http:// or https:// to auto-derive a websocket URL (got: ${redactUrl(httpUrl)}). Set SOLANA_WS explicitly instead.`);
}

const config = {
  SOLANA_RPC:         requiredEnv('SOLANA_RPC'),
  PRIVATE_KEY:        requiredEnv('PRIVATE_KEY'),
  PUBLIC_KEY:         requiredEnv('PUBLIC_KEY'),
  BOT_MODE:           requiredEnv('BOT_MODE').toUpperCase(),       // "COPY" or "SELLING"
  // One wallet, or several separated by commas: every one is copied.
  // COPY_WALLET is the first; COPY_WALLETS the whole list.
  COPY_WALLETS:       [...new Set(requiredEnv('COPY_WALLET').split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean))],
  TRADE_TYPE:         requiredEnv('TRADE_TYPE').toUpperCase(),     // "EXACT", "SAFE", "TIERED", or "STIERED"
  BUY_AMOUNT:         numEnv('BUY_AMOUNT', { required: true, min: 0, minExclusive: true }),   // SOL, used if SAFE
  TAKE_PROFIT:        numEnv('TAKE_PROFIT', { required: true, min: 0, minExclusive: true }),  // percent
  STOP_LOSS:          numEnv('STOP_LOSS', { required: true, min: 0, minExclusive: true, max: 100 }), // percent
  SLIPPAGE:           numEnv('SLIPPAGE', { required: true, min: 0, minExclusive: true, max: 100 }), // percent
  JITO_TIP:           numEnv('JITO_TIP', { required: true, min: 0 }),                         // SOL
  JITO_ENGINE:        requiredEnv('JITO_ENGINE'),
  PRICE_CHECK_DELAY:  numEnv('PRICE_CHECK_DELAY', { required: true, min: 250, integer: true }), // ms
  PREFERRED_DEX:      (process.env.PREFERRED_DEX || 'none').toLowerCase(), // "none" (system decides) or specific DEX: "auto", "pumpfun", "meteora", "raydium", "moonshot", "jupiter"

  // Minimum |SOL amount| (see txParser.js) for a classified buy/sell to be
  // treated as real, rather than dust/rent noise (e.g. the copied wallet
  // paying ~0.002 SOL of its own rent to create a token account while
  // claiming an airdrop, which would otherwise look like a tiny "buy").
  // Also used as the smallest buy we'll bother placing after risk caps clamp
  // a buy down — below this, fees and tips would eat the position.
  MIN_TRADE_SOL:      numEnv('MIN_TRADE_SOL', { def: 0.003, min: 0 }), // in SOL

  // --- Risk caps (apply to every trade mode) ---
  // Hard ceiling on any single buy, regardless of what TRADE_TYPE computed
  // (EXACT/TIERED sizing off a copy wallet, a misconfigured BUY_AMOUNT,
  // etc.) — the buy is clamped down to this, never skipped outright.
  MAX_BUY_AMOUNT:      numEnv('MAX_BUY_AMOUNT', { def: 11, min: 0, minExclusive: true }), // in SOL

  // Hard ceiling on total SOL committed across all open positions at once,
  // *including* buys that are still in flight. A new buy is clamped to
  // whatever room is left under this cap; if there's no meaningful room
  // left (less than MIN_TRADE_SOL), the buy is skipped entirely.
  MAX_TOTAL_EXPOSURE:  numEnv('MAX_TOTAL_EXPOSURE', { def: 15, min: 0, minExclusive: true }), // in SOL

  // Optional comma-separated list of additional RPC HTTP URLs to fail over
  // to if the primary SOLANA_RPC starts erroring (see src/rpcPool.js).
  // Leave unset (default) to disable this entirely — the bot then behaves
  // exactly as it always has, using only SOLANA_RPC everywhere.
  SOLANA_RPC_FALLBACKS: (process.env.SOLANA_RPC_FALLBACKS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  // Optional Telegram control bot (src/telegramBot.js): lists open positions
  // with a per-position "Sell" button, and pushes buy/sell (with PnL)
  // notifications. Both must be set to enable it; leave either unset
  // (default) to disable the feature entirely — no telegram package is even
  // touched.
  //   TELEGRAM_BOT_TOKEN - from @BotFather
  //   TELEGRAM_CHAT_ID   - your personal chat id (e.g. from @userinfobot);
  //                        only this person, in a private chat with the bot,
  //                        can see or sell positions.
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || null,
  TELEGRAM_CHAT_ID:   process.env.TELEGRAM_CHAT_ID || null,

  // Build & sign Pump.fun bonding-curve buys/sells directly on-chain using
  // Pump.fun's own SDK, instead of routing through SolanaPortal's API — cuts
  // one network hop out of the buy/sell path. Only applies when the copied
  // trade was on Pump.fun AND the coin is a plain SOL-paired, legacy-SPL-Token
  // bonding curve (the vast majority of pump.fun coins); anything else
  // automatically falls back to SolanaPortal, as does any error building the
  // direct tx. Off by default — this is new and hasn't been battle-tested
  // against live mainnet execution the way the SolanaPortal path has. Test
  // with a small BUY_AMOUNT before trusting it with size.
  DIRECT_PUMPFUN_SWAP: (process.env.DIRECT_PUMPFUN_SWAP === 'true'),

  // Same idea as DIRECT_PUMPFUN_SWAP, for Raydium: builds Standard-pool
  // (AMM v4 / CPMM) buys/sells directly via Raydium's own SDK instead of
  // SolanaPortal's API. CLMM (concentrated-liquidity) pools and anything
  // else out of scope, or any build error, falls back to SolanaPortal
  // automatically. Off by default — same beta caveat as DIRECT_PUMPFUN_SWAP.
  DIRECT_RAYDIUM_SWAP: (process.env.DIRECT_RAYDIUM_SWAP === 'true'),

  // Most RPC calls the bot makes per second (0 = no limit). Keep it a little
  // under your RPC plan's limit; the bot's trading calls always go first and
  // background lookups use what's left. See src/rateLimiter.js.
  RPC_MAX_RPS: numEnv('RPC_MAX_RPS', { def: 8, min: 0 }),
  USAGE_LOG_MIN: numEnv('USAGE_LOG_MIN', { def: 10, min: 0 }),

  // Close empty token accounts (after a coin is fully sold, plus a sweep
  // every 30 min) to get back the ~0.002 SOL deposit each one holds.
  // On by default; set "false" to turn off. See src/accountCleaner.js.
  CLOSE_EMPTY_ACCOUNTS: process.env.CLOSE_EMPTY_ACCOUNTS !== 'false',
  // STIERED: on the copy wallet's FIRST sell (or transfer out) of a coin,
  // sell 100% of ours instead of mirroring the percentage.
  FULL_EXIT_ON_COPY_SELL: process.env.FULL_EXIT_ON_COPY_SELL === 'true',
  // Only copy the copy wallet's FIRST buy of a coin: skip its buy if it
  // already held the coin (e.g. the bot was started mid-trade). Default on.
  ONLY_COPY_FIRST_BUY: process.env.ONLY_COPY_FIRST_BUY !== 'false',
  // Skip a copy buy when our expected price per token is more than this
  // percentage above what the copy wallet paid (other copy bots got in first
  // and pushed the price up). Checked from the direct builder's own quote
  // before sending, so it adds no time. Unset (default) = no check.
  MAX_ENTRY_PREMIUM_PCT: numEnv('MAX_ENTRY_PREMIUM_PCT', { def: null, min: 0 }),
  // Instant buy filters (no extra lookups: the direct builder already knows
  // the coin's curve or pool). Market cap in SOL, just before our buy. Unset
  // (default) = no limit. With either set, a coin whose market cap can't be
  // read instantly (no direct build, e.g. Raydium) is skipped.
  MIN_MARKET_CAP_SOL: numEnv('MIN_MARKET_CAP_SOL', { def: null, min: 0 }),
  MAX_MARKET_CAP_SOL: numEnv('MAX_MARKET_CAP_SOL', { def: null, min: 0, minExclusive: true }),
  // Skip the copy wallet's buys smaller than this (SOL). Unset = no minimum
  // beyond MIN_TRADE_SOL's dust filter.
  MIN_COPY_BUY_SOL: numEnv('MIN_COPY_BUY_SOL', { def: null, min: 0 }),
  // Only buy if our transaction lands within this many slots of the copy
  // wallet's (0 = the same block). Enforced on-chain by a slot guard in the
  // transaction (slotGuard.js). Unset (default) = off.
  MAX_SLOTS_BEHIND: numEnv('MAX_SLOTS_BEHIND', { def: null, min: 0, integer: true }),
  // Where each slot's leader is (public schedule + IP location, see
  // leaderInfo.js): shown in each shred buy's timing line. "false" = off.
  LEADER_INFO: (process.env.LEADER_INFO || '').trim() !== 'false',
  // Skip a buy when the leader of every slot it could land in is further
  // than this many km from this server. Empty (default) = off.
  LEADER_MAX_KM: numEnv('LEADER_MAX_KM', { def: null, min: 1 }),
  // This server's location as "lat,lon", instead of looking it up from its IP.
  LEADER_HOME: parseLatLon(process.env.LEADER_HOME),
  // At most this many positions open at once (buys in flight included); a
  // copy buy that would open another is skipped. 0 = no limit.
  MAX_OPEN_POSITIONS: numEnv('MAX_OPEN_POSITIONS', { def: 2, min: 0, integer: true }),
  // QUOTE_TOKENS (default off): tokens other than SOL that Pump.fun coins
  // can be paired to (e.g. the PUMP token). For each one listed the bot keeps
  // a reserve worth QUOTE_TOKEN_RESERVE_SOL, topped up via Jupiter, and buys
  // coins paired to it from that reserve (see quoteTokens.js).
  QUOTE_TOKENS: [...new Set((process.env.QUOTE_TOKENS || '').split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean))],
  QUOTE_TOKEN_RESERVE_SOL: numEnv('QUOTE_TOKEN_RESERVE_SOL', { def: 1, min: 0.01 }),
  // Compute budget of trades in token-paired coins (token transfers, more
  // accounts); the priority fee total stays the same, spread over it.
  QUOTE_COMPUTE_UNITS: numEnv('QUOTE_COMPUTE_UNITS', { def: 200_000, min: 60_000, max: 1_400_000, integer: true }),
  // After the bot sends a buy, skip any other copy buy that comes within
  // this many seconds (whatever coin or wallet). 0 = off.
  BUY_COOLDOWN_SEC: numEnv('BUY_COOLDOWN_SEC', { def: 5, min: 0 }),
  // Shred stream: sees the copy wallet's trades as the leader produces them,
  // ahead of the websocket feed, which keeps running alongside. Which kind
  // is SHRED_SOURCE (set below). Unset = off.
  SHRED_STREAM_URL: (process.env.SHRED_STREAM_URL || '').trim(),
  SHRED_STREAM_TOKEN: (process.env.SHRED_STREAM_TOKEN || '').trim(),
  SHRED_STREAM_AUTH_HEADER: (process.env.SHRED_STREAM_AUTH_HEADER || 'x-token').trim().toLowerCase(),
  // SHRED_SOURCE="shreder": Shreder's decoded-shreds gRPC address, e.g.
  // http://fra1.shreder.xyz:9991. Access is by the server's IP address
  // (Shreder whitelists it), so there is no token.
  SHREDER_URL: (process.env.SHREDER_URL || '').trim(),
  // Shreds show a trade before it runs, so the copy wallet's buy can still
  // fail after we copied it. "true" (default): then sell ours at once.
  // "false": just alert in Telegram.
  SHRED_SELL_IF_COPY_FAILED: process.env.SHRED_SELL_IF_COPY_FAILED !== 'false',
  // With a shred source on, copy only the buys the shred stream reports: a
  // buy first seen by the websocket feed comes too late to be worth it.
  // While the shred feed is down nothing is bought (Telegram alert). Sells
  // and exits come from both feeds. "false": buy from either feed.
  SHRED_BUYS_ONLY: process.env.SHRED_BUYS_ONLY !== 'false',
  // Credit safety for helius-preprocessed (billed per message): if more than
  // this many messages a minute arrive, the shred feed stops for the run and
  // Telegram says so. 0 = no limit.
  SHRED_MAX_MSGS_PER_MIN: numEnv('SHRED_MAX_MSGS_PER_MIN', { def: 3000, min: 0, integer: true }),
  // Build shred-copied Pump.fun buys WITHOUT looking the coin up (saves one
  // round trip). The price can't be quoted then, so the buy spends exactly
  // its SOL and its only price limit is MAX_MARKET_CAP_SOL, enforced
  // on-chain (required). Falls back to the normal build when something it
  // needs isn't known. Default off.
  SHRED_FAST_BUY: process.env.SHRED_FAST_BUY === 'true',
  // SHRED_FAST_BUY buys written straight into transaction bytes instead of
  // through Pump.fun's SDK and web3.js (pumpBuyRaw.js): the same transaction,
  // checked identical at startup, in a fraction of the time. "false" = the
  // SDK route.
  HAND_BUILT_BUYS: (process.env.HAND_BUILT_BUYS || '').trim() !== 'false',
  // "rust": the Rust fast path (fastpath/) reads the shred feeds and sends
  // the shred-copied Pump.fun buys it can, this bot does everything else.
  // Empty (default) = off.
  FAST_PATH: (process.env.FAST_PATH || '').trim().toLowerCase(),
  FAST_PATH_PORT: numEnv('FAST_PATH_PORT', { def: 7799, min: 1, max: 65535, integer: true }),
  // If the fast path is unreachable this long, this bot opens its own shred
  // feed(s) until it's back.
  FAST_PATH_FALLBACK_MS: numEnv('FAST_PATH_FALLBACK_MS', { def: 5000, min: 0, integer: true }),
  // Helius feeds (helius-preprocessed shreds and DETECTION_FEED="transaction"):
  // leave out transactions that mention any of these accounts, e.g. a spam
  // program (the [Shreds] summary suggests candidates).
  SHRED_EXCLUDE_ACCOUNTS: (process.env.SHRED_EXCLUDE_ACCOUNTS || '').split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean),
  // Sell the whole position this many seconds after our buy confirms,
  // whatever the copy wallet does (a quick flip). 0 (default) = off.
  SELL_AFTER_SECONDS: numEnv('SELL_AFTER_SECONDS', { def: 0, min: 0 }),
  // Sell everything the moment our buy lands (seen at "processed", without
  // waiting for confirmation or the bookkeeping), optionally after
  // INSTANT_SELL_DELAY_MS. Default off.
  INSTANT_SELL: (process.env.INSTANT_SELL || '').trim() === 'true',
  INSTANT_SELL_DELAY_MS: numEnv('INSTANT_SELL_DELAY_MS', { def: 0, min: 0, max: 60000 }),
  // Keep a recent blockhash and Pump.fun's config fetched in the background
  // (see prewarm.js), so a direct buy needs one network round trip instead
  // of three. ~3 calls a minute. "false" = fetch everything per trade.
  PREWARM: process.env.PREWARM !== 'false',
  // PnL from the swaps alone, leaving out network fees, tips and
  // token-account deposits (default). "false": what actually left / arrived
  // in the wallet.
  PNL_EXCLUDE_FEES: process.env.PNL_EXCLUDE_FEES !== 'false',
  // Backup route when SolanaPortal can't build a trade (see jupiterSwap.js).
  // Which trades each service may build: { buy, sell }. Values "true",
  // "false", "sells" (exits only) or "buys".
  // Jupiter: off by default.
  JUPITER_FALLBACK: sidesEnv('JUPITER_FALLBACK', 'false'),
  // SolanaPortal builds every trade the direct builders don't (default).
  USE_SOLANAPORTAL: sidesEnv('USE_SOLANAPORTAL', 'true'),
  JUPITER_API_KEY: (process.env.JUPITER_API_KEY || '').trim(),
  JUPITER_API_URL: (process.env.JUPITER_API_URL || 'https://api.jup.ag/swap/v2').replace(/\/+$/, ''),

  // Skip coins whose transfer fee ("tax", a Token-2022 feature) is above
  // this percentage, e.g. "1". Unset (default) = no check. Pump.fun coins
  // can't carry one and aren't checked; other coins cost one quick lookup
  // before the buy. See src/tokenTax.js.
  MAX_TOKEN_TAX_PCT: numEnv('MAX_TOKEN_TAX_PCT', { def: null, min: 0, max: 100 }),

  // Start with buying paused; tap Resume in Telegram to begin. Exits work
  // while paused. Default on (needs Telegram; ignored without it).
  START_PAUSED: process.env.START_PAUSED !== 'false',
  // While buying is paused, still run each buy copied from the shreds up to
  // the moment of sending (checks, build, signing) and log its timing, so a
  // paused bot measures how fast it would have been. Nothing is sent.
  PAUSED_REHEARSAL: (process.env.PAUSED_REHEARSAL || '').trim() !== 'false',
  // A test bot that never buys: permanently paused (no Telegram needed),
  // every shred buy rehearsed for timing. Exits still work if it holds any.
  REHEARSE_ONLY: (process.env.REHEARSE_ONLY || '').trim() === 'true',

  // New: allow or prevent multiple buys for same mint
  ENABLE_MULTI_BUY:   (process.env.ENABLE_MULTI_BUY === 'true'),

  // When to act on the copy wallet's trades:
  //   "confirmed" (default) - once the network has confirmed the trade.
  //   "processed" - as soon as it's first processed, roughly 0.5-1s sooner.
  //     Pump.fun bonding-curve trades are read straight from the notification
  //     with no extra lookup. Everything else (other DEXes, transfers) still
  //     waits for confirmation. Risk: very occasionally a processed
  //     transaction is dropped and never confirms, so you'd copy a trade that
  //     didn't happen.
  DETECTION_COMMITMENT: (process.env.DETECTION_COMMITMENT || 'confirmed').toLowerCase(),
  DETECTION_FEED: (process.env.DETECTION_FEED || 'logs').toLowerCase(),

  // Ignore the copy wallet buying back into a coin it has exited:
  //   "off"  - always copy its buys (default)
  //   "full" - once it has sold/moved out its WHOLE bag of a coin, ignore
  //            its later buys of that coin
  //   "any"  - once it has sold/moved out ANY of a coin, ignore its later
  //            buys of that coin
  SKIP_REBUYS:        (process.env.SKIP_REBUYS || 'off').toLowerCase(),

  // Treat the copy wallet moving a token OUT without selling it for SOL
  // (sending it to another wallet, burning it, swapping it into another
  // token) as an exit, mirrored exactly like a sell of the same percentage
  // for EXACT and STIERED positions. On by default; set "false" to only
  // mirror real sells.
  MIRROR_TRANSFERS:   (process.env.MIRROR_TRANSFERS || 'true').toLowerCase() !== 'false',

  // Trailing Stop Loss Configuration
  ENABLE_TRAILING_STOP: (process.env.ENABLE_TRAILING_STOP === 'true'),
  TRAILING_STOP_DISTANCE: numEnv('TRAILING_STOP_DISTANCE', { def: 0, min: 0, max: 100 }), // percent distance from peak
  TRAILING_STOP_ACTIVATION: numEnv('TRAILING_STOP_ACTIVATION', { def: 0, min: 0 }), // minimum profit % before trailing starts

  // --- Advanced (optional) — sensible defaults, rarely need changing ---
  // How long to wait for a buy/sell to confirm before treating it as not
  // landed. A Solana transaction's blockhash expires after ~60-90s, so
  // anything not confirmed by then can no longer land.
  CONFIRM_TIMEOUT_SEC:    numEnv('CONFIRM_TIMEOUT_SEC', { def: 90, min: 1 }),
  // A sell that fails is retried SELL_MAX_ATTEMPTS times, SELL_RETRY_DELAY_MS
  // apart. If it still fails the position stays OPEN (never silently
  // forgotten) and is retried again after SELL_RETRY_COOLDOWN_MS (doubling
  // on each further failure, up to 10 minutes). Minimum 2 attempts: the
  // retry is where the amount is re-checked against the real balance.
  SELL_MAX_ATTEMPTS:      numEnv('SELL_MAX_ATTEMPTS', { def: 3, min: 2, integer: true }),
  SELL_RETRY_DELAY_MS:    numEnv('SELL_RETRY_DELAY_MS', { def: 2000, min: 0, integer: true }),
  SELL_RETRY_COOLDOWN_MS: numEnv('SELL_RETRY_COOLDOWN_MS', { def: 30000, min: 0, integer: true }),
};

const validBotModes   = ['COPY', 'SELLING'];
const validTradeTypes = ['EXACT', 'SAFE', 'TIERED', 'STIERED'];
const validDexOptions = ['none', 'auto', 'pumpfun', 'meteora', 'raydium', 'moonshot', 'jupiter'];

if (!validBotModes.includes(config.BOT_MODE)) {
  fail(`BOT_MODE must be one of: ${validBotModes.join(', ')}`);
}
if (!validTradeTypes.includes(config.TRADE_TYPE)) {
  fail(`TRADE_TYPE must be one of: ${validTradeTypes.join(', ')}`);
}
for (const key of ['USE_SOLANAPORTAL', 'JUPITER_FALLBACK']) {
  if (!config[key]) fail(`${key} must be "true", "false", "sells" or "buys"`);
}
if (!['logs', 'transaction'].includes(config.DETECTION_FEED)) {
  fail('DETECTION_FEED must be "logs" or "transaction"');
}
if (!['confirmed', 'processed'].includes(config.DETECTION_COMMITMENT)) {
  fail('DETECTION_COMMITMENT must be "confirmed" or "processed"');
}
if (!['off', 'full', 'any'].includes(config.SKIP_REBUYS)) {
  fail('SKIP_REBUYS must be one of: off, full, any');
}
if (!validDexOptions.includes(config.PREFERRED_DEX)) {
  fail(`PREFERRED_DEX must be one of: ${validDexOptions.join(', ')}`);
}

// Wallet sanity: addresses must be real Solana public keys, and PUBLIC_KEY
// must be the wallet PRIVATE_KEY actually controls. A mismatch otherwise
// "works" — trades are signed by PRIVATE_KEY — but every balance check runs
// against the wrong wallet, so positions record zero tokens and never sell.
config.COPY_WALLET = config.COPY_WALLETS[0];
if (!config.COPY_WALLET) fail('COPY_WALLET is empty');
try {
  new PublicKey(config.PUBLIC_KEY);
} catch {
  fail(`PUBLIC_KEY is not a valid Solana address (got "${config.PUBLIC_KEY}")`);
}
for (const w of config.COPY_WALLETS) {
  try {
    new PublicKey(w);
  } catch {
    fail(`COPY_WALLET: "${w}" is not a valid Solana address (separate several wallets with commas)`);
  }
}
{
  let derived;
  try {
    derived = Keypair.fromSecretKey(bs58.decode(config.PRIVATE_KEY)).publicKey.toBase58();
  } catch (err) {
    fail(`PRIVATE_KEY is not a valid base58 Solana secret key (${err.message})`);
  }
  if (derived !== config.PUBLIC_KEY) {
    fail(`PUBLIC_KEY (${config.PUBLIC_KEY}) does not match the wallet PRIVATE_KEY controls (${derived}). Set PUBLIC_KEY to ${derived}.`);
  }
}
if (config.COPY_WALLETS.includes(config.PUBLIC_KEY)) {
  fail('COPY_WALLET is your own wallet — the bot would copy its own trades in a loop.');
}

if (config.ENABLE_TRAILING_STOP && !(config.TRAILING_STOP_DISTANCE > 0)) {
  fail('ENABLE_TRAILING_STOP=true requires TRAILING_STOP_DISTANCE greater than 0.');
}
if (config.MAX_BUY_AMOUNT > config.MAX_TOTAL_EXPOSURE) {
  console.warn(
    `[config] WARNING: MAX_BUY_AMOUNT (${config.MAX_BUY_AMOUNT}) is larger than MAX_TOTAL_EXPOSURE ` +
      `(${config.MAX_TOTAL_EXPOSURE}); single buys will effectively be capped at MAX_TOTAL_EXPOSURE.`
  );
}
if (config.JITO_TIP > 0.05) {
  console.warn(`[config] WARNING: JITO_TIP is ${config.JITO_TIP} SOL per transaction — that's unusually high.`);
}

// --- How transactions are sent (see src/heliusSender.js) ---
//   SEND_VIA="jito"   (default) - straight to the Jito block engine (JITO_ENGINE).
//   SEND_VIA="sender" - Helius Sender: Jito + staked validator connections at
//                       once. Needs a tip of SENDER_TIP and a priority fee.
config.SEND_VIA = (process.env.SEND_VIA || 'jito').toLowerCase();
if (!['jito', 'sender'].includes(config.SEND_VIA)) fail(`SEND_VIA must be "jito" or "sender" (got "${process.env.SEND_VIA}")`);
config.SENDER_ENDPOINT = process.env.SENDER_ENDPOINT || 'http://fra-sender.helius-rpc.com/fast';
if (!/^https?:\/\//.test(config.SENDER_ENDPOINT)) fail(`SENDER_ENDPOINT must be an http(s) URL (got "${config.SENDER_ENDPOINT}")`);
config.SENDER_SWQOS_ONLY = process.env.SENDER_SWQOS_ONLY === 'true';
// A BUY that Sender turns away with 429 is not sent again (it would land late); sells always are.
config.BUY_RETRY_ON_SENDER_429 = process.env.BUY_RETRY_ON_SENDER_429 === 'true';

// How a fast Pump.fun buy gets its token account. "ata" (default): the usual
// Associated Token Account, made by its program (about 17,000 compute units).
// "plain": made directly with the System and Token programs (about 2,500), at
// an address worked out from the coin's address. Same account type; more fee
// per compute unit at the same total fee. See src/plainAccount.js.
config.TOKEN_ACCOUNT_MODE = (process.env.TOKEN_ACCOUNT_MODE || 'ata').trim().toLowerCase();
// Length in bytes of a Token-2022 token account of these coins (normally learned
// from the wallet's own accounts; set it only if learning can't work). Plain mode only.
config.TOKEN_2022_ACCOUNT_BYTES = numEnv('TOKEN_2022_ACCOUNT_BYTES', { def: null, min: 165, max: 400, integer: true });
if (!['ata', 'plain'].includes(config.TOKEN_ACCOUNT_MODE)) {
  throw new Error(`TOKEN_ACCOUNT_MODE must be "ata" or "plain" (got "${process.env.TOKEN_ACCOUNT_MODE}")`);
}
config.SENDER_MEV_PROTECT = process.env.SENDER_MEV_PROTECT === 'true';
const senderMinTip = config.SENDER_SWQOS_ONLY ? 0.000005 : 0.001;
config.SENDER_TIP = numEnv('SENDER_TIP', { def: senderMinTip, min: 0 }); // SOL
if (config.SEND_VIA === 'sender' && config.SENDER_TIP < senderMinTip) {
  fail(
    `SENDER_TIP must be at least ${senderMinTip} SOL${config.SENDER_SWQOS_ONLY ? ' with SENDER_SWQOS_ONLY=true' : ''} ` +
      `(Helius Sender's minimum; got ${config.SENDER_TIP}).`
  );
}
// Sender tip for SELLS, if different (default: SENDER_TIP). Sells rarely race
// anyone, so a lower tip (Sender's minimum) saves SOL on every sell; or set it
// higher to leave a falling coin faster.
config.SELL_SENDER_TIP = numEnv('SELL_SENDER_TIP', { def: config.SENDER_TIP, min: 0 }); // SOL
if (config.SEND_VIA === 'sender' && config.SELL_SENDER_TIP < senderMinTip) {
  fail(`SELL_SENDER_TIP must be at least ${senderMinTip} SOL (Helius Sender's minimum; got ${config.SELL_SENDER_TIP}).`);
}
// Priority fee (SOL per transaction) on transactions the bot builds itself,
// and the floor for SolanaPortal-built ones sent via Sender. Sender requires
// one, so it defaults to 0.0001 SOL there; with Jito it defaults to none.
// Compute-unit budget of direct Pump.fun / PumpSwap trades. The priority fee
// (PRIORITY_FEE_SOL) is spread over this budget, so a budget close to what a
// trade really uses (the log reports it after each trade) means a higher
// price per unit, i.e. an earlier place in the block, for the same fee. Too
// low and the trade fails ("exceeded CUs meter").
config.PUMPFUN_COMPUTE_UNITS = numEnv('PUMPFUN_COMPUTE_UNITS', { def: 300_000, min: 60_000, max: 1_400_000, integer: true });
// Size each trade's compute-unit limit to what that kind of trade has been
// using (PUMPFUN_COMPUTE_UNITS is then the ceiling). "false" = always the full limit.
config.AUTO_COMPUTE_UNITS = (process.env.AUTO_COMPUTE_UNITS || '').trim() !== 'false';
// How far above the most a kind of trade has used its learned limit is set (see computeBudget.js).
config.COMPUTE_MARGIN_PCT = numEnv('COMPUTE_MARGIN_PCT', { def: 10, min: 0, max: 100 });
config.COMPUTE_MARGIN_UNITS = numEnv('COMPUTE_MARGIN_UNITS', { def: 3000, min: 0, max: 100_000, integer: true });
config.PRIORITY_FEE_SOL = numEnv('PRIORITY_FEE_SOL', { def: config.SEND_VIA === 'sender' ? 0.0001 : 0, min: 0 });
if (config.SEND_VIA === 'sender' && !(config.PRIORITY_FEE_SOL > 0)) {
  fail('SEND_VIA="sender" requires PRIORITY_FEE_SOL greater than 0 (Helius Sender rejects transactions without a priority fee).');
}
// Buys can pay a higher priority fee than sells: inside a block, the leader
// runs the transactions it has waiting in order of priority fee per compute
// unit, so a copy buy competing with snipers for the same coin needs a high
// one, while a sell rarely does. BUY_PRIORITY_FEE_SOL is the fee for buys
// (default: PRIORITY_FEE_SOL); BUY_PRIORITY_FEE_PCT, if set, raises it to
// that % of the buy amount when that is more (e.g. "3": 0.03 SOL on a 1 SOL
// buy, the fixed fee on small test buys). Paid even when the slot guard
// cancels the buy.
config.BUY_PRIORITY_FEE_SOL = numEnv('BUY_PRIORITY_FEE_SOL', { def: config.PRIORITY_FEE_SOL, min: 0 });
config.BUY_PRIORITY_FEE_PCT = numEnv('BUY_PRIORITY_FEE_PCT', { def: null, min: 0, max: 50 });
if (config.SEND_VIA === 'sender' && !(config.BUY_PRIORITY_FEE_SOL > 0)) {
  fail('SEND_VIA="sender" requires BUY_PRIORITY_FEE_SOL greater than 0 (Helius Sender rejects transactions without a priority fee).');
}
if (config.BUY_PRIORITY_FEE_SOL > 0.5) {
  console.warn(`[config] WARNING: BUY_PRIORITY_FEE_SOL=${config.BUY_PRIORITY_FEE_SOL} SOL per buy — that's very high (it is paid even when a buy is cancelled).`);
}
if (config.PRIORITY_FEE_SOL > 0.01 || config.SENDER_TIP > 0.05 || config.SELL_SENDER_TIP > 0.05) {
  console.warn(
    `[config] WARNING: PRIORITY_FEE_SOL=${config.PRIORITY_FEE_SOL} / SENDER_TIP=${config.SENDER_TIP} SOL per transaction — that's unusually high.`
  );
}

// Websocket RPC URL for the trade-detection feed (src/websocket.js). Set
// SOLANA_WS explicitly if your provider uses a different host/path for
// websockets than for HTTP; otherwise it's derived automatically from
// SOLANA_RPC.
config.SOLANA_WS = process.env.SOLANA_WS || deriveWsUrl(config.SOLANA_RPC);

// BLOCKED_CREATORS: wallets whose coins are never bought (comma- or
// space-separated addresses). Checked against the coin's creator, which the
// direct builder reads anyway.
{
  const list = (process.env.BLOCKED_CREATORS || '').split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean);
  for (const a of list) {
    try {
      new PublicKey(a);
    } catch {
      fail(`BLOCKED_CREATORS: "${a}" is not a valid Solana address`);
    }
  }
  config.BLOCKED_CREATORS = new Set(list);
}
for (const a of config.SHRED_EXCLUDE_ACCOUNTS) {
  try {
    new PublicKey(a);
  } catch {
    fail(`SHRED_EXCLUDE_ACCOUNTS: "${a}" is not a valid Solana address`);
  }
  if (config.COPY_WALLETS.includes(a)) fail('SHRED_EXCLUDE_ACCOUNTS must not contain a COPY_WALLET (nothing would arrive)');
}
for (const q of config.QUOTE_TOKENS) {
  try {
    new PublicKey(q);
  } catch {
    fail(`QUOTE_TOKENS: "${q}" is not a valid token address`);
  }
  if (q === 'So11111111111111111111111111111111111111112') fail('QUOTE_TOKENS: SOL coins are bought normally; list only other tokens (e.g. the PUMP token)');
}
if (config.QUOTE_TOKENS.length && !config.JUPITER_API_KEY) {
  console.warn('[config] WARNING: QUOTE_TOKENS needs JUPITER_API_KEY to price the tokens and top up their reserves; without it, coins paired to them are skipped.');
}

// Settings that only work through the direct Pump.fun builder: without it
// every buy would be skipped (or the setting does nothing).
if (!config.DIRECT_PUMPFUN_SWAP) {
  const needs = [];
  if (config.MIN_MARKET_CAP_SOL !== null || config.MAX_MARKET_CAP_SOL !== null) needs.push('MIN/MAX_MARKET_CAP_SOL (every buy would be skipped: the market cap is read by the direct builder)');
  if (config.MAX_SLOTS_BEHIND !== null) needs.push('MAX_SLOTS_BEHIND (every buy would be skipped: the slot guard goes into direct builds)');
  if (config.SHRED_FAST_BUY) needs.push('SHRED_FAST_BUY (has no effect)');
  if (config.QUOTE_TOKENS.length) needs.push('QUOTE_TOKENS (has no effect)');
  if (needs.length) {
    console.warn(`[config] WARNING: DIRECT_PUMPFUN_SWAP is off, but these need it: ${needs.join("; ")}. Set DIRECT_PUMPFUN_SWAP="true".`);
  }
}

if ((process.env.INSTANT_SELL || '').trim() && !['true', 'false'].includes(process.env.INSTANT_SELL.trim())) {
  fail(`INSTANT_SELL must be "true" or "false" (got "${process.env.INSTANT_SELL}")`);
}
if (config.INSTANT_SELL && config.SELL_AFTER_SECONDS > 0) {
  console.warn('[config] WARNING: INSTANT_SELL is on, so SELL_AFTER_SECONDS is ignored (every position is sold as soon as its buy lands).');
}
if (!config.INSTANT_SELL && config.INSTANT_SELL_DELAY_MS > 0) {
  console.warn('[config] WARNING: INSTANT_SELL_DELAY_MS does nothing while INSTANT_SELL is off.');
}

if (config.LEADER_MAX_KM !== null && !config.LEADER_INFO) {
  fail('LEADER_MAX_KM needs the leader locations: remove LEADER_INFO="false".');
}
const leaderInfoVal = (process.env.LEADER_INFO || '').trim();
if (leaderInfoVal && !['true', 'false'].includes(leaderInfoVal)) fail(`LEADER_INFO must be "true" or "false" (got "${process.env.LEADER_INFO}")`);

if (config.SHRED_FAST_BUY && config.MAX_MARKET_CAP_SOL === null) {
  fail('SHRED_FAST_BUY="true" needs MAX_MARKET_CAP_SOL: without a lookup it is the only price limit the buy has (checked on-chain).');
}
if (config.MIN_MARKET_CAP_SOL !== null && config.MAX_MARKET_CAP_SOL !== null && config.MIN_MARKET_CAP_SOL >= config.MAX_MARKET_CAP_SOL) {
  fail(`MIN_MARKET_CAP_SOL (${config.MIN_MARKET_CAP_SOL}) must be below MAX_MARKET_CAP_SOL (${config.MAX_MARKET_CAP_SOL})`);
}

// TIERED / STIERED modes: buy size scales with how much SOL the copied
// wallet spent. Requires TIER_BUY_CONFIG, a JSON array of { maxSol, buyAmount }
// tiers — see .env.example for the format and worked example. STIERED
// additionally mirrors the copied wallet's *sells* proportionally (see
// index.js) instead of using TAKE_PROFIT/STOP_LOSS to exit.
if (config.TRADE_TYPE === 'TIERED' || config.TRADE_TYPE === 'STIERED') {
  const rawTierConfig = requiredEnv('TIER_BUY_CONFIG');
  try {
    config.TIER_BUY_CONFIG = parseTierConfig(rawTierConfig);
  } catch (err) {
    fail(err.message);
  }
}

// Shred source(s): "jito-grpc" (decoded shreds over gRPC at SHRED_STREAM_URL;
// the default when only SHRED_STREAM_URL is set), "helius-preprocessed"
// (Helius preprocessedSubscribe: decoded shreds over a websocket, filtered to
// the copy wallet by Helius; any paid Helius plan) or "shreder" (Shreder's
// decoded shreds over gRPC at SHREDER_URL, filtered to the copy wallets by
// Shreder). Several, comma-separated (e.g. "shreder,helius-preprocessed"),
// run side by side: whichever reports a trade first is used, and the
// [Race] lines say which was faster and by how much. Unset = no shred feed.
{
  const SOURCES = ['jito-grpc', 'helius-preprocessed', 'shreder'];
  const raw = (process.env.SHRED_SOURCE || '').trim().toLowerCase();
  let list = raw ? raw.split(/[\s,;+]+/).filter(Boolean) : config.SHRED_STREAM_URL ? ['jito-grpc'] : [];
  list = [...new Set(list)];
  for (const src of list) {
    if (!SOURCES.includes(src)) {
      fail(`SHRED_SOURCE must be "jito-grpc", "helius-preprocessed" or "shreder", or several of them comma-separated (got "${process.env.SHRED_SOURCE}")`);
    }
  }
  if (list.includes('jito-grpc') && !config.SHRED_STREAM_URL) {
    fail('SHRED_SOURCE="jito-grpc" needs SHRED_STREAM_URL (the provider\'s gRPC address).');
  }
  if (list.includes('jito-grpc') && list.includes('helius-preprocessed')) {
    fail('SHRED_SOURCE: "jito-grpc" and "helius-preprocessed" can\'t run together (both use SHRED_STREAM_URL).');
  }
  if (list.includes('helius-preprocessed') && !config.SHRED_STREAM_TOKEN && !config.SHRED_STREAM_URL) {
    let key = null;
    try {
      const u = new URL(config.SOLANA_RPC);
      if (/helius/i.test(u.hostname)) key = u.searchParams.get('api-key');
    } catch {}
    if (!key) {
      fail('SHRED_SOURCE="helius-preprocessed" needs a Helius API key: use a Helius SOLANA_RPC, or set SHRED_STREAM_TOKEN to the key.');
    }
  }
  if (list.includes('shreder')) {
    if (!config.SHREDER_URL) {
      fail('SHRED_SOURCE="shreder" needs SHREDER_URL, the address Shreder gave you (e.g. http://fra1.shreder.xyz:9991).');
    }
    if (!/^(?:(https?|grpcs?):\/\/)?([^/:\s]+)(?::(\d+))?\/?$/.test(config.SHREDER_URL)) {
      fail(`SHREDER_URL "${config.SHREDER_URL}" isn't a valid address (expected e.g. http://fra1.shreder.xyz:9991)`);
    }
  } else if (config.SHREDER_URL) {
    console.warn('[config] WARNING: SHREDER_URL is set but SHRED_SOURCE doesn\'t include "shreder", so it is not used.');
  }
  config.SHRED_SOURCES = list;
  config.SHRED_SOURCE = list.join(',');
}

if (config.FAST_PATH && config.FAST_PATH !== 'rust') fail(`FAST_PATH must be "rust" or empty (got "${process.env.FAST_PATH}")`);
if (config.FAST_PATH === 'rust') {
  if (!config.SHRED_SOURCES.some((x) => x === 'shreder' || x === 'helius-preprocessed')) {
    fail('FAST_PATH="rust" needs SHRED_SOURCE to include "shreder" and/or "helius-preprocessed" (the feeds the fast path reads).');
  }
  if (!config.SHRED_FAST_BUY || !config.DIRECT_PUMPFUN_SWAP) {
    console.warn('[config] WARNING: FAST_PATH="rust" only buys with SHRED_FAST_BUY="true" and DIRECT_PUMPFUN_SWAP="true"; until then it only reads the feeds.');
  }
}

config.ENV_FILE = ENV_FILE;

module.exports = config;
