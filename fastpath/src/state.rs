//! The Node bot's view of things, pushed to us several times a second, and
//! the buy decision made from it. Mirrors the checks in handleCopyBuy
//! (src/index.js). Whenever the answer isn't clear-cut, we decline and the
//! Node bot decides (and says why, in the log and Telegram).

use crate::keys::Pubkey;
use serde::Deserialize;
use std::collections::{HashMap, HashSet};
use std::time::{SystemTime, UNIX_EPOCH};

/// A snapshot older than this isn't trusted: the Node bot decides instead.
pub const MAX_AGE_MS: f64 = 1500.0;
/// Our own buys count against the caps until the Node bot acknowledges them
/// (its snapshot then includes them); this is only a backstop.
const PENDING_MAX_MS: f64 = 120_000.0;
pub const SLOT_MS: f64 = 400.0;

pub fn now_ms() -> f64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs_f64() * 1000.0).unwrap_or(0.0)
}

#[derive(Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct WalletState {
    pub allowed: bool,
    pub holdings_loaded: bool,
    #[serde(default)]
    pub held: Vec<String>,
    #[serde(default)]
    pub exited: Vec<String>,
}

#[derive(Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct Sizing {
    pub mode: String, // exact | fixed | tiers
    #[serde(default)]
    pub fixed: f64,
    #[serde(default)]
    pub tiers: Vec<(Option<f64>, f64)>,
}

#[derive(Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct Fees {
    pub buy_fee_sol: f64,
    pub buy_fee_pct: f64,
    pub use_sender: bool,
    pub sender_tip: f64,
    pub jito_tip: f64,
    pub ceiling: u32,
}

#[derive(Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct StateMsg {
    #[allow(dead_code)]
    pub version: u64,
    pub at: f64,
    pub buying: bool,
    pub rehearse: bool,
    pub fast_buy: bool,
    pub only_first_buy: bool,
    pub wallets: HashMap<String, WalletState>,
    #[serde(default)]
    pub positions: Vec<String>,
    pub sizing: Sizing,
    pub min_trade_sol: f64,
    pub min_copy_buy_sol: Option<f64>,
    pub max_buy_sol: f64,
    pub room_sol: f64,
    pub spendable_sol: Option<f64>,
    pub cooldown_ms: f64,
    pub last_buy_at: f64,
    pub open_slots: Option<i64>,
    pub max_mcap_sol: Option<f64>,
    pub min_mcap_set: bool,
    #[serde(default)]
    pub blocked_vaults: Vec<String>,
    #[serde(default)]
    pub quote_mints: Vec<String>,
    #[serde(default)]
    pub quote_prefixes: Vec<String>,
    pub max_slots_behind: Option<u64>,
    pub guard_available: bool,
    #[serde(default)]
    pub far_slots: Vec<(u64, u64)>,
    pub fees: Fees,
    #[serde(default)]
    pub compute_limits: HashMap<String, u32>,
    #[serde(default)]
    pub ack: Vec<String>,
    /// Our buys whose position the Node bot has saved (or that definitely failed).
    #[serde(default)]
    pub saved: Vec<String>,
}

/// The snapshot in a form that's quick to check.
pub struct Snapshot {
    pub msg: StateMsg,
    pub received_at: f64,
    held: HashMap<Pubkey, HashSet<Pubkey>>,
    exited: HashMap<Pubkey, HashSet<Pubkey>>,
    positions: HashSet<Pubkey>,
    blocked_vaults: HashSet<Pubkey>,
    pub quote_mints: HashSet<Pubkey>,
    quote_prefixes: Prefixes,
}

/// Base58 prefixes as byte ranges: a key's base58 text starts with "Xs" exactly
/// when its 32 bytes fall in a range worked out once, so checking a
/// transaction's keys needs no base58 encoding.
#[derive(Default)]
pub struct Prefixes {
    ranges: Vec<([u8; 32], [u8; 32])>,
    /// Prefixes starting with '1' (leading zero bytes): checked as text.
    slow: Vec<String>,
}

fn pad32(v: &[u8]) -> Option<[u8; 32]> {
    if v.len() > 32 {
        return None;
    }
    let mut a = [0u8; 32];
    a[32 - v.len()..].copy_from_slice(v);
    Some(a)
}

impl Prefixes {
    pub fn new(list: &[String]) -> Prefixes {
        let mut p = Prefixes::default();
        for pre in list {
            if pre.is_empty() || pre.starts_with('1') || pre.len() > 44 || bs58::decode(pre).into_vec().is_err() {
                p.slow.push(pre.clone());
                continue;
            }
            // A 32-byte key without a leading zero byte is 43 or 44 characters.
            for n in [43usize, 44] {
                if pre.len() > n {
                    continue;
                }
                let fill = n - pre.len();
                let lo = bs58::decode(format!("{pre}{}", "1".repeat(fill))).into_vec().ok().and_then(|v| pad32(&v));
                let Some(lo) = lo else { continue }; // past 32 bytes already
                let hi = bs58::decode(format!("{pre}{}", "z".repeat(fill))).into_vec().ok().and_then(|v| pad32(&v)).unwrap_or([0xff; 32]);
                p.ranges.push((lo, hi));
            }
        }
        p
    }

    pub fn is_empty(&self) -> bool {
        self.ranges.is_empty() && self.slow.is_empty()
    }

    pub fn matches(&self, k: &Pubkey) -> bool {
        let b = k.bytes();
        if b[0] != 0 {
            return self.ranges.iter().any(|(lo, hi)| b >= lo && b <= hi);
        }
        // A leading zero byte: the text starts with '1', which only the slow list can match (rare).
        !self.slow.is_empty() && {
            let t = k.b58();
            self.slow.iter().any(|p| t.starts_with(p.as_str()))
        }
    }
}

fn set(v: &[String]) -> HashSet<Pubkey> {
    v.iter().filter_map(|s| Pubkey::from_b58(s)).collect()
}

impl Snapshot {
    pub fn new(msg: StateMsg) -> Snapshot {
        let mut held = HashMap::new();
        let mut exited = HashMap::new();
        for (w, s) in &msg.wallets {
            if let Some(wk) = Pubkey::from_b58(w) {
                held.insert(wk, set(&s.held));
                exited.insert(wk, set(&s.exited));
            }
        }
        Snapshot {
            positions: set(&msg.positions),
            blocked_vaults: set(&msg.blocked_vaults),
            quote_mints: set(&msg.quote_mints),
            quote_prefixes: Prefixes::new(&msg.quote_prefixes),
            held,
            exited,
            received_at: now_ms(),
            msg,
        }
    }

    /// Does the copy wallet already hold this coin? None if not known.
    pub fn held(&self, wallet: &Pubkey, mint: &Pubkey) -> Option<bool> {
        let w = self.msg.wallets.get(&wallet.b58())?;
        if !w.holdings_loaded {
            return None;
        }
        Some(self.held.get(wallet).map(|s| s.contains(mint)).unwrap_or(false))
    }
}

/// A buy we're making or made that the Node bot hasn't accounted for yet.
pub struct Pending {
    pub id: u64,
    pub signature: String,
    pub mint: Pubkey,
    pub sol: f64,
    pub at: f64,
}

#[derive(Default)]
pub struct Local {
    next_id: u64,
    pub pending: Vec<Pending>,
    pub last_buy_at: f64,
}

impl Local {
    pub fn prune(&mut self, snap: &Snapshot) {
        let now = now_ms();
        let acked: HashSet<&String> = snap.msg.ack.iter().collect();
        self.pending.retain(|p| !(acked.contains(&p.signature) && !p.signature.is_empty()) && now - p.at < PENDING_MAX_MS);
    }
    fn pending_sol(&self) -> f64 {
        self.pending.iter().map(|p| p.sol).sum()
    }
    /// Count a buy against the caps (and its coin as being bought) now. Returns its id
    /// and the previous last-buy time (restored if it's given back).
    pub fn reserve(&mut self, mint: Pubkey, sol: f64) -> (u64, f64) {
        self.next_id += 1;
        let prev = self.last_buy_at;
        self.pending.push(Pending { id: self.next_id, signature: String::new(), mint, sol, at: now_ms() });
        self.last_buy_at = now_ms();
        (self.next_id, prev)
    }
    /// Nothing was sent after all: give the reservation back.
    pub fn release(&mut self, id: u64, prev_last_buy: f64) {
        self.pending.retain(|p| p.id != id);
        self.last_buy_at = prev_last_buy;
    }
    pub fn set_signature(&mut self, id: u64, sig: &str) {
        if let Some(p) = self.pending.iter_mut().find(|p| p.id == id) {
            p.signature = sig.to_string();
        }
    }
}

pub struct Decision {
    pub amount_sol: f64,
    pub fee_sol: f64,
    pub guard_max_slot: Option<u64>,
    pub rehearse: bool,
}

fn size(s: &Sizing, copy_sol: f64) -> Option<f64> {
    match s.mode.as_str() {
        "exact" => Some(copy_sol),
        "fixed" => Some(s.fixed),
        "tiers" => s.tiers.iter().find(|(max, _)| max.map(|m| copy_sol < m).unwrap_or(true)).map(|(_, a)| *a),
        _ => None,
    }
}

/// Should we buy `mint` after `wallet` bought `copy_sol` SOL of it in `slot`?
/// Err(reason) = leave it to the Node bot.
pub fn decide(snap: Option<&Snapshot>, local: &Local, wallet: &Pubkey, mint: &Pubkey, copy_sol: f64, slot: u64, creator_vault: Option<&Pubkey>, keys: &[Pubkey]) -> Result<Decision, String> {
    let Some(s) = snap else { return Err("no state from the Node bot yet".into()) };
    let m = &s.msg;
    let now = now_ms();
    if now - s.received_at > MAX_AGE_MS || now - m.at > MAX_AGE_MS + 1000.0 {
        return Err("the Node bot's state is stale".into());
    }
    if !m.fast_buy {
        return Err("fast buys are off (SHRED_FAST_BUY / DIRECT_PUMPFUN_SWAP / HAND_BUILT_BUYS)".into());
    }
    if !m.buying && !m.rehearse {
        return Err("buying is paused".into());
    }
    let Some(w) = m.wallets.get(&wallet.b58()) else { return Err("unknown copy wallet".into()) };
    if !w.allowed {
        return Err("buys from this wallet aren't being copied".into());
    }
    if s.positions.contains(mint) {
        return Err("a position in this coin is already open (or being bought)".into());
    }
    if local.pending.iter().any(|p| p.mint == *mint) {
        return Err("our own buy of this coin is still in flight".into());
    }
    if s.exited.get(wallet).map(|x| x.contains(mint)).unwrap_or(false) {
        return Err("the copy wallet exited this coin before (SKIP_REBUYS)".into());
    }
    if m.only_first_buy {
        match s.held(wallet, mint) {
            Some(false) => {}
            Some(true) => return Err("the copy wallet already held it (ONLY_COPY_FIRST_BUY)".into()),
            None => return Err("the copy wallet's holdings aren't loaded yet".into()),
        }
    }
    if copy_sol <= 0.0 || copy_sol < m.min_trade_sol {
        return Err("below MIN_TRADE_SOL".into());
    }
    if let Some(min) = m.min_copy_buy_sol {
        if copy_sol < min {
            return Err("below MIN_COPY_BUY_SOL".into());
        }
    }
    let Some(mut amount) = size(&m.sizing, copy_sol) else { return Err("unknown buy sizing".into()) };
    if amount > m.max_buy_sol {
        amount = m.max_buy_sol;
    }
    let room = m.room_sol - local.pending_sol();
    if amount > room {
        if room <= 0.0 || room < m.min_trade_sol {
            return Err("no room under MAX_TOTAL_EXPOSURE".into());
        }
        amount = room;
    }
    amount = (amount * 1e9).floor() / 1e9;
    match m.spendable_sol {
        Some(sp) if sp - local.pending_sol() >= amount => {}
        Some(_) => return Err("not enough SOL in the wallet".into()),
        None => return Err("wallet balance not known yet".into()),
    }
    let last = m.last_buy_at.max(local.last_buy_at);
    if m.cooldown_ms > 0.0 && last > 0.0 && now - last < m.cooldown_ms {
        return Err("within BUY_COOLDOWN_SEC of another buy".into());
    }
    if let Some(open) = m.open_slots {
        if open - local.pending.len() as i64 <= 0 {
            return Err("MAX_OPEN_POSITIONS reached".into());
        }
    }
    if m.max_mcap_sol.is_none() || m.min_mcap_set {
        return Err("needs a lookup (MAX_MARKET_CAP_SOL unset or MIN_MARKET_CAP_SOL set)".into());
    }
    let Some(vault) = creator_vault else { return Err("the coin's creator account isn't known".into()) };
    if s.blocked_vaults.contains(vault) {
        return Err("BLOCKED_CREATORS".into());
    }
    if keys.iter().any(|k| s.quote_mints.contains(k)) {
        return Err("his transaction involves a quote token (may not be SOL-paired)".into());
    }
    if !s.quote_prefixes.is_empty() && keys.iter().any(|k| s.quote_prefixes.matches(k)) {
        return Err("his transaction involves a stock token (may not be SOL-paired)".into());
    }
    let mut guard_max_slot = None;
    if let Some(n) = m.max_slots_behind {
        if !m.guard_available {
            return Err("slot guard not available".into());
        }
        guard_max_slot = Some(slot + n);
    }
    // LEADER_MAX_KM: every slot it could land in is led from too far away.
    let allowed = m.max_slots_behind.unwrap_or(0);
    if !m.far_slots.is_empty() && (slot..=slot + allowed).all(|x| m.far_slots.iter().any(|(a, b)| x >= *a && x <= *b)) {
        return Err("the slot leader is too far away (LEADER_MAX_KM)".into());
    }
    let pct_fee = if m.fees.buy_fee_pct > 0.0 { amount * (m.fees.buy_fee_pct / 100.0) } else { 0.0 };
    let fee_sol = m.fees.buy_fee_sol.max(pct_fee);
    Ok(Decision { amount_sol: amount, fee_sol, guard_max_slot, rehearse: !m.buying && m.rehearse })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prefix_ranges_match_the_text() {
        let list: Vec<String> = ["Xs", "Ab9", "z", "2", "11", "Xs3eBt"].iter().map(|x| x.to_string()).collect();
        let p = Prefixes::new(&list);
        let mut seed = 0x9e3779b97f4a7c15u64;
        let mut next = || {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            seed
        };
        let mut hits = 0;
        for i in 0..200_000 {
            let mut b = [0u8; 32];
            for c in b.chunks_mut(8) {
                c.copy_from_slice(&next().to_le_bytes());
            }
            if i % 50 == 0 {
                b[0] = 0;
            }
            // Some keys built to start with a listed prefix.
            if i % 7 == 0 {
                let pre = &list[i % list.len()];
                if let Ok(v) = bs58::decode(format!("{pre}{}", bs58::encode(&b[..]).into_string().get(pre.len()..).unwrap_or(""))).into_vec() {
                    if v.len() == 32 {
                        b.copy_from_slice(&v);
                    }
                }
            }
            let k = Pubkey(b);
            let t = k.b58();
            let want = list.iter().any(|x| t.starts_with(x.as_str()));
            assert_eq!(p.matches(&k), want, "{t}");
            hits += want as u32;
        }
        assert!(hits > 1000);
    }
}
