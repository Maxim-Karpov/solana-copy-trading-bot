//! fastpath: the race part of the copy-trading bot, in Rust.
//!
//! Shred feed -> the copy wallet's Pump.fun buy -> decision (from the Node
//! bot's state) -> buy written into bytes -> signed -> sent. Everything else
//! (positions, sells, Telegram, anything we're not sure about) stays with
//! the Node bot, which gets every transaction we see, and what we did.

mod buy;
mod config;
mod decode;
mod feeds;
mod keys;
mod link;
mod state;
mod tx;

use base64::Engine;
use ed25519_dalek::Signer;
use keys::Pubkey;
use rand::Rng;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::Instant;

pub fn log(text: &str) {
    let now = chrono_like();
    println!("[{now}] [fastpath] {text}");
}

fn chrono_like() -> String {
    let ms = state::now_ms() as u64;
    let secs = ms / 1000;
    let (h, m, s) = ((secs / 3600) % 24, (secs / 60) % 60, secs % 60);
    format!("{h:02}:{m:02}:{s:02}.{:03}", ms % 1000)
}

const MAX_ROUTER_SOL_CURVE: f64 = 200.0;

thread_local! {
    /// Inside a practice build (whose panic is caught and reported, not fatal).
    static IN_PRACTICE: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// Any other panic stops the program (pm2 restarts it). Carrying on could
/// leave it linked but deaf: a feed task gone, or the shared state's lock
/// poisoned, while the Node bot still thinks everything's up.
fn exit_on_panic() {
    let default = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        default(info);
        if !IN_PRACTICE.with(|f| f.get()) {
            eprintln!("[fastpath] Stopping after an unexpected error (pm2 restarts it).");
            std::process::exit(1);
        }
    }));
}
const TABLE_REFETCH_MS: f64 = 5000.0;
/// A blockhash older than this may expire before the buy lands (they last ~60 s).
const BLOCKHASH_MAX_AGE_SECS: u64 = 45;

struct Shared {
    snapshot: Option<state::Snapshot>,
    local: state::Local,
    template: Option<Arc<buy::Template>>,
    verified: bool,
    /// The latest blockhash from the Node bot, and when it arrived.
    blockhash: Option<([u8; 32], Instant)>,
    routers: decode::Routers,
    tables: HashMap<Pubkey, Vec<Pubkey>>,
    table_fetched: HashMap<Pubkey, f64>,
    seen: HashMap<String, (&'static str, Instant)>,
    seen_order: VecDeque<String>,
    known_programs: HashMap<Pubkey, Pubkey>, // mint -> token program, once seen
    plain_used: HashSet<Pubkey>, // mints this program made a plain token account for (TOKEN_ACCOUNT_MODE=plain)
}

/// A buy report: complete, or built when needed (one saved just before the
/// send, so a crash mid-send can't lose it, without slowing the send down).
#[derive(Clone)]
enum Report {
    Done(Value),
    Lazy(Arc<dyn Fn() -> Value + Send + Sync>),
}

impl Report {
    fn value(&self) -> Value {
        match self {
            Report::Done(v) => v.clone(),
            Report::Lazy(f) => f(),
        }
    }
}

/// Buys the Node bot hasn't saved yet (their reports), kept on disk too, so a
/// restart of either side can't lose track of one. Written by one background
/// task, always with the current list.
struct Unacked {
    list: Vec<(String, Report)>,
    dirty: tokio::sync::mpsc::UnboundedSender<()>,
}

impl Unacked {
    fn load(file: &std::path::Path) -> Vec<(String, Value)> {
        std::fs::read_to_string(file).ok().and_then(|t| serde_json::from_str::<Vec<(String, Value)>>(&t).ok()).unwrap_or_default()
    }
    fn json(&self) -> String {
        let v: Vec<(String, Value)> = self.list.iter().map(|(s, r)| (s.clone(), r.value())).collect();
        serde_json::to_string(&v).unwrap_or_default()
    }
    fn put(&mut self, sig: String, report: Report) {
        match self.list.iter_mut().find(|(s, _)| *s == sig) {
            Some(e) => e.1 = report,
            None => self.list.push((sig, report)),
        }
        let _ = self.dirty.send(());
    }
    fn remove(&mut self, sigs: &[String]) {
        let before = self.list.len();
        self.list.retain(|(s, _)| !sigs.contains(s));
        if self.list.len() != before {
            let _ = self.dirty.send(());
        }
    }
}

fn spawn_saver(file: std::path::PathBuf, unacked: Arc<Mutex<Unacked>>, mut dirty: tokio::sync::mpsc::UnboundedReceiver<()>) {
    tokio::spawn(async move {
        while dirty.recv().await.is_some() {
            while dirty.try_recv().is_ok() {}
            let text = unacked.lock().unwrap().json();
            let f = file.clone();
            let _ = tokio::task::spawn_blocking(move || {
                if let Some(dir) = f.parent() {
                    let _ = std::fs::create_dir_all(dir);
                }
                let tmp = f.with_extension("tmp");
                if std::fs::write(&tmp, text).is_ok() {
                    let _ = std::fs::rename(&tmp, &f);
                }
            })
            .await;
        }
    });
}

#[allow(clippy::too_many_arguments)]
fn report_json(source: &str, slot: u64, at_ms: f64, epoch_ms: f64, sig: &str, wallet: &Pubkey, t: &tx::Tx, keys: Option<&Vec<Pubkey>>, outcome: &Value, marks: &Value) -> Value {
    json!({
        "type": "tx", "source": source, "slot": slot, "at": at_ms, "seenAt": epoch_ms,
        "signature": sig, "wallet": wallet.b58(), "tx": tx_json(t), "keys": keys.map(|k| k.iter().map(|x| x.b58()).collect::<Vec<_>>()), "outcome": outcome, "marks": marks,
    })
}

struct App {
    cfg: config::Config,
    shared: Mutex<Shared>,
    feed_states: Arc<Mutex<HashMap<String, String>>>,
    unacked: Arc<Mutex<Unacked>>,
    sender: send::Sender,
    out: tokio::sync::mpsc::UnboundedSender<Value>,
    linked: Arc<std::sync::atomic::AtomicBool>,
    started: Instant,
}

mod send;

fn b64(b: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(b)
}

fn tx_json(t: &tx::Tx) -> Value {
    json!({
        "signature": t.signature_b58(),
        "numSigners": t.num_signers,
        "version": match t.version { tx::Version::Legacy => json!("legacy"), tx::Version::V0 => json!(0), tx::Version::V1 => json!(1) },
        "staticKeys": t.static_keys.iter().map(|k| b64(k.bytes())).collect::<Vec<_>>(),
        "instructions": t.instructions.iter().map(|ix| json!({ "programIdIndex": ix.program_id_index, "accounts": ix.accounts, "data": b64(&ix.data) })).collect::<Vec<_>>(),
        "lookups": t.lookups.iter().map(|l| json!({ "key": b64(l.key.bytes()), "writable": l.writable, "readonly": l.readonly })).collect::<Vec<_>>(),
    })
}

impl App {
    fn ms_since_start(&self, t: Instant) -> f64 {
        t.duration_since(self.started).as_secs_f64() * 1000.0
    }

    fn send_node(&self, v: Value) {
        // Not queued while the Node bot is away (its unsaved buys are resent on connect).
        if self.linked.load(std::sync::atomic::Ordering::Acquire) {
            let _ = self.out.send(v);
        }
    }

    async fn keys_for(&self, t: &tx::Tx) -> Option<Vec<Pubkey>> {
        {
            let s = self.shared.lock().unwrap();
            if let Some(k) = tx::resolve_keys(t, &s.tables) {
                return Some(k);
            }
        }
        // A lookup table we don't have (or that has grown): fetch it.
        for l in &t.lookups {
            let stale = {
                let s = self.shared.lock().unwrap();
                let last = s.table_fetched.get(&l.key).copied().unwrap_or(0.0);
                !s.tables.contains_key(&l.key) || state::now_ms() - last > TABLE_REFETCH_MS
            };
            if !stale {
                continue;
            }
            if let Some(data) = self.sender.account_data(&l.key.b58()).await {
                if data.len() >= 56 {
                    let addrs: Vec<Pubkey> = data[56..].chunks_exact(32).filter_map(Pubkey::from_slice).collect();
                    let mut s = self.shared.lock().unwrap();
                    s.tables.insert(l.key, addrs);
                    s.table_fetched.insert(l.key, state::now_ms());
                }
            }
        }
        let s = self.shared.lock().unwrap();
        tx::resolve_keys(t, &s.tables)
    }

    /// One copy-wallet transaction, first time seen.
    async fn handle(self: Arc<Self>, source: &'static str, slot: u64, at: Instant, epoch_ms: f64, t: tx::Tx, wallet: Pubkey) {
        let sig = t.signature_b58().unwrap_or_default();
        let mark = |x: Instant| x.duration_since(at).as_secs_f64() * 1000.0;
        let keys = self.keys_for(&t).await;
        let t_keys = Instant::now();
        let mut outcome = json!({ "status": "none" });
        let mut marks = json!({ "keys": mark(t_keys), "tablesFetched": !t.lookups.is_empty() });
        if let Some(keys) = keys.as_ref() {
            let found = {
                let s = self.shared.lock().unwrap();
                let held = |m: &Pubkey| s.snapshot.as_ref().and_then(|sn| sn.held(&wallet, m));
                decode::find_buy(&t, keys, &wallet, &s.routers, &held)
            };
            let t_classified = Instant::now();
            marks["classified"] = json!(mark(t_classified));
            match found {
                decode::Found::Nothing => {}
                decode::Found::Unusable(why) => outcome = json!({ "status": "declined", "reason": why }),
                decode::Found::Buy(b) => {
                    outcome = self.clone().try_buy(&b, keys, &wallet, slot, at, epoch_ms, &sig, &mut marks, &t, source).await;
                }
            }
        } else {
            outcome = json!({ "status": "declined", "reason": "couldn't resolve its address lookup tables" });
        }
        let report = report_json(source, slot, self.ms_since_start(at), epoch_ms, &sig, &wallet, &t, keys.as_ref(), &outcome, &marks);
        if report["outcome"]["status"] == "bought" {
            // Kept until the Node bot says it has saved the position.
            let ours = report["outcome"]["signature"].as_str().unwrap_or_default().to_string();
            self.unacked.lock().unwrap().put(ours, Report::Done(report.clone()));
        }
        self.send_node(report);
    }

    #[allow(clippy::too_many_arguments)]
    async fn try_buy(self: Arc<Self>, b: &decode::BuyIntent, keys: &[Pubkey], wallet: &Pubkey, slot: u64, at: Instant, epoch_ms: f64, his_sig: &str, marks: &mut Value, t: &tx::Tx, source: &'static str) -> Value {
        let mark = |x: Instant| x.duration_since(at).as_secs_f64() * 1000.0;
        let decline = |why: &str| json!({ "status": "declined", "reason": why, "mint": b.mint.b58() });
        let copy_sol = b.sol_lamports as f64 / 1e9;
        if b.approx && copy_sol > MAX_ROUTER_SOL_CURVE {
            return decline("the router amount read is larger than any real buy");
        }
        if b.pool != decode::Pool::Curve {
            return decline("not a Pump.fun curve buy");
        }
        let key_set: HashSet<Pubkey> = keys.iter().copied().collect();
        // Everything decided and reserved under one lock, so two buys arriving
        // together can't both take the last of the room.
        let prepared = {
            let mut guard = self.shared.lock().unwrap();
            let s = &mut *guard;
            if let Some(sn) = s.snapshot.as_ref() {
                s.local.prune(sn);
            }
            let Some(template) = s.template.clone() else { return decline("no buy template from the Node bot yet") };
            if !s.verified {
                return decline("not yet checked against the Node bot's build");
            }
            let Some((blockhash, bh_at)) = s.blockhash else { return decline("no recent blockhash yet") };
            if bh_at.elapsed().as_secs() > BLOCKHASH_MAX_AGE_SECS {
                return decline("the blockhash from the Node bot is too old");
            }
            // Mayhem-mode coins (non-standard supply): only when his buy used a normal fee recipient.
            if template.reserved_fee_recipients.iter().any(|k| key_set.contains(k)) {
                return decline("mayhem-mode coin (non-standard supply)");
            }
            if !template.fee_recipients.iter().any(|k| key_set.contains(k)) {
                return decline("can't tell from his transaction whether it's a mayhem-mode coin");
            }
            let d = match state::decide(s.snapshot.as_ref(), &s.local, wallet, &b.mint, copy_sol, slot, b.creator_vault.as_ref(), keys) {
                Ok(d) => d,
                Err(why) => return decline(&why),
            };
            let snap = s.snapshot.as_ref().unwrap();
            if snap.msg.fees.use_sender != self.cfg.use_sender {
                return decline("SEND_VIA differs between the Node bot and the fast path (restart both after changing .env)");
            }
            let fees = snap.msg.fees.clone();
            let max_mcap = snap.msg.max_mcap_sol.unwrap_or(0.0);
            let limits = snap.msg.compute_limits.clone();
            let known_program = s.known_programs.get(&b.mint).copied();
            let max_slots_behind = snap.msg.max_slots_behind;
            let reservation = if d.rehearse { None } else { Some(s.local.reserve(b.mint, d.amount_sol)) };
            (template, blockhash, d, fees, max_mcap, limits, known_program, reservation, max_slots_behind)
        };
        let (template, blockhash, d, fees, max_mcap, limits, known_program, reservation, max_slots_behind) = prepared;
        let t_decided = Instant::now();
        marks["decide"] = json!(mark(t_decided));
        if !d.rehearse {
            // His transaction is ours now: the Node bot's other feeds leave it
            // alone, and it counts this buy against its caps straight away.
            self.send_node(json!({ "type": "claim", "his": his_sig, "mint": b.mint.b58(), "amountSol": d.amount_sol }));
        }
        let release = |app: &App| {
            if let Some((id, prev)) = reservation {
                app.shared.lock().unwrap().local.release(id, prev);
            }
            if !d.rehearse {
                app.send_node(json!({ "type": "unclaim", "his": his_sig }));
            }
        };

        let lamports = (d.amount_sol * 1e9).round() as u64;
        let min_out = buy::min_tokens_at_mcap(&template, lamports, max_mcap);
        if min_out == 0 || min_out > u64::MAX as u128 {
            release(&self);
            return decline("buy too small to set a minimum");
        }
        let present = |k: &Pubkey| key_set.contains(k);
        let fee_recipient = template.fee_recipients[rand::thread_rng().gen_range(0..template.fee_recipients.len())];
        let pick = |list: &[Pubkey]| list[rand::thread_rng().gen_range(0..list.len())];
        let tip = if fees.use_sender && !template.sender_tips.is_empty() {
            Some((pick(&template.sender_tips), (fees.sender_tip * 1e9).round() as u64))
        } else if !fees.use_sender && fees.jito_tip > 0.0 && !template.jito_tips.is_empty() {
            Some((pick(&template.jito_tips), (fees.jito_tip * 1e9).round() as u64))
        } else if fees.use_sender {
            release(&self);
            return decline("no Sender tip accounts from the Node bot");
        } else {
            None
        };
        let acc = match buy::coin_accounts(&b.mint, &present, &template.user, known_program) {
            Ok(a) => a,
            Err(why) => {
                release(&self);
                return decline(&why);
            }
        };
        let plain = {
            let s = self.shared.lock().unwrap();
            buy::plain_plan(&template, &b.mint, &acc.token_program, &|m| s.plain_used.contains(m))
        };
        let kind = buy::kind_of(d.guard_max_slot.is_some(), &acc.token_program, plain.as_ref());
        let plan = buy::fee_plan(d.fee_sol, fees.ceiling, fees.use_sender, limits.get(&kind).copied());
        let input = buy::BuyInput {
            template: &template,
            mint: b.mint,
            creator_vault: b.creator_vault.unwrap(),
            fee_recipient,
            lamports,
            min_out: min_out as u64,
            plan: &plan,
            guard_max_slot: d.guard_max_slot,
            tip,
            blockhash,
            plain: plain.as_ref(),
        };
        let built = match buy::build_buy(&input, &acc) {
            Ok(x) => x,
            Err(e) => {
                release(&self);
                return decline(&format!("couldn't build it ({e})"));
            }
        };
        let t_built = Instant::now();
        let signature: [u8; 64] = self.cfg.signing_key.sign(&built.message).to_bytes();
        let wire = buy::wire(&signature, &built.message);
        let sig_b58 = bs58::encode(signature).into_string();
        let t_signed = Instant::now();
        marks["built"] = json!(mark(t_built));
        marks["signed"] = json!(mark(t_signed));
        let common = json!({
            "mint": b.mint.b58(), "amountSol": d.amount_sol, "copySol": copy_sol, "approx": b.approx, "signature": sig_b58, "his": his_sig, "via": b.via,
            "buildMs": (t_signed - t_decided).as_secs_f64() * 1000.0,
            "readyMs": mark(t_signed),
            "guard": d.guard_max_slot.map(|m| json!({ "maxSlot": m, "ixIndex": built.guard_ix_index })),
            "compute": { "kind": kind, "limit": plan.limit, "learned": plan.learned, "feeSol": d.fee_sol },
            "minOut": min_out.to_string(), "maxMcapSol": max_mcap, "tokenProgram": built.token_program.b58(), "plain": plain.is_some(),
        });
        if d.rehearse {
            let mut o = common;
            o["status"] = json!("rehearsed");
            return o;
        }
        // Too late for the slot guard already: don't pay a fee for a buy it would cancel.
        // (Read under the decision's lock above: locking again here while
        // release() also locks would deadlock.)
        if let Some(n) = max_slots_behind {
            let late = state::now_ms() - epoch_ms;
            if late > (n as f64 + 1.0) * state::SLOT_MS {
                release(&self);
                return decline("too late to land within MAX_SLOTS_BEHIND");
            }
        }
        {
            let mut s = self.shared.lock().unwrap();
            if let Some((id, _)) = reservation {
                s.local.set_signature(id, &sig_b58);
            }
            s.known_programs.insert(b.mint, built.token_program);
            if plain.is_some() {
                s.plain_used.insert(b.mint);
            }
        }
        let sent_at = state::now_ms();
        {
            // Kept before sending (built only when needed, off the hot path):
            // if this program stops mid-send, the Node bot still hears of it.
            let mut o = common.clone();
            o["status"] = json!("bought");
            o["sentAt"] = json!(sent_at);
            o["ambiguous"] = json!("the fast path stopped before Sender answered");
            let (t2, keys2, w2, his2, at_ms, m2) = (t.clone(), keys.to_vec(), *wallet, his_sig.to_string(), self.ms_since_start(at), marks.clone());
            let f: Arc<dyn Fn() -> Value + Send + Sync> = Arc::new(move || report_json(source, slot, at_ms, epoch_ms, &his2, &w2, &t2, Some(&keys2), &o, &m2));
            self.unacked.lock().unwrap().put(sig_b58.clone(), Report::Lazy(f));
        }
        let t_send = Instant::now();
        let result = self.sender.send(&wire, &sig_b58).await;
        let send_ms = t_send.elapsed().as_secs_f64() * 1000.0;
        marks["sent"] = json!(mark(t_send));
        let mut o = common;
        o["sentAt"] = json!(sent_at);
        o["sendMs"] = json!(send_ms);
        match result {
            Ok(_) => {
                o["status"] = json!("bought");
                log(&format!("BUY sent: {} SOL of {} ({}), {:.2} ms from seeing his buy to sending ours: {sig_b58}", d.amount_sol, b.mint, b.via, mark(t_send)));
            }
            Err(send::SendError::Ambiguous(e)) => {
                o["status"] = json!("bought");
                o["ambiguous"] = json!(e);
                log(&format!("BUY {sig_b58}: send outcome unknown ({e}); the Node bot follows it."));
            }
            Err(send::SendError::Refused(e)) => {
                release(&self);
                self.unacked.lock().unwrap().remove(std::slice::from_ref(&sig_b58));
                o["status"] = json!("failed");
                o["reason"] = json!(e);
                log(&format!("BUY of {} refused: {e}", b.mint));
            }
        }
        o
    }

    fn on_node_message(&self, v: Value) {
        let kind = v["type"].as_str().unwrap_or("").to_string();
        // Parsed before taking the lock, so a buy deciding meanwhile isn't kept waiting.
        match kind.as_str() {
            "state" => {
                match serde_json::from_value::<state::StateMsg>(v) {
                    Ok(m) => {
                        if !m.saved.is_empty() {
                            self.unacked.lock().unwrap().remove(&m.saved);
                        }
                        let snap = state::Snapshot::new(m);
                        self.shared.lock().unwrap().snapshot = Some(snap);
                    }
                    Err(e) => log(&format!("Unreadable state from the Node bot: {e}")),
                }
                return;
            }
            "template" => {
                match serde_json::from_value::<buy::TemplateMsg>(v).map_err(anyhow::Error::from).and_then(|m| buy::Template::from_msg(&m)) {
                    Ok(t) => {
                        if t.user != self.cfg.wallet {
                            log("The Node bot's template is for another wallet; ignoring it.");
                        } else {
                            self.shared.lock().unwrap().template = Some(Arc::new(t));
                        }
                    }
                    Err(e) => log(&format!("Unreadable buy template: {e}")),
                }
                return;
            }
            "practice" => {
                let reply = self.practice(&v);
                self.send_node(reply);
                return;
            }
            _ => {}
        }
        let mut s = self.shared.lock().unwrap();
        match kind.as_str() {
            "verified" => {
                let ok = v["ok"].as_bool().unwrap_or(false);
                if ok != s.verified {
                    log(if ok { "Checked against the Node bot's build: identical. Buying from here." } else { "The Node bot's check failed: not buying from here." });
                }
                s.verified = ok;
                if !ok {
                    if let Some(why) = v["why"].as_str() {
                        log(why);
                    }
                }
            }
            "blockhash" => {
                if let Some(bh) = v["value"].as_str().and_then(Pubkey::from_b58) {
                    // Dated from when the Node bot fetched it.
                    let age = std::time::Duration::from_millis(v["ageMs"].as_f64().unwrap_or(0.0).clamp(0.0, 600_000.0) as u64);
                    let fetched = Instant::now().checked_sub(age).unwrap_or_else(Instant::now);
                    s.blockhash = Some((bh.0, fetched));
                }
            }
            "routers" => match serde_json::from_value::<Vec<decode::Router>>(v["list"].clone()) {
                Ok(list) => {
                    let before = s.routers.len();
                    s.routers.set(list);
                    if s.routers.len() != before {
                        log(&format!("{} learned router instruction(s) from the Node bot.", s.routers.len()));
                    }
                }
                Err(e) => log(&format!("Unreadable router list: {e}")),
            },
            "tables" => {
                if let Some(map) = v["tables"].as_object() {
                    for (k, addrs) in map {
                        if let (Some(key), Some(arr)) = (Pubkey::from_b58(k), addrs.as_array()) {
                            let list: Vec<Pubkey> = arr.iter().filter_map(|a| a.as_str().and_then(Pubkey::from_b58)).collect();
                            s.tables.insert(key, list);
                            s.table_fetched.insert(key, state::now_ms());
                        }
                    }
                }
            }
            "disconnected" => {
                // Without the Node bot nothing is bought from here.
                s.snapshot = None;
                s.verified = false;
            }
            _ => {}
        }
    }

    /// A feed event, handled in the feed's own task (the buy itself gets its own task).
    fn on_feed(self: &Arc<Self>, ev: feeds::FeedEvent) {
        let app = self;
        match ev {
            feeds::FeedEvent::State { source, state, detail } => {
                app.feed_states.lock().unwrap().insert(source.to_string(), state.to_string());
                log(&format!("{source}: {state}{}", if detail.is_empty() { String::new() } else { format!(" ({detail})") }));
                app.send_node(json!({ "type": "feed", "source": source, "state": state, "detail": detail }));
            }
            feeds::FeedEvent::Unreadable { source, why } => app.send_node(json!({ "type": "unreadable", "source": source, "why": why })),
            feeds::FeedEvent::Tx { source, slot, at, epoch_ms, tx } => {
                // Only the copy wallets' own transactions (the filters also
                // deliver ones that merely mention them).
                let Some(wallet) = tx.signer_among(&app.cfg.copy_wallets) else { return };
                let Some(sig) = tx.signature_b58() else { return };
                let first = {
                    let mut s = app.shared.lock().unwrap();
                    if let Some((first_src, _)) = s.seen.get(&sig) {
                        if *first_src == source {
                            false
                        } else {
                            drop(s);
                            app.send_node(json!({ "type": "seen", "source": source, "signature": sig, "at": app.ms_since_start(at), "slot": slot }));
                            return;
                        }
                    } else {
                        s.seen.insert(sig.clone(), (source, at));
                        s.seen_order.push_back(sig.clone());
                        if s.seen_order.len() > 5000 {
                            if let Some(old) = s.seen_order.pop_front() {
                                s.seen.remove(&old);
                            }
                        }
                        true
                    }
                };
                if !first {
                    return; // a repeat from the same source
                }
                tokio::spawn(app.clone().handle(source, slot, at, epoch_ms, tx, wallet));
            }
        }
    }

    /// Build a buy from explicit inputs, for the Node bot to compare with its own.
    fn practice(&self, v: &Value) -> Value {
        let id = v["id"].clone();
        IN_PRACTICE.with(|f| f.set(true));
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| -> anyhow::Result<Value> {
            let i = &v["input"];
            let s = self.shared.lock().unwrap();
            let template = s.template.clone().ok_or_else(|| anyhow::anyhow!("no template"))?;
            drop(s);
            let pk = |x: &Value| x.as_str().and_then(Pubkey::from_b58).ok_or_else(|| anyhow::anyhow!("bad address"));
            let keys: HashSet<Pubkey> = i["txKeys"].as_array().cloned().unwrap_or_default().iter().filter_map(|k| k.as_str().and_then(Pubkey::from_b58)).collect();
            let present = |k: &Pubkey| keys.contains(k);
            let mint = pk(&i["mint"])?;
            let known_program = i["knownTokenProgram"].as_str().and_then(Pubkey::from_b58);
            let lamports: u64 = i["lamports"].as_str().unwrap_or("0").parse()?;
            let max_mcap = i["maxMcapSol"].as_f64().unwrap_or(0.0);
            let min_out = u64::try_from(buy::min_tokens_at_mcap(&template, lamports, max_mcap)).map_err(|_| anyhow::anyhow!("minimum out of range"))?;
            let f = &i["fees"];
            let acc = buy::coin_accounts(&mint, &present, &template.user, known_program).map_err(|e| anyhow::anyhow!(e))?;
            let guard = i["guardMaxSlot"].as_u64();
            let plain = buy::plain_plan(&template, &mint, &acc.token_program, &|_| false);
            let kind = buy::kind_of(guard.is_some(), &acc.token_program, plain.as_ref());
            let plan = buy::fee_plan(f["feeSol"].as_f64().unwrap_or(0.0), f["ceiling"].as_u64().unwrap_or(0) as u32, f["useSender"].as_bool().unwrap_or(false), f["learnedLimit"].as_u64().map(|x| x as u32));
            let tip = if i["tip"].is_null() { None } else { Some((pk(&i["tip"]["account"])?, i["tip"]["lamports"].as_u64().unwrap_or(0))) };
            let input = buy::BuyInput {
                template: &template,
                mint,
                creator_vault: pk(&i["creatorVault"])?,
                fee_recipient: pk(&i["feeRecipient"])?,
                lamports,
                min_out,
                plan: &plan,
                guard_max_slot: guard,
                tip,
                blockhash: pk(&i["blockhash"])?.0,
                plain: plain.as_ref(),
            };
            let t0 = Instant::now();
            let built = buy::build_buy(&input, &acc)?;
            let signature = self.cfg.signing_key.sign(&built.message).to_bytes();
            let wire = buy::wire(&signature, &built.message);
            let us = t0.elapsed().as_secs_f64() * 1e6;
            Ok(json!({ "ok": true, "wire": b64(&wire), "kind": kind, "limit": plan.limit, "learned": plan.learned, "minOut": min_out.to_string(), "buildUs": us }))
        }))
        .unwrap_or_else(|_| Err(anyhow::anyhow!("the practice build panicked")));
        IN_PRACTICE.with(|f| f.set(false));
        match r {
            Ok(mut o) => {
                o["type"] = json!("practiceResult");
                o["id"] = id;
                o
            }
            Err(e) => json!({ "type": "practiceResult", "id": id, "ok": false, "error": e.to_string() }),
        }
    }
}

#[tokio::main(flavor = "multi_thread", worker_threads = 2)]
async fn main() {
    exit_on_panic();
    let cfg = match config::load() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[fastpath] Not started: {e:#}");
            std::process::exit(1);
        }
    };
    if !cfg.enabled {
        log(&format!("FAST_PATH isn't \"rust\" in {}: not starting (nothing to do).", cfg.env_file.display()));
        std::process::exit(0);
    }
    log(&format!("Settings from {}; wallet {}; copying {}.", cfg.env_file.display(), cfg.wallet, cfg.copy_wallets.iter().map(|w| w.b58()).collect::<Vec<_>>().join(", ")));
    if cfg.sources.is_empty() {
        eprintln!("[fastpath] Not started: SHRED_SOURCE must include \"shreder\" and/or \"helius-preprocessed\".");
        std::process::exit(1);
    }

    let (inbox_tx, mut inbox_rx) = tokio::sync::mpsc::unbounded_channel::<Value>();
    let feed_states: Arc<Mutex<HashMap<String, String>>> = Arc::new(Mutex::new(HashMap::new()));
    let data_dir = cfg.env_file.parent().map(|p| p.to_path_buf()).unwrap_or_default();
    // The bot's own data/ folder: next to its .env, or above this program
    // (<bot>/fastpath/target/release/fastpath), else the current folder's.
    let from_exe = std::env::current_exe().ok().and_then(|e| e.ancestors().nth(4).map(|p| p.to_path_buf()));
    let bot_dir = [Some(data_dir.clone()), from_exe].into_iter().flatten().find(|d| d.join("package.json").exists());
    let bot_data = bot_dir.map(|d| d.join("data")).unwrap_or_else(|| std::env::current_dir().unwrap_or_default().join("data"));
    let unacked_file = bot_data.join("fastpath-unacked.json");
    let loaded = Unacked::load(&unacked_file);
    let (dirty_tx, dirty_rx) = tokio::sync::mpsc::unbounded_channel::<()>();
    let unacked = Arc::new(Mutex::new(Unacked { list: loaded.iter().map(|(s, v)| (s.clone(), Report::Done(v.clone()))).collect(), dirty: dirty_tx }));
    spawn_saver(unacked_file, unacked.clone(), dirty_rx);
    if !loaded.is_empty() {
        log(&format!("{} buy(s) the Node bot hasn't saved yet; they'll be resent when it connects.", loaded.len()));
    }
    let greeting: link::Greeting = {
        let (fs, ua, wallet, sources) = (feed_states.clone(), unacked.clone(), cfg.wallet.b58(), cfg.sources.clone());
        Arc::new(move || {
            let hello = json!({ "type": "hello", "version": env!("CARGO_PKG_VERSION"), "wallet": wallet, "sources": sources, "feeds": *fs.lock().unwrap() });
            let resend = ua.lock().unwrap().list.iter().map(|(_, r)| { let mut r = r.value(); r["resent"] = json!(true); r }).collect();
            (hello, resend)
        })
    };
    let link = match link::serve(cfg.port, inbox_tx, greeting).await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("[fastpath] Can't listen on 127.0.0.1:{}: {e} (is another fastpath running?)", cfg.port);
            std::process::exit(1);
        }
    };
    log(&format!("Waiting for the Node bot on 127.0.0.1:{} (local only).", cfg.port));

    let mut sender = send::Sender::new(cfg.use_sender, &cfg.sender_url, &cfg.jito_url, &cfg.rpc_url);
    sender.retry_429 = cfg.retry_429;
    sender.spawn_keepalive();
    // Buys from before a restart still count against the caps until saved.
    let mut local = state::Local::default();
    for (sig, r) in &loaded {
        if let (Some(m), Some(sol)) = (r["outcome"]["mint"].as_str().and_then(Pubkey::from_b58), r["outcome"]["amountSol"].as_f64()) {
            let (id, _) = local.reserve(m, sol);
            local.set_signature(id, sig);
        }
    }
    let app = Arc::new(App {
        cfg,
        feed_states,
        unacked,
        shared: Mutex::new(Shared {
            snapshot: None,
            local,
            template: None,
            verified: false,
            blockhash: None,
            routers: decode::Routers::default(),
            tables: HashMap::new(),
            table_fetched: HashMap::new(),
            seen: HashMap::new(),
            seen_order: VecDeque::new(),
            known_programs: HashMap::new(),
            plain_used: HashSet::new(),
        }),
        sender,
        out: link.out,
        linked: link.connected,
        started: Instant::now(),
    });

    let a = app.clone();
    tokio::spawn(async move {
        while let Some(v) = inbox_rx.recv().await {
            a.on_node_message(v);
        }
    });

    let sink: feeds::Sink = {
        let a = app.clone();
        Arc::new(move |ev| a.on_feed(ev))
    };
    for src in &app.cfg.sources {
        match src.as_str() {
            "shreder" => match &app.cfg.shreder_url {
                Some(u) => {
                    log(&format!("Connecting to Shreder at {u}..."));
                    feeds::spawn_shreder(u.clone(), app.cfg.copy_wallets.clone(), app.cfg.exclude_accounts.clone(), sink.clone());
                }
                None => log("SHRED_SOURCE includes shreder but SHREDER_URL is not set; skipping it."),
            },
            "helius-preprocessed" => match &app.cfg.helius_ws_url {
                Some(u) => {
                    log(&format!("Connecting to Helius preprocessed transactions ({})...", config::redact(u)));
                    feeds::spawn_helius(u.clone(), app.cfg.copy_wallets.clone(), app.cfg.exclude_accounts.clone(), app.cfg.max_msgs_per_min, sink.clone());
                }
                None => log("SHRED_SOURCE includes helius-preprocessed but no Helius API key was found; skipping it."),
            },
            _ => {}
        }
    }

    // Everything runs in the feeds' and the link's tasks from here on.
    std::future::pending::<()>().await;
}
