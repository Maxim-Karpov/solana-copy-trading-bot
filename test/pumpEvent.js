// test/pumpEvent.js — builds real Pump.fun TradeEvent log lines with the
// official SDK's encoder, for tests.
const { Keypair, PublicKey } = require('@solana/web3.js');
const BN = require('bn.js');
const { PUMP_SDK } = require('@pump-fun/pump-sdk');

const PUMP = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const pk = () => Keypair.generate().publicKey;
const bn = (v) => new BN(String(v ?? 0));

const WSOL = 'So11111111111111111111111111111111111111112';

function tradeEventLine({ mint, user, sol = 0, tokens = 0, isBuy = true, vSol = 0, vTok = 0, rSol = 0, rTok = 0, creator, quoteMint = WSOL, mayhem = false, creatorFeeBps = 0 }) {
  const z = new BN(0);
  const body = PUMP_SDK.offlinePumpProgram.coder.types.encode('tradeEvent', {
    mint: new PublicKey(mint), solAmount: bn(sol), tokenAmount: bn(tokens), isBuy,
    user: new PublicKey(user), timestamp: new BN(1700000000), virtualSolReserves: bn(vSol), virtualTokenReserves: bn(vTok),
    realSolReserves: bn(rSol), realTokenReserves: bn(rTok), feeRecipient: pk(), feeBasisPoints: z, fee: z,
    creator: creator ? new PublicKey(creator) : pk(),
    creatorFeeBasisPoints: bn(creatorFeeBps), creatorFee: z, trackVolume: false, totalUnclaimedTokens: z, totalClaimedTokens: z,
    currentSolVolume: z, lastUpdateTimestamp: z, ixName: isBuy ? 'buy' : 'sell', mayhemMode: mayhem,
    cashbackFeeBasisPoints: z, cashback: z, buybackFeeBasisPoints: z, buybackFee: z, shareholders: [],
    quoteMint: new PublicKey(quoteMint), quoteAmount: z, virtualQuoteReserves: z, realQuoteReserves: z, holderRewardsBps: z, holderRewards: z
  });
  return 'Program data: ' + Buffer.concat([Buffer.from('bddb7fd34ee661ee', 'hex'), body]).toString('base64');
}

// A Pump.fun buy as it really logs: the token transfer (via the coin's token
// program) and SOL transfers are Pump.fun's own inner calls, then the event.
const pumpBuyLogs = (tokenProgram, ...dataLines) => [
  `Program ${PUMP} invoke [1]`,
  'Program log: Instruction: Buy',
  `Program ${tokenProgram} invoke [2]`,
  'Program log: Instruction: TransferChecked',
  `Program ${tokenProgram} success`,
  'Program 11111111111111111111111111111111 invoke [2]',
  'Program 11111111111111111111111111111111 success',
  ...dataLines,
  `Program ${PUMP} success`
];

const pumpLogs = (...dataLines) => [
  `Program ${PUMP} invoke [1]`,
  'Program log: Instruction: Buy',
  ...dataLines,
  `Program ${PUMP} success`
];

module.exports = { tradeEventLine, pumpLogs, pumpBuyLogs, PUMP };
