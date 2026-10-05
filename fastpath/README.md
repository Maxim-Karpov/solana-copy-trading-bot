# fastpath

The Rust fast path for the copy-trading bot: shred feed → the copy wallet's
Pump.fun buy → decision (from the Node bot's state) → buy written into bytes
→ signed → sent. Everything else stays in the Node bot (see the main README,
"Rust fast path").

```
cargo build --release          # target/release/fastpath
cargo test --release           # unit tests; bench: cargo test --release bench_build -- --nocapture
```

| File | |
|---|---|
| `src/main.rs` | the engine: feed events → decode → decide → build → sign → send → report |
| `src/feeds.rs` | Helius preprocessed (websocket) and Shreder (gRPC) |
| `src/tx.rs` | transactions: legacy, v0 (lookup tables), v1 |
| `src/decode.rs` | direct Pump.fun buys and learned router buys |
| `src/state.rs` | the Node bot's snapshot and the buy decision |
| `src/buy.rs` | the buy, byte-identical to `src/pumpBuyRaw.js` |
| `src/send.rs` | Helius Sender (kept warm), Jito, RPC fallback |
| `src/link.rs` | the link with the Node bot (127.0.0.1, JSON lines) |
| `src/config.rs` | settings from the bot's `.env` |
