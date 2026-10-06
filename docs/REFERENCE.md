# Reference: every setting and feature

The full guide to the bot's settings and behaviour. For an overview and quick start, see the [README](../README.md); for the settings file itself, [`.env.example`](../.env.example).

---

## Table of Contents

1. [Overview](#overview)  
2. [Features](#features)  
3. [Prerequisites](#prerequisites)  
4. [Installation](#installation)  
5. [Configuration](#configuration)  
6. [Project Structure](#project-structure)  
7. [Usage](#usage)  
8. [Environment Variables Reference](#environment-variables-reference)  
9. [RPC Failover](#rpc-failover)  
10. [Graceful Shutdown](#graceful-shutdown)  
11. [Telegram Control Bot](#telegram-control-bot)  
12. [PnL Reporting](#pnl-reporting)  
13. [License](#license)  

---

## Overview

This bot connects directly to your Solana RPC provider's websocket endpoint (`logsSubscribe`, filtered to the copy wallet) to detect trades, and classifies each transaction itself from its on-chain balance changes — no third-party indexer or API key required for trade detection. It mirrors each buy/sell by submitting transactions via Jito. It tracks open positions in a local JSON database and can operate in either "COPY" or "SELLING" mode. Price checks for Take-Profit/Stop-Loss (used by `SAFE` and `TIERED` modes) come from DexScreener's free public API. Neither of these pieces depends on CoinVera anymore.

---

## Features

- **DEX Coverage:** Pump.fun, Pump.fun AMM, Raydium, Meteora, Moonshot, Orca, Jupiter, and more.  
- **Jito Execution:** Fast, low-latency transaction submission.  
- **Trade Detection:** Direct Solana RPC websocket subscription (`logsSubscribe`) to the copy wallet — classifies buys/sells from on-chain balance changes, no third-party indexer needed.  
- **Trade Modes:**  
  - **EXACT:** Mirror exact SOL spent. Exits by mirroring the copied wallet's sell — any sell by them dumps 100% of our position, regardless of how much of their own stack they sold.  
  - **SAFE:** Use fixed BUY_AMOUNT with Stop-Loss/Take-Profit. The copied wallet's sells are ignored — exit is entirely our own TP/SL (and trailing stop, if enabled).  
  - **TIERED:** Scale your BUY_AMOUNT based on how much SOL the copied wallet spent (e.g. buy 0.05 SOL if they buy <0.5 SOL, 0.15 SOL if 0.5-2 SOL, 0.3 SOL if >2 SOL), with Stop-Loss/Take-Profit like SAFE. The copied wallet's sells are ignored here too.  
  - **STIERED:** Same tiered buy sizing as TIERED, but exits by mirroring the copied wallet's sell *proportionally* instead of using TP/SL: if they sell 100% of their stack we close fully, if they sell 40% of their stack we sell 40% of ours and keep the rest open. TAKE_PROFIT/STOP_LOSS are not used in this mode.  
  - For EXACT and STIERED, the copy wallet **moving tokens out without selling** also counts as an exit: sending them to another wallet, burning them, or swapping them into another token. It's mirrored like a sell of the same percentage. Controlled by `MIRROR_TRANSFERS` (default on).  
- **Multi-Buy Toggle:** Enable/disable multiple buys per mint (when enabled, later buys are added to the same position).  
- **Safe exits:** A position is only marked closed once its sell has *confirmed on-chain*. Failed or unconfirmed sells are retried and the position stays open meanwhile, so a failed sell can't leave tokens in your wallet that the bot has forgotten.  
- **Risk caps:** `MAX_BUY_AMOUNT` per trade, `MAX_TOTAL_EXPOSURE` across all open positions, and `MAX_OPEN_POSITIONS` (default 2) open at once, all including buys still in flight; `BUY_COOLDOWN_SEC` (default 5) skips a buy that comes within seconds of the last one sent.  
- **Several copy wallets:** `COPY_WALLET="A,B"` copies each of them; every position follows the sells of the wallet whose buy opened it.  
- **Position Tracking:** Persistent JSON storage for open/closed positions.  
- **Price Monitoring:** Polls the [DexScreener](https://dexscreener.com) public API (free, no API key) for TP/SL checks and Telegram's position list. Covers Pump.fun (bonding-curve and post-graduation PumpSwap pairs) and Raydium (AMM v4/CPMM/CLMM). All open positions are priced in **one batched request per tick** (up to 30 tokens per request), so holding more positions doesn't multiply calls toward DexScreener's rate limit.  
- **Trailing Stop Loss:** Dynamic stop loss that follows price movements upward, locking in profits while allowing for maximum upside.  
- **Emergency SELL:** Liquidate all positions on startup if desired.  
- **Accurate Balances & PnL:** Token amounts and SOL cost/proceeds are read from each of your own transactions and handled as exact integers. No float rounding, and PnL is realized from real SOL in and out.  
- **User-Friendly Logs:** Clear, timestamped console output.  

---

## Prerequisites

- **Node.js** (v18.17+; v20 or v22 LTS recommended), **npm**  
- Solana wallet private key (Base58) with sufficient SOL  
- A Solana RPC endpoint whose plan supports websocket subscriptions (`logsSubscribe`) — most paid providers (Helius, QuickNode, Triton, etc.) support this; some free/public endpoints throttle or disable it, which will show up as the bot failing to receive trade notifications  
- Copy wallet public address whose trades will be mirrored  

---

## Installation

See [Quick start](../README.md#quick-start) in the README.

---

## Configuration

Rename `.env.example` to `.env` and configure variables (or keep them in `copybot.env` next to the bot folder; see **Updating** below):

- **SOLANA_RPC**: Solana RPC URL (e.g. Jito RPC or mainnet-beta).  
- **SOLANA_WS**: Optional — websocket RPC URL for trade detection. Auto-derived from `SOLANA_RPC` (scheme swapped to `wss://`/`ws://`) if not set; only needed if your provider uses a different host/path for websockets.  
- **SOLANA_RPC_FALLBACKS**: Optional — comma-separated additional RPC URLs for automatic failover if `SOLANA_RPC` starts erroring. See [RPC Failover](#rpc-failover).  
- **PRIVATE_KEY**: Base58 private key for signing.  
- **PUBLIC_KEY**: Your wallet address, i.e. the public key of `PRIVATE_KEY`. The bot checks the two match at startup and refuses to run if they don't.  
- **BOT_MODE**: `COPY` or `SELLING`.  
- **COPY_WALLET**: Wallet address to mirror.  
- **MAX_BUY_AMOUNT** / **MAX_TOTAL_EXPOSURE**: Hard risk caps that apply no matter what `TRADE_TYPE` computed — a per-trade ceiling (default `11` SOL, clamps the buy down) and a total-exposure ceiling (default `15` SOL) counting the remaining cost of open positions *plus buys still in flight*. A buy is clamped to the remaining room, or skipped if less than `MIN_TRADE_SOL` is left.  
- **TRADE_TYPE**: `EXACT`, `SAFE`, `TIERED`, or `STIERED`.  
- **BUY_AMOUNT**: Only for `SAFE`.  
- **TAKE_PROFIT**, **STOP_LOSS**: For `SAFE` or `TIERED` (not used by `STIERED`, which exits by mirroring the copied wallet's sells instead).  
- **TIER_BUY_CONFIG**: For `TIERED` or `STIERED` — JSON array of `{ maxSol, buyAmount }` tiers controlling how much SOL you spend depending on the copied wallet's buy size. See `.env.example` for the format and a worked example.  
- **TELEGRAM_BOT_TOKEN**, **TELEGRAM_CHAT_ID**: Optional — enables a Telegram bot for viewing/selling positions and PnL notifications. See [Telegram Control Bot](#telegram-control-bot).  
- **ENABLE_MULTI_BUY**: `true` adds repeat buys of the same token to the existing position; `false` ignores them.  
- **DETECTION_COMMITMENT**: `confirmed` (default) or `processed`. `processed` acts on the copy wallet's trades about 0.5–1s sooner. Pump.fun bonding-curve trades are read straight from the live notification; other DEXes and transfers still wait for confirmation. The trade-off: very occasionally a processed transaction is dropped and never confirms, so you'd copy a trade that didn't happen.  
- **SKIP_REBUYS**: `off` (default), `full` or `any`. With `full`, once the copy wallet has sold or moved out its whole bag of a coin, its later buys of that coin are ignored. `any` does the same after any sell, even a partial one. Exited coins are remembered across restarts, in `data/exited-mints.txt`.  
- **MIRROR_TRANSFERS**: `true` (default) treats the copy wallet moving a token out without selling (sent elsewhere, burned, swapped into another token) as an exit for EXACT/STIERED positions; `false` mirrors only real sells.  
- **CONFIRM_TIMEOUT_SEC**, **SELL_MAX_ATTEMPTS**, **SELL_RETRY_DELAY_MS**, **SELL_RETRY_COOLDOWN_MS**: Optional advanced settings for confirmation waits and sell retries. The defaults are sensible; see `.env.example`.  
- **SLIPPAGE**, **JITO_TIP**, **JITO_ENGINE**: Execution parameters.  
- **PRICE_CHECK_DELAY**: How often (ms) to poll DexScreener for TP/SL checks.  
- **ENABLE_TRAILING_STOP**, **TRAILING_STOP_DISTANCE**, **TRAILING_STOP_ACTIVATION**: Trailing stop loss configuration.  
- **DIRECT_PUMPFUN_SWAP**: `true`/`false` (default `false`, beta). When enabled, buys/sells on Pump.fun bonding-curve coins are built and signed directly on-chain via Pump.fun's own SDK instead of calling SolanaPortal's API — one fewer network hop. Automatically falls back to SolanaPortal for anything outside its scope (already-migrated curves, Token-2022 "v2" coins, non-SOL-quoted coins) or if the direct build fails for any reason, so enabling it never breaks trading. See [How Direct Pump.fun Swaps Work](#how-direct-pumpfun-swaps-work).  
- **DIRECT_RAYDIUM_SWAP**: `true`/`false` (default `false`, beta). Same idea, for Raydium Standard (AMM v4/CPMM) SOL-paired pools, via Raydium's own SDK. Falls back to SolanaPortal for CLMM-only tokens or any build error. See [How Direct Raydium Swaps Work](#how-direct-raydium-swaps-work).  

No CoinVera API key is required anywhere in this bot anymore.

## How Direct Pump.fun Swaps Work

By default, every buy/sell (whatever the DEX) is built by calling SolanaPortal's trading API, which returns a ready-to-sign transaction — simple and DEX-agnostic, but it costs an extra network round-trip before the bot can sign and submit.

With `DIRECT_PUMPFUN_SWAP=true`, a Pump.fun bonding-curve trade instead:
1. Fetches the coin's on-chain `Global` and `BondingCurve` state directly.
2. Builds the `buy`/`sell` instruction using Pump.fun's own official SDK (`@pump-fun/pump-sdk`), which derives all the program's PDAs and fee accounts for you — nothing here is hand-assembled instruction bytes.
3. Adds a Jito tip transfer instruction to one of Jito's official tip accounts (SolanaPortal did this for you before; a self-built transaction needs it added explicitly, or `JITO_TIP` would silently do nothing).
4. Signs and submits via the same Jito path as every other trade.

**Scope & fallback:** this covers SOL-paired bonding-curve coins on either token program: classic SPL Token or Token-2022 (newer Pump.fun coins are Token-2022; the bot reads which one a coin uses, in parallel with another lookup so it adds no time). Non-SOL-quoted coins, or a coin whose curve has already migrated to PumpSwap, are detected and skipped. Any of those cases, or any error while building the direct transaction, makes the bot log a warning and fall straight back to SolanaPortal for that trade.

**Which route a trade took** is always in the log line that sends it:
- `BUY txn sent via Pump.fun direct (built by the bot)` / `via Raydium direct`
- `BUY txn sent via SolanaPortal`
- `BUY txn sent via Jupiter backup (route: Meteora DLMM)`

If a Pump.fun or Raydium trade could have been built directly but the setting is off, the log says so (`DIRECT_PUMPFUN_SWAP is off, so this Pump.fun buy goes through SolanaPortal`).

**Faster during outages:** after SolanaPortal's *server* fails (5xx, Cloudflare 52x, unreachable), the bot skips it for 2 minutes and builds with Jupiter straight away instead of waiting for it to fail again. A coin a direct builder can't handle (e.g. no standard Raydium pool) isn't retried with that builder for 10 minutes.

**Only the copy wallet's first buy (`ONLY_COPY_FIRST_BUY`, default on):** if it already held a coin when it buys more (you started the bot mid-trade, or your first copy failed), that buy is skipped. The bot knows from the copy wallet's own transaction (its balance just before), or, for Pump.fun buys read straight from processed logs, from one snapshot of its coins taken at startup and kept current from its trades. No call is added to the buy path. A full exit by the copy wallet resets it for that coin.

**Don't buy into the copy-bot rush (`MAX_ENTRY_PREMIUM_PCT`, default off):** popular wallets are copied by many bots, and the fastest push the price up within the same second. With e.g. `MAX_ENTRY_PREMIUM_PCT="30"`, a copy buy is skipped (nothing is sent; Telegram tells you) when our expected price per token is more than 30% above what the copy wallet paid. The check uses the quote the direct builder already computes, so it costs no time or calls. Pump.fun curve, PumpSwap and Raydium AMM/CPMM/CLMM buys are checked; LaunchLab, SolanaPortal and Jupiter buys, and buys where the copy wallet's price isn't known, go ahead without the check (the log says so).

**Instant buy filters (default off).** These skip a copy buy without costing any time: they use what the direct builder already knows about the coin while it builds the transaction (its curve or pool, and its creator). Nothing is sent for a skipped coin, and Telegram tells you why.
- `MIN_MARKET_CAP_SOL` / `MAX_MARKET_CAP_SOL`: the coin's market cap in SOL just before our buy. On the websocket feed that is right after the copy wallet's own buy. For scale, a Pump.fun coin launches at about 28 SOL and graduates at about 410 SOL. With either set, a coin whose market cap can't be read instantly is skipped (buys with no direct build: Raydium LaunchLab, SolanaPortal, Jupiter).
- `MIN_COPY_BUY_SOL`: ignore the copy wallet's buys smaller than this, e.g. its test buys.
- `BLOCKED_CREATORS`: never buy coins made by these wallets (comma-separated).

**Land in his block or not at all (`MAX_SLOTS_BEHIND`, default off).** With e.g. `MAX_SLOTS_BEHIND="0"`, every buy carries a slot guard: an instruction for [Lighthouse](https://www.quicknode.com/guides/solana-development/tooling/web3-2/lighthouse), a public on-chain assertion program, that says "the current slot must be at most his slot + N". If our buy lands later, that instruction fails and Solana undoes the whole transaction (the swap, the token-account creation and the tip), so nothing is bought and only the network fee is paid. A buy that is already clearly too late before sending isn't sent at all. The log says `cancelled: it would have landed after slot …` rather than reporting a failure. Pump.fun curve and PumpSwap buys only; other buys are skipped while it's on. At startup the bot checks that the Lighthouse program exists; if it doesn't, the guard turns off and Telegram says so. It needs shreds to be useful at 0 or 1: the websocket feed reports his buy after his block has ended, so nearly every buy would be cancelled.

**Where the slot leader is (`LEADER_INFO`, on; `LEADER_MAX_KM`, off).** Each slot is produced by a validator known in advance, and how close it is to this server decides much of the race to his block: a transaction can't reach a leader in Tokyo from Frankfurt in time, whatever it pays. The bot reads the public leader schedule and validators' addresses, places them on a map (ip-api.com, cached a week in `data/leader-locations.json`), and adds the leader's city and distance to each shred buy's `[Timing]` line, with the same-block rate split by distance (≤100 km, 100–1,500 km, >1,500 km). With `LEADER_MAX_KM` set (e.g. `100` for Frankfurt only, `400` to include Amsterdam), a buy is skipped, sending nothing, when the leader of every slot it could land in (his, plus `MAX_SLOTS_BEHIND`) is further away. Unknown locations never cause a skip. `LEADER_HOME="lat,lon"` sets this server's location instead of looking it up. Locations come from IP addresses, so they're approximate.

**Past buys by slot leader (`npm run leaders`).** Without any logs: reads your wallet's last 300 transactions from your RPC (`-- --limit 1000` for more), matches each buy to the copy wallet's buy of the same coin just before it (from its own transactions), looks up who led his slot (the block's fee reward) and where that validator is, then lists each buy (in his block / late / cancelled by the slot guard) with the leader's city and distance, and the in-block rate by distance and by city. Uses `PUBLIC_KEY` and `COPY_WALLET` from `.env`, or `-- --wallet <yours> --copy <his>[,<his2>]`. Run it while the bot is stopped or quiet if you're close to your RPC's rate limit. It also pings each leader from the server it runs on (the fastest of 3 replies; many validators don't answer ping) and adds the in-block rate by ping time; `-- --no-ping` skips that. To check particular validators instead: `npm run leaders -- --ping <address>[,<address2>]` (identity or vote account addresses, or IPs) prints each one's location, IP and ping.

The startup line lists the filters that are on (`buy filters=…`). With shreds, the market cap is read when the bot builds, which can be just before the copy wallet's own buy lands.

**Quick flip (`SELL_AFTER_SECONDS`, default off):** with e.g. `SELL_AFTER_SECONDS="5"`, each new position is sold in full 5 seconds after our buy confirms, whatever the copy wallet does. Copy-sells that arrive earlier still apply. A failed timed sell is retried like a copy-sell, also after a restart; positions you mark "Keep" in Telegram are left alone. Added buys (`ENABLE_MULTI_BUY`) don't reset the timer.

**Instant sell (`INSTANT_SELL`, default off):** with `INSTANT_SELL="true"`, every new position is sold in full the moment our buy lands, to catch the first one or two 1-second candles. When the buy is sent, the bot subscribes to its token account, so the RPC pushes the new balance the moment the block with our buy has run and the sell goes out at once with that amount; as a backup it checks the buy's status every 50 ms and, as soon as it shows as executed ("processed": in a block, not yet confirmed, usually several hundred ms earlier), reads the tokens from that block and sends the sell, typically landing 2-4 slots (~1-1.5 s) after the buy. The position is recorded as usual meanwhile and closed by that sell; if it fails, the bot sells again the normal way. `INSTANT_SELL_DELAY_MS` (default 0) waits that long after the buy lands first (e.g. 1000 to aim for the second candle). `SELL_AFTER_SECONDS` is ignored while it's on. Rarely, a buy seen "processed" is dropped by the network: the sell then fails, costing only its network and priority fee. Each round trip pays two sets of fees and tips, so it suits larger buys. On Pump.fun the sell is prepared while the buy is still on its way, from the coin state read when the buy went out, so building it takes about 2 ms instead of ~38 ms. If Sender answers "rate limited", the sell is also sent through the normal RPC at once instead of waiting. A failed or partly filled sell is not sent again until its blockhash has expired (`SELL_EXPIRY_MS`, default 90000), so a late-landing first attempt can't be followed by a second one.

**Full exit on the first copy sell:** with `FULL_EXIT_ON_COPY_SELL="true"` (STIERED), the copy wallet's first sell or transfer out of a coin makes the bot sell 100% of its position, instead of mirroring each partial sell.

## Jupiter backup route (JUPITER_FALLBACK)

When SolanaPortal can't build a trade (its server is down, it times out, or it refuses), the bot asks Jupiter's Swap API (`/swap/v2/build`) for the swap instead. Jupiter routes through almost every venue (Meteora, Orca, PumpSwap, Raydium, Pump.fun...), so this also covers coins the direct builders don't. The bot assembles Jupiter's instructions into its own transaction, with your tip and priority fee, and sends it via Jito or Sender like every other trade. It only ever replaces the *building* step: when SolanaPortal fails nothing has been signed or sent, so there's no risk of a double buy or sell.

Jupiter needs a free API key: create one at https://developers.jup.ag/portal and set `JUPITER_API_KEY`. **Off by default**; `JUPITER_FALLBACK="true"` turns it on. `USE_SOLANAPORTAL="false"` stops the bot contacting SolanaPortal at all. Both settings also accept `"sells"` (or `"buys"`): e.g. `USE_SOLANAPORTAL="sells"` and `JUPITER_FALLBACK="sells"` means buys only happen through the fast direct builders, while exits can always fall back to SolanaPortal and then Jupiter. If neither may build sells, the bot warns at startup: a coin that stops qualifying for a direct build while you hold it can then only be sold from a wallet app.

### PumpSwap (graduated Pump.fun coins)

`DIRECT_PUMPFUN_SWAP=true` also covers **PumpSwap**, Pump.fun's own AMM where a coin trades once its bonding curve completes. It uses Pump.fun's official `@pump-fun/pump-swap-sdk` on the coin's canonical SOL pool. The log shows `via PumpSwap direct` or `via Pump.fun curve direct`.

**Which builder:** the copy wallet's own transaction names the program it traded on (`Pump.fun` = curve, `Pump.fun Amm` = PumpSwap, `Raydium Launchpad` / `Clmm` / `Cpmm` ...), and the bot goes straight to the matching builder. The pool type is stored with the position, so sells do the same. If a coin's curve completes while you hold it, the curve builder reports it and the bot switches to PumpSwap for that coin from then on.

## Pre-warmed builds (PREWARM, default on)

A direct buy used to wait on three network round trips one after another: Pump.fun's global config (plus the coin's mint account), then the coin's curve and your token account, then a recent blockhash. With `PREWARM` on, the blockhash (refreshed every 20 s) and Pump.fun's config (every 60 s) are kept fetched in the background. The curve, your token account and, for a coin not seen before, its mint account come back together in **one** call. So a direct Pump.fun buy or sell now waits on a single round trip. Compare the `built by the bot in …ms` part of the log line before and after.

The background refreshes use about 3 RPC calls a minute (~6k Helius credits a day) at low priority, so they never delay a trade. Pump.fun's fee schedule is re-read every 5 minutes too, so a trade never waits on it. If they fail, trades simply fetch what they need themselves. PumpSwap trades save the blockhash round trip too; Raydium builds are unchanged. `PREWARM="false"` turns it off.

### No-lookup Pump.fun buys (processed feed)

With `DETECTION_COMMITMENT="processed"`, the bot reads the copy wallet's Pump.fun buy straight from its log lines. Pump.fun's trade record in those logs also says where the coin's curve stands **after** his buy (its reserves), the coin's creator, whether it is a mayhem-mode coin, and which token program moved his tokens. That is everything a buy needs. So, with the pre-warmed blockhash, config and fee schedule, the bot builds its buy with **no network calls at all**: the build takes a few milliseconds instead of one round trip. Your token account is created in the same transaction if you don't have one yet (an "idempotent" create, which does nothing if it already exists). As a bonus, the price already includes his buy, so the `MAX_ENTRY_PREMIUM_PCT` check is more accurate.

The log line says so: `BUY txn sent via Pump.fun curve direct (built by the bot in 15ms, from the copy wallet's trade record, no lookups)`.

With nothing left to wait for, what remains is the bot's own CPU time, which matters on a 1-vCPU server. Two things keep it low. Pump.fun's SDK is set up once, not for every trade: setting it up took 20–30 ms each time. And `PREWARM` runs a **practice build** (built and signed with a throwaway key, never sent) a few times at startup and then every 30 seconds. That keeps the buy code compiled and fast between trades, since Node drops compiled code that sits unused. The `[Prewarm] Ready` line shows how long a practice build takes on your server; a real buy takes about the same.

The bot looks the coin up as before (one call) when:
- his trade record is more than 3 seconds old by the time the buy is built;
- the token program isn't clear from his transaction;
- it's a mayhem-mode coin the bot hasn't seen before (its supply sets the fee tier);
- the coin isn't priced in SOL.

A log line gives the reason each time. Sells, buys detected by the shred stream (they arrive before his transaction has run, so there is no trade record yet), and buys found by the confirmed path always look the coin up. Nothing to switch on: it follows `DETECTION_COMMITMENT="processed"` and `DIRECT_PUMPFUN_SWAP`.

**Slots behind.** The "landed N slots behind the copy wallet" figure now uses the slot his transaction actually landed in. The bot looks his signature up in the same call that confirms yours, so this costs nothing extra. Previously it used the slot the websocket notification came with, which can be later than his real slot. If the two differ, the log line says so.

## How Direct Raydium Swaps Work

With `DIRECT_RAYDIUM_SWAP=true`, a Raydium trade (AMM, CPMM, CLMM or LaunchLab) instead:
1. In one round trip, checks on-chain whether the coin is still on a **LaunchLab** bonding curve paired with SOL, and asks Raydium's API for every SOL pool for the coin (standard AMM v4 / AMM Stable / CPMM, and **CLMM** concentrated-liquidity pools).
2. Picks the pool: a LaunchLab curve that is still trading wins (that's where the coin trades until it graduates); otherwise the SOL pool with the most liquidity.
3. Builds the swap with Raydium's own SDK (`@raydium-io/raydium-sdk-v2`): `launchpad.buyToken/sellToken`, `clmm.swap` (quoted from the pool's live tick data), `liquidity.swap` or `cpmm.swap`, including the Jito tip.
4. Signs and submits via the same Jito/Sender path as every other trade. The log says which pool type it used, e.g. `BUY txn sent via Raydium LaunchLab direct`.

**Scope & fallback:** only SOL-paired pools. A coin priced in another token (e.g. USD1-quoted LaunchLab coins), or a brand-new pool Raydium's API doesn't list yet, logs the reason and goes to SolanaPortal / Jupiter (if switched on for that side) for that trade. A coin that can't be built directly isn't retried with the direct builder for 10 minutes.

**Beta status:** same caveat as Pump.fun — verified against the SDK's real, installed type definitions and Raydium's own official demo code, but not exercised against a live mainnet execution from where it was built. Test with a small `BUY_AMOUNT` first.

### How Trade Detection Works

`src/websocket.js` opens a raw websocket connection to `SOLANA_WS` and sends a standard [`logsSubscribe`](https://solana.com/docs/rpc/websocket/logssubscribe) JSON-RPC request filtered to `{"mentions": [COPY_WALLET]}`, so the RPC node only pushes notifications for transactions that touch the copy wallet. Each notification carries just a signature; the bot then calls `getParsedTransaction` on it and hands the result to `src/txParser.js`, which:

1. Reads the copy wallet's net SOL balance change (adjusted for the network fee) and net SPL token balance change (ignoring wrapped SOL) to determine whether it was a **buy** (SOL decreased, a token balance increased) or a **sell** (SOL increased, a token balance decreased), and by how much.
2. Identifies which DEX program executed the swap by scanning the transaction's instructions (including inner instructions, for swaps routed through Jupiter) against a table of known program IDs — currently Pump.fun, PumpSwap, Raydium (AMM v4/CPMM/CLMM/Launchpad), Orca Whirlpool, Meteora DLMM, and Jupiter itself as a fallback.

This means detection works for *any* DEX — an unrecognized program still gets a correct buy/sell/amount classification, it just falls back to a generic `Jupiter` label for routing (which `dexMapper.js` already normalizes to `jupiter`). If you add support for a new DEX, add its program ID to `DEX_PROGRAM_LABELS` in `src/txParser.js`.

**Note:** Program IDs occasionally change when a protocol deploys a new version. If trades stop being detected or get mislabeled, double check the relevant program ID against [Solscan](https://solscan.io).  

**Only real buys/sells are mirrored.** A transaction is only ever classified as a buy or sell if *both* an SOL balance change and a matching SPL token balance change are present on the copied wallet. A plain SOL transfer (sending or receiving SOL with nothing else attached) never matches this and is silently ignored — nothing gets copied just because SOL moved in or out of the wallet. `MIN_TRADE_SOL` (default `0.003` SOL) adds a second safety margin on top of that: it filters out a transaction where the copied wallet paid its own rent (~0.002 SOL) to open a token account — e.g. self-claiming an airdrop — which would otherwise technically match the buy pattern above even though nothing was actually purchased. It applies to buys only. A sell is mirrored however small it is, because a crashed token's final exit is exactly the sell an EXACT/STIERED position needs to see.  

Wallets that keep a persistent wrapped-SOL (WSOL) account and trade out of it are handled too: WSOL balance changes count as SOL.

**Missed sells.** If a copy wallet's sell never reaches the bot (the websocket was down, or the transaction was in a format the parser doesn't read), EXACT and STIERED positions would otherwise stay open, since they have no TP/SL. So every minute, and right after the websocket reconnects, the bot checks that each copy wallet still holds the coins of the positions that follow it (one small RPC call per open position, positions older than a minute only). If it holds none, the position is sold as if the wallet had sold everything, and Telegram says so. Coins the wallet moved out with `MIRROR_TRANSFERS="false"` are left alone, as are positions you marked Keep.  

### Trailing Stop Loss

The trailing stop loss feature is an advanced risk management tool that automatically adjusts your stop loss upward as the price increases, helping lock in profits while allowing for continued upside potential. This dynamic approach maximizes your profit potential while protecting against significant reversals.

#### 📚 **How Trailing Stop Loss Works**

**Phase 1: Monitoring (Before Activation)**
- Bot tracks the highest price reached since entry
- Trailing stop remains inactive until activation threshold is met
- Regular stop loss provides downside protection

**Phase 2: Activation**
- When profit reaches `TRAILING_STOP_ACTIVATION` threshold, trailing stop activates
- Initial trailing stop price is set at `TRAILING_STOP_DISTANCE` below current peak
- Bot continues to track peak price movements

**Phase 3: Dynamic Adjustment**
- As price rises to new peaks, trailing stop moves up proportionally
- Trailing stop price = Peak Price × (1 - `TRAILING_STOP_DISTANCE` / 100)
- **Important**: Trailing stop never moves down, only up

**Phase 4: Execution**
- When price drops to or below the trailing stop price, position is sold immediately
- Profit is locked in at the trailing stop level

#### 🔄 **Integration with Existing Features**

The bot checks exit conditions in this **priority order**:
1. **🎯 Trailing Stop Loss** (highest priority - if active)
2. **📈 Take Profit** (fixed percentage)
3. **📉 Stop Loss** (fixed percentage)

**Interaction Examples:**

| Scenario | Entry | Peak | Current | Action | Result |
|----------|-------|------|---------|--------|--------|
| Trailing Stop Wins | $1.00 | $2.00 | $1.79 | Trailing Stop | Sell at $1.79 (+79%) |
| Take Profit Wins | $1.00 | $1.45 | $1.50 | Take Profit | Sell at $1.50 (+50%) |
| Stop Loss Protects | $1.00 | $1.15 | $0.80 | Stop Loss | Sell at $0.80 (-20%) |

#### ⚙️ **Configuration Options**

```env
# Enable/disable trailing stop loss
ENABLE_TRAILING_STOP=true

# Distance below peak price to maintain stop loss (percentage)
TRAILING_STOP_DISTANCE=10.0

# Minimum profit before trailing stop activates (percentage)
TRAILING_STOP_ACTIVATION=20.0
```

#### 🎯 **Configuration Strategies**

**Conservative Strategy (Risk-Averse)**
```env
ENABLE_TRAILING_STOP=true
TRAILING_STOP_DISTANCE=15.0      # Wider distance - less sensitive
TRAILING_STOP_ACTIVATION=30.0    # Higher activation - more selective
TAKE_PROFIT=40.0                 # Lower take profit - secure gains
STOP_LOSS=15.0                   # Tighter stop loss - limit losses
```

**Aggressive Strategy (Maximum Profit)**
```env
ENABLE_TRAILING_STOP=true
TRAILING_STOP_DISTANCE=8.0       # Closer distance - more sensitive
TRAILING_STOP_ACTIVATION=15.0    # Lower activation - starts sooner
TAKE_PROFIT=100.0                # Higher take profit - let winners run
STOP_LOSS=25.0                   # Wider stop loss - ride volatility
```

**Balanced Strategy (Recommended)**
```env
ENABLE_TRAILING_STOP=true
TRAILING_STOP_DISTANCE=12.0      # Moderate distance
TRAILING_STOP_ACTIVATION=25.0    # Reasonable activation threshold
TAKE_PROFIT=60.0                 # Balanced take profit
STOP_LOSS=20.0                   # Standard stop loss
```

#### 📊 **Detailed Examples**

**Example 1: Successful Trailing Stop**
```
Entry Price: $1.00
Config: TSL Distance=10%, TSL Activation=20%

Price Movement:
$1.00 → $1.10 (+10%) → Tracking peak, TSL not active
$1.10 → $1.25 (+25%) → TSL ACTIVATES, stop at $1.125
$1.25 → $1.60 (+60%) → TSL updates to $1.44
$1.60 → $1.80 (+80%) → TSL updates to $1.62
$1.80 → $1.61 (+61%) → TSL TRIGGERS, sells at $1.61

Result: +61% profit (vs +80% peak, -10.6% from peak)
```

**Example 2: Take Profit Override**
```
Entry Price: $1.00
Config: TSL Distance=10%, TSL Activation=20%, Take Profit=50%

Price Movement:
$1.00 → $1.25 (+25%) → TSL activates, stop at $1.125
$1.25 → $1.50 (+50%) → TAKE PROFIT triggers immediately

Result: +50% profit (take profit overrides trailing stop)
```

**Example 3: Stop Loss Protection**
```
Entry Price: $1.00
Config: TSL Distance=10%, TSL Activation=20%, Stop Loss=15%

Price Movement:
$1.00 → $1.15 (+15%) → TSL not active yet (below 20%)
$1.15 → $0.85 (-15%) → STOP LOSS triggers

Result: -15% loss (regular stop loss protects before TSL activates)
```

#### 🚨 **Important Considerations**

**Market Volatility:**
- High volatility may trigger trailing stops prematurely
- Consider wider `TRAILING_STOP_DISTANCE` for volatile tokens
- Monitor and adjust based on market conditions

**Activation Timing:**
- Too low activation threshold: May activate on small pumps
- Too high activation threshold: May miss profit protection opportunities
- Recommended range: 15-30% depending on strategy

**Distance Setting:**
- Too tight distance: Frequent false triggers on normal volatility
- Too wide distance: May give back too much profit
- Recommended range: 8-15% depending on token behavior

#### 🧪 **Testing Your Configuration**

Before going live, it's recommended to:

1. **Start with Conservative Settings**: Use wider distances and higher activation thresholds
2. **Monitor Initial Trades**: Watch how the trailing stop behaves with your token selections
3. **Adjust Based on Results**: Fine-tune parameters based on actual performance
4. **Use Small Amounts**: Test with smaller `BUY_AMOUNT` initially

#### 📈 **Performance Benefits**

- **Profit Maximization**: Captures more upside than fixed take profit
- **Risk Management**: Protects against significant reversals
- **Automated Execution**: No manual intervention required
- **Adaptive Strategy**: Adjusts to market movements in real-time

#### 🔧 **Technical Implementation**

- **Storage**: All trailing stop data persisted in `positions.json`
- **Logging**: Comprehensive logging with `[TSL]` prefix for easy monitoring
- **Mode Support**: `SAFE` and `TIERED` positions (not `EXACT`/`STIERED`, which exit by mirroring the copy wallet)
- **Performance**: Minimal overhead, checked during regular price polling

Refer to the `.env.example` for details and examples.  

---

## Shred stream (SHRED_SOURCE)

A shred stream delivers the transactions in each block as the slot leader produces them, before they are processed, so the copy wallet's trades are seen typically a few hundred milliseconds earlier than through the websocket feed. The websocket feed **keeps running alongside**: whichever sees a trade first acts, and the same transaction is never copied twice. Three sources (or several side by side):

- **`SHRED_SOURCE="helius-preprocessed"`** (recommended for a small VPS): Helius's `preprocessedSubscribe`, available on any paid Helius plan at 0.1 credits per message. Helius decodes the shreds and sends only the transactions that mention the copy wallet, so bandwidth and CPU use are small. Each message costs 0.1 credits, including spam that merely mentions the wallet (a popular wallet gets several a second). `SHRED_MAX_MSGS_PER_MIN` (default 3000) is a safety stop: if more arrive within a minute, the shred feed stops for the run and Telegram tells you, rather than burning credits. The stop message and every `[Shreds]` summary include a breakdown of what arrived: how many were the copy wallet's own, duplicates, the busiest other signers, and accounts found in most of the rest. If spam comes through one program or account, put it in `SHRED_EXCLUDE_ACCOUNTS` and Helius leaves those transactions out, in the shred feed and in the `DETECTION_FEED="transaction"` websocket feed (check on Solscan first that the account isn't in the copy wallet's own trades). Legacy, v0 and the new v1 transactions (SIMD-0385) are all read. A `[Shreds]` summary appears after the first minute and when the bot stops, and the first copy-wallet transaction received is logged, so you can see at once whether the feed is delivering. It uses the API key from your Helius `SOLANA_RPC` (or `SHRED_STREAM_TOKEN`). If Helius refuses the subscription (e.g. a free plan), the bot logs why and carries on with the websocket feed. The `[Shreds]` summary shows the approximate credits used.
- **`SHRED_SOURCE="jito-grpc"`** (the default when only `SHRED_STREAM_URL` is set): decoded shreds over gRPC in the standard Jito ShredStream format (`shredstream.ShredstreamProxy/SubscribeEntries`), from a provider's endpoint (`SHRED_STREAM_URL`, `SHRED_STREAM_TOKEN`). This also works with providers that only send **raw UDP shreds** (e.g. GetBlock's standalone service): run Jito's open-source `shredstream-proxy` in `forward-only` mode with `--grpc-service-port 9999` next to the bot, and set `SHRED_STREAM_URL="http://127.0.0.1:9999"`. This stream carries every transaction on Solana, so it needs much more bandwidth and CPU.

- **`SHRED_SOURCE="shreder"`**: [Shreder](https://shreder.xyz)'s Decoded Shreds (paid; trials available), at `SHREDER_URL` (the address Shreder gives you, e.g. `http://fra1.shreder.xyz:9991`). Shreder decodes the shreds and sends only the transactions that mention the copy wallets (filtered on their side, `SHRED_EXCLUDE_ACCOUNTS` included), so it is as light as Helius. There is no token: Shreder allows your **server's public IPv4 address**, so give them the address of the server the bot runs on (`curl -4 -s https://ifconfig.me ; echo` prints it). Repeats of the same transaction are dropped. The `[Shreds]` summary adds how long messages take from Shreder to the bot, from Shreder's own timestamps (only as accurate as both clocks). **`npm run shreder-check`** connects from the server, subscribes to Pump.fun's transactions for 20 seconds and reports whether data flows, how much and how quickly (`-- --copy` for just your copy wallets' transactions, `-- --seconds 60`, `-- --url <address>`): run it the moment the trial starts, before the bot. If the connection fails, it says what to check.
- **Several sources side by side**, comma-separated, e.g. **`SHRED_SOURCE="shreder,helius-preprocessed"`**: both run at once and the first to report a trade is the one acted on (a buy is copied once, a sell exits once, a router is learned once). Every copy-wallet transaction gets a `[Race]` line, e.g. `[Race] 5Kx9…aB3d (slot 371234567): Shreder first, Helius +18.4 ms`, or `only Helius reported it` if the other didn't within 10 seconds; a `[Race] Last N min` summary (who was first how often, with the median and best lead) comes every `USAGE_LOG_MIN` minutes, and a whole-run one when the bot stops. Times are taken when each message reaches the bot, before any decoding, on the same clock, so this is a fair head-to-head on the same trades. Buying carries on while at least one source is up. (`jito-grpc` and `helius-preprocessed` can't be combined: both use `SHRED_STREAM_URL`.)

**Timing and same-block rate.** After every buy copied from the shreds, a `[Timing]` line shows:
- how far into the copy wallet's slot his trade reached the bot, and when yours went out (the bot follows slot starts through a small `slotSubscribe` on the websocket feed);
- how long each step took: deciding (split into reading his transaction, including any wait for an address lookup table, handing it over to the buy handler, and the buy checks), building, and how long Sender took to answer;
- where yours landed: in his block, in his block but failed (e.g. slippage), or N slots late (including buys the slot guard cancelled).

It ends with a running total for the run, e.g. `In his block this run: 4 of 7 (57%); median seeing→sending 48 ms; sent at median 170 ms into his slot when we made it, 330 ms when we didn't`. The same rate appears in the Telegram buy message and when the bot stops. If the buys that miss went out late in his slot, his trade simply came too late in the slot to follow; if they went out early and still missed, fees, tip or the route are what to change.

**Is the server keeping up? (`[Host]` lines).** Every `USAGE_LOG_MIN` minutes (10 by default, and once a minute after starting) the bot logs how late its event loop was in getting to ready work (typical, 99th percentile and worst), how busy the machine's CPU was, how much of that was the bot, and how much CPU time the hypervisor gave to other customers' machines ("stolen"; high on busy shared-CPU servers, ~0 with dedicated cores). Worst delays of tens of ms, or stolen CPU above a few %, mean buys can wait behind other work or other tenants: a server with dedicated cores helps. The address lookup tables the copy wallets used recently are loaded at startup, so their next trades are read without fetching a table first.

**Buys only from the shreds (`SHRED_BUYS_ONLY`, default on).** With a shred source configured, a copy buy that reached the bot only through the websocket feed is a late buy, and late buys into the copy-bot rush tend to lose money. So only buys the shred stream reports are copied. That includes buys the shreds can't read yet: other venues, and a router's first two buys while it's being learned. Those are logged as not bought, and they still teach the router. If the shred feed is down for 30 seconds, buying stops and Telegram tells you; you get another message when it's back. Sells and exits always come from both feeds. `SHRED_BUYS_ONLY="false"` copies buys from either feed.

What it copies from the shreds:

- **Direct Pump.fun and PumpSwap buys** by the copy wallet are read from the instruction itself: `buy_exact_sol_in` / `buy_exact_quote_in` give the exact SOL, while a plain `buy` gives only its maximum SOL cost (used for tier sizing). The log shows `[Shreds] Copy wallet BUY of … seen early`.
- **Router buys.** Trading terminals and bots, such as the one your streamer uses, call Pump.fun from inside their own instruction, and its format isn't public. The bot **learns** it from the copy wallet's confirmed trades, which the websocket feed delivers. It learns which instruction is the buy (by the instruction's first data byte, which works for routers with a 1-byte instruction tag as well as Anchor programs) and where the SOL amount sits: each confirmed buy votes for the positions where its amount appears, and the position found in at least two buys, and in at least half of them, wins. An odd trade doesn't undo what was learned, and buys of another variant of the instruction (the amount isn't in the data at all) don't count against it. A router instruction is only treated as sell-only once the same router's buys are known to use a different instruction, so a router that buys and sells with one instruction never has its buys taken for sells. After two matching confirmed buys, the log says `[Shreds] Learned the copy wallet's router …` and from then on those buys come from the shreds. What it has learned is saved in `data/shred-routers.json`, so it survives restarts. Router buys are only copied for coins the copy wallet doesn't hold yet (its first buy).
- **Sells** give an early exit only where the % sold doesn't matter: `TRADE_TYPE=EXACT`, or STIERED with `FULL_EXIT_ON_COPY_SELL=true`. Partial-sell mirroring still waits for the websocket feed, which also records every sell.
- Everything else (Raydium, other venues, routers not learned yet) comes from the websocket feed as before.

Things to know:

- **The copy wallet's buy can still fail, or never land.** Shreds show what was sent, not what happened. Each early buy is checked a few seconds later; if the original failed, or still doesn't exist after 15 seconds (dropped), our position is sold (`SHRED_SELL_IF_COPY_FAILED`, default on) or you get a Telegram alert. Before selling, the bot checks whether the copy wallet holds the coin anyway. Some wallets send several copies of each buy, and only one lands; if another copy bought the coin, the failed one was just a duplicate and your position stays.
- **Slippage.** When copying from the shreds the bot usually builds its buy before the copy wallet's own buy has run, so the price will move by the copy wallet's buy, and by everyone else's, before ours lands. Keep `SLIPPAGE` high enough to cover that: the copy wallet's buy size relative to the coin's liquidity.
- **Buys without a lookup (`SHRED_FAST_BUY`, default off).** Normally the bot reads the coin's bonding curve before building (one RPC round trip, typically 20–60 ms). With `SHRED_FAST_BUY="true"`, Pump.fun bonding-curve buys copied from the shreds are built from the copy wallet's transaction alone, as `buy_exact_sol_in`: exactly your buy amount in, and at least as many tokens as you'd get at `MAX_MARKET_CAP_SOL` (required). So the market cap limit is enforced by Pump.fun itself when the buy runs (it fails with "market cap above your MAX_MARKET_CAP_SOL" otherwise), and `SLIPPAGE` doesn't apply to these buys. The creator's fee account, the token program and the coin's mode are taken from his transaction; for a router, the bot learns where it keeps the creator account from his first few confirmed buys (logged once learned, and saved with the router). `BLOCKED_CREATORS` is still checked. When anything can't be worked out, or `MIN_MARKET_CAP_SOL` is set (which needs the curve), the buy is built the normal way, and the log says why. Try it with small amounts first.

- **Hand-built buys (`HAND_BUILT_BUYS`, default on).** `SHRED_FAST_BUY` buys are written straight into transaction bytes (`src/pumpBuyRaw.js`) instead of going through Pump.fun's SDK, web3.js's message compiler and Sender's tip swap, which reads the whole transaction back and compiles it again. The coin's accounts are matched against the copy wallet's transaction by hashing, your token account is derived with a fast curve test, and the message is written into one buffer, signed with Node's native ed25519 and sent. On a 2-vCPU server, building and signing took a median of 0.3 ms instead of 1.8 ms (99th percentile 1.1 ms instead of 4.1 ms), and the first buys after a quiet spell ~1 ms instead of 5–15 ms; it also creates far less garbage, so fewer collection pauses land in the middle of a buy. The result is the same transaction, byte for byte: the accounts come from a template made from the SDK's own instruction, and every practice build (at startup, then every 30 s) builds a practice buy both ways and compares them. If they ever differ (e.g. Pump.fun changed its buy and the SDK was updated), hand-built buys switch off for the run with a warning, and buys go the SDK way. The startup log says `Hand-built Pump.fun buys on (SHRED_FAST_BUY): checked identical to the SDK's` with both timings. `HAND_BUILT_BUYS="false"` always uses the SDK.

- **The Rust fast path (`FAST_PATH="rust"`, off by default).** A separate program (`fastpath/`, Rust) on the same server takes over the race for these buys. It connects to the shred feeds in `SHRED_SOURCE` itself (`shreder`, `helius-preprocessed`, or both; the first to report a transaction wins and `[Race]` lines compare them, as before). It reads the copy wallets' transactions (legacy, v0 with lookup tables, v1), recognises direct Pump.fun curve buys and the router buys this bot has learned, and decides whether to buy from a snapshot of this bot's state, which this bot sends the moment anything in it changes (paused, a position opened or closed, the balance, a coin the copy wallet bought or exited) and every 250 ms regardless, so the fast path never waits for it: the decision reads the copy already in memory. The snapshot covers: paused or not (and rehearsals), room under `MAX_TOTAL_EXPOSURE` and `MAX_BUY_AMOUNT`, the wallet balance, `BUY_COOLDOWN_SEC`, `MAX_OPEN_POSITIONS`, open positions, the copy wallet's holdings (`ONLY_COPY_FIRST_BUY`), exited coins (`SKIP_REBUYS`), buy sizes (`TRADE_TYPE`, `TIER_BUY_CONFIG`), `MAX_MARKET_CAP_SOL`, `BLOCKED_CREATORS`, quote and stock tokens, `MAX_SLOTS_BEHIND`, `LEADER_MAX_KM`, fees and tips, learned compute limits, and the blockhash. Its own buys count against the room and cooldown at once, before this bot's next snapshot. It then writes the buy into bytes, signs it and sends it via Sender (kept warm) or Jito, all in about 0.04 ms (99th percentile under 0.1 ms) on a 2-vCPU server. This bot gets every copy-wallet transaction it sees, with what it did: **bought** (this bot takes over the position: confirmation, `INSTANT_SELL`, copy sells, PnL, `[Timing]`), **rehearsed** (paused: a `[Timing] REHEARSAL … (Rust fast path)` line), or **declined** with the reason (this bot handles it as it always has, including its own skip messages). It declines whenever its snapshot is over 1.5 s old, the link is down, or it isn't sure. It buys only after its practice buy is byte-identical to this bot's hand-built one (itself checked against Pump.fun's SDK); that check is repeated every 30 s, and a mismatch stops it buying. If it's unreachable for `FAST_PATH_FALLBACK_MS` (5 s), this bot opens its own shred feed(s) until it's back. They talk over `127.0.0.1:FAST_PATH_PORT` (7799) only. Both read the same `.env` (the fast path finds it the same way, or via `FASTPATH_ENV`). With `FAST_PATH` unset, the fast path exits at once, so pm2 can list it harmlessly. Building it: install Rust (`rustup`), then `cd fastpath && cargo build --release`; pm2 then starts it with the bot (`ecosystem.config.js`), or run `./fastpath/target/release/fastpath` yourself. PumpSwap buys, sells and everything else stay in this bot.
- **No fill price yet.** The copy wallet's price isn't known until its trade has run, so `MAX_ENTRY_PREMIUM_PCT` can't check shred-copied buys (the log says so).
- **Bandwidth (jito-grpc).** That stream carries every transaction on Solana. Messages without the copy wallet's address are discarded with one quick scan, but expect steady incoming traffic. Helius preprocessed only sends the copy wallet's transactions.
- **Newer transaction formats.** A transaction in a format the bot can't read yet is left to the websocket feed (counted as "unreadable" in the `[Shreds]` summary).
- Every few minutes (`USAGE_LOG_MIN`) the log shows a `[Shreds]` summary: messages, MB received, the copy wallet's transactions seen and copied early, and for Helius the approximate credits. If the stream drops, the bot reconnects with backoff while the websocket feed carries on.

## Project Structure

```
.
├── .env.example          # Copy to .env and configure
├── data/
│   ├── positions.json    # Open positions (and ones closed in the last few minutes), pause state
│   ├── positions-closed.jsonl  # Closed positions, one JSON line each (moved out of positions.json)
│   ├── exited-mints.txt  # Coins the copy wallets have exited (SKIP_REBUYS)
│   └── shred-routers.json  # Router formats learned from the shred stream
├── utils/
│   └── getTimestamp.js   # ISO timestamp helper
└── src/
    ├── config.js         # Loads and validates environment variables
    ├── logger.js         # Timestamped console logger
    ├── storage.js        # Reads/writes data/positions.json (kept in memory) and the archive files
    ├── tieredBuy.js       # TIER_BUY_CONFIG parsing + tiered buy-amount lookup
    ├── dexMapper.js      # Maps txParser.js DEX labels to SolanaPortal codes
    ├── txParser.js       # Classifies a parsed tx into a buy/sell copyTrade event
    ├── priceChecker.js   # Fetches prices from DexScreener's public API
    ├── websocket.js      # Raw Solana RPC logsSubscribe feed, emits copyTrade events
    ├── prewarm.js        # Blockhash + Pump.fun config kept warm (PREWARM)
    ├── shredFeed.js      # Shred stream (SHRED_SOURCE: Helius preprocessed, Shreder or Jito gRPC; several side by side), alongside websocket.js
    ├── feedRace.js       # With several shred sources: which reported each transaction first ([Race] lines)
    ├── shredTx.js        # Reads transactions out of shred-stream entries
    ├── shredDecode.js    # Pump.fun/PumpSwap/router buy & sell intents; router learning
    ├── proto/            # gRPC definition of the shred stream service
    ├── rpcPool.js         # Optional multi-endpoint RPC failover (SOLANA_RPC_FALLBACKS)
    ├── tradeExecutor.js  # Builds & submits transactions (SolanaPortal or direct)
    ├── pumpfunDirect.js  # Direct Pump.fun bonding-curve swap builder (beta)
    ├── pumpBuyRaw.js     # SHRED_FAST_BUY buys written straight into bytes (HAND_BUILT_BUYS)
    ├── fastPath.js       # The link with the Rust fast path (FAST_PATH="rust")
    ├── raydiumDirect.js  # Direct Raydium AMM v4/CPMM swap builder (beta)
    ├── jitoTip.js        # Shared Jito tip-account list/instruction helper
    ├── amounts.js        # Exact token-amount math (string/BigInt, no float rounding)
    ├── timeouts.js       # Timeouts for every network call
    ├── tokenLinks.js     # Builds an Axiom Trade token-page link for new buys
    ├── fastPumpParser.js # Reads Pump.fun trades from logs (DETECTION_COMMITMENT=processed)
    ├── telegramBot.js    # Optional Telegram control bot (positions/sell/PnL)
    └── index.js          # Main application logic and event loop
test/                     # `npm test`: unit + end-to-end tests, network fully simulated
```

---

## Usage

1. Clone & install (see [Installation](#installation)).  
2. Rename `.env.example` to `.env` and fill in values.  
3. Run:  
   ```bash
   npm start
   ```  
   - `BOT_MODE=SELLING`: Liquidate all open positions and exit (exit code 1 if any couldn't be sold; those stay open).  
   - `BOT_MODE=COPY`: Listen for copy-wallet trades and mirror them.  
4. Optional: `npm test` runs the test suite. It needs no network or wallet funds, because RPC, Jito, SolanaPortal, DexScreener and Telegram are all simulated.  

---

## Running on a server (VPS)

`ecosystem.config.js` runs the bot under [pm2](https://pm2.keymetrics.io/), which keeps it going after you log out and restarts it if it crashes:

```bash
npm install -g pm2
pm2 start ecosystem.config.js   # start
pm2 logs copybot                # live logs
pm2 status                      # is it running?
pm2 restart copybot             # restart (e.g. after /stop or an update)
pm2 save && pm2 startup         # start automatically when the server reboots
```

The config is set up for this bot:
- **Telegram `/stop` stays stopped.** It exits cleanly, and pm2 doesn't restart a clean exit.
- **A crash is restarted.** A crash loop, e.g. from a bad `.env` value, gives up after 15 tries.
- **`pm2 stop`/`restart` shuts down gracefully.** Buys and sells in progress get up to 30s to finish.

**Updating:** the release zip doesn't contain `.env` or `data/`, so you can unzip a new version over the old folder without losing your settings or positions. Then run `npm install`, `npm test` and `pm2 restart copybot`.

**Keeping settings outside the bot folder (optional):** if there's no `.env` in the bot folder, the bot reads `copybot.env` from the folder *above* it instead, e.g. `~/copybot.env` when the bot is in `~/solana-copy-trading-bot-main`. Then you can delete or replace the whole bot folder on an update and your settings are untouched. (Move `data/` too only if you replace the folder; unzipping over it keeps `data/`.)

**New settings after an update:** run `npm run check-env`. It prints which settings file is in use, any settings from the new `.env.example` your file doesn't mention (the bot uses their defaults; add them only if you want to change them), and any names in your file the bot doesn't recognise (typos). It never prints values. The bot also logs the same summary at startup.

## Environment Variables Reference

| Variable            | Description                                                                                   |
|---------------------|-----------------------------------------------------------------------------------------------|
| `SOLANA_RPC`        | RPC endpoint (mainnet-beta)                                                      |
| `SOLANA_WS`         | Optional websocket RPC URL for trade detection; auto-derived from `SOLANA_RPC` if unset          |
| `SOLANA_RPC_FALLBACKS` | Optional comma-separated list of additional RPC HTTP URLs to fail over to if `SOLANA_RPC` errors. Unset by default (no failover). See [RPC Failover](#rpc-failover). |
| `PRIVATE_KEY`       | Base58 private key for signing transactions                                                   |
| `PUBLIC_KEY`        | Your wallet address (must match `PRIVATE_KEY`; checked at startup)                             |
| `BOT_MODE`          | `COPY` (normal) or `SELLING` (liquidate & exit)                                                |
| `COPY_WALLET`       | Wallet address to mirror, or several separated by commas. Each position follows the wallet whose buy opened it; another wallet's buys and sells of a coin you hold are ignored for it. `SKIP_REBUYS` and `ONLY_COPY_FIRST_BUY` are per wallet |
| `MIN_TRADE_SOL`     | Minimum SOL amount for a detected *buy* to be mirrored, filtering out rent/dust false-positives (default `0.003`). Sells aren't filtered, so a tiny final exit by the copy wallet is still mirrored |
| `MAX_BUY_AMOUNT`    | Hard ceiling on any single buy, across every `TRADE_TYPE` mode — clamps down rather than skipping (default `11`, in SOL) |
| `MAX_OPEN_POSITIONS` | Most positions open at once, counting buys in flight (default `2`; `0` = no limit). A copy buy that would open one more is skipped; adding to a coin you hold still works |
| `BUY_COOLDOWN_SEC` | After the bot sends a buy, any other copy buy within this many seconds is skipped, whatever the coin or wallet (default `5`; `0` = off). A buy skipped or failed before sending doesn't count |
| `MAX_TOTAL_EXPOSURE`| Hard ceiling on total SOL committed: remaining cost of open positions plus in-flight buys. Clamps a new buy to the remaining room, or skips it if less than `MIN_TRADE_SOL` is left (default `15`, in SOL) |
| `TRADE_TYPE`        | `EXACT`, `SAFE`, `TIERED`, or `STIERED`                                                       |
| `BUY_AMOUNT`        | (If `TRADE_TYPE=SAFE`) SOL to spend per buy                                                     |
| `TAKE_PROFIT`       | (If `TRADE_TYPE=SAFE` or `TIERED`) TP percentage — not used by `STIERED`                      |
| `STOP_LOSS`         | (If `TRADE_TYPE=SAFE` or `TIERED`) SL percentage — not used by `STIERED`                      |
| `TIER_BUY_CONFIG`   | (If `TRADE_TYPE=TIERED` or `STIERED`) JSON array of `{maxSol,buyAmount}` tiers, e.g. `[{"maxSol":0.5,"buyAmount":0.05},{"maxSol":2,"buyAmount":0.15},{"maxSol":null,"buyAmount":0.3}]` |
| `ENABLE_MULTI_BUY`  | `true`: repeat buys of a token are added to the existing position. `false`: ignored             |
| `DETECTION_COMMITMENT` | `confirmed` (default) or `processed`: act on Pump.fun trades as soon as they're processed (~0.5–1s sooner), at a small risk of copying a trade that later gets dropped |
| `SKIP_REBUYS`       | `off` (default) / `full` / `any`: ignore the copy wallet buying back into a coin after it sold all of it (`full`) or any of it (`any`). Remembered across restarts |
| `MIRROR_TRANSFERS`  | `true` (default): the copy wallet moving a token out without selling it (sent to another wallet, burned, swapped into another token) is mirrored like a sell of the same % for EXACT/STIERED positions. `false`: only real sells |
| `SLIPPAGE`          | Slippage tolerance (%)                                                                         |
| `JITO_TIP`          | SOL tip per transaction to prioritize on Jito                                                   |
| `JITO_ENGINE`       | Jito block engine URL. Use the region nearest to where the bot runs, e.g. `https://london.mainnet.block-engine.jito.wtf/api/v1/transactions` from the UK (others: amsterdam, dublin, frankfurt, ny, slc, singapore, tokyo) |
| `SEND_VIA`          | `jito` (default) or `sender` (Helius Sender — see "Sending via Helius Sender") |
| `SENDER_ENDPOINT`, `SENDER_TIP`, `PRIORITY_FEE_SOL` | Sender region URL (default Frankfurt), tip per transaction (default/minimum 0.001 SOL), priority fee per transaction (default 0.0001 SOL with Sender, off with Jito) |
| `SHRED_FAST_BUY` | `true`: Pump.fun buys copied from the shreds are built without a lookup, with `MAX_MARKET_CAP_SOL` enforced on-chain instead of `SLIPPAGE` (default `false`; needs `MAX_MARKET_CAP_SOL`). See "Shred stream" |
| `HAND_BUILT_BUYS` | `true` (default): `SHRED_FAST_BUY` buys are written straight into bytes (~0.3 ms instead of ~2 ms), checked identical to the SDK's at startup and every 30 s, and switched off if they ever differ. `false`: always the SDK way |
| `FAST_PATH`, `FAST_PATH_PORT`, `FAST_PATH_FALLBACK_MS` | `rust`: the Rust fast path (`fastpath/`) reads the shred feeds and sends `SHRED_FAST_BUY` buys itself; this bot does everything else (default off). Local port (7799), and how long it may be unreachable before this bot opens its own feeds (5000 ms) |
| `QUOTE_TOKENS`, `QUOTE_TOKEN_RESERVE_SOL`, `QUOTE_COMPUTE_UNITS` | Off by default. Mint addresses of tokens (e.g. PUMP, `pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn`) whose Pump.fun-curve coins should be bought instead of skipped. The bot keeps a reserve of each worth `QUOTE_TOKEN_RESERVE_SOL` (default 1, topped up through Jupiter when below half) and buys straight from it in one instruction, so in the same block; sells pay out in the token, back into the reserve. Values and PnL are in SOL at the token's Jupiter price; the reserve itself moves with that price. Needs `DIRECT_PUMPFUN_SWAP=true` and `JUPITER_API_KEY`. `QUOTE_COMPUTE_UNITS` (default 200,000) is their compute budget. Try with small amounts first |
| `BUY_PRIORITY_FEE_SOL`, `BUY_PRIORITY_FEE_PCT` | Priority fee for buys (default `PRIORITY_FEE_SOL`), optionally raised to a % of the buy amount. Inside a block, waiting transactions run in order of fee per compute unit, so buys racing snipers need more than sells. Paid even when the slot guard cancels a buy |
| `PUMPFUN_COMPUTE_UNITS` | Compute-unit budget of direct Pump.fun / PumpSwap trades (default 300,000). The priority fee is spread over it, and transactions are ordered by fee per unit, so a budget close to real use (logged after each trade) buys an earlier place in the block at no extra cost. With `AUTO_COMPUTE_UNITS` (on by default) it's the ceiling: each kind of trade (buy/sell, programs called, token standard, number of accounts) gets the most its recent trades used +10% once seen 3 times, raised at once if one runs out (learned values in `data/compute-units.json`) |
| `PRICE_CHECK_DELAY` | Polling interval in ms for open-position price checks (one batched DexScreener request per tick) |
| `PREFERRED_DEX`     | Preferred DEX for trading. Options: "none" (system decides) or specific DEX: "auto", "pumpfun", "meteora", "raydium", "moonshot", "jupiter" |
| `ENABLE_TRAILING_STOP` | Enable trailing stop loss feature (`true` or `false`)                                       |
| `TRAILING_STOP_DISTANCE` | Distance below peak price to trail (%)                                                   |
| `TRAILING_STOP_ACTIVATION` | Minimum profit percentage before trailing starts (%)                                   |
| `DIRECT_PUMPFUN_SWAP` | `true`/`false` (default `false`, beta) — build & sign Pump.fun bonding-curve trades directly on-chain instead of via SolanaPortal. See [How Direct Pump.fun Swaps Work](#how-direct-pumpfun-swaps-work). |
| `DIRECT_RAYDIUM_SWAP` | `true`/`false` (default `false`, beta) — same idea for Raydium Standard (AMM v4/CPMM) pools. See [How Direct Raydium Swaps Work](#how-direct-raydium-swaps-work). |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | Optional — enables the Telegram control bot (position list + sell button + PnL notifications) when both are set. See [Telegram Control Bot](#telegram-control-bot). |
| `CONFIRM_TIMEOUT_SEC` | Advanced: seconds to wait for a buy/sell to confirm (default `90`) |
| `SELL_MAX_ATTEMPTS` / `SELL_RETRY_DELAY_MS` | Advanced: sell attempts per exit (minimum `2`) and the pause between them (defaults `3` / `2000`) |
| `SELL_RETRY_COOLDOWN_MS` | Advanced: after an exit fails all attempts, wait this long before trying again, doubling after each further failure (max 10 min); the position stays open meanwhile (default `30000`) |

---

## RPC rate limits (RPC_MAX_RPS)

RPC providers cap requests per second by plan; going over makes them refuse
calls ("429 Too Many Requests"). The bot paces its own RPC calls to
`RPC_MAX_RPS` (default 8; set it a little under your plan's limit, or 0 for
no limit), spaced evenly (at 8, one every 125 ms) rather than in bursts,
because providers such as Helius also refuse several calls arriving in the
same instant. Transactions of the copy wallet that never touch a token
(plain SOL transfers, tips) are recognised from the websocket's logs and not
looked up at all. Neither are recurring transactions that only *mention* the copy
wallet but are signed by someone else (spam bots, airdrops): after one
lookup shows who signed it, look-alikes (same programs and instructions in
their logs) are skipped, 1 in 20 is still checked, and the pattern is
forgotten the moment the copy wallet signs one itself. The copy wallet's
Pump.fun trades are read from the logs and never skipped.

**Failed transactions and `DETECTION_FEED`:** the standard feed
(`logsSubscribe`) also delivers every failed transaction that mentions the
copy wallet; for a wallet that attracts spam bots that can be over 95% of
the websocket data you're billed for. With a Helius Developer plan or
higher, `DETECTION_FEED="transaction"` uses `transactionSubscribe` instead:
Helius filters out failed transactions, and every message carries the whole
transaction, so no trade needs a lookup. If it's refused, the bot falls back
to the standard feed straight away and logs why.

**Where your credits go:** every `USAGE_LOG_MIN` minutes (default 10) and
when the bot stops, the log shows a `[Usage]` line: RPC calls by method,
calls refused, websocket messages and MB received, and an estimate of the
credits used and the daily rate (Helius prices: 1 credit per RPC call,
~20 per MB of websocket data). Your provider's dashboard is the real bill. Calls on the trading path (reading the copy wallet's trades,
buying, selling, confirming) always go first; background lookups (coin
info, token-account cleanup, balance checks) use the spare capacity. The
Solana library's own silent retries on 429 are switched off, so a busy
moment can't snowball, and if the provider still refuses calls the log says
so plainly (at most every 30s). Confirmation checks ease off after the first
few seconds, and buys the wallet can't afford are skipped up front (the bot
checks its SOL balance in the background) with a Telegram alert, at most
every 10 minutes.

## Getting token-account deposits back (CLOSE_EMPTY_ACCOUNTS)

Every coin bought opens a token account in the wallet, which holds a
refundable deposit of about 0.002 SOL. After a coin is fully sold, the
account sits empty with the deposit still locked in it. With
`CLOSE_EMPTY_ACCOUNTS="true"` (the default), the bot closes it about 30
seconds after the sale and sweeps for any other empty accounts 2 minutes after
starting and then every 30 minutes, which also recovers accounts from coins
traded before this feature. The logs show what was recovered, e.g.
"closed 3 empty token account(s), recovered 0.006118 SOL of deposits".

Safety: only accounts holding exactly zero tokens are closed (Solana itself
refuses to close one that holds tokens, and each close is simulated before it
is sent, so a refused one costs nothing); coins you hold or that are being
bought or sold are skipped; wrapped-SOL accounts are left alone. Closing
runs in the background as an ordinary transaction (about 0.000005 SOL per
batch of up to 12 accounts), never on the buy/sell path. Accounts left with
a tiny dust remainder are not closed. If the copy wallet buys a coin again
later, a new account is simply opened as usual.

## Sending via Helius Sender (optional)

By default every buy/sell goes straight to Jito (`JITO_ENGINE`). Set
`SEND_VIA="sender"` to use [Helius Sender](https://www.helius.dev/docs/sending-transactions/sender)
instead: it sends each transaction through Jito and through staked validator
connections at the same time, for a better chance of landing in the earliest
slot. It uses no Helius credits; each transaction pays:

If Sender answers "429 Too Many Requests", it turned the transaction away without forwarding it, so the bot tries once more 60 ms later and, if still refused, sends the very same signed transaction through your RPC (`SOLANA_RPC`) instead (it can't land twice), logging `[Sender] Rate-limited…` and `sending … through your RPC instead`. Frequent 429s are worth raising with Helius (their documented limit is 50 requests a second).

- **`SENDER_TIP`** (default and minimum 0.001 SOL) to one of Sender's tip
  accounts, instead of `JITO_TIP`, and
- **`PRIORITY_FEE_SOL`** (default 0.0001 SOL), which Sender requires.

Use the Sender region nearest the bot (`SENDER_ENDPOINT`, Frankfurt by
default). The bot pings it every 5 seconds to keep the connection warm.

How it works: transactions are built with a Jito tip as usual (by the direct
Pump.fun/Raydium builders, or by SolanaPortal). Just before signing, the bot
makes a converted copy: the tip goes to a Sender tip account with Sender's
amount, and the priority fee is raised to at least `PRIORITY_FEE_SOL` (or
added, if the transaction had none). Every other instruction stays exactly as
built. In the rare case a transaction can't be converted (it has no Jito tip,
or adding the priority fee would push it over Solana's 1232-byte limit), it's
sent via Jito exactly as before and the log says why.

Optional: `SENDER_SWQOS_ONLY="true"` skips the Jito route (minimum tip
0.000005 SOL); `SENDER_MEV_PROTECT="true"` avoids validators linked to
sandwich attacks, possibly landing slightly later.

To compare, run a few days on Jito and a few on Sender, and look at the
"slots behind" figure in the buy messages.

## RPC Failover

By default the bot uses a single RPC endpoint (`SOLANA_RPC`) for everything —
trade detection (websocket), balance checks, confirmations, and (if enabled)
direct on-chain swap building. If that endpoint has a bad night — rate
limits, timeouts, a regional outage — every one of those stops working at
once.

Setting `SOLANA_RPC_FALLBACKS` to a comma-separated list of additional RPC
HTTP URLs turns on automatic failover:

```
SOLANA_RPC_FALLBACKS="https://your-quicknode-url,https://api.mainnet-beta.solana.com"
```

- **HTTP calls** (confirmations, balance checks, direct-swap building) go
  through `src/rpcPool.js`'s `withFailover()`, which retries a failed call
  against the next configured endpoint before giving up.
- **The websocket trade-detection feed** rotates to the next endpoint's
  derived `wss://`/`ws://` URL after 3 consecutive failed connection
  attempts, rather than retrying a dead endpoint forever.
- With `SOLANA_RPC_FALLBACKS` unset (the default), all of this is a
  no-op passthrough — the bot behaves exactly as it did before this feature
  existed, using only `SOLANA_RPC`.

Suitable fallback providers (all offer a plain RPC HTTP endpoint on a
free/low tier): **Helius**, **QuickNode**, **Triton**, **Chainstack**,
**Ankr**, or as a last resort the public `https://api.mainnet-beta.solana.com`
endpoint. The public endpoint has low rate limits and unreliable websocket
support, so it's a reasonable *last* fallback in the list but a poor choice
for `SOLANA_RPC` itself.

---

## Graceful Shutdown

Sending `SIGINT` (Ctrl+C) or `SIGTERM` to a running bot triggers a clean
shutdown instead of killing it mid-trade:

1. New work stops being accepted immediately — the price-polling interval
   is cleared and the websocket trade-detection feed disconnects, so no new
   copy-trade event or polling tick starts after this point.
2. Anything already in flight (a buy/sell round-trip, a price-polling tick
   that's mid-way through) is allowed to finish — the bot waits up to 30
   seconds for that to happen.
3. Once everything has drained (or the 30s timeout is hit, whichever comes
   first), the process exits.

Exiting at the timeout is safe, because a position is only ever marked closed
after its sell has confirmed. A sell interrupted mid-way leaves the position
open. On the next start it's re-checked against your real on-chain balance.

No configuration needed; this is always on. A second `SIGINT`/`SIGTERM`
while already shutting down is logged and ignored rather than restarting
the drain.

---

## Telegram Control Bot

Set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` (see `.env.example` for how
to get both) to get a Telegram bot that can:

- **List open positions**: send `/positions` (or `/start`) in your chat.
  The list is also sent **automatically after every buy**, so the sell
  buttons are right there when you want to exit fast.
- **See how fast each buy was**: every buy message says how many slots
  (~0.4s each) after the copy wallet's trade your buy landed, and how many
  milliseconds the bot took from seeing the trade to sending its own. The
  same figures are in the logs. 1–2 slots is about as good as it gets;
  3+ regularly means detection or the network path is worth improving.
- **See the coin at a glance**: the buy message also shows the market cap
  (USD and SOL), how far along the Pump.fun bonding curve the coin is, how
  much of the supply its creator still holds, and how much the top 10
  holders own (not counting the bonding curve's own stock or pool
  accounts). Market cap and curve come from your own buy transaction at no
  cost; the holder figures take 3–4 RPC calls, made after the buy has
  confirmed, so they never slow trading down. Anything that can't be looked
  up within ~2.5s is simply left out of the message.
- **Starts paused** (`START_PAUSED="true"`, the default): when the bot
  starts it sends "🤖 Bot started … Buying is PAUSED" with a **Resume**
  button, and buys nothing until you tap it. Exits work while paused. This
  also applies after an automatic restart (e.g. pm2 restarting it after a
  crash), so check Telegram if buys stop. Set `START_PAUSED="false"` to start
  buying straight away. Without Telegram it's ignored.
  While paused, each buy copied from the shreds is **rehearsed** (`PAUSED_REHEARSAL`, on by default): checked, built and signed exactly as for real, but not sent, and logged as a `[Timing] REHEARSAL` line with the same step timings, so a paused bot still measures its speed. For a second test copy of the bot (e.g. comparing servers), `REHEARSE_ONLY="true"` keeps it permanently paused without needing Telegram; it can't be resumed.
- **Tax check** (`MAX_TOKEN_TAX_PCT`, optional): on Solana a "tax" is a
  Token-2022 transfer fee taken on every buy/sell. With e.g.
  `MAX_TOKEN_TAX_PCT="1"`, coins taxed above 1% are skipped (you get a
  Telegram note). Pump.fun coins can't have one and skip the check; other
  coins cost one quick lookup before the buy, and if that lookup fails the
  bot buys anyway. Any tax is shown in the buy message ("⚠️ Tax: 3% on every
  buy/sell"). **Stock-paired coins are exempt**: if the coin is priced in a
  tokenized stock (xStocks like NVDAx, PreStocks, Backpack stocks; see
  `src/stockTokens.js`), the cap isn't applied and the buy message shows
  "📈 Paired to: NVDAx (stock)". Add new stock tokens with
  `STOCK_TOKEN_MINTS` if needed.
- **See what you paid vs the copy wallet**: the buy message says, e.g.,
  "Entry: +8.4% vs copy wallet's price", i.e. how much more (or less) per
  token you paid than the wallet you copied. For Pump.fun bonding-curve
  trades it's exact (both prices come from Pump.fun's own trade records);
  elsewhere it's approximate, marked "≈", because the copy wallet's price
  is worked out from its balance changes, which include its fees. Also saved
  on the position as `entry_vs_copy_pct`.
- **Keep a position (stop following the copy wallet's sells)**: in EXACT and
  STIERED modes each position also has a **📌 Keep** button. Tap it and the
  bot ignores the copy wallet's sells for that position (it tells you in
  Telegram when the copy wallet sells, so you know), and you sell with the
  buttons when you're ready. A copy-wallet sell that was still being retried
  is cancelled. Tap **▶ Follow** to go back to mirroring its sells.
  Keep is remembered across restarts. TP/SL, if you use them, still apply.
- **Sell with a button**: each position has two buttons, **Sell 50%** and
  **Sell all**. Sell all closes the position the same way a copy-sell would,
  without restarting the bot in `BOT_MODE=SELLING`. If it fails, it's retried
  automatically. Sell 50% sells half of what's currently held. If it fails,
  you get an alert and nothing is queued; tap again when you want.
- **Close all positions**: the button at the bottom of the list sells every
  open position at once, after a confirm tap (valid for 2 minutes). You get
  a summary, e.g. "Closed 3 of 3". Any position whose sell fails stays open
  and is retried automatically.
- **Pause buying**: `/pause`, `/resume`, or the ⏸/▶️ button at the bottom
  of the positions list. While paused, the copy wallet's new buys are skipped,
  and aren't replayed when you resume. Everything that *exits* keeps working:
  copy-sells, transfer-outs, Sell buttons, Close all, TP/SL. The paused state
  is saved, so a restart comes back paused. The positions list shows
  "Buying is PAUSED" while it's on.
- **Stop the bot**: send `/stop` and tap **Yes, stop** within 2 minutes.
  It's the same graceful shutdown as Ctrl+C: no new buys, anything in
  progress finishes, then you get a final "Bot stopped" message. Open
  positions are **not** sold. They stay in your wallet, and nothing manages
  them until you start the bot again. To restart, run `npm start` on the
  machine; the bot can't restart itself from Telegram.
- `/help` lists the commands, and they also appear in Telegram's `/` menu.

Taps and commands sent while the bot is offline are ignored when it starts,
so an old Sell button or `/stop` never fires later.
- **Push notifications** — a message on every new buy, and on every sell
  (full or partial) with PnL stats attached (see below).

Only the person whose id is `TELEGRAM_CHAT_ID`, messaging the bot in a
**private chat**, can view positions or trigger a sell. Messages and button
taps from anyone else, including other members of a group chat, are ignored.
If a sell fails, the bot sends an alert instead of pretending it worked.
Leave either variable unset (the default) and this feature is completely inert.

The bot talks to the Telegram Bot API directly, with timeouts on every call
and exponential backoff when Telegram is unreachable. A Telegram outage only
ever shows up as log lines; it can't stop or crash trading.

---

## PnL Reporting

Every sell — a TP/SL/trailing-stop exit, an EXACT copy-sell, a full or
partial STIERED copy-sell, or a manual Telegram sell — logs a PnL line to
the terminal (and, if configured, to Telegram):

```
[Main][PnL] TP: sold 100.00% of <mint> (position 1a2b3c4d). PnL: +0.0600 SOL (+60.00%) — received 0.1600 SOL for tokens that cost 0.1000 SOL (fees, tips & deposits of 0.0020 SOL left out; including them: +0.0580 SOL).
```

**`PNL_EXCLUDE_FEES` (default `"true"`):** PnL compares what the swaps
themselves paid and returned, leaving out the network/priority fee, the
Jito/Sender tip and token-account deposits (refundable rent), so small test
trades aren't swamped by fixed costs. The pool's trading fee and any coin
transfer tax stay in (they're part of the price). The log line still shows
the figure including fees. `"false"` reports what actually left and arrived
in the wallet instead.

PnL is **realized**, not estimated. The bot reads its own buy and sell
transactions and uses the SOL that actually left and came back to your
wallet, net of network fees and Jito tips. `cost_basis_sol` on each position
is the real cost of the buy.

For `STIERED` positions, each partial sell reduces `cost_basis_sol`
proportionally and adds to a running `realized_pnl_sol`. Later sells report
both their own PnL and the position's total so far.

If a sell transaction can't be read back (e.g. an RPC hiccup), the bot falls
back to a price-based estimate and labels it `(est.)`.

---

## License

Licensed under the MIT License. Based on [ahk780/solana-copy-trading-bot](https://github.com/ahk780/solana-copy-trading-bot).  


**Crash recovery for buys (`data/pending-buys.json`).** A buy is written to this file when it is sent and removed once the position is saved. After a restart (or after 3 s and every 60 s while running) the bot checks any left over: if the buy landed, the position is recreated and reconciled from the wallet's real token balance; if it failed, or is older than `PENDING_BUY_GIVE_UP_MS`, it is dropped.

**Coin links in the buy message.** After a buy, the bot reads the coin's on-chain metadata (one extra low-priority RPC read) and the small JSON file it points to, and adds the creator's website, X and Telegram to the Telegram buy message (Token-2022 coins keep this information inside the coin itself, which is read too; when it can't be read the message says "Links: could not be read") and the log, labelled "set by the creator, unverified". Nothing waits on it and a failure just leaves the line out. The file's address is chosen by the coin's creator, so it is only fetched over plain https from a public host (no IP addresses or internal names, no redirects, 20 KB, 1.5 s), and the links are shown as text, never opened by the bot. It also reads the website's page (same protections, 2 s, 400 KB, redirects re-checked) and says whether the page shows this coin's own address, or whether the link itself is the coin's address page. Pages built by scripts may show the address without it being in the HTML the bot fetches, so "does NOT show" means "not found". It is information only: it never blocks or changes a trade.

**PumpSwap builds and the rate limiter.** A PumpSwap buy or sell reads everything it needs in one RPC call (the SDK's own read makes three in a row); if the pool isn't the standard layout it falls back to the SDK's read. Reads made by the direct builders skip the queue but still use up a slot in the `RPC_MAX_RPS` budget, so waiting background calls yield to them and the total stays under your limit.

**When Sender says "rate limited" (429).** Sender turns the transaction away without forwarding it. A **buy** is then NOT sent again by default (`BUY_RETRY_ON_SENDER_429`, default `false`): it would land late, and a missed buy costs nothing. Set it to `true` to send it again at once through your RPC and Sender (whichever accepts first wins; it can only land once), which is best combined with `MAX_SLOTS_BEHIND` so a late landing cancels itself. **Sells** are always sent again, because they must go out. This applies to both the Node bot and the Rust fast path.

**Tighter compute limits (`COMPUTE_MARGIN_PCT`, `COMPUTE_MARGIN_UNITS`).** With `AUTO_COMPUTE_UNITS` (on by default) a trade's compute limit is the most that kind of trade recently used plus a margin, default +10% and +3,000 units. The total priority fee stays the same, so a lower limit means more fee per unit and an earlier place in the block. The margins are settable: for example `COMPUTE_MARGIN_PCT="2"` and `COMPUTE_MARGIN_UNITS="1000"` puts a trade that used 75,140 units at 76,642 instead of 85,654. A trade that needs more than its limit fails and its fee is lost, so tighten in small steps and watch the log for "ran out of compute units" (the kind's limit is then raised at once). The Rust fast path uses the same learned limits.

**Cheaper token account (`TOKEN_ACCOUNT_MODE=plain`, off by default).** The usual token account (the ATA) is made by the Associated Token Account program, which costs about 17,000 compute units. With `plain` the fast Pump.fun buy (hand-built, SDK fast path and the Rust fast path) makes the account directly with the System and Token programs instead (about 2,500 units) at an address worked out from the coin's address (`createAccountWithSeed`, seed = 32 characters of the coin's address; the Rust path uses its own seed so the two never clash). It is the same kind of account, owned by your wallet, so balances, the account cleaner and explorers see it like any other. A buy needs about 14,000 fewer compute units, so the same fee is about 17% more per unit, which is what the block ordering looks at. Details: a coin is made a plain account **once**; a second buy of the same coin uses the ATA (creating the same account twice would fail); a sell takes the tokens from whichever account holds them and moves a second account's tokens over first; PumpSwap sells and SolanaPortal/Jupiter sells move plain-account tokens into the ATA first (in the same transaction for PumpSwap, in a transaction of their own for the other two); instant sell watches both addresses. Token-2022 coins need the length of a Token-2022 token account: the bot works it out from the extensions of any Token-2022 coin's mint it reads (the same length the ATA program would make) or from your wallet's own Token-2022 accounts, and if two coins need different lengths it stops using plain accounts for Token-2022 coins. Until the length is known those coins use the ATA; `TOKEN_2022_ACCOUNT_BYTES` sets it by hand. **Test before using:** `npm run check-plain -- <coin address>` builds the buy both ways and has your RPC simulate them, printing whether each works and the compute units each uses. Quote-token (`QUOTE_TOKENS`) buys and the slower lookup-based buy path keep using the ATA.

**Separate Sender tip for sells (`SELL_SENDER_TIP`).** With `SEND_VIA="sender"`, buys tip `SENDER_TIP` and sells tip `SELL_SENDER_TIP` (default: the same as `SENDER_TIP`, so nothing changes unless you set it; the same minimum applies). It covers every sell route: the bot's own Pump.fun/PumpSwap/Raydium sells, SolanaPortal and Jupiter sells, and the move-to-ATA transaction of plain mode.

**Where your Helius credits go (`[Usage]` log lines).** Every `USAGE_LOG_MIN` minutes (default 10) and at shutdown the bot logs the RPC calls by method and the trade-detection websocket's data, with an estimate of credits (1 per call, about 20 per MB of websocket data), followed by a second line splitting the websocket data **by copy wallet** (share of the MB, credits per day at that rate, and how many of its messages were transactions it signed, transactions someone else signed that merely mention it, or failed ones). With `DETECTION_FEED="transaction"` every transaction that mentions a copy wallet is delivered whole (about 4-6 KB), including airdrops, dust and other bots' transactions; there is no server-side filter for "signed by", so a busy wallet costs credits whether or not it trades.

