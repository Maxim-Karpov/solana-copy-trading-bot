// src/slotGuard.js
//
// MAX_SLOTS_BEHIND: only buy if our transaction lands within N slots of the
// copy wallet's own (0 = the same block). Solana transactions have no
// "must land by slot X" field, so the buy carries one extra instruction for
// Lighthouse, a public on-chain assertion program used by wallets as a
// transaction guard: "the current slot must be <= X". If the buy lands
// later, that instruction fails and the WHOLE transaction is undone (the
// swap, the token-account creation and the tip), so nothing is bought. You
// only pay the network fee (5,000 lamports plus your priority fee).
//
// The instruction is 12 bytes, needs no accounts and costs very little
// compute. Its layout comes from Lighthouse's own SDK (lighthouse-sdk,
// generated from the program): discriminator 15 (AssertSysvarClock), log
// level 0 (silent), assertion kind 0 (Slot), the slot as a u64, and the
// operator 5 (LessThanOrEqual).

const { PublicKey, TransactionInstruction } = require('@solana/web3.js');

const LIGHTHOUSE_PROGRAM_ID = new PublicKey('L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95');
const ASSERT_SYSVAR_CLOCK = 15;
const LOG_SILENT = 0;
const CLOCK_SLOT = 0;
const LESS_THAN_OR_EQUAL = 5;
const ASSERTION_FAILED = 6001; // Lighthouse's error code when an assertion doesn't hold

/** "Fail this transaction if it lands after `maxSlot`." */
function maxSlotInstruction(maxSlot) {
  const data = Buffer.alloc(12);
  data.writeUInt8(ASSERT_SYSVAR_CLOCK, 0);
  data.writeUInt8(LOG_SILENT, 1);
  data.writeUInt8(CLOCK_SLOT, 2);
  data.writeBigUInt64LE(BigInt(maxSlot), 3);
  data.writeUInt8(LESS_THAN_OR_EQUAL, 11);
  return new TransactionInstruction({ programId: LIGHTHOUSE_PROGRAM_ID, keys: [], data });
}

// signature -> { maxSlot, ixIndex }: guarded buys, so a failure can be explained.
const guarded = new Map();

function remember(signature, info) {
  guarded.set(signature, info);
  if (guarded.size > 500) guarded.delete(guarded.keys().next().value);
}

/**
 * If `err` (a failed buy's on-chain error) is our slot guard firing: a short
 * explanation, else null.
 */
function explainFailure(signature, err) {
  const g = guarded.get(signature);
  const ie = err && err.InstructionError;
  if (!g || !Array.isArray(ie) || ie[0] !== g.ixIndex) return null;
  const code = ie[1] && ie[1].Custom;
  if (code !== ASSERTION_FAILED) return null;
  return `it would have landed after slot ${g.maxSlot} (MAX_SLOTS_BEHIND), so the slot guard cancelled it; nothing was bought, only the network fee was paid`;
}

// Whether Lighthouse is deployed where we trade (checked once at startup).
let available = true;

/**
 * Check once that the Lighthouse program exists. Returns true / false; an
 * RPC error counts as available (the check is only there to catch a
 * missing program, which would make every guarded buy fail).
 */
async function verifyDeployed(connection) {
  try {
    const acc = await connection.getAccountInfo(LIGHTHOUSE_PROGRAM_ID);
    available = !!(acc && acc.executable);
  } catch {
    available = true;
  }
  return available;
}

function isAvailable() {
  return available;
}

module.exports = {
  LIGHTHOUSE_PROGRAM_ID,
  ASSERTION_FAILED,
  maxSlotInstruction,
  remember,
  explainFailure,
  verifyDeployed,
  isAvailable,
  _setAvailableForTests: (v) => {
    available = v;
  }
};
