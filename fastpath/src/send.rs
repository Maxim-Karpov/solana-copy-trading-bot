//! Sending: Helius Sender (kept warm with pings), Jito, and the RPC as the
//! fallback when Sender rate-limits (as heliusSender.js / tradeExecutor.js).

use base64::Engine;
use serde_json::{json, Value};
use std::time::Duration;

pub struct Sender {
    client: reqwest::Client,
    pub use_sender: bool,
    sender_url: String,
    ping_url: String,
    jito_url: String,
    rpc_url: String,
}

pub enum SendError {
    /// Definitely not sent (refused).
    Refused(String),
    /// May have gone out: follow the signature.
    Ambiguous(String),
}

impl Sender {
    pub fn new(use_sender: bool, sender_url: &str, jito_url: &str, rpc_url: &str) -> Sender {
        let client = reqwest::Client::builder()
            .tcp_nodelay(true)
            .pool_idle_timeout(Duration::from_secs(90))
            .pool_max_idle_per_host(4)
            .timeout(Duration::from_secs(10))
            .build()
            .expect("http client");
        let ping_url = {
            let base = sender_url.split('?').next().unwrap_or(sender_url);
            match base.rfind('/') {
                Some(i) => format!("{}/ping", &base[..i]),
                None => format!("{base}/ping"),
            }
        };
        Sender { client, use_sender, sender_url: sender_url.into(), ping_url, jito_url: jito_url.into(), rpc_url: rpc_url.into() }
    }

    /// Keep the Sender connection warm (Helius recommends a ping every few seconds).
    pub fn spawn_keepalive(&self) {
        if !self.use_sender {
            return;
        }
        let client = self.client.clone();
        let url = self.ping_url.clone();
        tokio::spawn(async move {
            loop {
                let _ = client.get(&url).timeout(Duration::from_secs(3)).send().await;
                tokio::time::sleep(Duration::from_millis(3000)).await;
            }
        });
    }

    async fn post(&self, url: &str, body: &Value) -> Result<(u16, Value), String> {
        // A send that takes this long has an unknown outcome (followed by signature).
        let res = self.client.post(url).json(body).timeout(Duration::from_secs(3)).send().await.map_err(|e| e.to_string())?;
        let status = res.status().as_u16();
        let text = res.text().await.map_err(|e| e.to_string())?;
        let v: Value = serde_json::from_str(&text).unwrap_or_else(|_| json!({ "raw": text.chars().take(300).collect::<String>() }));
        Ok((status, v))
    }

    pub async fn send(&self, wire: &[u8], signature: &str) -> Result<String, SendError> {
        if self.use_sender {
            let b64 = base64::engine::general_purpose::STANDARD.encode(wire);
            let body = json!({ "jsonrpc": "2.0", "id": "1", "method": "sendTransaction", "params": [b64, { "encoding": "base64", "skipPreflight": true, "maxRetries": 0 }] });
            for attempt in 0..2 {
                let (status, v) = self.post(&self.sender_url, &body).await.map_err(|e| SendError::Ambiguous(format!("Helius Sender outcome unknown ({e})")))?;
                if status == 429 {
                    if attempt == 0 {
                        tokio::time::sleep(Duration::from_millis(60)).await;
                        continue;
                    }
                    // Rate-limited twice: the same signed transaction through the RPC.
                    let rpc = json!({ "jsonrpc": "2.0", "id": 1, "method": "sendTransaction", "params": [b64, { "encoding": "base64", "skipPreflight": true, "maxRetries": 0 }] });
                    return match self.post(&self.rpc_url, &rpc).await {
                        Ok((_, v)) => v.get("result").and_then(|r| r.as_str()).map(String::from).ok_or_else(|| SendError::Ambiguous(format!("RPC send after Sender's 429: {v}"))),
                        Err(e) => Err(SendError::Ambiguous(format!("RPC send after Sender's 429 failed ({e})"))),
                    };
                }
                if status >= 500 {
                    // A gateway error may come after Sender already forwarded it.
                    return Err(SendError::Ambiguous(format!("Helius Sender answered {status} {v}")));
                }
                if !(200..300).contains(&status) {
                    return Err(SendError::Refused(format!("Helius Sender failed: {status} {v}")));
                }
                return v.get("result").and_then(|r| r.as_str()).map(String::from).ok_or_else(|| SendError::Ambiguous(format!("Helius Sender did not return a result: {v}")));
            }
            Err(SendError::Ambiguous("unreachable".into()))
        } else {
            let b58 = bs58::encode(wire).into_string();
            let body = json!({ "jsonrpc": "2.0", "id": 1, "method": "sendTransaction", "params": [b58] });
            match self.post(&self.jito_url, &body).await {
                Ok((status, v)) if (200..300).contains(&status) && v.get("result").is_some() => Ok(v["result"].as_str().unwrap_or(signature).to_string()),
                Ok((status, v)) if status >= 500 => Err(SendError::Ambiguous(format!("Jito answered {status} {v}"))),
                Ok((status, v)) => Err(SendError::Refused(format!("Jito refused it: {status} {v}"))),
                Err(e) => Err(SendError::Ambiguous(format!("Jito outcome unknown ({e})"))),
            }
        }
    }

    /// getAccountInfo, base64 data (address lookup tables).
    pub async fn account_data(&self, address: &str) -> Option<Vec<u8>> {
        let body = json!({ "jsonrpc": "2.0", "id": 1, "method": "getAccountInfo", "params": [address, { "encoding": "base64", "commitment": "processed" }] });
        let (_, v) = self.post(&self.rpc_url, &body).await.ok()?;
        let data = v.pointer("/result/value/data/0")?.as_str()?;
        base64::engine::general_purpose::STANDARD.decode(data).ok()
    }
}
