// src/telegramBot.js
//
// Optional Telegram control bot: lists open positions with an inline "Sell"
// button per position (so you can close one without restarting the bot in
// BOT_MODE=SELLING), and pushes buy/sell notifications including PnL stats.
//
// Entirely optional — with TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID unset
// (the default), every exported function here is a silent no-op.
//
// Talks to the Telegram Bot API directly with Node's built-in fetch (long
// polling via getUpdates) rather than a client library: it only needs three
// API calls, and the popular node-telegram-bot-api package was found to
// crash the whole process on a dropped connection when running behind a
// proxy. Every call has a timeout and every handler is wrapped, so a
// Telegram-side failure can only ever be logged — never take trading down.
const config = require('./config');
const { info, warn, error } = require('./logger');
const { axiomLink } = require('./tokenLinks');
const { fetchJson } = require('./timeouts');
const coinInfo = require('./coinInfo');

const LONG_POLL_SECONDS = 25;
const CALL_TIMEOUT_MS = 15000;

let running = false; // long polling active
let started = false; // init() succeeded; notifications keep working during shutdown drain
let pollAbort = null;
let pollLoopDone = Promise.resolve();
let sellPositionById = null; // injected by index.js via init()
let requestStop = null; // injected by index.js via init()
let closeAllPositions = null; // injected by index.js via init()
let isPaused = () => false; // injected by index.js via init()
let setPaused = null; // injected by index.js via init()
let setKeep = null; // injected by index.js via init()
const FOLLOWS_COPY_SELLS = new Set(['EXACT', 'STIERED']);
let lastOffset = 0; // next update_id to ask Telegram for (= everything before it handled)
const STOP_CONFIRM_TTL_MS = 2 * 60 * 1000;
let getActivePositions = null; // injected by index.js via init()

function isEnabled() {
  return Boolean(config.TELEGRAM_BOT_TOKEN && config.TELEGRAM_CHAT_ID);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function callApi(method, params, { timeoutMs = CALL_TIMEOUT_MS, signal } = {}) {
  const url = `https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/${method}`;
  const res = await fetchJson(
    url,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params), signal },
    timeoutMs
  );
  const data = res.data;
  if (!data || !data.ok) {
    const err = new Error(`Telegram ${method} failed: ${data && data.description ? data.description : `HTTP ${res.status}`}`);
    // 429 Too Many Requests: Telegram says how long to wait.
    if (data && data.parameters && Number(data.parameters.retry_after) > 0) err.retryAfterSec = Number(data.parameters.retry_after);
    throw err;
  }
  return data.result;
}

/**
 * Only the configured person, in a private chat with the bot, may list or
 * sell positions. Checking the sender (not just the chat) matters: in a
 * group chat every member shares the chat id.
 */
function isAuthorized(chat, from) {
  if (!chat || !from) return false;
  return (
    chat.type === 'private' &&
    String(chat.id) === String(config.TELEGRAM_CHAT_ID) &&
    String(from.id) === String(config.TELEGRAM_CHAT_ID)
  );
}

// Messages go out one at a time, at most about one a second (Telegram's
// limit for a chat); when Telegram still says "too many requests", the
// message waits as long as it asks and is sent again rather than lost.
const SEND_GAP_MS = process.env.TELEGRAM_SEND_GAP_MS !== undefined ? Number(process.env.TELEGRAM_SEND_GAP_MS) : 1000;
const SEND_QUEUE_MAX = 100;
let sendChain = Promise.resolve();
let sendQueued = 0;
let lastSendAt = 0;

function send(chatId, text, extra = {}) {
  if (!started) return Promise.resolve();
  if (sendQueued >= SEND_QUEUE_MAX) {
    warn(`[TelegramBot] ${sendQueued} messages waiting to go out; dropping: ${String(text).slice(0, 80)}`);
    return Promise.resolve();
  }
  sendQueued += 1;
  const job = sendChain.then(async () => {
    for (let attempt = 1; ; attempt++) {
      const wait = lastSendAt + SEND_GAP_MS - Date.now();
      if (wait > 0) await sleep(wait);
      lastSendAt = Date.now();
      try {
        return await callApi('sendMessage', { chat_id: chatId, text, disable_web_page_preview: true, ...extra });
      } catch (err) {
        if (err.retryAfterSec && attempt < 4 && running) {
          warn(`[TelegramBot] Telegram asked to slow down; sending again in ${err.retryAfterSec}s.`);
          await sleep(err.retryAfterSec * 1000);
          continue;
        }
        warn('[TelegramBot] sendMessage failed:', err.message);
        return undefined;
      }
    }
  });
  sendChain = job.then(
    () => { sendQueued -= 1; },
    () => { sendQueued -= 1; }
  );
  return job.catch(() => undefined);
}

function fmtSol(n) {
  const num = Number(n);
  return Number.isFinite(num) ? num.toFixed(4) : String(n);
}

function shortMint(mint) {
  return `${mint.slice(0, 4)}...${mint.slice(-4)}`;
}

function positionLabel(pos) {
  const amt = pos.cost_basis_sol ?? pos.buy_amount;
  let label = `${shortMint(pos.mint)} (${pos.trade_mode}, ${fmtSol(amt)} SOL`;
  const entry = Number(pos.entry_price);
  const cur = Number(pos.current_price);
  if (entry > 0 && cur > 0) {
    const pct = ((cur - entry) / entry) * 100;
    label += `, ${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`;
  }
  return label + ')' + (pos.keep ? ' 📌 kept' : '');
}

/**
 * Start long polling and wire the bot to the rest of the app via dependency
 * injection — this module never requires index.js directly.
 * @param {object} deps
 * @param {() => Array<object>} deps.getActivePositions  - current active positions
 * @param {(id: string) => Promise<{ok: boolean, message: string}>} deps.sellPositionById
 */
function init(deps) {
  getActivePositions = deps.getActivePositions;
  sellPositionById = deps.sellPositionById;
  requestStop = deps.requestStop || null;
  closeAllPositions = deps.closeAllPositions || null;
  isPaused = deps.isPaused || (() => false);
  setPaused = deps.setPaused || null;
  setKeep = deps.setKeep || null;

  if (!isEnabled()) {
    info('[TelegramBot] TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID not set; Telegram control bot disabled.');
    return;
  }

  started = true;
  running = true;
  pollAbort = new AbortController();
  pollLoopDone = pollLoop(pollAbort.signal).catch((err) => error('[TelegramBot] Poll loop stopped:', err.message));
  info('[TelegramBot] Telegram control bot started. Send /positions in your chat to get sell buttons.');
  // Shows the commands in Telegram's "/" menu. Cosmetic; failure is harmless.
  callApi('setMyCommands', {
    commands: [
      { command: 'positions', description: 'Open positions with sell buttons' },
      { command: 'pause', description: 'Pause new buys (exits keep working)' },
      { command: 'resume', description: 'Resume copying buys' },
      { command: 'stop', description: 'Stop the bot (positions are not sold)' },
      { command: 'help', description: 'List commands' }
    ]
  }).catch(() => {});
  send(config.TELEGRAM_CHAT_ID, '🤖 Copy-trading bot connected. Send /positions to see open positions and sell them.');
}

async function pollLoop(signal) {
  // Skip anything sent while the bot was offline: a Sell button tapped an
  // hour ago, or a /stop from the last session, must not fire on startup.
  // Retried until it works: starting without it would replay up to a day of
  // old taps (e.g. after a reboot before the network is up).
  for (let wait = 1000; running; wait = Math.min(wait * 2, 30000)) {
    try {
      const pending = await callApi('getUpdates', { offset: -1, timeout: 0 }, { timeoutMs: 10000, signal });
      if (pending && pending.length) {
        lastOffset = pending[pending.length - 1].update_id + 1;
        info('[TelegramBot] Ignored Telegram messages/taps sent while the bot was offline.');
      }
      break;
    } catch (err) {
      if (!running) return;
      warn(`[TelegramBot] Could not clear old updates (${err.message}); trying again in ${Math.round(wait / 1000)}s before listening.`);
      await sleep(wait);
    }
  }

  let backoffMs = 1000;
  while (running) {
    let updates;
    try {
      updates = await callApi(
        'getUpdates',
        { offset: lastOffset, timeout: LONG_POLL_SECONDS, allowed_updates: ['message', 'callback_query'] },
        { timeoutMs: (LONG_POLL_SECONDS + 10) * 1000, signal }
      );
      backoffMs = 1000;
    } catch (err) {
      if (!running) break;
      error('[TelegramBot] Polling error:', err.message);
      await sleep(backoffMs);
      backoffMs = Math.min(backoffMs * 2, 30000);
      continue;
    }
    for (const update of updates || []) {
      lastOffset = Math.max(lastOffset, update.update_id + 1);
      // Not awaited: a sell can take a while to confirm, and shouldn't
      // hold up reading the next update.
      handleUpdate(update).catch((err) => error('[TelegramBot] Update handler failed:', err.message));
    }
  }
}

async function handleUpdate(update) {
  if (update.message && typeof update.message.text === 'string') {
    const msg = update.message;
    if (!isAuthorized(msg.chat, msg.from)) return;
    if (/^\/(positions|start)\b/.test(msg.text)) {
      await sendPositionsList(msg.chat.id);
    } else if (/^\/pause\b/.test(msg.text)) {
      await changePause(msg.chat.id, true);
    } else if (/^\/resume\b/.test(msg.text)) {
      await changePause(msg.chat.id, false);
    } else if (/^\/stop\b/.test(msg.text)) {
      await sendStopConfirmation(msg.chat.id);
    } else if (/^\/help\b/.test(msg.text)) {
      await send(msg.chat.id, HELP_TEXT);
    }
    return;
  }
  if (update.callback_query) {
    await handleCallback(update.callback_query);
  }
}

const HELP_TEXT =
  '/positions — open positions with Sell 50% / Sell all buttons (also sent after every buy)\n' +
  '/pause — stop copying new buys (exits and sell buttons keep working)\n' +
  '/resume — start copying buys again\n' +
  '/stop — stop the bot (asks to confirm; open positions are NOT sold)\n' +
  '/help — this list';

const PAUSED_NOTE = 'Copy-sells, Sell buttons and Close all still work, so open positions can always be exited.';

async function changePause(chatId, value) {
  if (!setPaused) {
    await send(chatId, 'Pause is not available.');
    return;
  }
  const was = isPaused();
  setPaused(value);
  if (!value && isPaused()) {
    await send(chatId, '⏸ This bot is in REHEARSE_ONLY mode: it never buys, so it stays paused. Remove REHEARSE_ONLY from .env to trade.');
    return;
  }
  if (value) {
    await send(chatId, `${was ? 'Already paused' : '⏸ Paused'}: no new buys will be copied. ${PAUSED_NOTE} Send /resume to start again.`);
  } else {
    await send(chatId, was ? '▶️ Resumed: copying buys again.' : 'Not paused: buys are being copied.');
  }
}

async function sendStopConfirmation(chatId) {
  const positions = getActivePositions ? getActivePositions() : [];
  const note = positions.length
    ? `\n${positions.length} position(s) are open. Stopping does NOT sell them — they stay in your wallet, and nothing will sell them until the bot runs again.`
    : '';
  await send(chatId, `Stop the bot?${note}\n(To just stop new buys and keep the bot running, use /pause instead.)`, {
    reply_markup: {
      inline_keyboard: [[
        { text: '🛑 Yes, stop', callback_data: `stop:${Date.now()}` },
        { text: 'Cancel', callback_data: 'stopcancel' }
      ]]
    }
  });
}

async function handleStopCallback(query, chat, data) {
  if (data === 'stopcancel') {
    await answer(query, 'Cancelled.');
    await send(chat.id, 'OK, the bot keeps running.');
    return;
  }
  const issuedAt = Number(data.slice('stop:'.length));
  if (!(Date.now() - issuedAt < STOP_CONFIRM_TTL_MS)) {
    await answer(query, 'Expired.');
    await send(chat.id, 'That stop button has expired. Send /stop again if you still want to stop the bot.');
    return;
  }
  if (!requestStop) {
    await answer(query, 'Not available.');
    return;
  }
  await answer(query, 'Stopping...');
  await send(chat.id, '🛑 Stopping: no new buys from now; finishing anything in progress...');
  requestStop();
}

async function handleCloseAllCallback(query, chat, data) {
  // Step 1: the button under the positions list asks for confirmation.
  if (data === 'closeallask') {
    const positions = getActivePositions ? getActivePositions() : [];
    await answer(query, '');
    if (positions.length === 0) {
      await send(chat.id, 'No open positions.');
      return;
    }
    await send(chat.id, `Sell ALL ${positions.length} open position(s) now?`, {
      reply_markup: {
        inline_keyboard: [[
          { text: `🔴 Yes, sell all ${positions.length}`, callback_data: `closeall:${Date.now()}` },
          { text: 'Cancel', callback_data: 'closeallcancel' }
        ]]
      }
    });
    return;
  }
  if (data === 'closeallcancel') {
    await answer(query, 'Cancelled.');
    await send(chat.id, 'OK, nothing sold.');
    return;
  }
  // Step 2: confirmed.
  const issuedAt = Number(data.slice('closeall:'.length));
  if (!(Date.now() - issuedAt < STOP_CONFIRM_TTL_MS)) {
    await answer(query, 'Expired.');
    await send(chat.id, 'That button has expired. Tap "Close all positions" again if you still want to.');
    return;
  }
  if (!closeAllPositions) {
    await answer(query, 'Not available.');
    return;
  }
  await answer(query, 'Selling everything...');
  await send(chat.id, '🔴 Selling all open positions...');
  let r;
  try {
    r = await closeAllPositions();
  } catch (err) {
    await send(chat.id, `⚠️ Close all failed: ${err.message}`);
    return;
  }
  if (r.total === 0) {
    await send(chat.id, 'No open positions.');
  } else if (r.failed === 0 && !r.queued) {
    await send(chat.id, `✅ Closed all ${r.closed} position(s).`);
  } else if (r.failed === 0) {
    await send(chat.id, `✅ Closed ${r.closed} position(s); ${r.queued} had a sell already running and will be sold right after it.`);
  } else {
    await send(
      chat.id,
      `⚠️ Closed ${r.closed} of ${r.total} position(s). ${r.failed} could not be sold yet; they stay open and are retried automatically.`
    );
  }
}

async function answer(query, text) {
  try {
    await callApi('answerCallbackQuery', { callback_query_id: query.id, text });
  } catch (err) {
    // Typically "query is too old" for a button tapped long after it was
    // sent — harmless, the action below still runs.
    warn('[TelegramBot] answerCallbackQuery failed:', err.message);
  }
}

async function handleCallback(query) {
  const chat = query.message && query.message.chat;
  if (!isAuthorized(chat, query.from)) {
    await answer(query, 'Not authorized.');
    return;
  }
  if (/^stop(cancel$|:)/.test(query.data || '')) {
    await handleStopCallback(query, chat, query.data);
    return;
  }
  if (query.data === 'pause' || query.data === 'resume') {
    await answer(query, query.data === 'pause' ? 'Paused' : 'Resumed');
    await changePause(chat.id, query.data === 'pause');
    return;
  }
  if (/^closeall/.test(query.data || '')) {
    await handleCloseAllCallback(query, chat, query.data);
    return;
  }

  // "keep:<id>" = stop following the copy wallet's sells for this position;
  // "follow:<id>" = follow them again.
  const k = /^(keep|follow):(.+)$/.exec(query.data || '');
  if (k) {
    const keep = k[1] === 'keep';
    await answer(query, keep ? 'Keeping' : 'Following');
    const result = setKeep ? setKeep(k[2], keep) : { ok: false, message: 'Bot not ready.' };
    if (!result.ok) {
      await send(chat.id, `⚠️ ${result.message}`);
      return;
    }
    await send(
      chat.id,
      keep
        ? "📌 Keeping it: the bot won't follow the copy wallet's sells for this position. Sell with the buttons when you're ready."
        : '▶ Following again: the bot will mirror the copy wallet\'s next sells for this position.'
    );
    await sendPositionsList(chat.id);
    return;
  }

  // Buttons: "sell:<id>" = sell all, "sell50:<id>" = sell half.
  const m = /^sell(50)?:(.+)$/.exec(query.data || '');
  if (!m) return;
  const pct = m[1] ? 50 : 100;
  const id = m[2];

  await answer(query, `Selling ${pct === 100 ? 'all' : '50%'} of ${id.slice(0, 8)}...`);
  let result;
  try {
    result = sellPositionById ? await sellPositionById(id, pct) : { ok: false, message: 'Bot not ready.' };
  } catch (err) {
    result = { ok: false, message: err.message };
  }
  await send(chat.id, result.ok ? `✅ ${result.message}` : `⚠️ ${result.message}`);
}

function pauseButton() {
  return isPaused()
    ? { text: '▶️ Resume buying', callback_data: 'resume' }
    : { text: '⏸ Pause buying', callback_data: 'pause' };
}

async function sendPositionsList(chatId) {
  const positions = getActivePositions ? getActivePositions() : [];
  const status = isPaused() ? '⏸ Buying is PAUSED (exits still work).\n' : '';
  if (positions.length === 0) {
    await send(chatId, `${status}No open positions.`, { reply_markup: { inline_keyboard: [[pauseButton()]] } });
    return;
  }
  // Details go in the message text (numbered); each position gets one row
  // of two buttons carrying the same number, so they fit on a phone screen.
  const lines = positions.map((pos, i) => `${i + 1}. ${positionLabel(pos)}`);
  // Three buttons per row, kept short to fit a phone. "Keep" only for modes
  // that follow the copy wallet's sells (EXACT, STIERED).
  const keyboard = positions.map((pos, i) => {
    const n = i + 1;
    const row = [
      { text: `${n}·Sell 50%`, callback_data: `sell50:${pos.id}` },
      { text: `${n}·Sell all`, callback_data: `sell:${pos.id}` }
    ];
    if (FOLLOWS_COPY_SELLS.has(pos.trade_mode)) {
      row.push(
        pos.keep
          ? { text: `${n}·▶ Follow`, callback_data: `follow:${pos.id}` }
          : { text: `${n}·📌 Keep`, callback_data: `keep:${pos.id}` }
      );
    }
    return row;
  });
  keyboard.push([pauseButton(), { text: '🔴 Close all positions', callback_data: 'closeallask' }]);
  await send(chatId, `${status}${positions.length} open position(s):\n${lines.join('\n')}`, {
    reply_markup: { inline_keyboard: keyboard }
  });
}

/** Notify on a new buy (or an added-to position), then send the positions
 * list with its sell buttons right away so you can exit quickly. */
function notifyBuy(pos, { added = false, slotsBehind = null, reactionMs = null, coinSnapshot = null, vsCopy = null, pairedStock = null, blockRate = '' } = {}) {
  if (!started) return;
  let speed = '';
  if (typeof slotsBehind === 'number') {
    speed = `\nLanded ${slotsBehind} slot${slotsBehind === 1 ? '' : 's'} behind the copy wallet (~${(slotsBehind * 0.4).toFixed(1)}s)`;
    if (typeof reactionMs === 'number') speed += `; bot took ${reactionMs}ms to send`;
  }
  if (config.COPY_WALLETS && config.COPY_WALLETS.length > 1 && pos.copy_wallet) {
    speed += `\nCopied from ${pos.copy_wallet.slice(0, 4)}...${pos.copy_wallet.slice(-4)}`;
  }
  if (blockRate) speed += `\n${blockRate}`;
  if (pairedStock) speed += `\n📈 Paired to: ${pairedStock} (stock)`;
  if (vsCopy && Number.isFinite(vsCopy.pct)) {
    const p = vsCopy.pct;
    speed += `\nEntry: ${vsCopy.exact ? '' : '≈'}${p >= 0 ? '+' : '−'}${Math.abs(p).toFixed(1)}% vs copy wallet's price`;
  }
  (async () => {
    // Market cap / holders, looked up after the buy (capped at a few
    // seconds inside coinInfo); the message goes out without them if absent.
    let coin = '';
    if (coinSnapshot) {
      const lines = coinInfo.describe(await Promise.resolve(coinSnapshot).catch(() => null));
      if (lines.length) coin = '\n' + lines.join('\n');
    }
    await send(
      config.TELEGRAM_CHAT_ID,
      `🟢 ${added ? 'ADDED TO' : 'BUY'} ${positionLabel(pos)}\nTokens: ${pos.token_amount}${speed}${coin}\n${axiomLink(pos.mint)}`
    );
    await sendPositionsList(config.TELEGRAM_CHAT_ID);
  })().catch((err) => warn('[TelegramBot] Post-buy positions list failed:', err.message));
}

/** Notify on a sell (full or partial) with PnL stats. No-op if not configured. */
function notifySell({ pos, reason, soldPct, pnlSol, pnlPct, realized }) {
  if (!started) return;
  const known = typeof pnlSol === 'number' && Number.isFinite(pnlSol);
  const pnlText = known
    ? `${pnlSol >= 0 ? '+' : ''}${fmtSol(pnlSol)} SOL (${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%)${realized ? '' : ' (est.)'}`
    : 'unknown';
  const emoji = known ? (pnlSol >= 0 ? '✅' : '🔻') : 'ℹ️';
  send(
    config.TELEGRAM_CHAT_ID,
    `${emoji} SELL (${reason}) — ${soldPct.toFixed(2)}% of ${shortMint(pos.mint)}\nPnL: ${pnlText}`
  );
}

/** Plain information message (no alarm emoji). */
function notifyInfo(text) {
  if (!started) return;
  send(config.TELEGRAM_CHAT_ID, text);
}

/** Alert about something needing attention (e.g. a sell that keeps failing). */
function notifyAlert(text) {
  if (!started) return;
  send(config.TELEGRAM_CHAT_ID, `🚨 ${text}`);
}

/** Stop polling (used during graceful shutdown). No-op if not running. */
async function stop() {
  if (!running) return;
  running = false;
  // Abort the in-flight long poll. Deliberately not awaiting the loop
  // itself: it may be sitting in an error backoff (up to 30s) and there's
  // nothing to flush. Notifications still go out while shutdown drains.
  if (pollAbort) pollAbort.abort();
  // Tell Telegram everything so far was handled. Otherwise it re-delivers the
  // last updates on the next start — including the /stop that stopped us.
  if (lastOffset > 0) {
    try {
      await callApi('getUpdates', { offset: lastOffset, timeout: 0 }, { timeoutMs: 5000 });
    } catch (err) {
      warn('[TelegramBot] Could not acknowledge last updates:', err.message);
    }
  }
}

/** Final message before the process exits; awaited (bounded) so it gets out. */
async function notifyStopped(text) {
  if (!started) return;
  try {
    await callApi('sendMessage', { chat_id: config.TELEGRAM_CHAT_ID, text }, { timeoutMs: 5000 });
  } catch (err) {
    warn('[TelegramBot] Could not send the stop message:', err.message);
  }
}

/** Sent once at startup, with the Resume (or Pause) button. */
function notifyStarted({ paused, copyWallet, copyWallets = null, maxOpen = 0, openPositions = 0 }) {
  if (!started) return;
  const list = copyWallets && copyWallets.length ? copyWallets : copyWallet ? [copyWallet] : [];
  const short = (w) => `${w.slice(0, 4)}...${w.slice(-4)}`;
  const who = (list.length ? ` Copying ${list.map(short).join(', ')}.` : '') + (maxOpen ? ` Max ${maxOpen} open position(s).` : '');
  const open = openPositions ? ` ${openPositions} open position(s) carried over.` : '';
  const text = paused
    ? `🤖 Bot started.${who}${open}\n⏸ Buying is PAUSED. Tap Resume when you're ready (exits already work).`
    : `🤖 Bot started.${who}${open}\n▶️ Buying is ON.`;
  send(config.TELEGRAM_CHAT_ID, text, { reply_markup: { inline_keyboard: [[pauseButton()]] } });
}

module.exports = { init, notifyBuy, notifySell, notifyAlert, notifyInfo, notifyStarted, notifyStopped, stop, isEnabled };
