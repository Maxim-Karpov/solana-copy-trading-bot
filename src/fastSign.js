// src/fastSign.js
//
// Signs a transaction with Node's built-in ed25519 (OpenSSL) instead of
// @solana/web3.js's pure-JavaScript one: the same signature (ed25519 is
// deterministic), in roughly a tenth of the time, on every buy and sell
// just before it is sent. Falls back to web3.js if anything is unusual.

const crypto = require('crypto');
const { VersionedTransaction } = require('@solana/web3.js');

// DER prefix of a PKCS#8 ed25519 private key; the 32-byte seed follows.
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const keys = new WeakMap(); // Keypair -> KeyObject

function keyFor(keypair) {
  let key = keys.get(keypair);
  if (!key) {
    const seed = Buffer.from(keypair.secretKey.slice(0, 32));
    key = crypto.createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]), format: 'der', type: 'pkcs8' });
    keys.set(keypair, key);
  }
  return key;
}

/** Sign `tx` (in place) with `keypair`. */
function signTx(tx, keypair) {
  if (tx instanceof VersionedTransaction) {
    try {
      const signature = crypto.sign(null, Buffer.from(tx.message.serialize()), keyFor(keypair));
      tx.addSignature(keypair.publicKey, signature);
      return tx;
    } catch {
      // fall through to web3.js
    }
  }
  tx.sign([keypair]);
  return tx;
}

module.exports = { signTx, keyFor };
