// src/accountCleaner.js
//
// Every coin the bot buys opens a token account in the wallet, which locks up
// a refundable deposit ("rent", ~0.002 SOL). Once a coin is fully sold the
// account sits there empty, still holding that deposit. This closes empty
// token accounts and returns the deposit to the wallet.
//
// Safety:
//   - Only accounts holding EXACTLY zero tokens are closed. Solana itself
//     refuses to close an account that still holds tokens, and every close
//     is simulated before it's sent (a refused close costs nothing).
//   - Coins the bot holds, or is buying or selling right now, are skipped.
//   - Wrapped SOL accounts are left alone (swap routes may expect them).
//   - It runs only after a sell has confirmed, or in a periodic background
//     sweep; it is never on the buy/sell path, so it can't slow a trade.
//   - It's sent as a normal transaction (no Jito tip): it costs a 0.000005
//     SOL network fee per batch of up to 12 accounts, and recovers ~0.002 SOL
//     per account.

const { PublicKey, TransactionMessage, VersionedTransaction } = require('@solana/web3.js');
const { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, createCloseAccountInstruction } = require('@solana/spl-token');
const rpcPool = require('./rpcPool');
const { info, warn } = require('./logger');

const WSOL_MINT = 'So11111111111111111111111111111111111111112';
const MAX_PER_TX = 12;
const LOW = { priority: 'low' }; // background work: trading calls go first

/**
 * Empty token accounts of `owner` (both token programs), except for mints in
 * `skipMints`: [{ pubkey: PublicKey, mint: string, programId: PublicKey, lamports }].
 */
async function findEmptyAccounts(owner, skipMints = new Set()) {
  const out = [];
  for (const programId of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
    const resp = await rpcPool.withFailover((c) => c.getParsedTokenAccountsByOwner(owner, { programId }), undefined, LOW);
    for (const acc of resp.value || []) {
      const parsed = acc.account && acc.account.data && acc.account.data.parsed;
      const inf = parsed && parsed.info;
      if (!inf || !inf.tokenAmount) continue;
      if (inf.tokenAmount.amount !== '0') continue;
      if (inf.mint === WSOL_MINT || skipMints.has(inf.mint)) continue;
      if (inf.state && inf.state !== 'initialized') continue; // frozen accounts can't be closed
      // Token-2022 transfer-fee coins: an account with fees still withheld in
      // it can't be closed until they're harvested; skip it.
      const fee = (inf.extensions || []).find((e) => e.extension === 'transferFeeAmount');
      if (fee && fee.state && Number(fee.state.withheldAmount) > 0) continue;
      out.push({ pubkey: new PublicKey(acc.pubkey), mint: inf.mint, programId, lamports: acc.account.lamports || 0 });
    }
  }
  return out;
}

/**
 * Close the given empty accounts, sending the deposits to `owner`.
 * `confirm(signature)` resolves to { confirmed, err } (the bot's own
 * confirmation helper). Returns { closed, lamports } actually recovered.
 */
async function closeAccounts(accounts, { owner, signer, confirm }) {
  let closed = 0;
  let lamports = 0;
  for (let i = 0; i < accounts.length; i += MAX_PER_TX) {
    const batch = accounts.slice(i, i + MAX_PER_TX);
    try {
      const { blockhash } = await rpcPool.withFailover((c) => c.getLatestBlockhash('confirmed'), undefined, LOW);
      const ixs = batch.map((a) => createCloseAccountInstruction(a.pubkey, owner, owner, [], a.programId));
      const tx = new VersionedTransaction(
        new TransactionMessage({ payerKey: owner, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message()
      );
      tx.sign([signer]);
      // Simulated first (preflight): if anything in the batch can't be closed,
      // nothing is sent and nothing is paid.
      const sig = await rpcPool.withFailover((c) =>
        c.sendRawTransaction(tx.serialize(), { skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 3 }),
      undefined, LOW);
      const res = await confirm(sig);
      if (res && res.confirmed) {
        closed += batch.length;
        lamports += batch.reduce((s, a) => s + a.lamports, 0);
      } else {
        warn(`[accountCleaner] Close transaction ${sig} did not confirm${res && res.err ? ` (${JSON.stringify(res.err)})` : ''}.`);
      }
    } catch (err) {
      warn(`[accountCleaner] Couldn't close ${batch.length} empty token account(s): ${err.message}`);
    }
  }
  return { closed, lamports };
}

/** Find and close empty accounts; logs what was recovered. Never throws. */
async function sweep({ owner, signer, confirm, skipMints, onlyMint = null, label = 'sweep' }) {
  try {
    let accounts = await findEmptyAccounts(owner, skipMints);
    if (onlyMint) accounts = accounts.filter((a) => a.mint === onlyMint);
    if (accounts.length === 0) return { closed: 0, lamports: 0 };
    const res = await closeAccounts(accounts, { owner, signer, confirm });
    if (res.closed > 0) {
      info(
        `[accountCleaner] ${label}: closed ${res.closed} empty token account(s), ` +
          `recovered ${(res.lamports / 1e9).toFixed(6)} SOL of deposits.`
      );
    }
    return res;
  } catch (err) {
    warn(`[accountCleaner] ${label} failed: ${err.message}`);
    return { closed: 0, lamports: 0 };
  }
}

module.exports = { findEmptyAccounts, closeAccounts, sweep, MAX_PER_TX };
