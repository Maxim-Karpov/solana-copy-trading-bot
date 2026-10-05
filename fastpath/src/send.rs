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

/// A failed post: `connect` when it never got through to the server (so
/// nothing was sent), otherwise its outcome is unknown.
pub struct PostError {
    connect: bool,
    msg: String,
}

impl From<reqwest::Error> for PostError {
    fn from(e: reqwest::Error) -> Self {
        PostError { connect: e.is_connect(), msg: e.to_string() }
    }
}

impl std::fmt::Display for PostError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.msg)
    }
}

impl PostError {
    fn into_send_error(self, what: &str) -> SendError {
        if self.connect {
            SendError::Refused(format!("couldn't connect to {what} ({})", self.msg))
        } else {
            SendError::Ambiguous(format!("{what} outcome unknown ({})", self.msg))
        }
    }
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
        // https://host/fast?api-key=... -> https://host/ping
        let ping_url = match reqwest::Url::parse(sender_url) {
            Ok(mut u) => {
                u.set_path("/ping");
                u.set_query(None);
                u.to_string()
            }
            Err(_) => sender_url.into(),
        };
        Sender { client, use_sender, sender_url: sender_url.into(), ping_url, jito_url: jito_url.into(), rpc_url: rpc_url.into() }
    }

    /// Keep the connections a buy uses warm, so none starts with a TCP + TLS
    /// handshake: Sender (Helius recommends a ping every few seconds) or Jito,
    /// and the RPC (lookup tables, the fallback after Sender's 429).
    pub fn spawn_keepalive(&self) {
        let client = self.client.clone();
        let (use_sender, ping_url, jito_url) = (self.use_sender, self.ping_url.clone(), self.jito_url.clone());
        tokio::spawn(async move {
            loop {
                // Any answer keeps the connection open (read in full so it's reused);
                // Jito's rate limit counts sends, not this.
                let url = if use_sender { &ping_url } else { &jito_url };
                if let Ok(r) = client.get(url).timeout(Duration::from_secs(3)).send().await {
                    let _ = r.bytes().await;
                }
                tokio::time::sleep(Duration::from_millis(if use_sender { 3000 } else { 15000 })).await;
            }
        });
        let client = self.client.clone();
        let rpc_url = self.rpc_url.clone();
        tokio::spawn(async move {
            let body = json!({ "jsonrpc": "2.0", "id": 1, "method": "getHealth" });
            loop {
                if let Ok(r) = client.post(&rpc_url).json(&body).timeout(Duration::from_secs(3)).send().await {
                    let _ = r.bytes().await;
                }
                tokio::time::sleep(Duration::from_secs(30)).await;
            }
        });
    }

    async fn post(&self, url: &str, body: &Value) -> Result<(u16, Value), PostError> {
        // A send that takes this long has an unknown outcome (followed by signature).
        let res = self.client.post(url).json(body).timeout(Duration::from_secs(3)).send().await.map_err(PostError::from)?;
        let status = res.status().as_u16();
        let text = res.text().await.map_err(PostError::from)?;
        let v: Value = serde_json::from_str(&text).unwrap_or_else(|_| json!({ "raw": text.chars().take(300).collect::<String>() }));
        Ok((status, v))
    }

    pub async fn send(&self, wire: &[u8], signature: &str) -> Result<String, SendError> {
        if self.use_sender {
            let b64 = base64::engine::general_purpose::STANDARD.encode(wire);
            let body = json!({ "jsonrpc": "2.0", "id": "1", "method": "sendTransaction", "params": [b64, { "encoding": "base64", "skipPreflight": true, "maxRetries": 0 }] });
            for attempt in 0..2 {
                let (status, v) = self.post(&self.sender_url, &body).await.map_err(|e| e.into_send_error("Helius Sender"))?;
                if status == 429 {
                    if attempt == 0 {
                        tokio::time::sleep(Duration::from_millis(60)).await;
                        continue;
                    }
                    // Rate-limited twice: the same signed transaction through the RPC.
                    let rpc = json!({ "jsonrpc": "2.0", "id": 1, "method": "sendTransaction", "params": [b64, { "encoding": "base64", "skipPreflight": true, "maxRetries": 0 }] });
                    return match self.post(&self.rpc_url, &rpc).await {
                        Ok((_, v)) => v.get("result").and_then(|r| r.as_str()).map(String::from).ok_or_else(|| SendError::Ambiguous(format!("RPC send after Sender's 429: {v}"))),
                        Err(e) => Err(e.into_send_error("the RPC (after Sender's 429)")),
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
            // base64: much quicker to encode than base58, and Jito accepts it.
            let b64 = base64::engine::general_purpose::STANDARD.encode(wire);
            let body = json!({ "jsonrpc": "2.0", "id": 1, "method": "sendTransaction", "params": [b64, { "encoding": "base64" }] });
            match self.post(&self.jito_url, &body).await {
                Ok((status, v)) if (200..300).contains(&status) && v.get("result").is_some() => Ok(v["result"].as_str().unwrap_or(signature).to_string()),
                Ok((status, v)) if status >= 500 => Err(SendError::Ambiguous(format!("Jito answered {status} {v}"))),
                Ok((status, v)) => Err(SendError::Refused(format!("Jito refused it: {status} {v}"))),
                Err(e) => Err(e.into_send_error("Jito")),
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
