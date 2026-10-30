//! Replays the legacy oracle recorded by `scripts/compare-legacy.cjs` (pinned blobs,
//! no network) against the Rust port. Regenerate with:
//! `node scripts/compare-legacy.cjs` and commit the fixture if the pins change.
mod common;
use common::*;
use serde_json::{json, Value};
use tl_relayer_core::attestation::{country_from_criminalip, normalize_ip, AttestationConfig};
use tl_relayer_core::registry::rescan_start_height;
use tl_relayer_core::rpc::*;
use tl_relayer_core::tx::order_candidates;
use tl_relayer_core::utxo::derive_first_funding;
use tl_relayer_core::Amount;

const FIXTURE: &str = include_str!("../fixtures/legacy-parity.json");

/// JavaScript `undefined` is dropped by JSON; the port uses `null` for it.
fn strip_nulls(v: &Value) -> Value {
    match v {
        Value::Object(m) => Value::Object(
            m.iter()
                .filter(|(_, v)| !v.is_null())
                .map(|(k, v)| (k.clone(), strip_nulls(v)))
                .collect(),
        ),
        Value::Array(a) => Value::Array(a.iter().map(strip_nulls).collect()),
        other => other.clone(),
    }
}

fn fx() -> Value {
    serde_json::from_str(FIXTURE).unwrap()
}

#[test]
fn fixture_pins_the_expected_legacy_blobs() {
    let f = fx();
    let pins = f["pinned"].as_object().unwrap();
    assert_eq!(pins.len(), 6);
    assert_eq!(
        pins["src/services/address.service.ts"],
        "66b3d3305f197a514a53119ee27a0e6d38ebc3f6"
    );
    assert_eq!(
        pins["src/routes/rpc.route.ts"],
        "aa815103254e5b65837a521c7811f81900b24ef6"
    );
}

#[test]
fn listener_table_lookup_body_and_query_match_legacy() {
    let f = fx();
    for c in f["cases"]["listener_lookup"].as_array().unwrap() {
        let got = listener_method(c["in"].as_str().unwrap());
        assert_eq!(got.map(Value::from).unwrap_or(Value::Null), c["out"], "{c}");
    }
    for c in f["cases"]["listener_body"].as_array().unwrap() {
        let params: Vec<Value> = c["params"].as_array().unwrap().clone();
        let got = build_listener_body(c["method"].as_str().unwrap(), &params);
        assert_eq!(strip_nulls(&got), strip_nulls(&c["out"]), "{c}");
    }
    for c in f["cases"]["listener_query"].as_array().unwrap() {
        let params: Vec<Value> = c["params"].as_array().unwrap().clone();
        let got = build_listener_query(c["method"].as_str().unwrap(), &params);
        assert_eq!(strip_nulls(&got), strip_nulls(&c["out"]), "{c}");
    }
}

#[test]
fn public_allowlist_equals_the_legacy_set_in_order() {
    let f = fx();
    let legacy: Vec<&str> = f["cases"]["public_methods"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap())
        .collect();
    assert_eq!(legacy, PUBLIC_RPC_METHODS.to_vec());
    for c in f["cases"]["normalize_method"].as_array().unwrap() {
        assert_eq!(
            normalize_method(c["in"].as_str().unwrap()),
            c["out"].as_str().unwrap()
        );
    }
}

#[test]
fn first_funding_and_rescan_start_match_legacy() {
    let f = fx();
    for c in f["cases"]["first_funding"].as_array().unwrap() {
        let rows: Vec<(String, u64)> = c["utxos"]
            .as_array()
            .unwrap()
            .iter()
            .map(|u| {
                (
                    u["txid"].as_str().unwrap().to_string(),
                    u["confirmations"].as_u64().unwrap(),
                )
            })
            .collect();
        let (h, t) = derive_first_funding(&rows, c["height"].as_u64());
        let want = &c["out"];
        if c["height"].is_null() && !rows.is_empty() && rows.iter().any(|(_, c)| *c > 0) {
            // Repaired defect: legacy `Number(null) === 0` passes the finite/non-negative
            // guard, so an unknown tip height yields a bogus funding height of 0.
            assert_eq!(want["firstFundingHeight"], json!(0), "{c}");
            assert_eq!((h, t), (None, None), "{c}");
            continue;
        }
        assert_eq!(
            h.map(Value::from).unwrap_or(Value::Null),
            want["firstFundingHeight"],
            "{c}"
        );
        assert_eq!(
            t.map(Value::from).unwrap_or(Value::Null),
            want["firstFundingTxid"],
            "{c}"
        );
    }
    for c in f["cases"]["rescan_start"].as_array().unwrap() {
        let g = |k: &str| c[k].as_u64();
        let got = rescan_start_height(
            g("firstFundingHeight"),
            g("lastSnapshotHeight"),
            g("lastScannedHeight"),
        );
        let any_null = [
            "firstFundingHeight",
            "lastSnapshotHeight",
            "lastScannedHeight",
        ]
        .iter()
        .any(|k| c[*k].is_null());
        if any_null {
            // Repaired defect: legacy `normalizeHeight(null)` is `Number(null) === 0`, so a
            // single unknown height forces a rescan from block 0.
            assert_eq!(c["out"], json!(0), "{c}");
            let known: Vec<u64> = [
                "firstFundingHeight",
                "lastSnapshotHeight",
                "lastScannedHeight",
            ]
            .iter()
            .filter_map(|k| c[*k].as_u64())
            .collect();
            assert_eq!(got, known.iter().copied().min(), "{c}");
            continue;
        }
        assert_eq!(got.map(Value::from).unwrap_or(Value::Null), c["out"], "{c}");
    }
}

#[test]
fn candidate_order_matches_legacy_largest_first_and_fee_differs_by_design() {
    let f = fx();
    let from = dec(&p2wpkh(NET, &key(1)));
    for c in f["cases"]["legacy_selection"].as_array().unwrap() {
        let label = |s: &str| s.as_bytes()[0] - b'a' + 1;
        let mut utxos: Vec<_> = c["utxos"]
            .as_array()
            .unwrap()
            .iter()
            .map(|u| {
                let amt = Amount::from_json_coin(&u["amount"]).unwrap();
                utxo_for(&from, label(u["txid"].as_str().unwrap()), 0, amt.sat())
            })
            .collect();
        order_candidates(&mut utxos);
        let target = Amount::from_json_coin(&c["amount"]).unwrap().sat();
        let (mut total, mut picked) = (0u64, Vec::new());
        for u in &utxos {
            picked.push(u.outpoint.txid);
            total += u.amount.sat();
            if total >= target {
                break;
            }
        }
        let legacy: Vec<_> = c["selected"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| txid(label(s.as_str().unwrap())))
            .collect();
        assert_eq!(picked, legacy, "{c}");
        // The legacy fee is a constant 0.00001 regardless of size (see README: repaired).
        assert_eq!(c["legacyFee"], json!(0.00001));
    }
    // Legacy inferred the network from the first output's prefix and defaulted to BTC.
    let inf = f["cases"]["legacy_inference"].as_array().unwrap();
    let get = |a: &str| {
        inf.iter().find(|c| c["in"] == a).unwrap()["out"]
            .as_str()
            .unwrap()
            .to_string()
    };
    assert_eq!(get("tltc1qx"), "LTCTEST");
    assert_eq!(get("bcrt1qx"), "BTC", "regtest mislabelled as BTC mainnet");
    assert_eq!(
        get("D8x"),
        "BTC",
        "unknown prefixes defaulted to BTC mainnet"
    );
}

#[test]
fn attestation_helpers_match_legacy() {
    let f = fx();
    for c in f["cases"]["criminalip_country"].as_array().unwrap() {
        assert_eq!(
            country_from_criminalip(&c["in"]),
            c["out"].as_str().unwrap(),
            "{c}"
        );
    }
    for c in f["cases"]["normalize_ip"].as_array().unwrap() {
        let input = c["in"].as_str().unwrap();
        if input.trim().is_empty() {
            assert!(normalize_ip(input).is_err());
        } else {
            assert_eq!(
                normalize_ip(input).unwrap(),
                c["out"].as_str().unwrap().trim(),
                "{c}"
            );
        }
    }
    let legacy: Vec<&str> = f["cases"]["banned_countries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap())
        .collect();
    let ours = AttestationConfig::default().banned_countries;
    assert_eq!(legacy, ours.iter().map(String::as_str).collect::<Vec<_>>());
}
