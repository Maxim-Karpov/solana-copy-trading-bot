//! The SHRED_FAST_BUY Pump.fun buy, written straight into bytes.
//! Port of src/pumpBuyRaw.js; the Node bot checks our output against its own
//! byte for byte (the "practice" message) before letting us buy.

use crate::keys::{find_pda, known, match_pda, Pubkey};
use anyhow::{bail, Result};
use serde::Deserialize;
use std::collections::HashMap;

pub const BUY_ACCOUNTS: usize = 18;
pub const ROLE_FEE_RECIPIENT: usize = 1;
pub const ROLE_MINT: usize = 2;
pub const ROLE_BONDING_CURVE: usize = 3;
pub const ROLE_ASSOCIATED_BONDING_CURVE: usize = 4;
pub const ROLE_ASSOCIATED_USER: usize = 5;
pub const ROLE_USER: usize = 6;
pub const ROLE_TOKEN_PROGRAM: usize = 8;
pub const ROLE_CREATOR_VAULT: usize = 9;
pub const ROLE_BONDING_CURVE_V2: usize = 16;
const BUY_EXACT_SOL_IN: [u8; 8] = [0x38, 0xfc, 0x74, 0x08, 0x9e, 0xdf, 0xcd, 0x5f];
const FAST_BUMPS: u8 = 16;

#[derive(Clone, Copy, Debug)]
pub struct Meta {
    pub key: Pubkey,
    pub signer: bool,
    pub writable: bool,
}

/// What the Node bot sends: the SDK's own buy accounts for our wallet, and
/// the Pump.fun figures the minimum is worked out from.
#[derive(Clone, Debug)]
pub struct Template {
    pub user: Pubkey,
    pub accounts: Vec<Meta>,
    pub track_volume: u8,
    pub fee_recipients: Vec<Pubkey>,
    pub reserved_fee_recipients: Vec<Pubkey>,
    pub v_s0: u128,
    pub v_t0: u128,
    pub supply: u128,
    pub worst_fee_bps: u128,
    pub sender_tips: Vec<Pubkey>,
    pub jito_tips: Vec<Pubkey>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplateMsg {
    pub user: String,
    pub accounts: Vec<(String, bool, bool)>,
    pub track_volume: u8,
    pub fee_recipients: Vec<String>,
    pub reserved_fee_recipients: Vec<String>,
    pub min_out: MinOutMsg,
    #[serde(default)]
    pub sender_tips: Vec<String>,
    #[serde(default)]
    pub jito_tips: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MinOutMsg {
    pub v_s0: String,
    pub v_t0: String,
    pub supply: String,
    pub worst_fee_bps: u64,
}

impl Template {
    pub fn from_msg(m: &TemplateMsg) -> Result<Template> {
        let pk = |s: &str| Pubkey::from_b58(s).ok_or_else(|| anyhow::anyhow!("bad address {s}"));
        if m.accounts.len() != BUY_ACCOUNTS {
            bail!("template has {} accounts, expected {BUY_ACCOUNTS}", m.accounts.len());
        }
        let accounts = m.accounts.iter().map(|(k, s, w)| Ok(Meta { key: pk(k)?, signer: *s, writable: *w })).collect::<Result<Vec<_>>>()?;
        let user = pk(&m.user)?;
        if accounts[ROLE_USER].key != user {
            bail!("template is for another wallet");
        }
        let (v_s0, v_t0, supply): (u128, u128, u128) = (m.min_out.v_s0.parse()?, m.min_out.v_t0.parse()?, m.min_out.supply.parse()?);
        if v_s0 == 0 || v_t0 == 0 || supply == 0 {
            bail!("template has a zero curve constant");
        }
        if m.fee_recipients.is_empty() {
            bail!("template has no fee recipients");
        }
        Ok(Template {
            user,
            accounts,
            track_volume: m.track_volume,
            fee_recipients: m.fee_recipients.iter().map(|s| pk(s)).collect::<Result<_>>()?,
            reserved_fee_recipients: m.reserved_fee_recipients.iter().map(|s| pk(s)).collect::<Result<_>>()?,
            v_s0,
            v_t0,
            supply,
            worst_fee_bps: m.min_out.worst_fee_bps as u128,
            sender_tips: m.sender_tips.iter().map(|s| pk(s)).collect::<Result<_>>()?,
            jito_tips: m.jito_tips.iter().map(|s| pk(s)).collect::<Result<_>>()?,
        })
    }
}

fn isqrt(n: u128) -> u128 {
    if n < 2 {
        return n;
    }
    let mut x = (n as f64).sqrt() as u128;
    for _ in 0..6 {
        if x == 0 {
            break;
        }
        x = (x + n / x) >> 1;
    }
    while x.checked_mul(x).map_or(true, |v| v > n) {
        x -= 1;
    }
    while (x + 1).checked_mul(x + 1).is_some_and(|v| v <= n) {
        x += 1;
    }
    x
}

/// Tokens `lamports` buys if the curve stood at `max_mcap_sol` (min_tokens_out).
/// Same arithmetic as minTokensAtMcap in pumpfunDirect.js.
pub fn min_tokens_at_mcap(t: &Template, lamports: u64, max_mcap_sol: f64) -> u128 {
    // 0 (= don't buy) if anything is out of range rather than overflowing.
    let calc = || -> Option<u128> {
        if t.supply == 0 {
            return None;
        }
        let k = t.v_s0.checked_mul(t.v_t0)?;
        let mcap = (max_mcap_sol * 1e9).floor() as u128;
        let vs = isqrt(mcap.checked_mul(k)? / t.supply);
        if vs == 0 {
            return None;
        }
        let vt = k / vs;
        let net = (lamports as u128).checked_mul(10000)? / (10000 + t.worst_fee_bps);
        if net <= 1 {
            return None;
        }
        (net - 1).checked_mul(vt)?.checked_div(vs.checked_add(net - 1)?)
    };
    calc().unwrap_or(0)
}

pub struct CoinAccounts {
    pub curve: Pubkey,
    pub abc: Pubkey,
    pub curve_v2: Pubkey,
    pub token_program: Pubkey,
    pub associated_user: Pubkey,
}

/// The coin's own accounts: matched against his transaction where it has
/// them, derived otherwise. Err(reason) if the token program isn't clear.
pub fn coin_accounts(mint: &Pubkey, present: &(dyn Fn(&Pubkey) -> bool + Sync), user: &Pubkey, known_program: Option<Pubkey>) -> std::result::Result<CoinAccounts, String> {
    let pump = known::pump();
    let ata = known::ata_program();
    let curve = match_pda(&[vec![b"bonding-curve".as_slice(), mint.bytes().as_slice()]], &pump, present, FAST_BUMPS)
        .map(|(k, _)| k)
        .unwrap_or_else(|| find_pda(&[b"bonding-curve", mint.bytes()], &pump));
    let programs = match known_program {
        Some(p) => vec![p],
        None => vec![known::token(), known::token_2022()],
    };
    let cands: Vec<Vec<&[u8]>> = programs.iter().map(|p| vec![curve.bytes().as_slice(), p.bytes().as_slice(), mint.bytes().as_slice()]).collect();
    let (abc, token_program) = match match_pda(&cands, &ata, present, FAST_BUMPS) {
        Some((k, i)) => (k, programs[i]),
        None => match known_program {
            Some(p) => (find_pda(&[curve.bytes(), p.bytes(), mint.bytes()], &ata), p),
            None => return Err("the coin's token program isn't clear from his transaction".into()),
        },
    };
    let curve_v2 = match_pda(&[vec![b"bonding-curve-v2".as_slice(), mint.bytes().as_slice()]], &pump, present, FAST_BUMPS)
        .map(|(k, _)| k)
        .unwrap_or_else(|| find_pda(&[b"bonding-curve-v2", mint.bytes()], &pump));
    let associated_user = find_pda(&[user.bytes(), token_program.bytes(), mint.bytes()], &ata);
    Ok(CoinAccounts { curve, abc, curve_v2, token_program, associated_user })
}

pub struct Instruction {
    pub program: Pubkey,
    pub keys: Vec<Meta>,
    pub data: Vec<u8>,
}

fn write_compact(out: &mut Vec<u8>, mut n: usize) {
    while n >= 0x80 {
        out.push((n as u8 & 0x7f) | 0x80);
        n >>= 7;
    }
    out.push(n as u8);
}

/// A v0 message (no lookup tables), accounts ordered as web3.js orders them.
pub fn compile_v0(payer: &Pubkey, ixs: &[Instruction], blockhash: &[u8; 32]) -> Result<Vec<u8>> {
    let mut order: Vec<Pubkey> = Vec::with_capacity(32);
    let mut flags: HashMap<Pubkey, (bool, bool)> = HashMap::with_capacity(32);
    let mut add = |k: Pubkey, s: bool, w: bool| {
        let e = flags.entry(k).or_insert_with(|| {
            order.push(k);
            (false, false)
        });
        e.0 |= s;
        e.1 |= w;
    };
    add(*payer, true, true);
    for ix in ixs {
        add(ix.program, false, false);
        for m in &ix.keys {
            add(m.key, m.signer, m.writable);
        }
    }
    let f = |k: &Pubkey| flags[k];
    let mut ordered: Vec<Pubkey> = Vec::with_capacity(order.len());
    ordered.extend(order.iter().filter(|k| f(k) == (true, true)));
    ordered.extend(order.iter().filter(|k| f(k) == (true, false)));
    ordered.extend(order.iter().filter(|k| f(k) == (false, true)));
    ordered.extend(order.iter().filter(|k| f(k) == (false, false)));
    let index: HashMap<Pubkey, u8> = ordered.iter().enumerate().map(|(i, k)| (*k, i as u8)).collect();
    let num_signers = ordered.iter().filter(|k| f(k).0).count();
    let ro_signed = ordered.iter().filter(|k| f(k) == (true, false)).count();
    let ro_unsigned = ordered.iter().filter(|k| f(k) == (false, false)).count();

    let mut out = Vec::with_capacity(1232);
    out.push(0x80);
    out.push(num_signers as u8);
    out.push(ro_signed as u8);
    out.push(ro_unsigned as u8);
    write_compact(&mut out, ordered.len());
    for k in &ordered {
        out.extend_from_slice(k.bytes());
    }
    out.extend_from_slice(blockhash);
    write_compact(&mut out, ixs.len());
    for ix in ixs {
        out.push(index[&ix.program]);
        write_compact(&mut out, ix.keys.len());
        for m in &ix.keys {
            out.push(index[&m.key]);
        }
        write_compact(&mut out, ix.data.len());
        out.extend_from_slice(&ix.data);
    }
    write_compact(&mut out, 0);
    if out.len() > 1232 - 65 {
        bail!("transaction too large");
    }
    Ok(out)
}

/// Fees exactly as the SDK route ends up with them (see feePlan in pumpBuyRaw.js).
pub struct FeePlan {
    pub limit: u32,
    pub price: Option<u64>,
    pub price_first: bool,
    pub learned: bool,
}

/// JS's Math.ceil on a double: these figures are computed in floating point
/// on the Node side, and must come out identical.
fn ceil_f(x: f64) -> u64 {
    x.ceil() as u64
}

pub fn fee_plan(fee_sol: f64, ceiling: u32, use_sender: bool, learned_limit: Option<u32>) -> FeePlan {
    let mut limit = ceiling;
    let mut price = if fee_sol > 0.0 { Some(ceil_f((fee_sol * 1e9 * 1e6) / ceiling as f64)) } else { None };
    let fee_lamports = (fee_sol * 1e9).round();
    let mut learned = false;
    if let Some(l) = learned_limit {
        if l < ceiling {
            limit = l;
            learned = true;
            if price.is_some() && fee_lamports > 0.0 {
                price = Some(ceil_f((fee_lamports * 1e6) / limit as f64));
            }
        }
    }
    let mut price_first = false;
    if use_sender {
        let wanted = ceil_f((fee_sol * 1e9 * 1e6) / limit as f64);
        match price {
            None => {
                price = Some(wanted);
                price_first = true;
            }
            Some(p) if wanted > p => price = Some(wanted),
            _ => {}
        }
    }
    FeePlan { limit, price, price_first, learned }
}

pub struct BuyInput<'a> {
    pub template: &'a Template,
    pub mint: Pubkey,
    pub creator_vault: Pubkey,
    pub fee_recipient: Pubkey,
    pub lamports: u64,
    pub min_out: u64,
    pub plan: &'a FeePlan,
    pub guard_max_slot: Option<u64>,
    pub tip: Option<(Pubkey, u64)>,
    pub blockhash: [u8; 32],
}

pub struct BuiltBuy {
    pub message: Vec<u8>,
    pub token_program: Pubkey,
    pub guard_ix_index: Option<usize>,
}

/// Lighthouse "current slot <= max_slot" (slotGuard.js).
pub fn guard_data(max_slot: u64) -> Vec<u8> {
    let mut d = vec![15u8, 0, 0];
    d.extend_from_slice(&max_slot.to_le_bytes());
    d.push(5);
    d
}

pub fn build_buy(input: &BuyInput, acc: &CoinAccounts) -> Result<BuiltBuy> {
    let t = input.template;
    let user = t.user;
    let mut keys = t.accounts.clone();
    keys[ROLE_FEE_RECIPIENT].key = input.fee_recipient;
    keys[ROLE_MINT].key = input.mint;
    keys[ROLE_BONDING_CURVE].key = acc.curve;
    keys[ROLE_ASSOCIATED_BONDING_CURVE].key = acc.abc;
    keys[ROLE_ASSOCIATED_USER].key = acc.associated_user;
    keys[ROLE_TOKEN_PROGRAM].key = acc.token_program;
    keys[ROLE_CREATOR_VAULT].key = input.creator_vault;
    keys[ROLE_BONDING_CURVE_V2].key = acc.curve_v2;
    let mut data = Vec::with_capacity(25);
    data.extend_from_slice(&BUY_EXACT_SOL_IN);
    data.extend_from_slice(&input.lamports.to_le_bytes());
    data.extend_from_slice(&input.min_out.to_le_bytes());
    data.push(t.track_volume);

    let cb = known::compute_budget();
    let mut limit_data = vec![2u8];
    limit_data.extend_from_slice(&input.plan.limit.to_le_bytes());
    let mut ixs = vec![Instruction { program: cb, keys: vec![], data: limit_data }];
    if let Some(p) = input.plan.price {
        let mut d = vec![3u8];
        d.extend_from_slice(&p.to_le_bytes());
        let ix = Instruction { program: cb, keys: vec![], data: d };
        if input.plan.price_first {
            ixs.insert(0, ix);
        } else {
            ixs.push(ix);
        }
    }
    let guard_ix_index = input.guard_max_slot.map(|s| {
        ixs.push(Instruction { program: known::lighthouse(), keys: vec![], data: guard_data(s) });
        ixs.len() - 1
    });
    let m = |key: Pubkey, signer: bool, writable: bool| Meta { key, signer, writable };
    ixs.push(Instruction {
        program: known::ata_program(),
        keys: vec![
            m(user, true, true),
            m(acc.associated_user, false, true),
            m(user, false, false),
            m(input.mint, false, false),
            m(known::system(), false, false),
            m(acc.token_program, false, false),
        ],
        data: vec![1],
    });
    ixs.push(Instruction { program: known::pump(), keys, data });
    if let Some((account, lamports)) = input.tip {
        if lamports > 0 {
            let mut d = vec![2u8, 0, 0, 0];
            d.extend_from_slice(&lamports.to_le_bytes());
            ixs.push(Instruction { program: known::system(), keys: vec![m(user, true, true), m(account, false, true)], data: d });
        }
    }
    let message = compile_v0(&user, &ixs, &input.blockhash)?;
    Ok(BuiltBuy { message, token_program: acc.token_program, guard_ix_index })
}

/// computeBudget.kindOf's key for this buy.
pub fn kind_of(guarded: bool, token_program: &Pubkey) -> String {
    let t22 = if *token_program == known::token_2022() { "t22" } else { "spl" };
    format!("buy|{}AToken+6EF8rr|{t22}|a{BUY_ACCOUNTS}", if guarded { "L2TExM+" } else { "" })
}

/// The signed wire transaction: 1 signature, then the message.
pub fn wire(signature: &[u8; 64], message: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(1 + 64 + message.len());
    out.push(1);
    out.extend_from_slice(signature);
    out.extend_from_slice(message);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn isqrt_exact() {
        for n in [0u128, 1, 2, 3, 4, 15, 16, 17, 1 << 100, (1u128 << 100) + 12345] {
            let r = isqrt(n);
            assert!(r * r <= n && (r + 1) * (r + 1) > n);
        }
    }

    #[test]
    fn fee_plan_matches_node_arithmetic() {
        // 0.0015 SOL over 130,000 units: Math.ceil(0.0015*1e9*1e6/130000) in JS.
        let p = fee_plan(0.0015, 130000, true, None);
        assert_eq!(p.price, Some(11538462));
        assert_eq!(p.limit, 130000);
        let l = fee_plan(0.0015, 130000, true, Some(70000));
        assert_eq!(l.limit, 70000);
        assert!(l.learned);
        assert_eq!(l.price, Some(21428572));
    }

    #[test]
    fn guard_layout() {
        let d = guard_data(123456789);
        assert_eq!(d.len(), 12);
        assert_eq!(d[0], 15);
        assert_eq!(d[11], 5);
    }
}

#[cfg(test)]
mod bench {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};
    use std::collections::HashSet;
    use std::time::Instant;

    fn rnd(i: u64) -> Pubkey {
        use sha2::{Digest, Sha256};
        Pubkey(Sha256::digest(i.to_le_bytes()).into())
    }

    /// cargo test --release bench_build -- --nocapture
    #[test]
    fn bench_build() {
        let user = rnd(1);
        let mut accounts: Vec<Meta> = (0..BUY_ACCOUNTS as u64).map(|i| Meta { key: rnd(100 + i), signer: false, writable: i % 2 == 0 }).collect();
        accounts[ROLE_USER] = Meta { key: user, signer: true, writable: true };
        let t = Template {
            user,
            accounts,
            track_volume: 1,
            fee_recipients: vec![rnd(7)],
            reserved_fee_recipients: vec![],
            v_s0: 30_000_000_000,
            v_t0: 1_073_000_000_000_000,
            supply: 1_000_000_000_000_000,
            worst_fee_bps: 125,
            sender_tips: vec![rnd(8)],
            jito_tips: vec![],
        };
        let sk = SigningKey::from_bytes(&[9u8; 32]);
        let n = 20000;
        let mut times = Vec::with_capacity(n);
        for i in 0..n as u64 {
            let mint = rnd(1_000_000 + i);
            let curve = find_pda(&[b"bonding-curve", mint.bytes()], &known::pump());
            let abc = find_pda(&[curve.bytes(), known::token_2022().bytes(), mint.bytes()], &known::ata_program());
            let v2 = find_pda(&[b"bonding-curve-v2", mint.bytes()], &known::pump());
            let set: HashSet<Pubkey> = [curve, abc, v2, rnd(7)].into_iter().collect();
            let present = |k: &Pubkey| set.contains(k);
            let t0 = Instant::now();
            let acc = coin_accounts(&mint, &present, &user, None).unwrap();
            let plan = fee_plan(0.0015, 130000, true, None);
            let min_out = min_tokens_at_mcap(&t, 50_000_000, 300.0) as u64;
            let input = BuyInput { template: &t, mint, creator_vault: rnd(5), fee_recipient: rnd(7), lamports: 50_000_000, min_out, plan: &plan, guard_max_slot: Some(123), tip: Some((rnd(8), 1_600_000)), blockhash: [3u8; 32] };
            let b = build_buy(&input, &acc).unwrap();
            let sig = sk.sign(&b.message).to_bytes();
            let w = wire(&sig, &b.message);
            std::hint::black_box(w);
            times.push(t0.elapsed().as_secs_f64() * 1e6);
        }
        times.sort_by(|a, b| a.partial_cmp(b).unwrap());
        println!("build+sign: median {:.1} us, p99 {:.1} us, max {:.1} us", times[n / 2], times[n * 99 / 100], times[n - 1]);
    }
}
