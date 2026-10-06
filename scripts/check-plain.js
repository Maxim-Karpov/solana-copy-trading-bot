#!/usr/bin/env node
// scripts/check-plain.js — `npm run check-plain -- <coin address> [SOL amount]`
//
// Tries TOKEN_ACCOUNT_MODE=plain on a live Pump.fun coin WITHOUT buying
// anything: it builds the bot's fast buy twice (the usual way, and with a
// plain token account), has your RPC SIMULATE both against the chain as it is
// now, and prints whether each would succeed and how many compute units each
// uses. Run it before turning the setting on, on a coin that is still on its
// bonding curve (both a normal and a Token-2022 coin are worth trying).
// Needs the same .env as the bot (wallet, RPC) and a little SOL in the wallet
// (the simulation checks the balance; nothing is spent).
//
//   npm run check-plain -- <coin address>
//   npm run check-plain -- <coin address> 0.02

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
// The settings the fast buy needs (this script changes none of your files).
process.env.DIRECT_PUMPFUN_SWAP = 'true';
process.env.SHRED_FAST_BUY = 'true';
process.env.MAX_MARKET_CAP_SOL = process.env.MAX_MARKET_CAP_SOL || '1000000';

const { PublicKey, VersionedTransaction } = require('@solana/web3.js');
const sdk = require('@pump-fun/pump-sdk');
const { getAssociatedTokenAddressSync } = require('@solana/spl-token');

const mintArg = process.argv[2];
const amount = Number(process.argv[3] || 0.01);

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

async function main() {
  if (!mintArg) fail('Usage: npm run check-plain -- <coin address> [SOL amount]');
  let mintPk;
  try {
    mintPk = new PublicKey(mintArg);
  } catch {
    fail(`"${mintArg}" isn't an address.`);
  }
  const config = require('../src/config');
  const rpcPool = require('../src/rpcPool');
  const prewarm = require('../src/prewarm');
  const d = require('../src/pumpfunDirect');
  const te = require('../src/tradeExecutor');
  const plainAccount = require('../src/plainAccount');
  const user = new PublicKey(config.PUBLIC_KEY);
  const conn = rpcPool.getConnection('confirmed');

  console.log('Warming up (Pump.fun config, a blockhash, the hand-built buy check)...');
  await prewarm.start();
  const global = prewarm.pumpGlobal();
  if (!global || !prewarm.blockhash()) fail("Couldn't read Pump.fun's config or a blockhash from your RPC.");

  const st = await d.curveState(conn, mintPk, user);
  if (st.bondingCurve.complete) fail('That coin has graduated: pick one that is still on its bonding curve.');
  if (st.quoteMint && st.quoteMint.toBase58() !== 'So11111111111111111111111111111111111111112') fail('That coin is paired to another token; try a normal SOL coin.');
  const program = st.mintInfo.program;
  const is22 = program.toBase58().startsWith('Tokenz');
  console.log(`Coin ${mintPk.toBase58()}: ${is22 ? 'Token-2022' : 'classic SPL token'} coin, buying ${amount} SOL (simulated only).`);

  if (is22) await plainAccount.learnLength(conn, user);
  if (is22 && !plainAccount.accountLen(program)) {
    console.log("The wallet has no Token-2022 token account yet, so the length of one isn't known and plain mode would use the usual account for these coins.");
    console.log('Buy one Token-2022 coin the usual way first (or set TOKEN_2022_ACCOUNT_BYTES), then run this again.');
  }

  const curve = sdk.bondingCurvePda(mintPk);
  const feeRecipient = d.recipientsOf(global).normal[0];
  const hint = {
    mint: mintPk.toBase58(),
    creatorVault: sdk.creatorVaultPda(st.bondingCurve.creator).toBase58(),
    txKeys: [curve, getAssociatedTokenAddressSync(mintPk, curve, true, program), sdk.bondingCurveV2Pda(mintPk), new PublicKey(feeRecipient)].map(String)
  };
  const ceiling = config.PUMPFUN_COMPUTE_UNITS;
  const fee = te.priorityFeeSol('buy', amount);
  const tipSol = config.SEND_VIA === 'sender' ? config.SENDER_TIP : config.JITO_TIP;

  const results = {};
  for (const mode of ['ata', 'plain']) {
    config.TOKEN_ACCOUNT_MODE = mode;
    const tx = await d.buildPumpfunBuyTx({
      connection: conn,
      user,
      mint: mintPk.toBase58(),
      solAmount: amount,
      slippagePct: 20,
      tipSol: te.handBuiltPlan(fee, ceiling, tipSol).tip ? tipSol : 0,
      computeUnitLimit: ceiling,
      priorityFeeMicroLamports: fee > 0 ? Math.ceil((fee * 1e9 * 1e6) / ceiling) : 0,
      fastHint: hint,
      maxMcapSol: Number(process.env.MAX_MARKET_CAP_SOL),
      minMcapSol: null,
      handBuilt: te.handBuiltPlan(fee, ceiling, tipSol)
    });
    const label = mode === 'ata' ? 'usual account (ATA)' : 'plain account';
    const usedPlain = Boolean(tx.plainMint);
    if (mode === 'plain' && !usedPlain) {
      console.log(`\n${label}: not used for this coin (the bot would use the ATA: ${is22 ? 'Token-2022 length unknown' : 'plain mode is off'}).`);
      continue;
    }
    const vtx = VersionedTransaction.deserialize(tx.serialize());
    const sim = await conn.simulateTransaction(vtx, { sigVerify: false, replaceRecentBlockhash: true, commitment: 'processed' });
    const v = sim.value;
    results[mode] = v;
    console.log(`\n${label}: ${v.err ? 'FAILED' : 'OK'}${v.unitsConsumed ? `, ${v.unitsConsumed.toLocaleString('en-US')} compute units used` : ''}`);
    if (v.err) {
      console.log(`  error: ${JSON.stringify(v.err)}`);
      for (const l of (v.logs || []).slice(-8)) console.log(`  ${l}`);
    }
  }

  const a = results.ata;
  const p = results.plain;
  console.log('');
  if (a && p && !a.err && !p.err) {
    const saved = a.unitsConsumed - p.unitsConsumed;
    console.log(`Plain account saves ${saved.toLocaleString('en-US')} compute units (${((saved / a.unitsConsumed) * 100).toFixed(1)}%) on this buy: at the same total fee, ${((a.unitsConsumed / p.unitsConsumed - 1) * 100).toFixed(0)}% more fee per unit.`);
    console.log('Both simulated fine. To use it: set TOKEN_ACCOUNT_MODE="plain" in .env and restart.');
  } else if (p && p.err) {
    console.log('The plain-account buy FAILED in the simulation: leave TOKEN_ACCOUNT_MODE on "ata" and send me the lines above.');
  } else if (a && a.err) {
    console.log('Even the usual buy failed in the simulation (see above): the coin may have moved, or the wallet lacks SOL. Try another coin.');
  }
  process.exit(0);
}

main().catch((err) => fail(`Failed: ${err.message}`));
