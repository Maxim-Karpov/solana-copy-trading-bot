// src/stockTokens.js
//
// Recognises tokenized stocks (and pre-IPO stock tokens) used as the quote
// asset of "stock-paired" launches, e.g. coins on StonkFun / Raydium
// LaunchLab priced in NVDAx instead of SOL.
//
// A token counts as a stock token if it is:
//   - in the known list below (symbols shown in Telegram), or
//   - an xStocks token (Backed Finance; every mint starts with "Xs"), or
//   - a PreStocks token (mints start with "Pre"), or
//   - listed in STOCK_TOKEN_MINTS in .env (comma-separated), for anything new.
// Prefixes are only ever tested on the token a coin is PRICED IN, never on
// the coin itself.

const KNOWN = {
  // xStocks (Backed Finance)
  XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W: 'SPYx',
  Xs8S1uUs1zvS2p7iwtsG3b6fkhpvmwz4GYU3gWAmWHZ: 'QQQx',
  XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp: 'AAPLx',
  XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB: 'TSLAx',
  Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh: 'NVDAx',
  XspzcW1PRtgf6Wj92HCiZdjzKCyFekVD8P5Ueh3dRMX: 'MSFTx',
  Xsa62P5mvPszXL1krVUnU5ar38bBSVcWAB6fmPCo5Zu: 'METAx',
  XsCPL9dNWBMvFtTmwcCA5v3xWPSMEBCszbQdiLLq6aN: 'GOOGLx',
  Xs3eBt7uRfJX8QUs4suhyU8p2M6DoUDrJyWBa8LLZsg: 'AMZNx',
  Xsv9hRk1z5ystj9MhnA7Lq4vjSsLwzL2nxrwmwtD3re: 'GLDx',
  XsueG8BtpquVJX9LVLLEGuViXUungE6WmK5YZ3p3bd1: 'CRCLx',
  XsP7xzNPvEHS1m6qfanPUGjNmdnmsLKEoNAnHjdxxyZ: 'MSTRx',
  Xs7ZdzSHLU9ftNJsii5fCeJhoRWSC32SQGzGQtePxNu: 'COINx',
  Xs3oZwbHvqis4NYcf4YKWmEia2eC84wSiVrcYcTqpH8: 'SPCXx',
  XsoBhf2ufR8fTyNSjqfU71DYGaE6Z3SUGAidpzriAA4: 'PLTRx',
  Xsf9mBktVB9BSU5kf4nHxPq5hCBJ2j2ui3ecFGxPRGc: 'GMEx',
  XsqE9cRRpzxcGKDXj1BJ7Xmg4GRhZoyY1KpmGSxAWT2: 'MCDx',
  // Pre-IPO stock tokens
  PreweJYECqtQwBtpxHL171nL2K6umo692gTm7Q3rpgF: 'OPENAI (PreStocks)',
  Pren1FvFX6J3E4kXhJuCiAD5aDmGEb7qJRncwA8Lkhw: 'ANTHROPIC (PreStocks)',
  oPAiAikWTaFj9RYoRFD35ccfwhnMcB3ThgBZRHSkjTZ: 'tOpenAI',
  // Backpack Securities
  BoTx8y9ynfdxf5ZjWtCoBVkff52qKA82ysaLU8ZM6d8T: 'BOT',
  LLYuwZ33keFihgwoxXsBawy31AiRFLFSva32TYq5TvD: 'LLY'
};

const extra = new Set(
  (process.env.STOCK_TOKEN_MINTS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
);

/** Is this mint a tokenized stock / pre-IPO token? */
function isStockToken(mint) {
  if (!mint || typeof mint !== 'string') return false;
  return Boolean(KNOWN[mint]) || extra.has(mint) || mint.startsWith('Xs') || mint.startsWith('Pre');
}

/** Display name: the known symbol, or a shortened address. */
function stockLabel(mint) {
  return KNOWN[mint] || `${mint.slice(0, 4)}...${mint.slice(-4)}`;
}

/**
 * The stock a copy-wallet trade went through, from the transaction's token
 * balance records (pool vaults included), or null. `coinMint` is the coin
 * itself, which is never treated as the quote.
 */
function findStockInTx(parsedTx, coinMint) {
  const meta = parsedTx && parsedTx.meta;
  if (!meta) return null;
  for (const tb of [...(meta.preTokenBalances || []), ...(meta.postTokenBalances || [])]) {
    if (tb && tb.mint && tb.mint !== coinMint && isStockToken(tb.mint)) return tb.mint;
  }
  return null;
}

module.exports = { isStockToken, stockLabel, findStockInTx, KNOWN_STOCKS: KNOWN };
