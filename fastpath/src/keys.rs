//! Public keys, base58, program-derived addresses.

use curve25519_dalek::edwards::CompressedEdwardsY;
use sha2::{Digest, Sha256};
use std::fmt;

#[derive(Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Default)]
pub struct Pubkey(pub [u8; 32]);

impl Pubkey {
    pub fn from_b58(s: &str) -> Option<Pubkey> {
        let v = bs58::decode(s).into_vec().ok()?;
        Self::from_slice(&v)
    }
    pub fn from_slice(b: &[u8]) -> Option<Pubkey> {
        if b.len() != 32 {
            return None;
        }
        let mut k = [0u8; 32];
        k.copy_from_slice(b);
        Some(Pubkey(k))
    }
    pub fn b58(&self) -> String {
        bs58::encode(self.0).into_string()
    }
    pub fn bytes(&self) -> &[u8; 32] {
        &self.0
    }
}

impl fmt::Debug for Pubkey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.b58())
    }
}
impl fmt::Display for Pubkey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.b58())
    }
}

/// A compile-time-known address, decoded once.
pub fn key(s: &str) -> Pubkey {
    Pubkey::from_b58(s).unwrap_or_else(|| panic!("bad built-in address {s}"))
}

pub const PDA_MARKER: &[u8] = b"ProgramDerivedAddress";

/// Is this 32-byte value a valid ed25519 point? (Exactly Solana's own rule.)
pub fn is_on_curve(b: &[u8; 32]) -> bool {
    CompressedEdwardsY(*b).decompress().is_some()
}

fn pda_hash(seeds: &[&[u8]], bump: u8, program: &Pubkey) -> [u8; 32] {
    let mut h = Sha256::new();
    for s in seeds {
        h.update(s);
    }
    h.update([bump]);
    h.update(program.0);
    h.update(PDA_MARKER);
    h.finalize().into()
}

/// find_program_address: the first bump (from 255 down) whose hash is off the curve.
pub fn find_pda(seeds: &[&[u8]], program: &Pubkey) -> Pubkey {
    for bump in (0..=255u8).rev() {
        let h = pda_hash(seeds, bump, program);
        if !is_on_curve(&h) {
            return Pubkey(h);
        }
    }
    panic!("no program address found");
}

/// The PDA of one of `candidates` (seed sets) that is in `present`, trying the
/// usual bumps (255 down to 255-`bumps`+1), highest first. No curve check: a
/// hash equal to an address in the transaction can only be that address.
/// Returns (address, which candidate).
pub fn match_pda(candidates: &[Vec<&[u8]>], program: &Pubkey, present: &(dyn Fn(&Pubkey) -> bool + Sync), bumps: u8) -> Option<(Pubkey, usize)> {
    for bump in (256 - bumps as u16..=255u16).rev() {
        for (i, seeds) in candidates.iter().enumerate() {
            let h = Pubkey(pda_hash(seeds, bump as u8, program));
            if present(&h) {
                return Some((h, i));
            }
        }
    }
    None
}

pub mod known {
    use super::{key, Pubkey};
    use std::sync::OnceLock;

    macro_rules! k {
        ($name:ident, $s:expr) => {
            pub fn $name() -> Pubkey {
                static C: OnceLock<Pubkey> = OnceLock::new();
                *C.get_or_init(|| key($s))
            }
        };
    }
    k!(pump, "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
    k!(pump_amm, "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");
    k!(system, "11111111111111111111111111111111");
    k!(compute_budget, "ComputeBudget111111111111111111111111111111");
    k!(token, "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
    k!(token_2022, "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
    k!(ata_program, "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
    k!(memo, "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
    k!(memo_v1, "Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo");
    k!(wsol, "So11111111111111111111111111111111111111112");
    k!(lighthouse, "L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base58_round_trip() {
        let k = known::pump();
        assert_eq!(k.b58(), "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
    }

    #[test]
    fn bonding_curve_pda_matches_known_value() {
        // A mint whose curve was checked with web3.js (fixture from the Node side).
        let mint = key("7yK8G8UBnrTNYZLXD2gAut6FftGHDGHNa5SeDbz3rtSP");
        let curve = find_pda(&[b"bonding-curve", mint.bytes()], &known::pump());
        assert_eq!(curve.b58(), "DqdZwg2KhNs1ziZQExzS3NrBNEtz8ZxATJxroct6PtMM");
    }
}
