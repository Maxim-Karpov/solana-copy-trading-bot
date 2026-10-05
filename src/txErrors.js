// src/txErrors.js
//
// Plain-English reasons for the on-chain errors a trade most often fails
// with. Program error numbers are per program, so a reason is only given
// when the trade's route is known; anything else keeps the raw error.

// Keyed by pool type (dexMapper.detectPool) or venue: the same number means
// different things in different programs (6004 is slippage on PumpSwap but
// a mint mismatch on the Pump.fun curve).
const BY_ROUTE = {
  'pump-curve': {
    6002: 'the price rose more than your SLIPPAGE before it landed (Pump.fun: too much SOL required)',
    6003: 'the price fell more than your SLIPPAGE before it landed (Pump.fun: too little SOL received)',
    6042: 'the market cap was above your MAX_MARKET_CAP_SOL when it ran (shred buy without lookup: fewer tokens than the minimum)'
  },
  pumpswap: {
    6004: 'the price moved more than your SLIPPAGE before it landed (PumpSwap)',
    6040: 'the price rose more than your SLIPPAGE before it landed (PumpSwap: fewer tokens than the minimum)'
  },
  jupiter: { 6001: 'the price moved more than your SLIPPAGE before it landed (Jupiter)' }
};
BY_ROUTE.pumpfun = BY_ROUTE['pump-curve']; // venue only: most Pump.fun trades are on the curve

/** "reason (raw error)" when the reason is known, else the raw error. */
function explainTxError(err, route) {
  const raw = JSON.stringify(err);
  const ie = err && err.InstructionError;
  if (Array.isArray(ie) && ie[1] === 'ComputationalBudgetExceeded') {
    return `it ran out of compute units (raise PUMPFUN_COMPUTE_UNITS); ${raw}`;
  }
  if (Array.isArray(ie) && ie[1] === 'ProgramFailedToComplete') {
    return `the program stopped part-way, usually because it ran out of compute units inside Pump.fun (raise PUMPFUN_COMPUTE_UNITS if the budget is tight); ${raw}`;
  }
  const code = Array.isArray(ie) && ie[1] && typeof ie[1].Custom === 'number' ? ie[1].Custom : null;
  const reason = code !== null && BY_ROUTE[route] && BY_ROUTE[route][code];
  return reason ? `${reason}; ${raw}` : raw;
}

module.exports = { explainTxError };
