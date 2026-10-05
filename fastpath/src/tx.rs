//! Solana transactions as the shred feeds deliver them: wire format (legacy,
//! v0, v1/SIMD-0385) or already decoded (Shreder). Port of src/shredTx.js.

use crate::keys::Pubkey;
use anyhow::{bail, Result};
use std::collections::HashMap;

#[derive(Clone, Debug, Default)]
pub struct Ix {
    pub program_id_index: u8,
    pub accounts: Vec<u8>,
    pub data: Vec<u8>,
}

#[derive(Clone, Debug, Default)]
pub struct Lookup {
    pub key: Pubkey,
    pub writable: Vec<u8>,
    pub readonly: Vec<u8>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Version {
    Legacy,
    V0,
    V1,
}

#[derive(Clone, Debug)]
pub struct Tx {
    pub signature: Option<[u8; 64]>,
    pub num_signers: u8,
    pub version: Version,
    pub static_keys: Vec<Pubkey>,
    pub instructions: Vec<Ix>,
    pub lookups: Vec<Lookup>,
}

impl Tx {
    pub fn signature_b58(&self) -> Option<String> {
        self.signature.map(|s| bs58::encode(s).into_string())
    }
    /// The first of `wallets` that signed it.
    pub fn signer_among(&self, wallets: &[Pubkey]) -> Option<Pubkey> {
        let n = (self.num_signers as usize).min(self.static_keys.len());
        self.static_keys[..n].iter().find(|k| wallets.contains(k)).copied()
    }
}

struct Reader<'a> {
    b: &'a [u8],
    off: usize,
}

impl<'a> Reader<'a> {
    fn need(&self, n: usize) -> Result<()> {
        if self.off + n > self.b.len() {
            bail!("truncated transaction");
        }
        Ok(())
    }
    fn u8(&mut self) -> Result<u8> {
        self.need(1)?;
        let v = self.b[self.off];
        self.off += 1;
        Ok(v)
    }
    fn compact(&mut self) -> Result<usize> {
        let mut value = 0usize;
        let mut size = 0;
        loop {
            self.need(1)?;
            let byte = self.b[self.off];
            self.off += 1;
            value |= ((byte & 0x7f) as usize) << (size * 7);
            size += 1;
            if byte & 0x80 == 0 {
                break;
            }
            if size >= 3 {
                bail!("bad length prefix");
            }
        }
        Ok(value)
    }
    fn take(&mut self, n: usize) -> Result<&'a [u8]> {
        self.need(n)?;
        let s = &self.b[self.off..self.off + n];
        self.off += n;
        Ok(s)
    }
    fn key(&mut self) -> Result<Pubkey> {
        Ok(Pubkey::from_slice(self.take(32)?).unwrap())
    }
}

const V1_PREFIX: u8 = 0x81;
const CFG_PRIORITY_FEE: u32 = 0b11;
const CFG_COMPUTE_UNIT_LIMIT: u32 = 0b100;
const CFG_LOADED_ACCOUNTS_DATA_SIZE: u32 = 0b1000;
const CFG_HEAP_SIZE: u32 = 0b10000;
const CFG_KNOWN: u32 = CFG_PRIORITY_FEE | CFG_COMPUTE_UNIT_LIMIT | CFG_LOADED_ACCOUNTS_DATA_SIZE | CFG_HEAP_SIZE;

/// Parse one wire-format transaction at the start of `b`.
pub fn parse(b: &[u8]) -> Result<Tx> {
    if b.is_empty() {
        bail!("empty transaction");
    }
    if b[0] == V1_PREFIX {
        return parse_v1(b);
    }
    let mut r = Reader { b, off: 0 };
    let nsig = r.compact()?;
    let sigs = r.take(nsig * 64)?;
    let signature = if nsig > 0 {
        let mut s = [0u8; 64];
        s.copy_from_slice(&sigs[..64]);
        Some(s)
    } else {
        None
    };
    let mut version = Version::Legacy;
    r.need(1)?;
    if r.b[r.off] & 0x80 != 0 {
        let v = r.u8()? & 0x7f;
        if v != 0 {
            bail!("unsupported transaction version {v}");
        }
        version = Version::V0;
    }
    let num_signers = r.u8()?;
    r.take(2)?;
    let nkeys = r.compact()?;
    let mut static_keys = Vec::with_capacity(nkeys.min(256));
    for _ in 0..nkeys {
        static_keys.push(r.key()?);
    }
    r.take(32)?; // blockhash
    let nix = r.compact()?;
    let mut instructions = Vec::with_capacity(nix.min(64));
    for _ in 0..nix {
        let program_id_index = r.u8()?;
        let na = r.compact()?;
        let accounts = r.take(na)?.to_vec();
        let nd = r.compact()?;
        let data = r.take(nd)?.to_vec();
        instructions.push(Ix { program_id_index, accounts, data });
    }
    let mut lookups = Vec::new();
    if version == Version::V0 {
        let nl = r.compact()?;
        for _ in 0..nl {
            let key = r.key()?;
            let nw = r.compact()?;
            let writable = r.take(nw)?.to_vec();
            let nr = r.compact()?;
            let readonly = r.take(nr)?.to_vec();
            lookups.push(Lookup { key, writable, readonly });
        }
    }
    Ok(Tx { signature, num_signers, version, static_keys, instructions, lookups })
}

fn parse_v1(b: &[u8]) -> Result<Tx> {
    let mut r = Reader { b, off: 1 };
    let num_signers = r.u8()?;
    r.take(2)?;
    let mask_b = r.take(4)?;
    let mask = u32::from_le_bytes([mask_b[0], mask_b[1], mask_b[2], mask_b[3]]);
    if mask & !CFG_KNOWN != 0 {
        bail!("v1 transaction with unknown config bits ({mask})");
    }
    let pf = mask & CFG_PRIORITY_FEE;
    if pf != 0 && pf != CFG_PRIORITY_FEE {
        bail!("v1 transaction with a malformed priority fee mask");
    }
    r.take(32)?; // blockhash
    let nix = r.u8()? as usize;
    let naddr = r.u8()? as usize;
    let mut static_keys = Vec::with_capacity(naddr.min(256));
    for _ in 0..naddr {
        static_keys.push(r.key()?);
    }
    let cfg_len = (if pf != 0 { 8 } else { 0 })
        + (if mask & CFG_COMPUTE_UNIT_LIMIT != 0 { 4 } else { 0 })
        + (if mask & CFG_LOADED_ACCOUNTS_DATA_SIZE != 0 { 4 } else { 0 })
        + (if mask & CFG_HEAP_SIZE != 0 { 4 } else { 0 });
    r.take(cfg_len)?;
    let mut headers = Vec::with_capacity(nix.min(64));
    for _ in 0..nix {
        let h = r.take(4)?;
        headers.push((h[0], h[1] as usize, u16::from_le_bytes([h[2], h[3]]) as usize));
    }
    let mut instructions = Vec::with_capacity(nix.min(64));
    for (program_id_index, na, nd) in headers {
        let accounts = r.take(na)?.to_vec();
        let data = r.take(nd)?.to_vec();
        instructions.push(Ix { program_id_index, accounts, data });
    }
    let sigs = r.take(num_signers as usize * 64)?;
    let signature = if num_signers > 0 {
        let mut s = [0u8; 64];
        s.copy_from_slice(&sigs[..64]);
        Some(s)
    } else {
        None
    };
    Ok(Tx { signature, num_signers, version: Version::V1, static_keys, instructions, lookups: Vec::new() })
}

/// All account keys in Solana's order: static, then every table's writable
/// entries, then every table's read-only entries. None if a table is missing.
pub fn resolve_keys(tx: &Tx, tables: &HashMap<Pubkey, Vec<Pubkey>>) -> Option<Vec<Pubkey>> {
    let mut keys = tx.static_keys.clone();
    if tx.lookups.is_empty() {
        return Some(keys);
    }
    let mut ro = Vec::new();
    for l in &tx.lookups {
        let addrs = tables.get(&l.key)?;
        for &i in &l.writable {
            keys.push(*addrs.get(i as usize)?);
        }
        for &i in &l.readonly {
            ro.push(*addrs.get(i as usize)?);
        }
    }
    keys.extend(ro);
    Some(keys)
}

#[cfg(test)]
pub mod tests {
    use super::*;

    /// A legacy transaction: 1 signature, 3 keys, one instruction.
    pub fn sample_legacy() -> Vec<u8> {
        let mut b = vec![1u8];
        b.extend([7u8; 64]);
        b.extend([1, 0, 1]); // header
        b.push(3);
        for i in 0..3u8 {
            b.extend([i + 1; 32]);
        }
        b.extend([9u8; 32]); // blockhash
        b.push(1); // one instruction
        b.push(2); // program index
        b.push(2);
        b.extend([0, 1]);
        b.push(3);
        b.extend([0xaa, 0xbb, 0xcc]);
        b
    }

    #[test]
    fn parses_legacy() {
        let t = parse(&sample_legacy()).unwrap();
        assert_eq!(t.version, Version::Legacy);
        assert_eq!(t.static_keys.len(), 3);
        assert_eq!(t.instructions[0].data, vec![0xaa, 0xbb, 0xcc]);
        assert_eq!(t.signature.unwrap()[0], 7);
    }
}
