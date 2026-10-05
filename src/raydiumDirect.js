// src/raydiumDirect.js
//
// Builds Raydium swap transactions directly against the on-chain programs,
// using Raydium's own official SDK (@raydium-io/raydium-sdk-v2) instead of
// routing through SolanaPortal's trade-building API.
//
// Pool types handled, all paired with SOL:
//   - LaunchLab: Raydium's launchpad bonding curve (like Pump.fun's), while
//     the coin is still on its curve. Found directly on-chain (no API).
//   - AMM v4 / AMM Stable / CPMM ("standard" pools).
//   - CLMM (concentrated liquidity).
// Coins whose pools pair with another token (e.g. USD1) instead of SOL, or
// that are too new to be in Raydium's pool list, are rejected with
// UnsupportedRaydiumTradeError so the caller falls back to SolanaPortal /
// Jupiter.
//
// Which pool: a LaunchLab curve that is still trading wins (while a coin is
// on its curve, that's where it trades); otherwise the SOL pool with the most
// liquidity in Raydium's list.

const { NATIVE_MINT } = require('@solana/spl-token');
const { PublicKey } = require('@solana/web3.js');
const BN = require('bn.js');
const {
  Raydium,
  TxVersion,
  PoolFetchType,
  AMM_V4,
  AMM_STABLE,
  CREATE_CPMM_POOL_PROGRAM,
  CLMM_PROGRAM_ID,
  LAUNCHPAD_PROGRAM,
  getPdaLaunchpadPoolId,
  LaunchpadPool,
  PoolUtils,
  CurveCalculator,
  FeeOn
} = require('@raydium-io/raydium-sdk-v2');
const { randomTipAccount } = require('./jitoTip');
const { uiToRaw } = require('./amounts');
const { attachQuote } = require('./buyQuote');

class UnsupportedRaydiumTradeError extends Error {}

const AMM_PROGRAM_IDS = new Set([AMM_V4.toBase58(), AMM_STABLE.toBase58()]);
const CPMM_PROGRAM_IDS = new Set([CREATE_CPMM_POOL_PROGRAM.toBase58()]);
const CLMM_PROGRAM_IDS = new Set([CLMM_PROGRAM_ID.toBase58()]);
const SOL = NATIVE_MINT.toBase58();
const LAUNCHLAB_TRADING = 0; // pool status: 0 = curve trading, 1 = migrating, 2 = migrated
const KIND_LABEL = { amm: 'Raydium AMM', cpmm: 'Raydium CPMM', clmm: 'Raydium CLMM', launchlab: 'Raydium LaunchLab' };

function poolKind(programId) {
  if (AMM_PROGRAM_IDS.has(programId)) return 'amm';
  if (CPMM_PROGRAM_IDS.has(programId)) return 'cpmm';
  if (CLMM_PROGRAM_IDS.has(programId)) return 'clmm';
  return null;
}

// Raydium.load() fetches Raydium's own API config on first call; reuse one
// lazily-created instance across trades instead of reloading it every time.
// Rebuilt if the Connection changes (RPC failover rotated endpoints), since
// the SDK instance holds on to the Connection it was loaded with.
// One load in flight at a time (two builds at once share it), and the
// connection is only switched once its load has succeeded: a failed reload
// must not leave the old instance paired with the new connection.
let raydiumConnection = null;
let raydiumLoad = null; // Promise of the instance for raydiumConnection
async function getRaydium(connection, owner) {
  if (!raydiumLoad || raydiumConnection !== connection) {
    const load = Raydium.load({
      connection,
      owner,
      cluster: 'mainnet',
      disableLoadToken: true,
      disableFeatureCheck: true,
      blockhashCommitment: 'confirmed'
    });
    raydiumConnection = connection;
    raydiumLoad = load;
    load.catch(() => {
      // Failed: forget it, so the next build tries again.
      if (raydiumLoad === load) {
        raydiumLoad = null;
        raydiumConnection = null;
      }
    });
  }
  return raydiumLoad;
}

/**
 * Where to trade `mint` against SOL on Raydium:
 *   { kind: 'launchlab', id, launch }  - LaunchLab curve still trading
 *   { kind: 'amm'|'cpmm'|'clmm', id, poolInfo } - most liquid listed SOL pool
 * The on-chain LaunchLab lookup and Raydium's pool list are fetched in
 * parallel (one round trip).
 */
async function resolvePool(raydium, connection, mint) {
  const launchId = getPdaLaunchpadPoolId(LAUNCHPAD_PROGRAM, new PublicKey(mint), NATIVE_MINT).publicKey;
  const [launchAcc, listed] = await Promise.all([
    connection.getAccountInfo(launchId, 'processed').catch(() => null),
    raydium.api
      .fetchPoolByMints({ mint1: SOL, mint2: mint, type: PoolFetchType.All, sort: 'liquidity', order: 'desc' })
      .then((r) => (r && r.data) || [])
      .catch(() => [])
  ]);

  if (launchAcc && launchAcc.owner && launchAcc.owner.equals(LAUNCHPAD_PROGRAM)) {
    const launch = LaunchpadPool.decode(launchAcc.data);
    if (launch.status === LAUNCHLAB_TRADING) return { kind: 'launchlab', id: launchId.toBase58(), launch };
    // Curve finished: the coin now trades on the pool it migrated to (below).
  }

  const pools = listed.filter((p) => {
    const a = p.mintA && p.mintA.address;
    const b = p.mintB && p.mintB.address;
    return poolKind(p.programId) && ((a === SOL && b === mint) || (b === SOL && a === mint));
  });
  if (pools.length) {
    const best = pools.reduce((x, y) => ((Number(y.tvl) || 0) > (Number(x.tvl) || 0) ? y : x), pools[0]);
    return { kind: poolKind(best.programId), id: best.id, poolInfo: best };
  }
  throw new UnsupportedRaydiumTradeError(
    launchAcc
      ? `its LaunchLab curve has finished and Raydium doesn't list its new pool yet`
      : `no Raydium pool pairs it with SOL (it may be priced in another token such as USD1, or be too new for Raydium's pool list)`
  );
}

/** A CLMM swap (exact input), quoted from the pool's live on-chain state. */
async function clmmSwap(raydium, data, inputMint, amountIn, slippage, common) {
  const { poolInfo, poolKeys, computePoolInfo, tickData } = data;
  const baseIn = poolInfo.mintA.address === inputMint;
  const quote = PoolUtils.computeAmountOutFormat({
    poolInfo: computePoolInfo,
    tickarrayBitmapExtension: computePoolInfo.exBitmapInfo,
    tickArrayCache: tickData[poolInfo.id],
    amountIn,
    tokenOut: poolInfo[baseIn ? 'mintB' : 'mintA'],
    slippage,
    epochInfo: await raydium.fetchEpochInfo(),
    blockTimestamp: Math.floor(Date.now() / 1000)
  });
  const res = await raydium.clmm.swap({
    poolInfo,
    poolKeys,
    inputMint,
    amountIn,
    amountOutMin: quote.minAmountOut.amount.raw,
    observationId: computePoolInfo.observationId,
    ownerInfo: { useSOLBalance: true },
    remainingAccounts: quote.remainingAccounts,
    ...common
  });
  // Expected (not minimum) amount out, for MAX_ENTRY_PREMIUM_PCT.
  if (res && quote.amountOut && quote.amountOut.amount) res.expectedOutRaw = quote.amountOut.amount.raw;
  return res;
}

/** Mark which Raydium pool type a transaction was built for (shown in the log). */
function labelled(tx, kind) {
  try {
    Object.defineProperty(tx, 'routeLabel', { value: KIND_LABEL[kind] || 'Raydium', enumerable: false });
  } catch {}
  return tx;
}

/**
 * Build an unsigned buy transaction (spend SOL, receive `mint`).
 * @param solAmount   - SOL to spend (plain number, e.g. 0.05)
 * @param slippagePct - percent, e.g. 20 for 20% (same convention as config.SLIPPAGE)
 */
async function buildRaydiumBuyTx({
  connection,
  user,
  mint,
  solAmount,
  slippagePct,
  tipSol = 0,
  computeUnitLimit = 300_000,
  priorityFeeMicroLamports = 0
}) {
  const raydium = await getRaydium(connection, user);
  const pool = await resolvePool(raydium, connection, mint);
  const { kind, poolInfo } = pool;

  const inputMint = SOL;
  const amountIn = new BN(Math.round(solAmount * 1e9));
  const slippage = slippagePct / 100; // SDK expects a fraction (0.01 = 1%), config.SLIPPAGE is a percent
  const computeBudgetConfig = { units: computeUnitLimit, microLamports: priorityFeeMicroLamports || undefined };
  const txTipConfig = tipSol > 0 ? { address: randomTipAccount(), amount: new BN(Math.round(tipSol * 1e9)) } : undefined;
  const common = { txVersion: TxVersion.V0, computeBudgetConfig, txTipConfig };

  let txResult;
  let outRaw = null; // expected tokens out (raw), where the pool type gives it cheaply
  if (kind === 'launchlab') {
    txResult = await raydium.launchpad.buyToken({
      programId: LAUNCHPAD_PROGRAM,
      mintA: new PublicKey(mint),
      mintB: NATIVE_MINT,
      poolInfo: pool.launch,
      buyAmount: amountIn,
      slippage: new BN(Math.round(slippagePct * 100)), // basis points
      ...common
    });
  } else if (kind === 'clmm') {
    const data = await raydium.clmm.getPoolInfoFromRpc(pool.id);
    txResult = await clmmSwap(raydium, data, inputMint, amountIn, slippage, common);
    outRaw = txResult.expectedOutRaw || null;
  } else if (kind === 'amm') {
    const poolKeys = await raydium.liquidity.getAmmPoolKeys(poolInfo.id);
    const rpcData = await raydium.liquidity.getRpcPoolInfo(poolInfo.id);
    const [baseReserve, quoteReserve, status] = [rpcData.baseReserve, rpcData.quoteReserve, rpcData.status.toNumber()];
    const [mintIn, mintOut] =
      poolInfo.mintA.address === inputMint ? [poolInfo.mintA, poolInfo.mintB] : [poolInfo.mintB, poolInfo.mintA];

    const out = raydium.liquidity.computeAmountOut({
      poolInfo: { ...poolInfo, baseReserve, quoteReserve, status, version: 4 },
      amountIn,
      mintIn: mintIn.address,
      mintOut: mintOut.address,
      slippage
    });
    outRaw = out.amountOut || null;

    txResult = await raydium.liquidity.swap({
      poolInfo,
      poolKeys,
      amountIn,
      amountOut: out.minAmountOut,
      fixedSide: 'in',
      inputMint: mintIn.address,
      txVersion: TxVersion.V0,
      computeBudgetConfig,
      txTipConfig
    });
  } else {
    const rpcData = await raydium.cpmm.getRpcPoolInfo(poolInfo.id, true);
    const baseIn = poolInfo.mintA.address === inputMint;
    const swapResult = CurveCalculator.swapBaseInput(
      amountIn,
      baseIn ? rpcData.baseReserve : rpcData.quoteReserve,
      baseIn ? rpcData.quoteReserve : rpcData.baseReserve,
      rpcData.configInfo.tradeFeeRate,
      rpcData.configInfo.creatorFeeRate,
      rpcData.configInfo.protocolFeeRate,
      rpcData.configInfo.fundFeeRate,
      rpcData.feeOn === FeeOn.BothToken || rpcData.feeOn === FeeOn.OnlyTokenB
    );
    outRaw = swapResult.outputAmount || null;

    txResult = await raydium.cpmm.swap({
      poolInfo,
      inputAmount: amountIn,
      swapResult,
      slippage,
      baseIn,
      txVersion: TxVersion.V0,
      computeBudgetConfig,
      txTipConfig
    });
  }

  const tx = labelled(txResult.transaction, kind);
  // LaunchLab gives no cheap quote here; MAX_ENTRY_PREMIUM_PCT then can't check it.
  const tokenSide = poolInfo && poolInfo.mintA && (poolInfo.mintA.address === mint ? poolInfo.mintA : poolInfo.mintB);
  if (outRaw && tokenSide && typeof tokenSide.decimals === 'number') {
    attachQuote(tx, { solIn: solAmount, tokensOut: Number(outRaw.toString()) / 10 ** tokenSide.decimals });
  }
  return tx;
}

/**
 * Build an unsigned sell transaction (spend `mint`, receive SOL).
 * @param tokenAmountUi - tokens to sell, in UI units (e.g. "1234.56")
 * @param slippagePct   - percent, e.g. 20 for 20%
 */
async function buildRaydiumSellTx({
  connection,
  user,
  mint,
  tokenAmountUi,
  slippagePct,
  tipSol = 0,
  computeUnitLimit = 300_000,
  priorityFeeMicroLamports = 0
}) {
  const raydium = await getRaydium(connection, user);
  // The SDK finds our token account in its cached list of the wallet's
  // accounts; refresh it so a coin bought moments ago is in it.
  const [pool] = await Promise.all([
    resolvePool(raydium, connection, mint),
    raydium.account.fetchWalletTokenAccounts({ forceUpdate: true })
  ]);
  const { kind } = pool;
  const clmmData = kind === 'clmm' ? await raydium.clmm.getPoolInfoFromRpc(pool.id) : null;
  const poolInfo = clmmData ? clmmData.poolInfo : pool.poolInfo;

  let decimals;
  if (kind === 'launchlab') {
    decimals = pool.launch.mintDecimalsA;
  } else {
    const mintSide =
      poolInfo.mintA.address === mint ? poolInfo.mintA : poolInfo.mintB.address === mint ? poolInfo.mintB : null;
    if (!mintSide) throw new UnsupportedRaydiumTradeError(`Pool ${poolInfo.id} does not actually contain ${mint}`);
    decimals = mintSide.decimals;
  }

  // Built from an exact BigInt string: `new BN(number)` throws for values
  // above 2^53 (a large bag of a 9-decimal token) and float math can round
  // up past what we actually hold.
  const amountIn = new BN(uiToRaw(tokenAmountUi, decimals).toString());
  if (amountIn.lten(0)) {
    throw new UnsupportedRaydiumTradeError(`Sell amount for ${mint} rounds to zero raw tokens`);
  }

  const slippage = slippagePct / 100;
  const computeBudgetConfig = { units: computeUnitLimit, microLamports: priorityFeeMicroLamports || undefined };
  const txTipConfig = tipSol > 0 ? { address: randomTipAccount(), amount: new BN(Math.round(tipSol * 1e9)) } : undefined;
  const common = { txVersion: TxVersion.V0, computeBudgetConfig, txTipConfig };

  let txResult;
  if (kind === 'launchlab') {
    txResult = await raydium.launchpad.sellToken({
      programId: LAUNCHPAD_PROGRAM,
      mintA: new PublicKey(mint),
      mintB: NATIVE_MINT,
      poolInfo: pool.launch,
      sellAmount: amountIn,
      slippage: new BN(Math.round(slippagePct * 100)), // basis points
      ...common
    });
  } else if (kind === 'clmm') {
    txResult = await clmmSwap(raydium, clmmData, mint, amountIn, slippage, common);
  } else if (kind === 'amm') {
    const poolKeys = await raydium.liquidity.getAmmPoolKeys(poolInfo.id);
    const rpcData = await raydium.liquidity.getRpcPoolInfo(poolInfo.id);
    const [baseReserve, quoteReserve, status] = [rpcData.baseReserve, rpcData.quoteReserve, rpcData.status.toNumber()];
    const mintOut = poolInfo.mintA.address === mint ? poolInfo.mintB : poolInfo.mintA;

    const out = raydium.liquidity.computeAmountOut({
      poolInfo: { ...poolInfo, baseReserve, quoteReserve, status, version: 4 },
      amountIn,
      mintIn: mint,
      mintOut: mintOut.address,
      slippage
    });

    txResult = await raydium.liquidity.swap({
      poolInfo,
      poolKeys,
      amountIn,
      amountOut: out.minAmountOut,
      fixedSide: 'in',
      inputMint: mint,
      txVersion: TxVersion.V0,
      computeBudgetConfig,
      txTipConfig
    });
  } else {
    const rpcData = await raydium.cpmm.getRpcPoolInfo(poolInfo.id, true);
    const baseIn = poolInfo.mintA.address === mint;
    const swapResult = CurveCalculator.swapBaseInput(
      amountIn,
      baseIn ? rpcData.baseReserve : rpcData.quoteReserve,
      baseIn ? rpcData.quoteReserve : rpcData.baseReserve,
      rpcData.configInfo.tradeFeeRate,
      rpcData.configInfo.creatorFeeRate,
      rpcData.configInfo.protocolFeeRate,
      rpcData.configInfo.fundFeeRate,
      rpcData.feeOn === FeeOn.BothToken || rpcData.feeOn === FeeOn.OnlyTokenB
    );

    txResult = await raydium.cpmm.swap({
      poolInfo,
      inputAmount: amountIn,
      swapResult,
      slippage,
      baseIn,
      txVersion: TxVersion.V0,
      computeBudgetConfig,
      txTipConfig
    });
  }

  return labelled(txResult.transaction, kind);
}

/** For tests: use a stand-in SDK instance instead of loading Raydium's. */
function _setRaydiumForTests(instance, connection) {
  raydiumLoad = Promise.resolve(instance);
  raydiumConnection = connection;
}

module.exports = { buildRaydiumBuyTx, buildRaydiumSellTx, UnsupportedRaydiumTradeError, resolvePool, _setRaydiumForTests };
