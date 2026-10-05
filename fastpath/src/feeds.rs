//! The shred feeds: Helius preprocessed (websocket) and Shreder decoded
//! shreds (gRPC). Each delivers the copy wallets' transactions into one
//! channel, stamped the moment they arrive.

use crate::keys::Pubkey;
use crate::tx::{self, Ix, Lookup, Tx, Version};
use anyhow::Result;
use futures_util::{SinkExt, StreamExt};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio_tungstenite::tungstenite::Message;

/// Where a feed's events go: called straight from the feed's own task (no
/// channel hop between a transaction arriving and its handling starting).
pub type Sink = Arc<dyn Fn(FeedEvent) + Send + Sync>;

/// Helius: reconnect if nothing at all (not even a pong) arrives for this long.
const HELIUS_SILENT_SECS: u64 = 25;
const HELIUS_PING_SECS: u64 = 10;
const CONNECT_TIMEOUT_SECS: u64 = 10;

pub mod shredstream {
    tonic::include_proto!("shredstream");
}

pub enum FeedEvent {
    Tx { source: &'static str, slot: u64, at: Instant, epoch_ms: f64, tx: Tx },
    Unreadable { source: &'static str, why: String },
    State { source: &'static str, state: &'static str, detail: String },
}

fn backoff(attempt: u32) -> Duration {
    Duration::from_millis((1000u64 << attempt.min(5)).min(30_000))
}

// ---------------- Helius preprocessedSubscribe ----------------

pub fn spawn_helius(url: String, wallets: Vec<Pubkey>, exclude: Vec<String>, max_per_min: u64, out: Sink) {
    tokio::spawn(async move {
        let mut attempt = 0u32;
        loop {
            match helius_once(&url, &wallets, &exclude, max_per_min, &out, &mut attempt).await {
                Ok(Stop::Stopped(why)) => {
                    out(FeedEvent::State { source: "helius-preprocessed", state: "stopped", detail: why });
                    return;
                }
                Ok(Stop::Closed) => {}
                Err(e) => {
                    eprintln!("[fastpath] Helius preprocessed: {e}");
                    attempt += 1;
                }
            }
            out(FeedEvent::State { source: "helius-preprocessed", state: "down", detail: String::new() });
            tokio::time::sleep(backoff(attempt)).await;
        }
    });
}

enum Stop {
    Closed,
    Stopped(String),
}

async fn helius_once(url: &str, wallets: &[Pubkey], exclude: &[String], max_per_min: u64, out: &Sink, attempt: &mut u32) -> Result<Stop> {
    let (ws, _) = tokio::time::timeout(Duration::from_secs(CONNECT_TIMEOUT_SECS), tokio_tungstenite::connect_async(url))
        .await
        .map_err(|_| anyhow::anyhow!("connecting timed out"))??;
    let (mut tx_ws, mut rx_ws) = ws.split();
    let sub = serde_json::json!({
        "jsonrpc": "2.0", "id": 1, "method": "preprocessedSubscribe",
        "params": { "accountInclude": wallets.iter().map(|w| w.b58()).collect::<Vec<_>>(), "accountExclude": exclude, "accountRequired": [] }
    });
    tx_ws.send(Message::Text(sub.to_string())).await?;
    let mut window_start = Instant::now();
    let mut window_count = 0u64;
    let mut ping = tokio::time::interval(Duration::from_secs(HELIUS_PING_SECS));
    ping.tick().await;
    let mut last_heard = Instant::now();
    loop {
        tokio::select! {
            _ = ping.tick() => {
                if last_heard.elapsed() > Duration::from_secs(HELIUS_SILENT_SECS) {
                    anyhow::bail!("nothing heard for {HELIUS_SILENT_SECS} s (not even a pong); reconnecting");
                }
                tx_ws.send(Message::Ping(vec![])).await?;
            }
            msg = rx_ws.next() => {
                let Some(msg) = msg else { return Ok(Stop::Closed) };
                last_heard = Instant::now();
                match msg? {
                    Message::Binary(b) => {
                        let at = Instant::now();
                        let epoch_ms = crate::state::now_ms();
                        if max_per_min > 0 {
                            if window_start.elapsed() >= Duration::from_secs(60) { window_start = Instant::now(); window_count = 0; }
                            window_count += 1;
                            if window_count > max_per_min {
                                return Ok(Stop::Stopped(format!("{window_count} messages within a minute, over SHRED_MAX_MSGS_PER_MIN={max_per_min}; stopped to save Helius credits")));
                            }
                        }
                        const HEADER: usize = 1 + 8 + 64;
                        if b.len() <= HEADER { out(FeedEvent::Unreadable { source: "helius-preprocessed", why: "short frame".into() }); continue; }
                        let slot = u64::from_le_bytes(b[1..9].try_into().unwrap());
                        match tx::parse(&b[HEADER..]) {
                            Ok(t) => out(FeedEvent::Tx { source: "helius-preprocessed", slot, at, epoch_ms, tx: t }),
                            Err(e) => out(FeedEvent::Unreadable { source: "helius-preprocessed", why: e.to_string() }),
                        }
                    }
                    Message::Text(t) => {
                        let v: serde_json::Value = serde_json::from_str(&t).unwrap_or_default();
                        if v["id"] == 1 && v.get("error").is_some() {
                            return Ok(Stop::Stopped(format!("Helius refused preprocessedSubscribe: {}", v["error"])));
                        }
                        if v["id"] == 1 && v.get("result").is_some() {
                            *attempt = 0; // working again: the next drop retries quickly
                            out(FeedEvent::State { source: "helius-preprocessed", state: "up", detail: String::new() });
                        }
                    }
                    Message::Close(_) => return Ok(Stop::Closed),
                    _ => {}
                }
            }
        }
    }
}

// ---------------- Shreder decoded shreds ----------------

pub fn spawn_shreder(url: String, wallets: Vec<Pubkey>, exclude: Vec<String>, out: Sink) {
    tokio::spawn(async move {
        let mut attempt = 0u32;
        loop {
            match shreder_once(&url, &wallets, &exclude, &out, &mut attempt).await {
                Ok(()) => {}
                Err(e) => {
                    eprintln!("[fastpath] Shreder: {e}");
                    attempt += 1;
                }
            }
            out(FeedEvent::State { source: "shreder", state: "down", detail: String::new() });
            tokio::time::sleep(backoff(attempt)).await;
        }
    });
}

async fn shreder_once(url: &str, wallets: &[Pubkey], exclude: &[String], out: &Sink, attempt: &mut u32) -> Result<()> {
    use shredstream::shreder_service_client::ShrederServiceClient;
    use shredstream::{SubscribeRequestFilterTransactions, SubscribeTransactionsRequest};
    let endpoint = tonic::transport::Endpoint::from_shared(url.to_string())?
        .tcp_nodelay(true)
        .http2_keep_alive_interval(Duration::from_secs(15))
        .keep_alive_timeout(Duration::from_secs(5))
        .keep_alive_while_idle(true)
        .connect_timeout(Duration::from_secs(CONNECT_TIMEOUT_SECS));
    let endpoint = if url.starts_with("https") { endpoint.tls_config(tonic::transport::ClientTlsConfig::new().with_native_roots())? } else { endpoint };
    let channel = endpoint.connect().await?;
    let mut client = ShrederServiceClient::new(channel).max_decoding_message_size(64 * 1024 * 1024);
    let mut filters = std::collections::HashMap::new();
    filters.insert(
        "copy".to_string(),
        SubscribeRequestFilterTransactions { account_include: wallets.iter().map(|w| w.b58()).collect(), account_exclude: exclude.to_vec(), account_required: vec![] },
    );
    let req = SubscribeTransactionsRequest { transactions: filters };
    let requests = futures_util::stream::iter(vec![req]).chain(futures_util::stream::pending());
    let mut stream = client.subscribe_transactions(requests).await?.into_inner();
    *attempt = 0;
    out(FeedEvent::State { source: "shreder", state: "up", detail: String::new() });
    while let Some(msg) = stream.message().await? {
        let at = Instant::now();
        let epoch_ms = crate::state::now_ms();
        let Some(upd) = msg.transaction else { continue };
        let slot = upd.slot;
        match upd.transaction.as_ref().and_then(from_shreder) {
            Some(t) => out(FeedEvent::Tx { source: "shreder", slot, at, epoch_ms, tx: t }),
            None => out(FeedEvent::Unreadable { source: "shreder", why: "transaction without a readable message".into() }),
        }
    }
    Ok(())
}

fn from_shreder(t: &shredstream::Transaction) -> Option<Tx> {
    let m = t.message.as_ref()?;
    let h = m.header.as_ref()?;
    let static_keys = m.account_keys.iter().map(|k| Pubkey::from_slice(k)).collect::<Option<Vec<_>>>()?;
    let instructions = m
        .instructions
        .iter()
        .map(|ix| Ix { program_id_index: ix.program_id_index as u8, accounts: ix.accounts.clone(), data: ix.data.clone() })
        .collect();
    let lookups = m
        .address_table_lookups
        .iter()
        .map(|l| Some(Lookup { key: Pubkey::from_slice(&l.account_key)?, writable: l.writable_indexes.clone(), readonly: l.readonly_indexes.clone() }))
        .collect::<Option<Vec<_>>>()?;
    let signature = t.signatures.first().filter(|s| s.len() == 64).map(|s| {
        let mut a = [0u8; 64];
        a.copy_from_slice(s);
        a
    });
    let version = if m.config.is_some() { Version::V1 } else if m.versioned { Version::V0 } else { Version::Legacy };
    Some(Tx { signature, num_signers: h.num_required_signatures as u8, version, static_keys, instructions, lookups })
}
