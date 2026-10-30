//! External UTXO source (SoChain) validation and coverage comparison.
//!
//! Port of `watchonly-external.service.ts` and `verifyWatchOnlyAccountCoverage`
//! (`sochain.service.ts:291-362`). The HTTP call is a trait; this module owns
//! the bounds (pages, bytes, outputs) and the strict response mapping. The
//! BlockCypher token hard-coded at `sochain.service.ts:16` is not carried over.

use crate::address::{unhex, DecodedAddress};
use crate::error::{Error, Result};
use crate::money::Amount;
use crate::network::Network;
use crate::ports::ExternalUtxoSource;
use crate::registry::UtxoSnapshot;
use crate::utxo::{self, Utxo};
use bitcoin::{OutPoint, ScriptBuf};
use serde_json::Value;
use std::collections::BTreeSet;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ExternalLimits {
    pub max_pages: u32,
    /// SoChain returns 10 outputs per page; a shorter page ends the listing.
    pub page_size: usize,
    pub max_body_bytes: usize,
    pub max_utxos: usize,
}

impl Default for ExternalLimits {
    fn default() -> Self {
        ExternalLimits {
            max_pages: 20,
            page_size: 10,
            max_body_bytes: 256 * 1024,
            max_utxos: 2_000,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct ExternalSnapshot {
    pub source: &'static str,
    pub network: Network,
    pub address: String,
    pub checked_at: u64,
    pub hash: String,
    pub count: usize,
    pub total: Amount,
    pub utxos: Vec<Utxo>,
}

/// SoChain network code; identical to the legacy env codes.
pub fn sochain_code(n: Network) -> &'static str {
    n.legacy_code()
}

/// Map one SoChain output (`toUtxo`, `watchonly-external.service.ts:49`).
fn map_output(item: &Value, address: &DecodedAddress) -> Result<Utxo> {
    let o = item
        .as_object()
        .ok_or(Error::ExternalSource("output is not an object"))?;
    let txid_s = o
        .get("hash")
        .or_else(|| o.get("txid"))
        .and_then(Value::as_str)
        .ok_or(Error::ExternalSource("missing txid"))?;
    let txid = utxo::parse_txid(txid_s).map_err(|_| Error::ExternalSource("bad txid"))?;
    let vout = o
        .get("index")
        .or_else(|| o.get("vout"))
        .and_then(Value::as_u64)
        .and_then(|n| u32::try_from(n).ok())
        .ok_or(Error::ExternalSource("bad vout"))?;
    let amount = Amount::from_json_coin(
        o.get("value")
            .or_else(|| o.get("amount"))
            .ok_or(Error::ExternalSource("missing value"))?,
    )
    .map_err(|_| Error::ExternalSource("bad value"))?;
    if amount == Amount::ZERO {
        return Err(Error::ExternalSource("zero value"));
    }
    let confirmations = match o.get("confirmations") {
        Some(c) if !c.is_null() => c
            .as_u64()
            .ok_or(Error::ExternalSource("bad confirmations"))?,
        _ => u64::from(o.get("block").is_some_and(|b| !b.is_null())),
    };
    if let Some(s) = o.get("script").and_then(Value::as_str) {
        // Only a parseable script is compared; asm-style text is ignored.
        if let Some(b) = unhex(s) {
            if ScriptBuf::from_bytes(b) != address.script {
                return Err(Error::ExternalSource("script does not pay the address"));
            }
        }
    }
    Ok(Utxo {
        outpoint: OutPoint { txid, vout },
        amount,
        confirmations,
        script_pubkey: address.script.clone(),
        witness_script: None,
        prev_tx: None,
    })
}

/// Fetch and validate the complete external UTXO set. Any non-success page,
/// oversized body, duplicate output or truncation is an error: a partial list
/// must never be compared as if it were complete.
pub fn fetch_external_snapshot(
    src: &mut dyn ExternalUtxoSource,
    address: &DecodedAddress,
    now: u64,
    limits: &ExternalLimits,
) -> Result<ExternalSnapshot> {
    let mut all: Vec<Utxo> = Vec::new();
    let mut seen = BTreeSet::new();
    let mut complete = false;
    for page in 1..=limits.max_pages {
        let reply = src
            .fetch_page(address.network, &address.text, page)
            .map_err(|_| Error::ExternalSource("request failed"))?;
        if reply.status != 200 {
            return Err(Error::ExternalSource("unexpected http status"));
        }
        if reply.body.len() > limits.max_body_bytes {
            return Err(Error::TooLarge {
                what: "external response",
                max: limits.max_body_bytes,
            });
        }
        let payload: Value = serde_json::from_str(&reply.body)
            .map_err(|_| Error::ExternalSource("response is not json"))?;
        if payload
            .get("status")
            .and_then(Value::as_str)
            .map(str::to_ascii_lowercase)
            .as_deref()
            != Some("success")
        {
            return Err(Error::ExternalSource("status is not success"));
        }
        let outputs = payload
            .get("data")
            .and_then(|d| d.get("outputs"))
            .and_then(Value::as_array)
            .ok_or(Error::ExternalSource("missing outputs"))?;
        if outputs.len() > limits.page_size {
            return Err(Error::ExternalSource("page larger than page size"));
        }
        for item in outputs {
            let u = map_output(item, address)?;
            if !seen.insert(u.outpoint) {
                return Err(Error::DuplicateOutpoint);
            }
            all.push(u);
            if all.len() > limits.max_utxos {
                return Err(Error::TooMany {
                    what: "external utxos",
                    max: limits.max_utxos,
                });
            }
        }
        if outputs.len() < limits.page_size {
            complete = true;
            break;
        }
    }
    if !complete {
        return Err(Error::ExternalSource("listing truncated at page limit"));
    }
    Ok(ExternalSnapshot {
        source: "sochain",
        network: address.network,
        address: address.text.clone(),
        checked_at: now,
        hash: utxo::snapshot_hash(&all),
        count: all.len(),
        total: utxo::total_amount(&all)?,
        utxos: all,
    })
}

#[derive(Debug, Clone, PartialEq)]
pub struct CoverageVerdict {
    pub needs_rescan: bool,
    pub reason: &'static str,
}

/// Port of the mismatch decision of `verifyWatchOnlyAccountCoverage`.
pub fn compare_snapshots(
    local: Option<&UtxoSnapshot>,
    external: Option<&ExternalSnapshot>,
) -> CoverageVerdict {
    let Some(ext) = external else {
        return CoverageVerdict {
            needs_rescan: false,
            reason: "external utxo source unavailable",
        };
    };
    let Some(loc) = local else {
        return CoverageVerdict {
            needs_rescan: true,
            reason: "local snapshot missing",
        };
    };
    let mismatch = loc.hash != ext.hash || loc.count != ext.count || loc.total != ext.total;
    if mismatch {
        CoverageVerdict {
            needs_rescan: true,
            reason: "local snapshot differs from external utxo set",
        }
    } else {
        CoverageVerdict {
            needs_rescan: false,
            reason: "local snapshot matches external utxo set",
        }
    }
}
