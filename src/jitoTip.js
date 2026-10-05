// src/jitoTip.js
//
// Jito's official tip accounts (from `getTipAccounts`). A transaction sent
// via Jito's block engine only gets priority treatment if it itself
// transfers SOL to one of these accounts — SolanaPortal added this for you
// automatically; a directly-built transaction (pumpfunDirect.js,
// raydiumDirect.js) needs it added explicitly, or JITO_TIP silently does
// nothing. Spreading tips across all 8 accounts avoids hammering a single
// hot account.

const { PublicKey, SystemProgram } = require('@solana/web3.js');

const JITO_TIP_ACCOUNTS = [
  '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
  'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe',
  'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
  'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49',
  'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh',
  'ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt',
  'DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL',
  '3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT'
].map((a) => new PublicKey(a));

function randomTipAccount() {
  return JITO_TIP_ACCOUNTS[Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length)];
}

/** A SystemProgram.transfer instruction paying `tipSol` SOL to a random Jito tip account, or null if tipSol is falsy/zero. */
function buildTipInstruction(payer, tipSol) {
  if (!tipSol || tipSol <= 0) return null;
  return SystemProgram.transfer({
    fromPubkey: payer,
    toPubkey: randomTipAccount(),
    lamports: Math.round(tipSol * 1e9)
  });
}

module.exports = { JITO_TIP_ACCOUNTS, randomTipAccount, buildTipInstruction };
