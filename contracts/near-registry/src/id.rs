//! Canonical proposal-id encoding (see README.md, "Proposal id").
//!
//! `id = sha256(preimage)` where `preimage` is the concatenation of eleven
//! fields, each encoded as `u32_be(len) || bytes`:
//!
//! | # | field          | bytes                                        |
//! |---|----------------|----------------------------------------------|
//! | 1 | domain         | ASCII `autonear.registry.proposal.v1`        |
//! | 2 | network_id     | UTF-8                                        |
//! | 3 | registry       | UTF-8 NEAR account id of this contract       |
//! | 4 | target         | UTF-8 NEAR account id                        |
//! | 5 | method         | UTF-8                                        |
//! | 6 | max_spend      | u128 big-endian (16 bytes)                   |
//! | 7 | expiry         | u64 big-endian (8 bytes), nanoseconds        |
//! | 8 | nonce          | u64 big-endian (8 bytes)                     |
//! | 9 | artifact_hash  | raw 32 bytes                                 |

use near_sdk::env;

/// Domain-separation tag, first field of every preimage.
pub const ID_DOMAIN: &[u8] = b"autonear.registry.proposal.v1";

fn put(buf: &mut Vec<u8>, bytes: &[u8]) {
    let len = u32::try_from(bytes.len()).unwrap_or_else(|_| env::panic_str("field too long"));
    buf.extend_from_slice(&len.to_be_bytes());
    buf.extend_from_slice(bytes);
}

/// Builds the exact byte string that is hashed to produce a proposal id.
#[allow(clippy::too_many_arguments)]
pub fn id_preimage(
    network_id: &str,
    registry: &str,
    target: &str,
    method: &str,
    max_spend: u128,
    expiry: u64,
    nonce: u64,
    artifact_hash: &[u8; 32],
) -> Vec<u8> {
    let mut buf = Vec::with_capacity(256);
    put(&mut buf, ID_DOMAIN);
    put(&mut buf, network_id.as_bytes());
    put(&mut buf, registry.as_bytes());
    put(&mut buf, target.as_bytes());
    put(&mut buf, method.as_bytes());
    put(&mut buf, &max_spend.to_be_bytes());
    put(&mut buf, &expiry.to_be_bytes());
    put(&mut buf, &nonce.to_be_bytes());
    put(&mut buf, artifact_hash);
    buf
}

/// sha256 of [`id_preimage`].
#[allow(clippy::too_many_arguments)]
pub fn compute_id(
    network_id: &str,
    registry: &str,
    target: &str,
    method: &str,
    max_spend: u128,
    expiry: u64,
    nonce: u64,
    artifact_hash: &[u8; 32],
) -> [u8; 32] {
    env::sha256_array(&id_preimage(
        network_id,
        registry,
        target,
        method,
        max_spend,
        expiry,
        nonce,
        artifact_hash,
    ))
}

/// Lowercase hex encoding.
pub fn to_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push(HEX[(b >> 4) as usize] as char);
        s.push(HEX[(b & 15) as usize] as char);
    }
    s
}

/// Strict parser: exactly 64 lowercase hex characters.
pub fn parse_hex32(s: &str) -> Option<[u8; 32]> {
    let b = s.as_bytes();
    if b.len() != 64 {
        return None;
    }
    let nib = |c: u8| match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        _ => None,
    };
    let mut out = [0u8; 32];
    for i in 0..32 {
        out[i] = (nib(b[2 * i])? << 4) | nib(b[2 * i + 1])?;
    }
    Some(out)
}
