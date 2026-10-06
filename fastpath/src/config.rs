//! Settings, from the same file the Node bot reads: .env in the bot folder,
//! or copybot.env in the folder above it (src/envFile.js). Only what the
//! fast path itself needs; fees, sizes and limits come from the Node bot.

use crate::keys::Pubkey;
use anyhow::{bail, Context, Result};
use ed25519_dalek::SigningKey;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

pub struct Config {
    pub env_file: PathBuf,
    pub enabled: bool,
    pub signing_key: SigningKey,
    pub wallet: Pubkey,
    pub copy_wallets: Vec<Pubkey>,
    pub rpc_url: String,
    pub sources: Vec<String>,
    pub shreder_url: Option<String>,
    pub helius_ws_url: Option<String>,
    pub exclude_accounts: Vec<String>,
    pub max_msgs_per_min: u64,
    pub use_sender: bool,
    pub sender_url: String,
    /// BUY_RETRY_ON_SENDER_429: send a buy again after Sender's 429 (default off: it would land late).
    pub retry_429: bool,
    pub jito_url: String,
    pub port: u16,
}

/// The bot folder: here, or the folder above if we're inside fastpath/.
fn bot_dir() -> PathBuf {
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    if cwd.join("package.json").exists() {
        return cwd;
    }
    match cwd.parent() {
        Some(p) if p.join("package.json").exists() => p.to_path_buf(),
        _ => cwd,
    }
}

pub fn find_env_file() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("FASTPATH_ENV") {
        return Some(PathBuf::from(p));
    }
    let dir = bot_dir();
    let inside = dir.join(".env");
    if inside.exists() {
        return Some(inside);
    }
    let outside = dir.join("..").join("copybot.env");
    if outside.exists() {
        return Some(outside);
    }
    None
}

fn read_env(path: &Path) -> Result<HashMap<String, String>> {
    let mut m = HashMap::new();
    for item in dotenvy::from_path_iter(path).with_context(|| format!("can't read {}", path.display()))? {
        let (k, v) = item?;
        m.insert(k, v);
    }
    // The process environment wins, as with dotenv in Node.
    for (k, v) in std::env::vars() {
        m.insert(k, v);
    }
    Ok(m)
}

fn list(s: &str) -> Vec<String> {
    s.split(|c: char| c == ',' || c == ';' || c == '+' || c.is_whitespace()).map(|x| x.trim().to_string()).filter(|x| !x.is_empty()).collect()
}

pub fn load() -> Result<Config> {
    let env_file = find_env_file().context("no settings file: put .env in the bot folder (or copybot.env next to it), or set FASTPATH_ENV")?;
    let e = read_env(&env_file)?;
    let get = |k: &str| e.get(k).map(|s| s.trim().to_string()).filter(|s| !s.is_empty());

    let secret = bs58::decode(get("PRIVATE_KEY").context("PRIVATE_KEY is missing")?).into_vec().context("PRIVATE_KEY isn't valid base58")?;
    if secret.len() != 64 && secret.len() != 32 {
        bail!("PRIVATE_KEY has the wrong length");
    }
    let seed: [u8; 32] = secret[..32].try_into().unwrap();
    let signing_key = SigningKey::from_bytes(&seed);
    let wallet = Pubkey(signing_key.verifying_key().to_bytes());
    if let Some(pk) = get("PUBLIC_KEY") {
        if Pubkey::from_b58(&pk) != Some(wallet) {
            bail!("PUBLIC_KEY doesn't match PRIVATE_KEY");
        }
    }
    let copy_wallets: Vec<Pubkey> = list(&get("COPY_WALLET").context("COPY_WALLET is missing")?)
        .iter()
        .map(|w| Pubkey::from_b58(w).with_context(|| format!("COPY_WALLET: {w} isn't an address")))
        .collect::<Result<_>>()?;
    let rpc_url = get("SOLANA_RPC").context("SOLANA_RPC is missing")?;

    let mut sources = list(&get("SHRED_SOURCE").unwrap_or_default().to_lowercase());
    sources.retain(|s| s == "shreder" || s == "helius-preprocessed");
    let shreder_url = get("SHREDER_URL");
    let helius_ws_url = if sources.iter().any(|s| s == "helius-preprocessed") {
        match get("SHRED_STREAM_URL") {
            Some(u) => Some(u),
            None => {
                let key = get("SHRED_STREAM_TOKEN").or_else(|| {
                    rpc_url.split("api-key=").nth(1).map(|k| k.split('&').next().unwrap_or("").to_string()).filter(|k| !k.is_empty())
                });
                key.map(|k| format!("wss://beta.helius-rpc.com/?api-key={k}"))
            }
        }
    } else {
        None
    };
    let use_sender = get("SEND_VIA").map(|s| s.to_lowercase() == "sender").unwrap_or(false);
    let mut sender_url = get("SENDER_ENDPOINT").unwrap_or_else(|| "http://fra-sender.helius-rpc.com/fast".into());
    let mut params = vec![];
    if get("SENDER_SWQOS_ONLY").as_deref() == Some("true") {
        params.push("swqos_only=true");
    }
    if get("SENDER_MEV_PROTECT").as_deref() == Some("true") {
        params.push("mev-protect=true");
    }
    if !params.is_empty() {
        sender_url = format!("{sender_url}{}{}", if sender_url.contains('?') { "&" } else { "?" }, params.join("&"));
    }
    let jito_url = get("JITO_ENGINE").unwrap_or_default();
    let port = get("FAST_PATH_PORT").and_then(|p| p.parse().ok()).unwrap_or(7799);
    let max_msgs_per_min = get("SHRED_MAX_MSGS_PER_MIN").and_then(|p| p.parse().ok()).unwrap_or(3000);
    Ok(Config {
        enabled: get("FAST_PATH").map(|v| v.to_lowercase() == "rust").unwrap_or(false),
        env_file,
        signing_key,
        wallet,
        copy_wallets,
        rpc_url,
        sources,
        shreder_url,
        helius_ws_url,
        exclude_accounts: list(&get("SHRED_EXCLUDE_ACCOUNTS").unwrap_or_default()),
        max_msgs_per_min,
        use_sender,
        sender_url,
        retry_429: get("BUY_RETRY_ON_SENDER_429").as_deref() == Some("true"),
        jito_url,
        port,
    })
}

/// "https://x/?api-key=abc" -> "https://x/?api-key=…" for logs.
pub fn redact(url: &str) -> String {
    match url.find("api-key=") {
        Some(i) => format!("{}api-key=…", &url[..i]),
        None => url.to_string(),
    }
}
