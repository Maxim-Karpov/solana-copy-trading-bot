// src/pumpRoute.js
//
// Picks the direct builder for a Pump.fun coin:
//   - the copy wallet traded on PumpSwap ('pumpswap' hint), or the coin is
//     already known to have graduated -> PumpSwap straight away;
//   - otherwise the bonding curve, and if that reports the curve has
//     completed (the coin graduated, e.g. while we held it) -> PumpSwap,
//     remembered for this coin so later trades skip the curve.

const { buildPumpfunBuyTx, buildPumpfunSellTx, UnsupportedPumpfunTradeError } = require('./pumpfunDirect');
const { buildPumpSwapBuyTx, buildPumpSwapSellTx, UnsupportedPumpSwapTradeError } = require('./pumpswapDirect');

const graduated = new Set(); // mints whose curve has completed

function isUnsupported(err) {
  return err instanceof UnsupportedPumpfunTradeError || err instanceof UnsupportedPumpSwapTradeError;
}

async function buildPumpTx(side, args, hint) {
  if (hint !== 'pumpswap' && !graduated.has(args.mint)) {
    try {
      return await (side === 'buy' ? buildPumpfunBuyTx : buildPumpfunSellTx)(args);
    } catch (err) {
      if (!(err instanceof UnsupportedPumpfunTradeError && err.graduated)) throw err;
      graduated.add(args.mint);
      if (graduated.size > 2000) graduated.delete(graduated.values().next().value);
    }
  }
  return (side === 'buy' ? buildPumpSwapBuyTx : buildPumpSwapSellTx)(args);
}

module.exports = { buildPumpTx, isUnsupported, _graduated: graduated };
