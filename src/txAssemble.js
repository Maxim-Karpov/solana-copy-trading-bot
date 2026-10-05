// src/txAssemble.js
//
// Turns a list of swap instructions into an unsigned v0 transaction with the
// bot's compute budget and Jito tip. Shared by the direct builders that
// produce raw instructions (Pump.fun curve, PumpSwap).

const { SystemProgram, TransactionMessage, VersionedTransaction, ComputeBudgetProgram } = require('@solana/web3.js');
const { randomTipAccount } = require('./jitoTip');
const prewarm = require('./prewarm');

/**
 * guardInstructions: checks that must pass for anything else to happen
 * (MAX_SLOTS_BEHIND's slot guard). They go first, right after the compute
 * budget, so a guard that fails stops the transaction before the swap runs;
 * the guard's position is put on the transaction as `guardIxIndex`.
 */
async function assembleV0Tx({ connection, payer, instructions, computeUnitLimit, priorityFeeMicroLamports, tipSol, guardInstructions = [] }) {
  const finalIxs = [];
  if (computeUnitLimit) {
    finalIxs.push(ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnitLimit }));
  }
  if (priorityFeeMicroLamports) {
    finalIxs.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFeeMicroLamports }));
  }
  const guardIxIndex = guardInstructions.length ? finalIxs.length : null;
  finalIxs.push(...guardInstructions);
  finalIxs.push(...instructions);

  if (tipSol && tipSol > 0) {
    finalIxs.push(
      SystemProgram.transfer({
        fromPubkey: payer,
        toPubkey: randomTipAccount(),
        lamports: Math.round(tipSol * 1e9)
      })
    );
  }

  // PREWARM keeps a recent blockhash ready: no round trip here.
  const blockhash = prewarm.blockhash() || (await connection.getLatestBlockhash('confirmed')).blockhash;
  const message = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: blockhash,
    instructions: finalIxs
  }).compileToV0Message();

  const tx = new VersionedTransaction(message);
  if (guardIxIndex !== null) {
    try {
      Object.defineProperty(tx, 'guardIxIndex', { value: guardIxIndex, enumerable: false });
    } catch {}
  }
  return tx;
}

module.exports = { assembleV0Tx };
