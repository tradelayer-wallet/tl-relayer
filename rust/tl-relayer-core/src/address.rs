//! Address and public-key validation with an explicit network.
//!
//! Replaces the legacy node round trip `callRpc('validateaddress', ...)`
//! (`address.service.ts:543`) with local, chain-aware decoding, and adds the
//! pubkey-to-address binding the legacy registry never checked.

use crate::error::{Error, Result};
use crate::network::Network;
use bitcoin::bech32;
use bitcoin::hashes::Hash;
use bitcoin::key::PublicKey;
use bitcoin::secp256k1::{Secp256k1, XOnlyPublicKey};
use bitcoin::{PubkeyHash, ScriptBuf, ScriptHash, WPubkeyHash, WScriptHash};
use serde_json::{json, Value};

/// Longest address text accepted before any decoding is attempted.
pub const MAX_ADDRESS_LEN: usize = 100;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AddressKind {
    P2pkh,
    P2sh,
    P2wpkh,
    P2wsh,
    P2tr,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DecodedAddress {
    pub network: Network,
    pub kind: AddressKind,
    /// Canonical text (bech32 lowercased, base58 as given).
    pub text: String,
    pub script: ScriptBuf,
}

impl DecodedAddress {
    pub fn is_witness(&self) -> bool {
        matches!(
            self.kind,
            AddressKind::P2wpkh | AddressKind::P2wsh | AddressKind::P2tr
        )
    }
}

/// Decode `addr` for exactly `network`. An address that is valid on a different
/// network yields [`Error::AddressOnOtherNetwork`] (a diagnostic only; callers
/// must not retry with the other network).
pub fn decode_address(addr: &str, network: Network) -> Result<DecodedAddress> {
    match decode_inner(addr, network) {
        Ok(d) => Ok(d),
        Err(e) => {
            for other in Network::ALL {
                if other != network && decode_inner(addr, other).is_ok() {
                    return Err(Error::AddressOnOtherNetwork(other.legacy_code().to_string()));
                }
            }
            Err(e)
        }
    }
}

fn decode_inner(addr: &str, network: Network) -> Result<DecodedAddress> {
    if addr.is_empty() || addr.len() > MAX_ADDRESS_LEN {
        return Err(Error::InvalidAddress("length"));
    }
    if addr != addr.trim() || !addr.is_ascii() || addr.bytes().any(|b| b.is_ascii_control()) {
        return Err(Error::InvalidAddress("whitespace or non-ascii"));
    }
    if let Some(hrp) = network.bech32_hrp() {
        let lower = addr.to_ascii_lowercase();
        if lower.starts_with(hrp) && lower.as_bytes().get(hrp.len()) == Some(&b'1') {
            return decode_segwit(addr, hrp, network);
        }
    }
    decode_base58(addr, network)
}

fn decode_segwit(addr: &str, hrp: &str, network: Network) -> Result<DecodedAddress> {
    let (got_hrp, version, program) =
        bech32::segwit::decode(addr).map_err(|_| Error::InvalidAddress("bech32"))?;
    if got_hrp.to_lowercase() != hrp {
        return Err(Error::InvalidAddress("hrp"));
    }
    let v = version.to_u8();
    let (kind, script) = match (v, program.len()) {
        (0, 20) => (
            AddressKind::P2wpkh,
            ScriptBuf::new_p2wpkh(&WPubkeyHash::from_byte_array(to_arr(&program)?)),
        ),
        (0, 32) => (
            AddressKind::P2wsh,
            ScriptBuf::new_p2wsh(&WScriptHash::from_byte_array(to_arr(&program)?)),
        ),
        (1, 32) => {
            let mut b = Vec::with_capacity(34);
            b.push(0x51);
            b.push(0x20);
            b.extend_from_slice(&program);
            (AddressKind::P2tr, ScriptBuf::from_bytes(b))
        }
        _ => return Err(Error::InvalidAddress("unsupported witness program")),
    };
    Ok(DecodedAddress {
        network,
        kind,
        text: addr.to_ascii_lowercase(),
        script,
    })
}

fn decode_base58(addr: &str, network: Network) -> Result<DecodedAddress> {
    let data = bitcoin::base58::decode_check(addr).map_err(|_| Error::InvalidAddress("base58"))?;
    if data.len() != 21 {
        return Err(Error::InvalidAddress("payload length"));
    }
    let hash: [u8; 20] = to_arr(&data[1..])?;
    let version = data[0];
    let (kind, script) = if version == network.p2pkh_version() {
        (
            AddressKind::P2pkh,
            ScriptBuf::new_p2pkh(&PubkeyHash::from_byte_array(hash)),
        )
    } else if version == network.p2sh_version() {
        (
            AddressKind::P2sh,
            ScriptBuf::new_p2sh(&ScriptHash::from_byte_array(hash)),
        )
    } else {
        return Err(Error::InvalidAddress("version byte"));
    };
    Ok(DecodedAddress {
        network,
        kind,
        text: addr.to_string(),
        script,
    })
}

fn to_arr<const N: usize>(b: &[u8]) -> Result<[u8; N]> {
    b.try_into()
        .map_err(|_| Error::InvalidAddress("payload length"))
}

/// Node-style `validateaddress` result computed locally.
pub fn validate_address(addr: &str, network: Network) -> Value {
    match decode_address(addr, network) {
        Ok(d) => {
            let mut v = json!({
                "isvalid": true,
                "address": d.text,
                "scriptPubKey": hex(d.script.as_bytes()),
                "isscript": matches!(d.kind, AddressKind::P2sh | AddressKind::P2wsh),
                "iswitness": d.is_witness(),
            });
            if d.is_witness() {
                let b = d.script.as_bytes();
                let version = if b[0] == 0x00 { 0 } else { 1 };
                v["witness_version"] = json!(version);
                v["witness_program"] = json!(hex(&b[2..]));
            }
            v
        }
        Err(_) => json!({ "isvalid": false }),
    }
}

/// Parse a compressed secp256k1 public key from hex (either case); returns the
/// key and its canonical lowercase hex.
pub fn parse_pubkey(s: &str) -> Result<(PublicKey, String)> {
    if s.len() != 66 {
        return Err(Error::InvalidPubkey("must be 66 hex characters"));
    }
    if !s.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(Error::InvalidPubkey("not hex"));
    }
    let bytes = unhex(s).ok_or(Error::InvalidPubkey("not hex"))?;
    if bytes[0] != 0x02 && bytes[0] != 0x03 {
        return Err(Error::InvalidPubkey("not a compressed key"));
    }
    let pk = PublicKey::from_slice(&bytes).map_err(|_| Error::InvalidPubkey("not on curve"))?;
    if !pk.compressed {
        return Err(Error::InvalidPubkey("not a compressed key"));
    }
    Ok((pk, s.to_ascii_lowercase()))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Binding {
    /// The pubkey provably derives the address.
    Bound,
    /// The address kind (P2WSH, arbitrary P2SH) hides its keys.
    Unverifiable,
}

/// Check that `pk` derives `addr`. Supports P2PKH, P2WPKH, P2SH-P2WPKH and
/// P2TR (key-path with the BIP-86 tweak, or an untweaked x-only output key).
/// A mismatch is an error; kinds that cannot be checked report `Unverifiable`.
pub fn bind_pubkey(pk: &PublicKey, addr: &DecodedAddress) -> Result<Binding> {
    let secp = Secp256k1::verification_only();
    let ok = match addr.kind {
        AddressKind::P2pkh => ScriptBuf::new_p2pkh(&pk.pubkey_hash()) == addr.script,
        AddressKind::P2wpkh => {
            let h = pk
                .wpubkey_hash()
                .map_err(|_| Error::InvalidPubkey("not a compressed key"))?;
            ScriptBuf::new_p2wpkh(&h) == addr.script
        }
        AddressKind::P2sh => {
            let h = pk
                .wpubkey_hash()
                .map_err(|_| Error::InvalidPubkey("not a compressed key"))?;
            let redeem = ScriptBuf::new_p2wpkh(&h);
            let nested = ScriptBuf::new_p2sh(&redeem.script_hash());
            if nested == addr.script {
                true
            } else {
                // A bare P2SH may wrap anything; we cannot say it is not ours.
                return Ok(Binding::Unverifiable);
            }
        }
        AddressKind::P2tr => {
            let xonly = XOnlyPublicKey::from(pk.inner);
            let tweaked = ScriptBuf::new_p2tr(&secp, xonly, None);
            let mut raw = vec![0x51, 0x20];
            raw.extend_from_slice(&xonly.serialize());
            tweaked == addr.script || ScriptBuf::from_bytes(raw) == addr.script
        }
        AddressKind::P2wsh => return Ok(Binding::Unverifiable),
    };
    if ok {
        Ok(Binding::Bound)
    } else {
        Err(Error::PubkeyAddressMismatch)
    }
}

pub fn hex(b: &[u8]) -> String {
    const H: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(b.len() * 2);
    for x in b {
        s.push(H[(x >> 4) as usize] as char);
        s.push(H[(x & 15) as usize] as char);
    }
    s
}

pub fn unhex(s: &str) -> Option<Vec<u8>> {
    if !s.len().is_multiple_of(2) {
        return None;
    }
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len() / 2);
    for c in b.chunks(2) {
        let hi = (c[0] as char).to_digit(16)?;
        let lo = (c[1] as char).to_digit(16)?;
        out.push((hi * 16 + lo) as u8);
    }
    Some(out)
}
