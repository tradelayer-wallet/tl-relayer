//! Validated UTXO values, snapshot hashing and first-funding derivation.

use crate::address::{hex, unhex, DecodedAddress};
use crate::error::{Error, Result};
use crate::money::Amount;
use bitcoin::hashes::{sha256, Hash};
use bitcoin::{OutPoint, ScriptBuf, Transaction, Txid};
use serde_json::Value;
use std::collections::BTreeSet;
use std::str::FromStr;

pub const MAX_SCRIPT_BYTES: usize = 10_000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Utxo {
    pub outpoint: OutPoint,
    pub amount: Amount,
    pub confirmations: u64,
    pub script_pubkey: ScriptBuf,
    /// Witness script for P2WSH inputs (verified against the script hash by the
    /// transaction builder).
    pub witness_script: Option<ScriptBuf>,
    /// Full previous transaction, required for non-segwit inputs.
    pub prev_tx: Option<Transaction>,
}

impl Utxo {
    /// Strict parse of one provider/listunspent entry. `id` is ignored (it is
    /// always `txid:vout`); `amount` is coins, parsed exactly; `scriptPubKey` is
    /// required.
    pub fn from_json(v: &Value) -> Result<Utxo> {
        let o = v.as_object().ok_or(Error::InvalidUtxo("not an object"))?;
        let txid_s = o
            .get("txid")
            .and_then(Value::as_str)
            .ok_or(Error::InvalidUtxo("txid"))?;
        let txid = parse_txid(txid_s)?;
        let vout = o
            .get("vout")
            .and_then(Value::as_u64)
            .and_then(|n| u32::try_from(n).ok())
            .ok_or(Error::InvalidUtxo("vout"))?;
        let amount = Amount::from_json_coin(o.get("amount").ok_or(Error::InvalidUtxo("amount"))?)?;
        if amount == Amount::ZERO {
            return Err(Error::InvalidUtxo("zero amount"));
        }
        let confirmations = match o.get("confirmations") {
            None | Some(Value::Null) => 0,
            Some(c) => c.as_u64().ok_or(Error::InvalidUtxo("confirmations"))?,
        };
        let script_hex = o
            .get("scriptPubKey")
            .and_then(Value::as_str)
            .ok_or(Error::InvalidUtxo("scriptPubKey"))?;
        let script = parse_script_hex(script_hex)?;
        if script.is_empty() {
            return Err(Error::InvalidUtxo("empty scriptPubKey"));
        }
        let witness_script = match o.get("redeemScript").or_else(|| o.get("witnessScript")) {
            None | Some(Value::Null) => None,
            Some(Value::String(s)) => Some(parse_script_hex(s)?),
            Some(_) => return Err(Error::InvalidUtxo("redeemScript")),
        };
        Ok(Utxo {
            outpoint: OutPoint { txid, vout },
            amount,
            confirmations,
            script_pubkey: script,
            witness_script,
            prev_tx: None,
        })
    }

    pub fn id(&self) -> String {
        format!("{}:{}", self.outpoint.txid, self.outpoint.vout)
    }
}

pub fn parse_txid(s: &str) -> Result<Txid> {
    if s.len() != 64 || !s.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(Error::InvalidOutpoint("txid must be 64 hex characters"));
    }
    Txid::from_str(s).map_err(|_| Error::InvalidOutpoint("txid"))
}

pub fn parse_script_hex(s: &str) -> Result<ScriptBuf> {
    if s.len() > MAX_SCRIPT_BYTES * 2 {
        return Err(Error::TooLarge {
            what: "script",
            max: MAX_SCRIPT_BYTES,
        });
    }
    let b = unhex(s).ok_or(Error::InvalidUtxo("script is not hex"))?;
    Ok(ScriptBuf::from_bytes(b))
}

/// Validate a provider-supplied UTXO list for `address`: bounded length,
/// well-formed entries, every output pays the address, no duplicate outpoints.
pub fn validate_utxos(raw: &[Value], address: &DecodedAddress, max: usize) -> Result<Vec<Utxo>> {
    if raw.len() > max {
        return Err(Error::TooMany { what: "utxos", max });
    }
    let mut seen = BTreeSet::new();
    let mut out = Vec::with_capacity(raw.len());
    for v in raw {
        let u = Utxo::from_json(v)?;
        check_utxo_for(&u, address)?;
        if !seen.insert((u.outpoint.txid.to_string(), u.outpoint.vout)) {
            return Err(Error::DuplicateOutpoint);
        }
        out.push(u);
    }
    Ok(out)
}

/// Amount within the chain bound and script equal to the address script.
pub fn check_utxo_for(u: &Utxo, address: &DecodedAddress) -> Result<()> {
    u.amount.check_money(address.network)?;
    if u.script_pubkey != address.script {
        return Err(Error::ForeignScript);
    }
    Ok(())
}

/// Order-independent digest of a UTXO set. Versioned format (not the legacy
/// float JSON): `v2\n` then `txid:vout:sats\n` per output sorted by txid text
/// (byte order) and vout.
pub fn snapshot_hash(utxos: &[Utxo]) -> String {
    let mut rows: Vec<(String, u32, u64)> = utxos
        .iter()
        .map(|u| (u.outpoint.txid.to_string(), u.outpoint.vout, u.amount.sat()))
        .collect();
    rows.sort();
    let mut s = String::from("v2\n");
    for (t, v, a) in rows {
        s.push_str(&format!("{t}:{v}:{a}\n"));
    }
    hex(sha256::Hash::hash(s.as_bytes()).as_byte_array())
}

pub fn total_amount(utxos: &[Utxo]) -> Result<Amount> {
    Amount::sum(utxos.iter().map(|u| u.amount))
}

/// Port of `deriveFirstFundingScanInfo` (`sochain.service.ts:22`): earliest
/// confirmed output by estimated height `max(0, tip - confirmations + 1)`, ties
/// broken by txid.
pub fn derive_first_funding(
    utxos: &[(String, u64)],
    current_height: Option<u64>,
) -> (Option<u64>, Option<String>) {
    let Some(tip) = current_height else {
        return (None, None);
    };
    let mut rows: Vec<(u64, String)> = utxos
        .iter()
        .filter(|(t, c)| *c > 0 && !t.trim().is_empty())
        .map(|(t, c)| {
            (
                tip.saturating_add(1).saturating_sub(*c),
                t.trim().to_string(),
            )
        })
        .collect();
    rows.sort();
    match rows.into_iter().next() {
        Some((h, t)) => (Some(h), Some(t)),
        None => (None, None),
    }
}
