// src/pdaCache.js
//
// Remembers program-derived addresses. PublicKey.findProgramAddressSync
// searches for a valid address by hashing (about a quarter of a millisecond
// each, several times that on a small server), and a Pump.fun buy derives a
// dozen of them, most identical every time (Pump.fun's global and fee
// accounts, our own volume accumulator...). The answer for the same seeds
// and program never changes, so it is looked up once and then remembered.
// Installed once, for every user of @solana/web3.js in the process (the
// Pump.fun SDKs and spl-token included).

const { PublicKey } = require('@solana/web3.js');

const MAX_ENTRIES = 20000;

function install() {
  if (PublicKey.findProgramAddressSync.__cached) return;
  const original = PublicKey.findProgramAddressSync;
  const cache = new Map();
  const cached = function findProgramAddressSync(seeds, programId) {
    // The address is a hash of the seeds joined together plus the program,
    // so that is exactly the key (how the seeds are split doesn't matter).
    const parts = seeds.map((seed) => Buffer.from(seed.buffer, seed.byteOffset, seed.byteLength));
    parts.push(programId.toBuffer());
    const key = Buffer.concat(parts).toString('latin1');
    const hit = cache.get(key);
    if (hit) return [hit[0], hit[1]];
    const result = original.call(this, seeds, programId);
    if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value);
    cache.set(key, result);
    return [result[0], result[1]];
  };
  cached.__cached = true;
  cached.cacheSize = () => cache.size;
  PublicKey.findProgramAddressSync = cached;
}

install();

module.exports = { install };
