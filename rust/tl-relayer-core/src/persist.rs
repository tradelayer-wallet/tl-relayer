//! Registry persistence shape.
//!
//! Version 2 documents are `{version, network, generatedAt, entries[],
//! tradeLayerState}`. The decoder also reads the legacy file shapes (a bare
//! array, `{entries}` or `{accounts}`; amounts in coins as `amount`), drops what
//! does not validate for the configured network, and reports what it dropped.

use crate::address::{bind_pubkey, decode_address, hex, parse_pubkey, Binding};
use crate::auth::Principal;
use crate::error::{Error, Result};
use crate::money::Amount;
use crate::network::Network;
use crate::registry::{
    clip_text, sanitize_node_id, Entry, Limits, LoadReport, MethodSnapshot, Policy, ScanState,
    State, TokenBalance, TokenSnapshot, UtxoSnapshot,
};
use crate::utxo::{self, Utxo};
use serde_json::{json, Map, Value};

pub const MAX_DOC_BYTES: usize = 32 * 1024 * 1024;
pub const FORMAT_VERSION: u64 = 2;

fn put<T: Into<Value>>(m: &mut Map<String, Value>, k: &str, v: Option<T>) {
    if let Some(v) = v {
        m.insert(k.to_string(), v.into());
    }
}

pub fn encode(st: &State, network: Network, now: u64) -> String {
    let entries: Vec<Value> = st.entries.values().map(entry_to_json).collect();
    let mut by_method = Map::new();
    for (k, v) in &st.trade_layer {
        let mut m = Map::new();
        m.insert("updatedAt".into(), v.updated_at.into());
        put(&mut m, "route", v.route.clone());
        put(&mut m, "address", v.address.clone());
        put(&mut m, "providerNodeId", v.provider_node_id.clone());
        put(&mut m, "network", v.network.clone());
        put(&mut m, "sourceEndpoint", v.source_endpoint.clone());
        put(&mut m, "summary", v.summary.clone());
        m.insert("payload".into(), v.payload.clone());
        by_method.insert(k.clone(), Value::Object(m));
    }
    let mut doc = json!({
        "version": FORMAT_VERSION,
        "network": network.legacy_code(),
        "generatedAt": now,
        "entries": entries,
    });
    if let Some(t) = st.trade_layer_updated_at {
        doc["tradeLayerState"] = json!({ "updatedAt": t, "byMethod": by_method });
    }
    let mut s = serde_json::to_string_pretty(&doc).unwrap_or_default();
    s.push('\n');
    s
}

fn entry_to_json(e: &Entry) -> Value {
    let mut m = Map::new();
    m.insert("address".into(), e.address.clone().into());
    m.insert("pubkey".into(), e.pubkey.clone().into());
    put(
        &mut m,
        "owner",
        e.owner.as_ref().map(|p| p.as_str().to_string()),
    );
    m.insert("source".into(), e.source.clone().into());
    put(
        &mut m,
        "assignedProviderNodeId",
        e.assigned_provider_node_id.clone(),
    );
    put(&mut m, "assignedAt", e.assigned_at);
    m.insert("firstSeenAt".into(), e.first_seen_at.into());
    put(&mut m, "firstFundingHeight", e.first_funding_height);
    put(&mut m, "firstFundingTxid", e.first_funding_txid.clone());
    m.insert("lastSeenAt".into(), e.last_seen_at.into());
    m.insert(
        "lastImportedAt".into(),
        e.last_imported_at.map_or(Value::Null, Value::from),
    );
    m.insert("importCount".into(), e.import_count.into());
    put(
        &mut m,
        "scanState",
        e.scan_state.map(|s| s.as_str().to_string()),
    );
    put(&mut m, "lastScannedAt", e.last_scanned_at);
    put(&mut m, "lastScannedHeight", e.last_scanned_height);
    put(&mut m, "scanSourceNodeId", e.scan_source_node_id.clone());
    put(&mut m, "lastSnapshotHeight", e.last_snapshot_height);
    put(&mut m, "lastError", e.last_error.clone());
    if let Some(s) = &e.utxo_snapshot {
        let mut sm = Map::new();
        sm.insert("hash".into(), s.hash.clone().into());
        sm.insert("count".into(), s.count.into());
        sm.insert("totalAmountSat".into(), s.total.sat().into());
        sm.insert("updatedAt".into(), s.updated_at.into());
        put(&mut sm, "scannedHeight", s.scanned_height);
        put(&mut sm, "scanSourceNodeId", s.scan_source_node_id.clone());
        let us: Vec<Value> = s
            .utxos
            .iter()
            .map(|u| {
                json!({
                    "id": u.id(),
                    "txid": u.outpoint.txid.to_string(),
                    "vout": u.outpoint.vout,
                    "amountSat": u.amount.sat(),
                    "confirmations": u.confirmations,
                    "scriptPubKey": hex(u.script_pubkey.as_bytes()),
                })
            })
            .collect();
        sm.insert("utxos".into(), us.into());
        m.insert("lastUtxoSnapshot".into(), Value::Object(sm));
    }
    if let Some(t) = &e.token_snapshot {
        let mut tm = Map::new();
        tm.insert("updatedAt".into(), t.updated_at.into());
        put(&mut tm, "scannedHeight", t.scanned_height);
        put(&mut tm, "scanSourceNodeId", t.scan_source_node_id.clone());
        let bs: Vec<Value> = t
            .balances
            .iter()
            .map(|b| {
                let mut bm = Map::new();
                bm.insert("propertyId".into(), b.property_id.clone().into());
                put(&mut bm, "ticker", b.ticker.clone());
                for (k, v) in [
                    ("amount", &b.amount),
                    ("available", &b.available),
                    ("reserved", &b.reserved),
                    ("margin", &b.margin),
                    ("vesting", &b.vesting),
                    ("channel", &b.channel),
                ] {
                    bm.insert(k.into(), v.clone().into());
                }
                Value::Object(bm)
            })
            .collect();
        tm.insert("balances".into(), bs.into());
        m.insert("lastTokenSnapshot".into(), Value::Object(tm));
    }
    Value::Object(m)
}

/// Validated decimal text for token amounts: digits with up to eight decimals.
pub fn decimal_text(v: &Value) -> Option<String> {
    let s = match v {
        Value::Number(n) => n.to_string(),
        Value::String(s) => s.trim().to_string(),
        Value::Null => "0".to_string(),
        _ => return None,
    };
    let (int, frac) = match s.split_once('.') {
        Some((i, f)) => (i, f),
        None => (s.as_str(), ""),
    };
    let ok = !int.is_empty()
        && int.len() <= 20
        && frac.len() <= 8
        && int.bytes().all(|b| b.is_ascii_digit())
        && frac.bytes().all(|b| b.is_ascii_digit());
    ok.then_some(s)
}

fn as_u64(v: Option<&Value>) -> Option<u64> {
    match v? {
        Value::Number(n) => n.as_u64().or_else(|| {
            n.as_f64()
                .filter(|f| *f >= 0.0 && f.fract() == 0.0 && *f < 9.0e15)
                .map(|f| f as u64)
        }),
        _ => None,
    }
}

fn opt_text(v: Option<&Value>, max: usize) -> Option<String> {
    v.and_then(Value::as_str)
        .map(|s| clip_text(s, max))
        .filter(|s| !s.is_empty())
}

pub fn decode(
    text: &str,
    network: Network,
    limits: &Limits,
    policy: &Policy,
    now: u64,
) -> Result<(State, LoadReport)> {
    if text.len() > MAX_DOC_BYTES {
        return Err(Error::TooLarge {
            what: "registry document",
            max: MAX_DOC_BYTES,
        });
    }
    if text.trim().is_empty() {
        return Ok((State::default(), LoadReport::default()));
    }
    let doc: Value = serde_json::from_str(text).map_err(|e| Error::Persist(e.to_string()))?;
    let mut report = LoadReport::default();
    if let Some(n) = doc.get("network").and_then(Value::as_str) {
        let found = Network::parse(n)?;
        if found != network {
            return Err(Error::NetworkMismatch {
                expected: network.legacy_code().into(),
                found: found.legacy_code().into(),
            });
        }
    }
    report.legacy_format = doc.get("version").and_then(Value::as_u64) != Some(FORMAT_VERSION);
    let items = doc
        .as_array()
        .or_else(|| doc.get("entries").and_then(Value::as_array))
        .or_else(|| doc.get("accounts").and_then(Value::as_array));
    let mut st = State::default();
    for item in items.map(Vec::as_slice).unwrap_or(&[]) {
        if st.entries.len() >= limits.max_entries {
            report.truncated += 1;
            continue;
        }
        match entry_from_json(item, network, limits, policy, now) {
            Some(e) => {
                st.entries.insert(e.address.clone(), e);
            }
            None => report.dropped_invalid += 1,
        }
    }
    report.loaded = st.entries.len();
    if let Some(t) = doc.get("tradeLayerState").and_then(Value::as_object) {
        st.trade_layer_updated_at = as_u64(t.get("updatedAt"));
        if let Some(bm) = t.get("byMethod").and_then(Value::as_object) {
            for (k, v) in bm {
                if st.trade_layer.len() >= limits.max_methods {
                    break;
                }
                let key = k.trim().to_ascii_lowercase();
                let Some(payload) = v.get("payload") else {
                    continue;
                };
                if key.is_empty() || key.len() > 64 {
                    continue;
                }
                if payload.to_string().len() > limits.max_payload_bytes {
                    continue;
                }
                st.trade_layer.insert(
                    key,
                    MethodSnapshot {
                        updated_at: as_u64(v.get("updatedAt")).unwrap_or(now),
                        route: opt_text(v.get("route"), limits.max_text),
                        address: opt_text(v.get("address"), limits.max_text),
                        provider_node_id: opt_text(v.get("providerNodeId"), limits.max_text),
                        network: opt_text(v.get("network"), limits.max_text),
                        source_endpoint: opt_text(v.get("sourceEndpoint"), limits.max_text),
                        summary: v.get("summary").cloned().filter(Value::is_object),
                        payload: payload.clone(),
                    },
                );
            }
        }
    }
    Ok((st, report))
}

fn entry_from_json(
    v: &Value,
    network: Network,
    limits: &Limits,
    policy: &Policy,
    now: u64,
) -> Option<Entry> {
    let addr = v.get("address")?.as_str()?.trim();
    let pk_s = v.get("pubkey")?.as_str()?.trim();
    let dec = decode_address(addr, network).ok()?;
    let (pk, pk_hex) = parse_pubkey(pk_s).ok()?;
    match bind_pubkey(&pk, &dec).ok()? {
        Binding::Bound => {}
        Binding::Unverifiable if policy.allow_unbound => {}
        Binding::Unverifiable => return None,
    }
    let owner = v
        .get("owner")
        .and_then(Value::as_str)
        .and_then(|s| Principal::new(s).ok());
    let first_seen = as_u64(v.get("firstSeenAt"))
        .filter(|n| *n > 0)
        .unwrap_or(now);
    let utxo_snapshot = v
        .get("lastUtxoSnapshot")
        .filter(|s| s.is_object())
        .and_then(|s| snapshot_from_json(s, &dec, limits, now));
    let token_snapshot = v
        .get("lastTokenSnapshot")
        .filter(|s| s.is_object())
        .map(|s| token_snapshot_from_json(s, limits, now));
    Some(Entry {
        address: dec.text.clone(),
        pubkey: pk_hex,
        owner,
        source: opt_text(v.get("source"), limits.max_text)
            .unwrap_or_else(|| "sync-watchonly".into()),
        assigned_provider_node_id: v
            .get("assignedProviderNodeId")
            .and_then(Value::as_str)
            .and_then(sanitize_node_id),
        assigned_at: as_u64(v.get("assignedAt")).filter(|n| *n > 0),
        first_seen_at: first_seen,
        first_funding_height: as_u64(v.get("firstFundingHeight")),
        first_funding_txid: v
            .get("firstFundingTxid")
            .and_then(Value::as_str)
            .filter(|t| utxo::parse_txid(t).is_ok())
            .map(str::to_string),
        last_seen_at: as_u64(v.get("lastSeenAt"))
            .filter(|n| *n > 0)
            .unwrap_or(now),
        last_imported_at: as_u64(v.get("lastImportedAt")).filter(|n| *n > 0),
        import_count: as_u64(v.get("importCount")).unwrap_or(0),
        scan_state: v
            .get("scanState")
            .and_then(Value::as_str)
            .and_then(ScanState::parse),
        last_scanned_at: as_u64(v.get("lastScannedAt")).filter(|n| *n > 0),
        last_scanned_height: as_u64(v.get("lastScannedHeight")),
        scan_source_node_id: v
            .get("scanSourceNodeId")
            .and_then(Value::as_str)
            .and_then(sanitize_node_id),
        last_snapshot_height: as_u64(v.get("lastSnapshotHeight")),
        last_error: opt_text(v.get("lastError"), limits.max_text),
        utxo_snapshot,
        token_snapshot,
    })
}

fn snapshot_from_json(
    s: &Value,
    dec: &crate::address::DecodedAddress,
    limits: &Limits,
    now: u64,
) -> Option<UtxoSnapshot> {
    let arr = s.get("utxos")?.as_array()?;
    if arr.len() > limits.max_utxos {
        return None;
    }
    let mut utxos = Vec::with_capacity(arr.len());
    let mut seen = std::collections::BTreeSet::new();
    for u in arr {
        let mut o = u.as_object()?.clone();
        // v2 stores `amountSat`; legacy stored coins in `amount`.
        if let Some(sat) = o.get("amountSat").and_then(Value::as_u64) {
            o.insert(
                "amount".into(),
                Value::String(Amount::from_sat(sat).to_coin_string()),
            );
        }
        let parsed = Utxo::from_json(&Value::Object(o)).ok()?;
        utxo::check_utxo_for(&parsed, dec).ok()?;
        if !seen.insert(parsed.outpoint) {
            return None;
        }
        utxos.push(parsed);
    }
    let total = utxo::total_amount(&utxos).ok()?;
    Some(UtxoSnapshot {
        hash: utxo::snapshot_hash(&utxos),
        count: utxos.len(),
        total,
        updated_at: as_u64(s.get("updatedAt")).unwrap_or(now),
        scanned_height: as_u64(s.get("scannedHeight")),
        scan_source_node_id: s
            .get("scanSourceNodeId")
            .and_then(Value::as_str)
            .and_then(sanitize_node_id),
        utxos,
    })
}

fn token_snapshot_from_json(s: &Value, limits: &Limits, now: u64) -> TokenSnapshot {
    let mut balances = Vec::new();
    for b in s
        .get("balances")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
    {
        if balances.len() >= limits.max_tokens {
            break;
        }
        let pid = match b.get("propertyId") {
            Some(Value::String(x)) => x.trim().to_string(),
            Some(Value::Number(n)) => n.to_string(),
            _ => continue,
        };
        if pid.is_empty() || pid.len() > 32 {
            continue;
        }
        let f = |k: &str| b.get(k).and_then(decimal_text);
        let (
            Some(amount),
            Some(available),
            Some(reserved),
            Some(margin),
            Some(vesting),
            Some(channel),
        ) = (
            f("amount"),
            f("available"),
            f("reserved"),
            f("margin"),
            f("vesting"),
            f("channel"),
        )
        else {
            continue;
        };
        balances.push(TokenBalance {
            property_id: pid,
            ticker: opt_text(b.get("ticker"), 64),
            amount,
            available,
            reserved,
            margin,
            vesting,
            channel,
        });
    }
    TokenSnapshot {
        updated_at: as_u64(s.get("updatedAt")).unwrap_or(now),
        scanned_height: as_u64(s.get("scannedHeight")),
        scan_source_node_id: s
            .get("scanSourceNodeId")
            .and_then(Value::as_str)
            .and_then(sanitize_node_id),
        balances,
    }
}
