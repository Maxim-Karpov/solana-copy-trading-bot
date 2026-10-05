// src/heliusSender.js
//
// Optional sending route: Helius Sender (SEND_VIA="sender"). Sender forwards
// each transaction through Jito AND staked validator connections at once,
// for a better chance of landing in the earliest possible slot.
//
// Sender has two hard requirements on every transaction:
//   1. a SOL tip to one of ITS tip accounts (not Jito's), of at least
//      0.001 SOL (or 0.000005 SOL with ?swqos_only=true), and
//   2. a priority fee (a ComputeBudget SetComputeUnitPrice instruction).
//
// Both kinds of transaction the bot sends are built with a Jito tip:
// SolanaPortal adds one, and the direct Pump.fun/Raydium builders add one.
// prepareForSender() makes a converted COPY of such a transaction, before
// signing:
//   - the Jito tip transfer is pointed at a Sender tip account instead, with
//     the amount set to SENDER_TIP, and
//   - the priority fee is raised to at least PRIORITY_FEE_SOL, or, if the
//     transaction has no priority-fee instruction (SolanaPortal's may not),
//     one is added at the front.
// Every other instruction is left exactly as it was: same programs, same
// accounts (signer/writable flags included), same data, same order. If the
// transaction doesn't fit the pattern (no Jito tip transfer to redirect) or
// the result would be too big to send, the original is left untouched and
// the caller sends it through Jito as before.

const { PublicKey, SystemProgram, ComputeBudgetProgram, Message, MessageV0, VersionedTransaction, PACKET_DATA_SIZE } = require('@solana/web3.js');
const config = require('./config');
const { JITO_TIP_ACCOUNTS } = require('./jitoTip');
const { fetchJson } = require('./timeouts');
const { warn } = require('./logger');

let bs58;
{
  const imported = require('bs58');
  bs58 = imported.default ? imported.default : imported;
}

// Helius Sender's mainnet tip accounts (from Helius's Sender docs).
const SENDER_TIP_ACCOUNTS = [
  '4ACfpUFoaSD9bfPdeu6DBt89gB6ENTeHBXCAi87NhDEE',
  'D2L6yPZ2FmmmTKPgzaMKdhu6EWZcTpLy1Vhx8uvZe7NZ',
  '9bnz4RShgq1hAnLnZbP8kbgBg1kEmcJBYQq3gQbmnSta',
  '5VY91ws6B2hMmBFRsXkoAAdsPHBJwRfBht4DXox3xkwn',
  '2nyhqdwKcJZR2vcqCyrYsaPVdAnFoJjiksCXJ7hfEYgD',
  '2q5pghRs6arqVjRvT5gfgWfWcHWmw1ZuCzphgd5KfWGJ',
  'wyvPkWjVZz1M8fHQnMMCDTQDbkManefNNhweYk5WkcF',
  '3KCKozbAaF75qEU33jtzozcJ29yJuaLJTy2jFdzUY8bT',
  '4vieeGHPYPG2MmyPRcYjdiDmmhN3ww7hsFNap8pVN3Ey',
  '4TQLFNWK8AovT1gFvda5jfw2oJeRMKEmw7aH6MGBJ3or'
].map((a) => new PublicKey(a));

const JITO_TIP_SET = new Set(JITO_TIP_ACCOUNTS.map((k) => k.toBase58()));
const SYSTEM_PROGRAM = SystemProgram.programId.toBase58();
const COMPUTE_BUDGET_PROGRAM = ComputeBudgetProgram.programId.toBase58();
const DEFAULT_CU_PER_INSTRUCTION = 200_000;
const MAX_CU = 1_400_000;
const SEND_TIMEOUT_MS = 10000;
// Helius recommends a ping every 5s when idle; Node's fetch drops an idle
// connection after 4 s unless the server says otherwise, so ping a bit sooner.
const KEEPALIVE_INTERVAL_MS = 3000;

function randomSenderTipAccount() {
  return SENDER_TIP_ACCOUNTS[Math.floor(Math.random() * SENDER_TIP_ACCOUNTS.length)];
}

/**
 * Convert an UNSIGNED transaction carrying a Jito tip into one Sender
 * accepts (see the top of this file). Never modifies `tx` itself.
 * Returns { ok: true, tx: converted, addedPriorityFee } or { ok: false, reason }.
 * @param tx                  - VersionedTransaction (not yet signed)
 * @param tipLamports         - Sender tip to pay
 * @param priorityFeeLamports - minimum total priority fee for the transaction
 */
function prepareForSender(tx, { tipLamports, priorityFeeLamports }) {
  let msg;
  try {
    msg = VersionedTransaction.deserialize(tx.serialize()).message; // work on a copy
  } catch (err) {
    return { ok: false, reason: `couldn't read the transaction (${err.message})` };
  }
  if (msg.version !== 'legacy' && msg.version !== 0) {
    return { ok: false, reason: `transaction version ${msg.version} isn't supported for conversion` };
  }
  const legacy = msg.version === 'legacy';
  const header = { ...msg.header };
  const keys = (legacy ? msg.accountKeys : msg.staticAccountKeys).slice();
  const ixs = legacy
    ? msg.instructions.map((ix) => ({
        programIdIndex: ix.programIdIndex,
        accountKeyIndexes: ix.accounts.slice(),
        data: Buffer.from(bs58.decode(ix.data))
      }))
    : msg.compiledInstructions.map((ix) => ({
        programIdIndex: ix.programIdIndex,
        accountKeyIndexes: ix.accountKeyIndexes.slice(),
        data: Buffer.from(ix.data)
      }));
  // Program ids are always static keys (never loaded from a lookup table).
  const programOf = (ix) => (keys[ix.programIdIndex] ? keys[ix.programIdIndex].toBase58() : null);

  // The Jito tip: a System transfer (instruction 2, 12 bytes) to a Jito tip account.
  const tip = ixs.find(
    (ix) =>
      programOf(ix) === SYSTEM_PROGRAM &&
      ix.data.length === 12 &&
      ix.data.readUInt32LE(0) === 2 &&
      ix.accountKeyIndexes.length >= 2 &&
      ix.accountKeyIndexes[1] < keys.length &&
      JITO_TIP_SET.has(keys[ix.accountKeyIndexes[1]].toBase58())
  );
  if (!tip) return { ok: false, reason: 'no Jito tip transfer to redirect' };

  const isBudget = (ix) => programOf(ix) === COMPUTE_BUDGET_PROGRAM;
  const price = ixs.find((ix) => isBudget(ix) && ix.data.length === 9 && ix.data[0] === 3); // SetComputeUnitPrice
  const limitIx = ixs.find((ix) => isBudget(ix) && ix.data.length === 5 && ix.data[0] === 2); // SetComputeUnitLimit
  const nonBudget = ixs.filter((ix) => !isBudget(ix)).length;
  const cuLimit = limitIx ? limitIx.data.readUInt32LE(1) : Math.min(MAX_CU, nonBudget * DEFAULT_CU_PER_INSTRUCTION);
  if (!(cuLimit > 0)) return { ok: false, reason: 'compute unit limit is zero' };

  // 1. Tip: same account slot (writable, not a signer), Sender's account and amount.
  keys[tip.accountKeyIndexes[1]] = randomSenderTipAccount();
  tip.data.writeBigUInt64LE(BigInt(Math.round(tipLamports)), 4);

  // 2. Priority fee, in micro-lamports per compute unit.
  const wanted = BigInt(Math.ceil((priorityFeeLamports * 1e6) / cuLimit));
  if (price) {
    if (wanted > price.data.readBigUInt64LE(1)) price.data.writeBigUInt64LE(wanted, 1);
  } else {
    let cbIndex = keys.findIndex((k) => k.toBase58() === COMPUTE_BUDGET_PROGRAM);
    if (cbIndex === -1) {
      // Add the ComputeBudget program as a read-only, non-signer static key.
      // Those come last among static keys, so appending keeps the order
      // valid. Accounts loaded from lookup tables are numbered after the
      // static keys, so their indexes all move up by one.
      const oldLen = keys.length;
      keys.push(ComputeBudgetProgram.programId);
      header.numReadonlyUnsignedAccounts += 1;
      cbIndex = oldLen;
      for (const ix of ixs) {
        ix.accountKeyIndexes = ix.accountKeyIndexes.map((i) => (i >= oldLen ? i + 1 : i));
      }
    }
    const data = Buffer.alloc(9);
    data[0] = 3;
    data.writeBigUInt64LE(wanted, 1);
    ixs.unshift({ programIdIndex: cbIndex, accountKeyIndexes: [], data });
  }

  const out = new VersionedTransaction(
    legacy
      ? new Message({
          header,
          accountKeys: keys,
          recentBlockhash: msg.recentBlockhash,
          instructions: ixs.map((ix) => ({ programIdIndex: ix.programIdIndex, accounts: ix.accountKeyIndexes, data: bs58.encode(ix.data) }))
        })
      : new MessageV0({
          header,
          staticAccountKeys: keys,
          recentBlockhash: msg.recentBlockhash,
          compiledInstructions: ixs.map((ix) => ({
            programIdIndex: ix.programIdIndex,
            accountKeyIndexes: ix.accountKeyIndexes,
            data: Uint8Array.from(ix.data)
          })),
          addressTableLookups: msg.addressTableLookups
        })
  );
  let size;
  try {
    size = out.serialize().length;
  } catch (err) {
    return { ok: false, reason: `converted transaction didn't serialize (${err.message})` };
  }
  if (size > PACKET_DATA_SIZE) {
    return { ok: false, reason: `adding a priority fee would make it too big (${size} > ${PACKET_DATA_SIZE} bytes)` };
  }
  return { ok: true, tx: out, addedPriorityFee: !price };
}

function senderUrl(pathSuffix = null) {
  const url = new URL(config.SENDER_ENDPOINT);
  if (pathSuffix) {
    url.pathname = url.pathname.replace(/\/[^/]*$/, '/' + pathSuffix);
    url.search = '';
    return url.toString();
  }
  if (config.SENDER_SWQOS_ONLY) url.searchParams.set('swqos_only', 'true');
  if (config.SENDER_MEV_PROTECT) url.searchParams.set('mev-protect', 'true');
  return url.toString();
}

/**
 * Submit a signed transaction to Helius Sender. Resolves with the signature.
 * Throws { ambiguous: true } (an Error with that flag) when the outcome is
 * unknown — connection dropped or timed out after the request may have gone
 * out — and a plain Error when Sender definitely rejected it.
 */
// "429 Too Many Requests": Sender turned the transaction away without
// forwarding it, so the very same signed transaction can be sent again (it
// can't land twice: one signature, one transaction). Retried once at once;
// if still refused, the caller sends it through the regular RPC instead
// (err.rateLimited) rather than losing the trade or waiting.
const RATE_LIMIT_RETRY_MS = [60];
let rateLimited = 0; // count, for the log

async function sendViaSender(signedTxBase64) {
  const body = {
    jsonrpc: '2.0',
    id: '1',
    method: 'sendTransaction',
    params: [signedTxBase64, { encoding: 'base64', skipPreflight: true, maxRetries: 0 }]
  };
  let res;
  for (let attempt = 0; ; attempt++) {
    try {
      res = await fetchJson(
        senderUrl(),
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
        SEND_TIMEOUT_MS
      );
    } catch (err) {
      const e = new Error(`Helius Sender outcome unknown (${err.message})`);
      e.ambiguous = true;
      throw e;
    }
    if (res.status !== 429 || attempt >= RATE_LIMIT_RETRY_MS.length) break;
    rateLimited += 1;
    warn(`[Sender] Rate-limited by Helius Sender (429; ${rateLimited} this run); trying once more in ${RATE_LIMIT_RETRY_MS[attempt]}ms.`);
    await new Promise((r) => setTimeout(r, RATE_LIMIT_RETRY_MS[attempt]));
  }
  if (res.status === 429) {
    const e = new Error('Helius Sender refused it: 429 Too Many Requests');
    e.rateLimited = true;
    throw e;
  }
  if (!res.ok) throw new Error(`Helius Sender failed: ${res.status} ${res.statusText} | ${res.text.slice(0, 300)}`);
  if (!res.data || !res.data.result) throw new Error(`Helius Sender did not return a result: ${res.text.slice(0, 300)}`);
  return res.data.result;
}

let keepAliveTimer = null;

/** Ping Sender every few seconds so the connection is warm when a trade comes. */
function startKeepAlive() {
  if (keepAliveTimer) return;
  const ping = () => fetchJson(senderUrl('ping'), { method: 'GET' }, 3000).catch(() => {});
  ping();
  keepAliveTimer = setInterval(ping, KEEPALIVE_INTERVAL_MS);
  if (keepAliveTimer.unref) keepAliveTimer.unref();
}

function stopKeepAlive() {
  if (keepAliveTimer) clearInterval(keepAliveTimer);
  keepAliveTimer = null;
}

module.exports = { prepareForSender, sendViaSender, startKeepAlive, stopKeepAlive, senderUrl, SENDER_TIP_ACCOUNTS };
