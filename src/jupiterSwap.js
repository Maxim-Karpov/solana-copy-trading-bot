// src/jupiterSwap.js
//
// Backup route: when SolanaPortal can't build a trade (it's down, times out,
// or refuses), the bot asks Jupiter's Swap API (/swap/v2/build) for the swap
// instead. Jupiter routes through almost every Solana venue (Pump.fun,
// PumpSwap, Raydium, Meteora, Orca, ...), so this covers coins the bot's own
// direct builders don't.
//
// Jupiter returns the raw swap instructions; the bot assembles the
// transaction itself with its own compute budget and tip, so it is signed
// and sent exactly like every other trade (Jito, or Helius Sender).
// Jupiter's response also carries a recent blockhash and the lookup tables'
// addresses, so building it costs no extra RPC calls (a sell needs one, for
// the coin's decimals, the first time).
//
// Needs a Jupiter API key (JUPITER_API_KEY, free at
// https://developers.jup.ag/portal). Without one the request is still tried,
// but Jupiter will most likely refuse it.

const {
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  SystemProgram,
  PACKET_DATA_SIZE
} = require('@solana/web3.js');
const config = require('./config');
const rpcPool = require('./rpcPool');
const { fetchJson } = require('./timeouts');
const { randomTipAccount } = require('./jitoTip');
const { uiToRaw } = require('./amounts');

let bs58;
{
  const imported = require('bs58');
  bs58 = imported.default ? imported.default : imported;
}

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const JUPITER_TIMEOUT_MS = 5000;
// Generous: Jupiter routes can hop through several pools. Only the priority
// fee is spread over it (PRIORITY_FEE_SOL stays the total), so a high limit
// costs nothing extra.
const JUPITER_CU_LIMIT = 600_000;
// Leave room in the 1232-byte transaction for our compute budget and tip.
const MAX_ROUTE_ACCOUNTS = 50;

const decimalsCache = new Map();

async function tokenDecimals(mint) {
  if (decimalsCache.has(mint)) return decimalsCache.get(mint);
  const resp = await rpcPool.withFailover((c) => c.getParsedAccountInfo(new PublicKey(mint)));
  const d = resp && resp.value && resp.value.data && resp.value.data.parsed && resp.value.data.parsed.info && resp.value.data.parsed.info.decimals;
  if (typeof d !== 'number') throw new Error(`couldn't read ${mint}'s decimals`);
  decimalsCache.set(mint, d);
  return d;
}

function toInstruction(ix) {
  return new TransactionInstruction({
    programId: new PublicKey(ix.programId),
    keys: (ix.accounts || []).map((a) => ({ pubkey: new PublicKey(a.pubkey), isSigner: !!a.isSigner, isWritable: !!a.isWritable })),
    data: Buffer.from(ix.data || '', 'base64')
  });
}

/** Venue names along Jupiter's route, e.g. "Meteora DLMM" or "Orca Whirlpool → Raydium". */
function routeLabel(build) {
  const labels = [];
  for (const step of build.routePlan || []) {
    const l = step && step.swapInfo && step.swapInfo.label;
    if (l && !labels.includes(l)) labels.push(l);
  }
  return labels.length ? labels.join(' → ') : 'unknown route';
}

async function requestBuild({ inputMint, outputMint, amountRaw, slippagePct, taker }) {
  const q = new URLSearchParams({
    inputMint,
    outputMint,
    amount: String(amountRaw),
    taker,
    slippageBps: String(Math.round(slippagePct * 100)),
    maxAccounts: String(MAX_ROUTE_ACCOUNTS),
    wrapAndUnwrapSol: 'true'
  });
  const headers = { Accept: 'application/json' };
  if (config.JUPITER_API_KEY) headers['x-api-key'] = config.JUPITER_API_KEY;
  const res = await fetchJson(`${config.JUPITER_API_URL}/build?${q}`, { method: 'GET', headers }, JUPITER_TIMEOUT_MS);
  if (res.status === 401 || res.status === 403) {
    throw new Error(
      `Jupiter refused the request (HTTP ${res.status})` +
        (config.JUPITER_API_KEY ? '; check JUPITER_API_KEY' : '; set JUPITER_API_KEY (free at https://developers.jup.ag/portal)')
    );
  }
  if (res.status === 429) throw new Error("Jupiter rate limit reached (HTTP 429); a JUPITER_API_KEY plan raises it");
  if (!res.ok) {
    const body = String(res.text || '');
    throw new Error(`Jupiter responded ${res.status}: ${/^\s*</.test(body) ? 'web page instead of a route' : body.slice(0, 200)}`);
  }
  const build = res.data;
  if (!build || !build.swapInstruction) {
    throw new Error(`Jupiter found no route${build && build.error ? ` (${build.error})` : ''}`);
  }
  return build;
}

/** Assemble Jupiter's instructions into an unsigned v0 transaction with our compute budget and tip. */
async function assemble(build, { payer, tipSol }) {
  const ixs = [ComputeBudgetProgram.setComputeUnitLimit({ units: JUPITER_CU_LIMIT })];
  if (config.PRIORITY_FEE_SOL > 0) {
    ixs.push(ComputeBudgetProgram.setComputeUnitPrice({
      microLamports: Math.ceil((config.PRIORITY_FEE_SOL * 1e9 * 1e6) / JUPITER_CU_LIMIT)
    }));
  }
  // Jupiter's own compute-budget instructions are left out: ours above apply.
  for (const ix of build.setupInstructions || []) ixs.push(toInstruction(ix));
  ixs.push(toInstruction(build.swapInstruction));
  if (build.cleanupInstruction) ixs.push(toInstruction(build.cleanupInstruction));
  for (const ix of build.otherInstructions || []) ixs.push(toInstruction(ix));
  if (tipSol > 0) {
    ixs.push(SystemProgram.transfer({ fromPubkey: payer, toPubkey: randomTipAccount(), lamports: Math.round(tipSol * 1e9) }));
  }

  const luts = Object.entries(build.addressesByLookupTableAddress || {}).map(
    ([key, addresses]) =>
      new AddressLookupTableAccount({
        key: new PublicKey(key),
        state: {
          deactivationSlot: BigInt('18446744073709551615'),
          lastExtendedSlot: 0,
          lastExtendedSlotStartIndex: 0,
          authority: undefined,
          addresses: addresses.map((a) => new PublicKey(a))
        }
      })
  );

  const bh = build.blockhashWithMetadata && build.blockhashWithMetadata.blockhash;
  const recentBlockhash = Array.isArray(bh) && bh.length === 32
    ? bs58.encode(Uint8Array.from(bh))
    : (await rpcPool.withFailover((c) => c.getLatestBlockhash('confirmed'))).blockhash;

  const tx = new VersionedTransaction(
    new TransactionMessage({ payerKey: payer, recentBlockhash, instructions: ixs }).compileToV0Message(luts)
  );
  const size = tx.serialize().length;
  if (size > PACKET_DATA_SIZE) throw new Error(`Jupiter's route is too large for one transaction (${size} bytes)`);
  return tx;
}

/** Unsigned buy transaction via Jupiter: { tx, route, outAmount }. */
async function buildJupiterBuyTx({ user, mint, amountSol, slippagePct, tipSol }) {
  const build = await requestBuild({
    inputMint: SOL_MINT,
    outputMint: mint,
    amountRaw: Math.round(amountSol * 1e9),
    slippagePct,
    taker: user.toBase58()
  });
  return { tx: await assemble(build, { payer: user, tipSol }), route: routeLabel(build), outAmount: build.outAmount };
}

/** Unsigned sell transaction via Jupiter: { tx, route, outAmount }. */
async function buildJupiterSellTx({ user, mint, tokenAmountUi, slippagePct, tipSol }) {
  const raw = uiToRaw(tokenAmountUi, await tokenDecimals(mint));
  if (raw <= 0n) throw new Error(`sell amount for ${mint} rounds to zero`);
  const build = await requestBuild({
    inputMint: mint,
    outputMint: SOL_MINT,
    amountRaw: raw,
    slippagePct,
    taker: user.toBase58()
  });
  return { tx: await assemble(build, { payer: user, tipSol }), route: routeLabel(build), outAmount: build.outAmount };
}

/** Raw units of `mint` that `amountSol` SOL buys right now (a price check; nothing is sent). */
async function priceProbe(mint, amountSol) {
  const build = await requestBuild({
    inputMint: SOL_MINT,
    outputMint: mint,
    amountRaw: Math.round(amountSol * 1e9),
    slippagePct: 1,
    taker: config.PUBLIC_KEY
  });
  return BigInt(build.outAmount || 0);
}

module.exports = { buildJupiterBuyTx, buildJupiterSellTx, priceProbe, routeLabel, JUPITER_CU_LIMIT };
