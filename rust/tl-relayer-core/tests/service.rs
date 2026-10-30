mod common;
use bitcoin::blockdata::opcodes::all::{OP_CHECKMULTISIG, OP_PUSHNUM_2};
use bitcoin::blockdata::script::Builder;
use common::*;
use serde_json::{json, Value};
use tl_relayer_core::address::hex;
use tl_relayer_core::auth::{AuthContext, Capability};
use tl_relayer_core::fakes::{FakeExternal, FakeOracle};
use tl_relayer_core::ports::OracleOutput;
use tl_relayer_core::registry::Account;
use tl_relayer_core::rpc::{Gateway, Router};
use tl_relayer_core::service::*;
use tl_relayer_core::tx::{audit_psbt, AuditRules, Role};
use tl_relayer_core::{Amount, Error, Network};

fn acct(n: u8) -> Account {
    Account {
        address: p2wpkh(NET, &key(n)),
        pubkey: pk_hex(&key(n)),
    }
}

fn alice() -> AuthContext {
    user("alice")
}

#[test]
fn import_registers_then_calls_the_provider_once() {
    let mut r = rig();
    let a = acct(1);
    r.transport.push_ok(ok_reply("node-1"));
    let o = r.svc.import_pubkey(&alice(), &a).unwrap();
    assert!(o.imported && !o.skipped);
    let calls = r.transport.calls();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].method, "tl_watchonly_register");
    assert_eq!(
        calls[0].params,
        vec![json!({"address": a.address, "pubkey": a.pubkey, "network": "litecoin.testnet"})]
    );
    let e = r.svc.registry.entry(&a.address).unwrap();
    assert_eq!(e.assigned_provider_node_id.as_deref(), Some("node-1"));
    assert!(e.last_imported_at.is_some());
    // Idempotent: no second provider call.
    let again = r.svc.import_pubkey(&alice(), &a).unwrap();
    assert!(!again.imported && again.skipped);
    assert_eq!(r.transport.calls().len(), 1);
}

#[test]
fn regression_import_authorises_and_binds_before_any_provider_call() {
    let mut r = rig();
    let a = acct(1);
    assert_eq!(
        r.svc
            .import_pubkey(&AuthContext::anonymous(), &a)
            .unwrap_err(),
        Error::Unauthorized
    );
    let forged = Account {
        address: a.address.clone(),
        pubkey: pk_hex(&key(2)),
    };
    assert_eq!(
        r.svc.import_pubkey(&alice(), &forged).unwrap_err(),
        Error::PubkeyAddressMismatch
    );
    let wrong_net = Account {
        address: p2wpkh(Network::BTC_TEST, &key(1)),
        pubkey: pk_hex(&key(1)),
    };
    assert!(matches!(
        r.svc.import_pubkey(&alice(), &wrong_net),
        Err(Error::AddressOnOtherNetwork(_))
    ));
    assert!(r.transport.calls().is_empty());
    assert!(r.svc.registry.is_empty());
}

#[test]
fn provider_failure_is_recorded_and_retried_by_reconcile() {
    let mut r = rig();
    let a = acct(1);
    r.transport
        .push_ok(json!({"ok": false, "error": {"message": "no WebRTC RPC provider"}}));
    let e = r.svc.import_pubkey(&alice(), &a).unwrap_err();
    assert!(matches!(e, Error::NoProvider(_)));
    let entry = r.svc.registry.entry(&a.address).unwrap();
    assert!(entry.last_imported_at.is_none());
    assert_eq!(entry.last_error.as_deref(), Some("no WebRTC RPC provider"));
    assert_eq!(
        r.svc.reconcile(&alice()).unwrap_err(),
        Error::Forbidden("missing capability")
    );
    r.transport.push_ok(ok_reply("node-2"));
    let sum = r.svc.reconcile(&admin()).unwrap();
    assert_eq!(sum.imported, 1);
    let entry = r.svc.registry.entry(&a.address).unwrap();
    assert!(entry.last_error.is_none());
    assert_eq!(entry.assigned_provider_node_id.as_deref(), Some("node-2"));
}

#[test]
fn import_accounts_is_bounded_and_returns_only_submitted_results() {
    let mut r = rig();
    r.svc
        .import_pubkey(&user("bob"), &{
            r.transport.push_ok(ok_reply("n"));
            acct(9)
        })
        .unwrap();
    let many: Vec<Account> = (0..101u8).map(acct).collect();
    assert!(matches!(
        r.svc.import_accounts(&alice(), &many),
        Err(Error::TooMany { .. })
    ));
    r.transport.push_ok(ok_reply("n"));
    let bad = Account {
        address: "junk".into(),
        pubkey: "k".into(),
    };
    let sum = r
        .svc
        .import_accounts(&alice(), &[acct(1), acct(1), bad])
        .unwrap();
    assert_eq!((sum.imported, sum.skipped, sum.failed), (1, 1, 1));
    assert_eq!(sum.results.len(), 2);
    assert!(
        sum.results.iter().all(|x| x.address != acct(9).address),
        "no foreign entries leak"
    );
}

fn registered_with_utxos(
    r: &mut Rig,
    n: u8,
    rows: &[(u8, u32, &str)],
    height: u64,
) -> tl_relayer_core::service::UtxoReply {
    let d = dec(&acct(n).address);
    r.transport.push_ok(ok_reply("node-1"));
    r.transport.push_ok(utxos_reply(&d, rows, height, "node-1"));
    r.svc
        .list_unspent(
            &alice(),
            &acct(n).address,
            Some(&acct(n).pubkey),
            Some("LTCTEST"),
        )
        .unwrap()
}

#[test]
fn list_unspent_registers_validates_and_records() {
    let mut r = rig();
    let reply = registered_with_utxos(&mut r, 1, &[(1, 0, "0.5"), (2, 1, "0.00001")], 700);
    assert_eq!(reply.utxos.len(), 2);
    assert_eq!(reply.height, Some(700));
    assert!(reply.recorded && !reply.from_cache);
    assert_eq!(reply.utxos[1].amount.sat(), 1_000);
    let calls = r.transport.calls();
    assert_eq!(calls[1].method, "tl_watchonly_utxos");
    assert_eq!(
        calls[1].preferred_provider_node_id.as_deref(),
        Some("node-1")
    );
    let e = r.svc.registry.entry(&acct(1).address).unwrap();
    let s = e.utxo_snapshot.as_ref().unwrap();
    assert_eq!(
        (s.count, s.total.sat(), s.scanned_height),
        (2, 50_001_000, Some(700))
    );
    assert_eq!(e.last_snapshot_height, Some(700));
    // confirmations 5 at tip 700 -> funded at 696
    assert_eq!(e.first_funding_height, Some(696));
    assert_eq!(s.hash.len(), 64);
}

#[test]
fn regression_provider_data_is_validated_not_trusted() {
    let mut r = rig();
    registered_with_utxos(&mut r, 1, &[(1, 0, "0.5")], 700);
    let a = acct(1);
    let d = dec(&a.address);
    let stranger = dec(&p2wpkh(NET, &key(9)));
    let before = r.svc.registry.entry(&a.address).unwrap().clone();
    let call = |r: &mut Rig, body: Value| {
        r.transport.push_ok(body);
        r.svc
            .list_unspent(&alice(), &a.address, Some(&a.pubkey), None)
    };
    // Output paying a different script.
    let mut foreign = utxos_reply(&d, &[(3, 0, "1")], 701, "node-1");
    foreign["result"]["utxos"][0]["scriptPubKey"] = json!(hex(stranger.script.as_bytes()));
    assert_eq!(call(&mut r, foreign).unwrap_err(), Error::ForeignScript);
    // Different address in the envelope.
    let other = utxos_reply(&stranger, &[(3, 0, "1")], 701, "node-1");
    assert!(matches!(call(&mut r, other), Err(Error::Upstream(_))));
    // Different network label.
    let mut net = utxos_reply(&d, &[], 701, "node-1");
    net["result"]["network"] = json!("litecoin.mainnet");
    assert!(matches!(
        call(&mut r, net),
        Err(Error::NetworkMismatch { .. })
    ));
    // Float dust / junk amounts, duplicates, missing fields.
    let mut junk = utxos_reply(&d, &[(3, 0, "1")], 701, "node-1");
    junk["result"]["utxos"][0]["amount"] = json!(0.123456789);
    assert!(call(&mut r, junk).is_err());
    let dup = utxos_reply(&d, &[(3, 0, "1"), (3, 0, "2")], 701, "node-1");
    assert_eq!(call(&mut r, dup).unwrap_err(), Error::DuplicateOutpoint);
    assert!(call(&mut r, json!({"result": {"utxos": "nope"}})).is_err());
    assert!(call(&mut r, json!({"result": [1, 2]})).is_err());
    // A lagging provider (older height) is refused and nothing changes.
    let lag = utxos_reply(&d, &[(7, 0, "9")], 650, "node-2");
    assert_eq!(
        call(&mut r, lag).unwrap_err(),
        Error::StaleSnapshot {
            have: 700,
            got: 650
        }
    );
    assert_eq!(r.svc.registry.entry(&a.address).unwrap(), &before);
    // A missing source height is served but not recorded.
    let mut nh = utxos_reply(&d, &[(8, 0, "1")], 0, "node-1");
    nh["result"]["snapshot"] = json!({});
    let rep = call(&mut r, nh).unwrap();
    assert!(!rep.recorded && rep.height.is_none());
    assert_eq!(r.svc.registry.entry(&a.address).unwrap(), &before);
}

#[test]
fn network_and_pubkey_checks_on_utxo_reads() {
    let mut r = rig();
    let a = acct(1);
    for net in ["LTC", "BTCTEST", "garbage"] {
        assert!(
            r.svc
                .list_unspent(&alice(), &a.address, Some(&a.pubkey), Some(net))
                .is_err(),
            "{net}"
        );
    }
    assert_eq!(
        r.svc
            .list_unspent(&AuthContext::anonymous(), &a.address, Some(&a.pubkey), None)
            .unwrap_err(),
        Error::Unauthorized
    );
    assert_eq!(
        r.svc
            .list_unspent(&alice(), &a.address, None, None)
            .unwrap_err(),
        Error::InvalidField("pubkey")
    );
    assert!(r.transport.calls().is_empty());
    registered_with_utxos(&mut r, 1, &[(1, 0, "1")], 10);
    // Pubkey omitted: the registry key is used. A different pubkey conflicts.
    r.transport
        .push_ok(utxos_reply(&dec(&a.address), &[(1, 0, "1")], 11, "node-1"));
    assert!(r.svc.list_unspent(&alice(), &a.address, None, None).is_ok());
    let e = r
        .svc
        .list_unspent(&alice(), &a.address, Some(&pk_hex(&key(2))), None)
        .unwrap_err();
    assert_eq!(e, Error::PubkeyConflict);
}

#[test]
fn cache_fallback_is_bounded_by_age() {
    let mut r = rig();
    let a = acct(1);
    registered_with_utxos(&mut r, 1, &[(1, 0, "1")], 10);
    r.clock.advance(60_000);
    r.transport
        .push_ok(json!({"ok": false, "error": "provider down"}));
    let rep = r
        .svc
        .list_unspent(&alice(), &a.address, Some(&a.pubkey), None)
        .unwrap();
    assert!(rep.from_cache && !rep.recorded);
    assert_eq!(rep.cached_at, Some(1_000_000));
    assert_eq!(rep.utxos.len(), 1);
    // Beyond snapshot_max_age_ms the error surfaces instead of stale coins.
    r.clock.advance(10 * 60_000);
    r.transport
        .push_ok(json!({"ok": false, "error": "provider down"}));
    assert_eq!(
        r.svc
            .list_unspent(&alice(), &a.address, Some(&a.pubkey), None)
            .unwrap_err(),
        Error::Upstream("provider down".into())
    );
}

fn tx_json(from: &Account, to: &Account, amount: f64) -> Value {
    json!({
        "fromKeyPair": {"address": from.address, "pubkey": from.pubkey},
        "toKeyPair": {"address": to.address},
        "amount": amount,
        "network": "LTCTEST",
    })
}

#[test]
fn build_unsigned_end_to_end() {
    let mut r = rig();
    let (from, to) = (acct(1), acct(2));
    r.transport.push_ok(ok_reply("node-1"));
    r.transport.push_ok(utxos_reply(
        &dec(&from.address),
        &[(1, 0, "0.01"), (2, 0, "0.004")],
        800,
        "node-1",
    ));
    let req = BuildTxRequest::from_json(&tx_json(&from, &to, 0.005), None).unwrap();
    let t = r.svc.build_unsigned(&alice(), &req).unwrap();
    assert_eq!(t.inputs.len(), 1);
    assert_eq!(t.inputs[0].amount.sat(), 1_000_000);
    let change = t.outputs.iter().find(|o| o.role == Role::Change).unwrap();
    assert_eq!(change.script, dec(&from.address).script);
    assert_eq!(t.total_out().unwrap().sat() + t.fee.sat(), 1_000_000);
    let rules = AuditRules {
        wallet_script: &dec(&from.address).script,
        allowed_recipients: &[dec(&to.address).script],
        max_fee_sat: 10_000,
    };
    audit_psbt(&t.psbt.serialize(), &rules).unwrap();
    let j = unsigned_json(&t);
    assert_eq!(j["feeSat"], t.fee.sat());
    assert_eq!(j["psbtHex"].as_str().unwrap(), t.psbt_hex());
    assert_eq!(j["inputs"][0]["amount"], json!(0.01));
}

#[test]
fn regression_build_request_rejects_client_fee_and_change_and_unverified_inputs() {
    let (from, to) = (acct(1), acct(2));
    for k in [
        "fee",
        "feeRate",
        "change",
        "changeAddress",
        "changeKeyPair",
        "fees",
        "changeTo",
    ] {
        let mut cfg = tx_json(&from, &to, 0.005);
        cfg[k] = json!("attacker");
        assert!(BuildTxRequest::from_json(&cfg, None).is_err(), "{k}");
    }
    let mut no_net = tx_json(&from, &to, 0.005);
    no_net.as_object_mut().unwrap().remove("network");
    assert_eq!(
        BuildTxRequest::from_json(&no_net, None).unwrap_err(),
        Error::InvalidField("network")
    );
    assert!(BuildTxRequest::from_json(&no_net, Some("LTCTEST")).is_ok());
    let mut weird = tx_json(&from, &to, 0.005);
    weird["amount"] = json!(0.1 + 0.2);
    assert!(BuildTxRequest::from_json(&weird, None).is_err());
    weird["amount"] = json!(-1);
    assert!(BuildTxRequest::from_json(&weird, None).is_err());

    // Client-listed inputs may only narrow the provider snapshot.
    let mut r = rig();
    r.transport.push_ok(ok_reply("node-1"));
    r.transport.push_ok(utxos_reply(
        &dec(&from.address),
        &[(1, 0, "0.01")],
        800,
        "node-1",
    ));
    let mut cfg = tx_json(&from, &to, 0.005);
    cfg["inputs"] = json!([{"txid": txid(1).to_string(), "vout": 0}, {"txid": txid(99).to_string(), "vout": 0}]);
    let req = BuildTxRequest::from_json(&cfg, None).unwrap();
    assert_eq!(
        r.svc.build_unsigned(&alice(), &req).unwrap_err(),
        Error::InputNotVerified
    );
    // Wrong network on the request.
    let mut cfg = tx_json(&from, &to, 0.005);
    cfg["network"] = json!("BTCTEST");
    let req = BuildTxRequest::from_json(&cfg, None).unwrap();
    assert!(matches!(
        r.svc.build_unsigned(&alice(), &req),
        Err(Error::NetworkMismatch { .. })
    ));
}

#[test]
fn building_refuses_stale_or_unstamped_snapshots() {
    let mut r = rig();
    let (from, to) = (acct(1), acct(2));
    registered_with_utxos(&mut r, 1, &[(1, 0, "0.01")], 800);
    let req = BuildTxRequest::from_json(&tx_json(&from, &to, 0.005), None).unwrap();
    r.transport.push_ok(json!({"ok": false, "error": "down"}));
    assert!(matches!(
        r.svc.build_unsigned(&alice(), &req),
        Err(Error::SnapshotUnavailable(_))
    ));
    let mut nh = utxos_reply(&dec(&from.address), &[(1, 0, "0.01")], 0, "node-1");
    nh["result"]["snapshot"] = json!({});
    r.transport.push_ok(nh);
    assert!(matches!(
        r.svc.build_unsigned(&alice(), &req),
        Err(Error::SnapshotUnavailable(_))
    ));
}

#[test]
fn trade_tx_uses_oracle_values_for_commit_outputs() {
    let mut r = rig();
    let (buyer, seller) = (acct(1), acct(2));
    let ws = Builder::new()
        .push_opcode(OP_PUSHNUM_2)
        .push_key(&key(11))
        .push_key(&key(12))
        .push_opcode(OP_PUSHNUM_2)
        .push_opcode(OP_CHECKMULTISIG)
        .into_script();
    let channel = dec(&p2wsh(NET, &ws));
    let oracle = FakeOracle::new();
    oracle.insert(
        op(7, 1),
        OracleOutput {
            amount_sat: 200_000,
            script_pubkey: channel.script.to_bytes(),
            confirmations: 9,
        },
    );
    let cfg = |commit_amount: f64, rs: &str| {
        json!({
            "buyerKeyPair": {"address": buyer.address, "pubkey": buyer.pubkey},
            "sellerKeyPair": {"address": seller.address},
            "amount": 0.003,
            "network": "LTCTEST",
            "payload": "tl2abc",
            "commitUTXOs": [{"txid": txid(7).to_string(), "vout": 1, "amount": commit_amount, "redeemScript": rs}],
        })
    };
    r.transport.push_ok(ok_reply("node-1"));
    r.transport.push_ok(utxos_reply(
        &dec(&buyer.address),
        &[(1, 0, "0.01"), (7, 1, "0.0")]
            .iter()
            .take(1)
            .copied()
            .collect::<Vec<_>>(),
        900,
        "node-1",
    ));
    // The caller claims the commit output holds 99 coins; the oracle says 200000 sat.
    let req = TradeTxRequest::from_json(&cfg(99.0, &hex(ws.as_bytes()))).unwrap();
    let mut orc = oracle.clone();
    let t = r
        .svc
        .build_trade_unsigned(&alice(), &req, &mut orc)
        .unwrap();
    assert_eq!(t.inputs[0].outpoint, op(7, 1));
    assert_eq!(t.inputs[0].amount.sat(), 200_000);
    assert!(t.outputs.iter().any(|o| o.role == Role::Data));
    assert_eq!(
        t.total_out().unwrap().sat() + t.fee.sat(),
        t.total_in().unwrap().sat()
    );
    assert!(t.fee.sat() < 5_000);
    for o in &t.outputs {
        assert!(
            o.role == Role::Data
                || o.script == dec(&buyer.address).script
                || o.script == dec(&seller.address).script
        );
    }
    // Unknown/spent commit output, or a redeem script that does not hash to it.
    let missing = TradeTxRequest::from_json(&{
        let mut c = cfg(1.0, &hex(ws.as_bytes()));
        c["commitUTXOs"][0]["vout"] = json!(5);
        c
    })
    .unwrap();
    assert_eq!(
        r.svc
            .build_trade_unsigned(&alice(), &missing, &mut orc)
            .unwrap_err(),
        Error::InputNotVerified
    );
    let bad_rs = TradeTxRequest::from_json(&cfg(1.0, "51")).unwrap();
    assert_eq!(
        r.svc
            .build_trade_unsigned(&alice(), &bad_rs, &mut orc)
            .unwrap_err(),
        Error::InputNotVerified
    );
    // Legacy bug: `cUtxo.vout === cUtxo.vout` excluded every output of the commit txid. Here only
    // the exact outpoint is excluded: another vout of the same txid stays selectable.
}

#[test]
fn trade_selection_only_excludes_the_exact_commit_outpoint() {
    let mut r = rig();
    let (buyer, seller) = (acct(1), acct(2));
    let ws = Builder::new()
        .push_opcode(OP_PUSHNUM_2)
        .push_key(&key(11))
        .push_key(&key(12))
        .push_opcode(OP_PUSHNUM_2)
        .push_opcode(OP_CHECKMULTISIG)
        .into_script();
    let channel = dec(&p2wsh(NET, &ws));
    let oracle = FakeOracle::new();
    oracle.insert(
        op(7, 1),
        OracleOutput {
            amount_sat: 100_000,
            script_pubkey: channel.script.to_bytes(),
            confirmations: 9,
        },
    );
    // Buyer's wallet holds txid 7 vout 0 too (a different output of the commit txid).
    r.transport.push_ok(ok_reply("n"));
    r.transport.push_ok(utxos_reply(
        &dec(&buyer.address),
        &[(7, 0, "0.01")],
        900,
        "n",
    ));
    let req = TradeTxRequest::from_json(&json!({
        "buyerKeyPair": {"address": buyer.address, "pubkey": buyer.pubkey},
        "sellerKeyPair": {"address": seller.address},
        "amount": 0.005, "network": "LTCTEST",
        "commitUTXOs": [{"txid": txid(7).to_string(), "vout": 1, "redeemScript": hex(ws.as_bytes())}],
    }))
    .unwrap();
    let t = r
        .svc
        .build_trade_unsigned(&alice(), &req, &mut oracle.clone())
        .unwrap();
    let outs: Vec<_> = t
        .inputs
        .iter()
        .map(|u| (u.outpoint.txid, u.outpoint.vout))
        .collect();
    assert!(outs.contains(&(txid(7), 1)) && outs.contains(&(txid(7), 0)));
}

#[test]
fn broadcast_validates_the_transaction() {
    let mut r = rig();
    let d = dec(&acct(1).address);
    let mut signed = bitcoin::Transaction {
        version: bitcoin::transaction::Version::TWO,
        lock_time: bitcoin::absolute::LockTime::ZERO,
        input: vec![bitcoin::TxIn {
            previous_output: op(1, 0),
            ..Default::default()
        }],
        output: vec![bitcoin::TxOut {
            value: bitcoin::Amount::from_sat(1_000),
            script_pubkey: d.script.clone(),
        }],
    };
    let unsigned_hex = bitcoin::consensus::encode::serialize_hex(&signed);
    assert_eq!(
        r.svc.broadcast(&alice(), &unsigned_hex).unwrap_err(),
        Error::InvalidField("transaction is not fully signed")
    );
    signed.input[0].witness = bitcoin::Witness::from_slice(&[vec![1u8; 71], vec![2u8; 33]]);
    let signed_hex = bitcoin::consensus::encode::serialize_hex(&signed);
    r.transport.push_ok(json!({"result": "deadbeef"}));
    let out = r.svc.broadcast(&alice(), &signed_hex).unwrap();
    assert_eq!(out, json!({"txid": "deadbeef"}));
    assert_eq!(r.transport.calls()[0].method, "sendrawtransaction");
    for bad in ["", "zz", "00", &"ab".repeat(400_001)] {
        assert!(r.svc.broadcast(&alice(), bad).is_err());
    }
    assert_eq!(
        r.svc
            .broadcast(&AuthContext::anonymous(), &signed_hex)
            .unwrap_err(),
        Error::Unauthorized
    );
    let dec = decode_raw_tx(&signed_hex).unwrap();
    assert_eq!(dec["vout"][0]["value"], json!(0.00001));
    assert_eq!(dec["vin"][0]["vout"], 0);
}

#[test]
fn regression_faucet_is_capability_gated_network_gated_and_rate_limited() {
    let mut r = rig();
    let a = acct(1).address;
    let faucet = ctx("f", &[Capability::Faucet]);
    assert_eq!(
        r.svc.faucet(&AuthContext::anonymous(), &a).unwrap_err(),
        Error::Unauthorized
    );
    assert_eq!(
        r.svc.faucet(&alice(), &a).unwrap_err(),
        Error::Forbidden("missing capability")
    );
    r.transport.push_ok(json!({"result": "tx1"}));
    assert_eq!(r.svc.faucet(&faucet, &a).unwrap(), json!({"txid": "tx1"}));
    let c = &r.transport.calls()[0];
    assert_eq!(
        (c.method.as_str(), &c.params[1]),
        ("sendtoaddress", &json!(1.0))
    );
    assert_eq!(
        r.svc.faucet(&faucet, &a).unwrap_err(),
        Error::Forbidden("faucet cooldown active")
    );
    r.clock.advance(24 * 60 * 60 * 1000);
    r.transport.push_ok(json!({"result": "tx2"}));
    assert!(r.svc.faucet(&faucet, &a).is_ok());
    assert!(r.svc.faucet(&faucet, "bogus").is_err());
    assert_eq!(r.transport.calls().len(), 2);
    // Mainnet service: never.
    let store = tl_relayer_core::fakes::MemoryStore::new();
    let clock = tl_relayer_core::fakes::ManualClock::new(1);
    let t = tl_relayer_core::fakes::FakeTransport::new();
    let (reg, _) = tl_relayer_core::registry::Registry::open(
        Network::LTC,
        Default::default(),
        Default::default(),
        store,
        clock,
    )
    .unwrap();
    let mut main = WatchOnlyService::new(
        ServiceConfig::new(Network::LTC),
        reg,
        Router::new("tradelayer.rpc", Network::LTC, t.clone()),
    )
    .unwrap();
    let main_addr = p2wpkh(Network::LTC, &key(1));
    assert_eq!(
        main.faucet(&faucet, &main_addr).unwrap_err(),
        Error::Forbidden("Faucet is allowed only on a test network")
    );
    assert!(t.calls().is_empty());
    // Mismatched wiring is refused.
    let (reg2, _) = tl_relayer_core::registry::Registry::open(
        NET,
        Default::default(),
        Default::default(),
        tl_relayer_core::fakes::MemoryStore::new(),
        tl_relayer_core::fakes::ManualClock::new(1),
    )
    .unwrap();
    assert!(WatchOnlyService::new(
        ServiceConfig::new(Network::LTC),
        reg2,
        Router::new("s", Network::LTC, t)
    )
    .is_err());
}

#[test]
fn regression_rescan_requires_admin_and_opt_in_even_with_force() {
    let mut cfg = ServiceConfig::new(NET);
    let mut r = rig_with(Default::default(), cfg.clone());
    registered_with_utxos(&mut r, 1, &[(1, 0, "1")], 100);
    assert_eq!(
        r.svc
            .rescan(&alice(), None, None, None, true, Some(200))
            .unwrap_err(),
        Error::Forbidden("missing capability")
    );
    r.transport.push_ok(utxos_reply(
        &dec(&acct(1).address),
        &[(1, 0, "1")],
        201,
        "node-1",
    ));
    let rep = r
        .svc
        .rescan(&admin(), None, None, None, true, Some(200))
        .unwrap();
    assert!(!rep.executed, "force cannot bypass the opt-in");
    assert!(r
        .transport
        .calls()
        .iter()
        .all(|c| c.method != "rescanblockchain"));
    assert_eq!(rep.refreshed, 1);

    cfg.rescan_opt_in = true;
    let mut r = rig_with(Default::default(), cfg);
    registered_with_utxos(&mut r, 1, &[(1, 0, "1")], 100);
    r.transport
        .push_ok(json!({"result": null, "data": {"start_height": 90}}));
    r.transport.push_ok(utxos_reply(
        &dec(&acct(1).address),
        &[(1, 0, "1")],
        201,
        "node-1",
    ));
    let rep = r
        .svc
        .rescan(
            &admin(),
            Some(&acct(1).address),
            None,
            None,
            false,
            Some(200),
        )
        .unwrap();
    assert!(rep.executed);
    assert_eq!(rep.from_height, 86);
    let c = r.transport.calls();
    let resc = c.iter().find(|c| c.method == "rescanblockchain").unwrap();
    assert_eq!(resc.params, vec![json!(86)]);
    assert!(r
        .svc
        .rescan(&admin(), None, Some(5), Some(2), false, None)
        .is_err());
    assert!(r
        .svc
        .rescan(&admin(), Some("nope"), None, None, false, None)
        .is_err());
}

#[test]
fn balance_records_and_falls_back_to_a_fresh_cache_only() {
    let mut r = rig();
    let a = acct(1);
    registered_with_utxos(&mut r, 1, &[(1, 0, "1")], 100);
    let rows = json!([
        {"propertyId": 3, "ticker": "TL", "amount": 12.5, "available": 10, "reserved": 2.5, "margin": 0, "vesting": 0, "channel": 0},
        {"propertyId": null, "amount": 1},
        "junk"
    ]);
    r.transport
        .push_ok(json!({"result": rows, "providerNodeId": "node-1"}));
    let rep = r.svc.balance(&alice(), &a.address).unwrap();
    assert_eq!(
        rep.balances.len(),
        3,
        "the raw provider array is returned unchanged"
    );
    let t = r
        .svc
        .registry
        .entry(&a.address)
        .unwrap()
        .token_snapshot
        .as_ref()
        .unwrap();
    assert_eq!(t.balances.len(), 1);
    assert_eq!(t.balances[0].amount, "12.5");
    r.transport.push_ok(json!({"ok": false, "error": "down"}));
    let cached = r.svc.balance(&alice(), &a.address).unwrap();
    assert!(cached.from_cache);
    assert_eq!(cached.balances[0]["amount"], json!(12.5));
    r.clock.advance(3_600_000);
    r.transport.push_ok(json!({"ok": false, "error": "down"}));
    assert_eq!(
        r.svc.balance(&alice(), &a.address).unwrap_err(),
        Error::Upstream("down".into())
    );
    // Unregistered address: served, nothing recorded, no entry created.
    let b = acct(2);
    r.transport.push_ok(json!({"result": []}));
    r.svc.balance(&alice(), &b.address).unwrap();
    assert!(r.svc.registry.entry(&b.address).is_none());
    assert!(r.svc.balance(&alice(), "bogus").is_err());
    r.transport.push_ok(json!({"result": "not an array"}));
    assert!(r
        .svc
        .balance(&alice(), &b.address)
        .unwrap()
        .balances
        .is_empty());
}

#[test]
fn verify_coverage_compares_with_the_external_source() {
    let mut r = rig();
    let a = acct(1);
    let d = dec(&a.address);
    registered_with_utxos(&mut r, 1, &[(1, 0, "1")], 100);
    let ext = FakeExternal::new();
    let page = |rows: &[(u8, &str)]| {
        json!({"status": "success", "data": {"outputs": rows.iter().map(|(n, v)| json!({
            "hash": txid(*n).to_string(), "index": 0, "value": v, "block": 5, "script": hex(d.script.as_bytes())
        })).collect::<Vec<_>>()}}).to_string()
    };
    ext.set_page(&a.address, 1, 200, &page(&[(1, "1.00000000")]));
    let rep = r
        .svc
        .verify_coverage(&alice(), &a.address, &mut ext.clone())
        .unwrap();
    assert!(!rep.needs_rescan);
    assert_eq!(rep.reason, "local snapshot matches external utxo set");
    ext.set_page(&a.address, 1, 200, &page(&[(1, "1.00000000"), (2, "0.5")]));
    let rep = r
        .svc
        .verify_coverage(&alice(), &a.address, &mut ext.clone())
        .unwrap();
    assert!(rep.needs_rescan);
    assert_eq!(rep.reason, "local snapshot differs from external utxo set");
    ext.set_page(&a.address, 1, 500, "boom");
    let rep = r
        .svc
        .verify_coverage(&alice(), &a.address, &mut ext.clone())
        .unwrap();
    assert!(!rep.needs_rescan && rep.external_hash.is_none());
    assert_eq!(rep.reason, "external utxo source unavailable");
    // Another principal cannot probe someone else's entry.
    assert_eq!(
        r.svc
            .verify_coverage(&user("bob"), &a.address, &mut ext.clone())
            .unwrap_err(),
        Error::NotFound
    );
}

#[test]
fn gateway_hooks_route_watchonly_methods_through_the_service() {
    let mut r = rig();
    let a = acct(1);
    let mut g = Gateway::new(Router::new("tradelayer.rpc", NET, r.transport.clone()));
    let body = json!({"params": [{"address": a.address, "pubkey": a.pubkey, "network": "litecoin.testnet"}]});
    let denied = {
        let mut hooks = ServiceHooks {
            service: &mut r.svc,
        };
        g.handle_generic(
            &AuthContext::anonymous(),
            "tl_watchonly_register",
            &body,
            None,
            &mut hooks,
        )
    };
    assert_eq!(denied.status, 401);
    assert!(r.transport.calls().is_empty());
    r.transport.push_ok(ok_reply("node-1"));
    let ok = {
        let mut hooks = ServiceHooks {
            service: &mut r.svc,
        };
        g.handle_generic(&alice(), "tl_watchonly_register", &body, None, &mut hooks)
    };
    assert_eq!(ok.status, 200);
    assert_eq!(ok.body["data"]["imported"], true);
    // Public reads are cached through observe().
    r.transport.push_ok(json!({"result": {"v": 1}}));
    {
        let mut hooks = ServiceHooks {
            service: &mut r.svc,
        };
        g.handle_generic(&alice(), "tl_getinfo", &json!({}), None, &mut hooks);
    }
    assert!(r
        .svc
        .registry
        .state()
        .trade_layer
        .contains_key("tl_getinfo"));
    // Utxos through the gateway are validated like direct calls.
    r.transport
        .push_ok(utxos_reply(&dec(&a.address), &[(1, 0, "1")], 50, "node-1"));
    let res = {
        let mut hooks = ServiceHooks {
            service: &mut r.svc,
        };
        g.handle_generic(&alice(), "tl_watchonly_utxos", &body, None, &mut hooks)
    };
    assert_eq!(res.status, 200);
    assert_eq!(res.body["data"]["utxos"][0]["amount"], json!(1.0));
    assert_eq!(
        Amount::from_json_coin(&res.body["data"]["utxos"][0]["amount"])
            .unwrap()
            .sat(),
        100_000_000
    );
}
