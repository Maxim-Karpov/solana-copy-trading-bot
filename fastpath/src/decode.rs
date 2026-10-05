//! The copy wallet's Pump.fun buy in one transaction, before it runs.
//! Port of the buy side of src/shredDecode.js: direct Pump.fun curve buys,
//! and router buys whose format the Node bot has learned (pushed to us).

use crate::keys::{find_pda, known, match_pda, Pubkey};
use crate::tx::Tx;
use serde::Deserialize;
use std::collections::{HashMap, HashSet};

pub const DISC_BUY: [u8; 8] = [0x66, 0x06, 0x3d, 0x12, 0x01, 0xda, 0xeb, 0xea];
pub const DISC_BUY_EXACT_SOL_IN: [u8; 8] = [0x38, 0xfc, 0x74, 0x08, 0x9e, 0xdf, 0xcd, 0x5f];
pub const DISC_SELL: [u8; 8] = [0x33, 0xe6, 0x85, 0xa4, 0x01, 0x7f, 0x83, 0xad];
const FAST_BUMPS: u8 = 8;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Router {
    pub program: String,
    pub tag: u8,
    pub status: String, // "buy" | "mixed" | "sell"
    pub offset: usize,
    pub ratio: f64,
    pub vault_index: Option<usize>,
}

#[derive(Default)]
pub struct Routers {
    by_key: HashMap<(Pubkey, u8), Router>,
}

#[allow(clippy::len_without_is_empty)]
impl Routers {
    pub fn set(&mut self, list: Vec<Router>) {
        self.by_key.clear();
        for r in list {
            if let Some(p) = Pubkey::from_b58(&r.program) {
                self.by_key.insert((p, r.tag), r);
            }
        }
    }
    pub fn len(&self) -> usize {
        self.by_key.len()
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum Pool {
    Curve,
}

#[derive(Clone, Debug)]
pub struct BuyIntent {
    pub mint: Pubkey,
    pub pool: Pool,
    pub sol_lamports: u64,
    pub approx: bool,
    pub via: String,
    pub creator_vault: Option<Pubkey>,
}

#[derive(Debug)]
pub enum Found {
    Buy(BuyIntent),
    /// A buy whose coin is known but which can't be copied from here (why).
    Unusable(String),
    /// Nothing to buy in it (a sell, a transfer, an unknown router...).
    Nothing,
}

fn u64_at(d: &[u8], off: usize) -> Option<u64> {
    d.get(off..off + 8).map(|s| u64::from_le_bytes(s.try_into().unwrap()))
}

fn not_router(p: &Pubkey) -> bool {
    *p == known::pump()
        || *p == known::pump_amm()
        || *p == known::system()
        || *p == known::compute_budget()
        || *p == known::token()
        || *p == known::token_2022()
        || *p == known::ata_program()
        || *p == known::memo()
        || *p == known::memo_v1()
}

/// The coin a router transaction buys on Pump.fun's curve: the account whose
/// bonding-curve address is also in the transaction.
pub fn find_curve_coin(keys: &[Pubkey], wallet: &Pubkey) -> Option<Pubkey> {
    let set: HashSet<Pubkey> = keys.iter().copied().collect();
    if !set.contains(&known::pump()) {
        return None;
    }
    let mut cands: Vec<Pubkey> = keys
        .iter()
        .copied()
        .filter(|k| k != wallet && !not_router(k) && *k != known::wsol())
        .collect();
    cands.dedup();
    // Most Pump.fun mints end in "pump": try those first.
    cands.sort_by_key(|k| if k.b58().ends_with("pump") { 0 } else { 1 });
    let seeds: Vec<Vec<&[u8]>> = cands.iter().map(|m| vec![b"bonding-curve".as_slice(), m.bytes().as_slice()]).collect();
    let present = |p: &Pubkey| set.contains(p);
    if let Some((_, i)) = match_pda(&seeds, &known::pump(), &present, FAST_BUMPS) {
        return Some(cands[i]);
    }
    // A curve with an unusually low bump: the full derivation.
    cands.into_iter().find(|m| set.contains(&find_pda(&[b"bonding-curve", m.bytes()], &known::pump())))
}

/// The first buy in `tx` by `wallet` that has an amount.
/// `held(mint)`: does the wallet already hold the coin (None = unknown).
pub fn find_buy(tx: &Tx, keys: &[Pubkey], wallet: &Pubkey, routers: &Routers, held: &dyn Fn(&Pubkey) -> Option<bool>) -> Found {
    let mut coin: Option<Option<Pubkey>> = None;
    let mut unusable: Option<String> = None;
    for ix in &tx.instructions {
        let Some(program) = keys.get(ix.program_id_index as usize) else { continue };
        let acc = |i: usize| ix.accounts.get(i).and_then(|&j| keys.get(j as usize)).copied();
        let data = &ix.data;
        if *program == known::pump() {
            if acc(6) != Some(*wallet) || data.len() < 8 {
                continue;
            }
            let Some(mint) = acc(2) else { continue };
            let disc = &data[..8];
            let (sol, approx) = if disc == DISC_BUY_EXACT_SOL_IN {
                (u64_at(data, 8), false)
            } else if disc == DISC_BUY {
                (u64_at(data, 16), true) // max SOL cost
            } else {
                continue;
            };
            if let Some(sol) = sol {
                return Found::Buy(BuyIntent { mint, pool: Pool::Curve, sol_lamports: sol, approx, via: "Pump.fun".into(), creator_vault: acc(9) });
            }
            continue;
        }
        if *program == known::pump_amm() {
            // PumpSwap buys are left to the Node bot.
            if acc(1) == Some(*wallet) && data.len() >= 8 && &data[..8] != DISC_SELL {
                unusable.get_or_insert_with(|| "a PumpSwap buy (built by the Node bot)".into());
            }
            continue;
        }
        if not_router(program) || data.len() < 9 {
            continue;
        }
        let Some(r) = routers.by_key.get(&(*program, data[0])) else { continue };
        if r.status != "buy" && r.status != "mixed" {
            continue;
        }
        let c = *coin.get_or_insert_with(|| find_curve_coin(keys, wallet));
        let Some(mint) = c else {
            unusable.get_or_insert_with(|| "router buy whose coin isn't on Pump.fun's curve".into());
            continue;
        };
        match held(&mint) {
            Some(false) => {}
            Some(true) => {
                unusable.get_or_insert_with(|| "the copy wallet already holds the coin".into());
                continue;
            }
            None => {
                unusable.get_or_insert_with(|| "the copy wallet's holdings aren't known yet".into());
                continue;
            }
        }
        let Some(v) = u64_at(data, r.offset).filter(|v| *v > 0) else { continue };
        let lamports = ((v as f64) * r.ratio).round() as u64;
        let creator_vault = r.vault_index.and_then(|i| ix.accounts.get(i)).and_then(|&j| keys.get(j as usize)).copied();
        let short = &r.program[..6.min(r.program.len())];
        return Found::Buy(BuyIntent { mint, pool: Pool::Curve, sol_lamports: lamports, approx: true, via: format!("router {short}…"), creator_vault });
    }
    match unusable {
        Some(why) => Found::Unusable(why),
        None => Found::Nothing,
    }
}
