mod common;
use common::*;
use serde_json::json;
use tl_relayer_core::address::hex;
use tl_relayer_core::auth::{AuthContext, Capability};
use tl_relayer_core::fakes::{FakeSeed, ManualClock, MemoryStore};
use tl_relayer_core::network::Network;
use tl_relayer_core::registry::*;
use tl_relayer_core::{Amount, Error};

fn acct(n: u8) -> Account {
    let pk = key(n);
    Account {
        address: p2wpkh(NET, &pk),
        pubkey: pk_hex(&pk),
    }
}

fn reg() -> (Registry<MemoryStore, ManualClock>, MemoryStore, ManualClock) {
    let s = MemoryStore::new();
    let c = ManualClock::new(5_000);
    (registry(s.clone(), c.clone()), s, c)
}

fn provider() -> AuthContext {
    ctx("provider", &[Capability::WriteSnapshot])
}

fn snap(a: &Account, rows: &[(u8, u64)], height: Option<u64>) -> SnapshotInput {
    let d = dec(&a.address);
    SnapshotInput {
        address: a.address.clone(),
        utxos: rows.iter().map(|(n, s)| utxo_for(&d, *n, 0, *s)).collect(),
        scanned_height: height,
        scan_source_node_id: Some("node-1".into()),
        scan_state: None,
        first_funding_height: None,
        first_funding_txid: None,
    }
}

#[test]
fn registration_requires_an_authenticated_capability() {
    let (mut r, _, _) = reg();
    let a = acct(1);
    let o = RegisterOpts::default();
    assert_eq!(r.register(&AuthContext::anonymous(), &a, &o).unwrap_err(), Error::Unauthorized);
    let weak = ctx("bob", &[Capability::ReadAll]);
    assert_eq!(r.register(&weak, &a, &o).unwrap_err(), Error::Forbidden("missing capability"));
    assert!(r.is_empty());
    let out = r.register(&user("alice"), &a, &o).unwrap();
    assert!(out.created);
    assert_eq!(r.len(), 1);
}

#[test]
fn registration_is_idempotent() {
    let (mut r, store, clock) = reg();
    let a = acct(1);
    let u = user("alice");
    let first = RegisterOpts { imported: true, provider_node_id: Some("node-1".into()), ..Default::default() };
    assert!(r.register(&u, &a, &first).unwrap().created);
    let before = r.entry(&a.address).unwrap().clone();
    clock.advance(10);
    let again = r.register(&u, &a, &first).unwrap();
    assert!(!again.created);
    assert_eq!(r.len(), 1);
    let after = r.entry(&a.address).unwrap();
    assert_eq!(after.import_count, 1, "import counted once");
    assert_eq!(after.first_seen_at, before.first_seen_at);
    assert_eq!(after.last_imported_at, before.last_imported_at);
    assert_eq!(after.assigned_provider_node_id.as_deref(), Some("node-1"));
    assert_eq!(after.last_seen_at, before.last_seen_at + 10);
    // A second principal registering the same pair does not take ownership.
    r.register(&user("mallory"), &a, &RegisterOpts::default()).unwrap();
    assert_eq!(r.entry(&a.address).unwrap().owner.as_ref().unwrap().as_str(), "alice");
    assert!(store.saves() >= 2);
}

#[test]
fn regression_victim_address_cannot_be_rebound_to_another_pubkey() {
    // Legacy importWatchOnlyAccount replaced the stored pubkey whenever a later
    // caller supplied a different one (watchonly-registry.service.ts:683-701).
    let (mut r, _, _) = reg();
    let victim = acct(1);
    r.register(&user("alice"), &victim, &RegisterOpts::default()).unwrap();
    let hijack = Account { address: victim.address.clone(), pubkey: pk_hex(&key(2)) };
    let e = r.register(&user("mallory"), &hijack, &RegisterOpts::default()).unwrap_err();
    assert_eq!(e, Error::PubkeyAddressMismatch);
    assert_eq!(r.entry(&victim.address).unwrap().pubkey, victim.pubkey);

    // Even where the key cannot be bound (opt-in unbound kinds) a conflict is an error.
    let store = MemoryStore::new();
    let (mut loose, _) = Registry::open(
        NET,
        Limits::default(),
        Policy { allow_unbound: true, ..Policy::default() },
        store,
        ManualClock::new(1),
    )
    .unwrap();
    let ws = bitcoin::ScriptBuf::from_bytes(vec![0x51]);
    let a1 = Account { address: p2wsh(NET, &ws), pubkey: pk_hex(&key(1)) };
    loose.register(&user("alice"), &a1, &RegisterOpts::default()).unwrap();
    let a2 = Account { address: a1.address.clone(), pubkey: pk_hex(&key(2)) };
    assert_eq!(loose.register(&user("mallory"), &a2, &RegisterOpts::default()).unwrap_err(), Error::PubkeyConflict);
    assert_eq!(loose.entry(&a1.address).unwrap().pubkey, a1.pubkey);
    // Default policy refuses unbindable kinds outright.
    let (mut strict, _, _) = reg();
    assert_eq!(strict.register(&user("a"), &a1, &RegisterOpts::default()).unwrap_err(), Error::PubkeyUnbindable);
}

#[test]
fn regression_unbounded_registrations() {
    let limits = Limits { max_entries: 3, max_entries_per_principal: 2, max_batch: 2, ..Limits::default() };
    let store = MemoryStore::new();
    let (mut r, _) = Registry::open(NET, limits, Policy::default(), store, ManualClock::new(1)).unwrap();
    let alice = user("alice");
    r.register(&alice, &acct(1), &RegisterOpts::default()).unwrap();
    r.register(&alice, &acct(2), &RegisterOpts::default()).unwrap();
    assert!(matches!(
        r.register(&alice, &acct(3), &RegisterOpts::default()),
        Err(Error::TooMany { what: "entries for this principal", max: 2 })
    ));
    r.register(&user("bob"), &acct(3), &RegisterOpts::default()).unwrap();
    assert!(matches!(
        r.register(&user("carol"), &acct(4), &RegisterOpts::default()),
        Err(Error::TooMany { what: "registry entries", max: 3 })
    ));
    assert_eq!(r.len(), 3);
    // Batch size.
    let batch = [acct(5), acct(6), acct(7)];
    assert!(matches!(
        r.register_batch(&user("dave"), &batch, &RegisterOpts::default()),
        Err(Error::TooMany { what: "accounts", max: 2 })
    ));
    // Refreshing an existing entry never needs capacity.
    r.register(&alice, &acct(1), &RegisterOpts::default()).unwrap();
}

#[test]
fn batch_reports_per_account_results_and_dedupes() {
    let (mut r, _, _) = reg();
    let bad = Account { address: "nonsense".into(), pubkey: pk_hex(&key(1)) };
    let empty = Account { address: String::new(), pubkey: String::new() };
    let sum = r
        .register_batch(&user("alice"), &[acct(1), acct(1), bad, empty, acct(2)], &RegisterOpts::default())
        .unwrap();
    assert_eq!((sum.imported, sum.skipped, sum.failed, sum.updated), (2, 1, 2, 2));
    assert_eq!(sum.results.len(), 5);
    assert!(sum.results[2].error.is_some());
    assert_eq!(r.len(), 2);
    let again = r.register_batch(&user("alice"), &[acct(1), acct(2)], &RegisterOpts::default()).unwrap();
    assert_eq!((again.imported, again.refreshed, again.skipped), (0, 2, 2));
}

#[test]
fn regression_persist_failure_is_an_error_and_state_is_unchanged() {
    // Legacy swallowed persist errors ("persist skipped") and kept the in-memory change.
    let (mut r, store, _) = reg();
    r.register(&user("alice"), &acct(1), &RegisterOpts::default()).unwrap();
    let doc_before = store.doc();
    store.set_fail_saves(true);
    let e = r.register(&user("alice"), &acct(2), &RegisterOpts::default()).unwrap_err();
    assert!(matches!(e, Error::Persist(_)));
    assert_eq!(r.len(), 1);
    assert!(r.entry(&acct(2).address).is_none());
    assert_eq!(store.doc(), doc_before);
    store.set_fail_saves(false);
    r.register(&user("alice"), &acct(2), &RegisterOpts::default()).unwrap();
    assert_eq!(r.len(), 2);
}

#[test]
fn restart_reloads_exactly_what_was_saved() {
    let (mut r, store, clock) = reg();
    let a = acct(1);
    r.register(&user("alice"), &a, &RegisterOpts { imported: true, provider_node_id: Some("node-1".into()), ..Default::default() }).unwrap();
    r.record_utxo_snapshot(&provider(), snap(&a, &[(1, 500_000), (2, 250_000)], Some(100))).unwrap();
    r.record_token_snapshot(
        &provider(),
        &a.address,
        vec![TokenBalance {
            property_id: "5".into(),
            ticker: Some("TL".into()),
            amount: "10.5".into(),
            available: "10.5".into(),
            reserved: "0".into(),
            margin: "0".into(),
            vesting: "0".into(),
            channel: "0".into(),
        }],
        Some(100),
        Some("node-1"),
    )
    .unwrap();
    let m = MethodSnapshot {
        updated_at: 1,
        route: Some("/rpc/x".into()),
        address: None,
        provider_node_id: None,
        network: Some("litecoin.testnet".into()),
        source_endpoint: None,
        summary: Some(json!({"k": 1})),
        payload: json!({"a": [1, 2]}),
    };
    assert!(r.record_trade_layer_snapshot(&provider(), "tl_getinfo", m).unwrap());
    let (r2, report) = Registry::open(NET, Limits::default(), Policy::default(), store.clone(), clock).unwrap();
    assert_eq!(report.loaded, 1);
    assert_eq!(report.dropped_invalid, 0);
    assert!(!report.legacy_format);
    assert_eq!(r2.state(), r.state());
    // Wrong network: refuse to mix.
    let other = Registry::open(Network::BTC_TEST, Limits::default(), Policy::default(), store, ManualClock::new(1));
    assert!(matches!(other, Err(Error::NetworkMismatch { .. })));
}

#[test]
fn legacy_files_load_with_validation() {
    let a = acct(1);
    let d = dec(&a.address);
    let stranger = dec(&p2wpkh(NET, &key(9)));
    let legacy = json!({
        "path": "state/watchonly-registry.json",
        "generatedAt": 1,
        "entries": [
            { "address": a.address, "pubkey": a.pubkey, "source": "bootstrap:x", "firstSeenAt": 10,
              "lastSeenAt": 11, "lastImportedAt": 12, "importCount": 1, "scanState": "live",
              "lastSnapshotHeight": 99.0,
              "lastUtxoSnapshot": { "hash": "abc", "count": 1, "totalAmount": 0.5, "updatedAt": 13,
                "scannedHeight": 99,
                "utxos": [{ "id": "x", "txid": txid(1).to_string(), "vout": 0, "amount": 0.5,
                            "confirmations": 4, "scriptPubKey": hex(d.script.as_bytes()) }] },
              "lastTokenSnapshot": { "updatedAt": 14, "balances": [
                { "propertyId": 3, "ticker": "T", "amount": 7, "available": 7, "reserved": 0, "margin": 0, "vesting": 0, "channel": 0 },
                { "propertyId": "", "amount": 1 } ] } },
            { "address": "garbage", "pubkey": a.pubkey },
            { "address": p2wpkh(NET, &key(2)), "pubkey": a.pubkey },
            { "address": a.address },
            { "address": stranger.text, "pubkey": pk_hex(&key(9)),
              "lastUtxoSnapshot": { "utxos": [{ "txid": txid(2).to_string(), "vout": 0, "amount": 1,
                   "scriptPubKey": hex(d.script.as_bytes()) }] } }
        ],
        "tradeLayerState": { "updatedAt": 5, "byMethod": { "TL_GetInfo": { "updatedAt": 5, "payload": {"x": 1} } } }
    });
    let store = MemoryStore::with_doc(&legacy.to_string());
    let (r, rep) = Registry::open(NET, Limits::default(), Policy::default(), store, ManualClock::new(77)).unwrap();
    assert!(rep.legacy_format);
    assert_eq!(rep.loaded, 2);
    assert_eq!(rep.dropped_invalid, 3);
    let e = r.entry(&a.address).unwrap();
    assert!(e.owner.is_none(), "legacy entries are ownerless");
    let s = e.utxo_snapshot.as_ref().unwrap();
    assert_eq!(s.total, Amount::from_sat(50_000_000));
    assert_eq!(e.last_snapshot_height, Some(99));
    assert_eq!(e.token_snapshot.as_ref().unwrap().balances.len(), 1);
    // The entry whose snapshot paid a foreign script keeps the account but drops the snapshot.
    assert!(r.entry(&stranger.text).unwrap().utxo_snapshot.is_none());
    assert!(r.state().trade_layer.contains_key("tl_getinfo"));
    // Oversize and malformed documents are errors, not panics.
    assert!(Registry::open(NET, Limits::default(), Policy::default(), MemoryStore::with_doc("{not json"), ManualClock::new(1)).is_err());
    let empty = MemoryStore::with_doc("  ");
    assert!(Registry::open(NET, Limits::default(), Policy::default(), empty, ManualClock::new(1)).unwrap().0.is_empty());
    let arr = MemoryStore::with_doc(&json!([{"address": a.address, "pubkey": a.pubkey}]).to_string());
    assert_eq!(Registry::open(NET, Limits::default(), Policy::default(), arr, ManualClock::new(1)).unwrap().1.loaded, 1);
}

#[test]
fn regression_snapshot_mutation_needs_authorization_and_proof_of_ownership() {
    // Legacy POST /address/watchonly/snapshot was open: anyone could write any UTXO list
    // for any address, and create entries with arbitrary pubkeys.
    let (mut r, _, _) = reg();
    let a = acct(1);
    r.register(&user("alice"), &a, &RegisterOpts::default()).unwrap();
    let s = snap(&a, &[(1, 500_000)], Some(10));
    assert_eq!(r.record_utxo_snapshot(&AuthContext::anonymous(), s.clone()).unwrap_err(), Error::Unauthorized);
    assert_eq!(r.record_utxo_snapshot(&user("alice"), s.clone()).unwrap_err(), Error::Forbidden("missing capability"));
    assert!(r.entry(&a.address).unwrap().utxo_snapshot.is_none());
    // No implicit entry creation.
    let ghost = acct(2);
    assert_eq!(r.record_utxo_snapshot(&provider(), snap(&ghost, &[(1, 1_000)], Some(1))).unwrap_err(), Error::NotFound);
    assert!(r.entry(&ghost.address).is_none());
    // Outputs must pay the registered address.
    let stranger = dec(&p2wpkh(NET, &key(9)));
    let mut forged = s.clone();
    forged.utxos = vec![utxo_for(&stranger, 1, 0, 9_000_000)];
    assert_eq!(r.record_utxo_snapshot(&provider(), forged).unwrap_err(), Error::ForeignScript);
    r.record_utxo_snapshot(&provider(), s).unwrap();
    assert_eq!(r.entry(&a.address).unwrap().utxo_snapshot.as_ref().unwrap().count, 1);
}

#[test]
fn snapshots_are_monotonic_bounded_and_height_stamped() {
    let limits = Limits { max_utxos: 2, ..Limits::default() };
    let (mut r, _) = Registry::open(NET, limits, Policy::default(), MemoryStore::new(), ManualClock::new(1)).unwrap();
    let a = acct(1);
    r.register(&user("alice"), &a, &RegisterOpts::default()).unwrap();
    let p = provider();
    r.record_utxo_snapshot(&p, snap(&a, &[(1, 5_000)], Some(100))).unwrap();
    // Same height refreshes; older height is rejected; missing height is rejected.
    r.record_utxo_snapshot(&p, snap(&a, &[(1, 5_000), (2, 6_000)], Some(100))).unwrap();
    assert_eq!(
        r.record_utxo_snapshot(&p, snap(&a, &[], Some(99))).unwrap_err(),
        Error::StaleSnapshot { have: 100, got: 99 }
    );
    assert_eq!(
        r.record_utxo_snapshot(&p, snap(&a, &[], None)).unwrap_err(),
        Error::SnapshotUnavailable("missing source block height")
    );
    assert!(matches!(
        r.record_utxo_snapshot(&p, snap(&a, &[(1, 1_000), (2, 1_000), (3, 1_000)], Some(101))),
        Err(Error::TooMany { what: "utxos", max: 2 })
    ));
    assert_eq!(r.record_utxo_snapshot(&p, snap(&a, &[(1, 1_000), (1, 2_000)], Some(101))).unwrap_err(), Error::DuplicateOutpoint);
    let e = r.entry(&a.address).unwrap();
    assert_eq!(e.last_snapshot_height, Some(100));
    assert_eq!(e.utxo_snapshot.as_ref().unwrap().count, 2);
    assert_eq!(e.utxo_snapshot.as_ref().unwrap().total, Amount::from_sat(11_000));
    // Scan source recorded and sanitised.
    let mut bad_src = snap(&a, &[], Some(102));
    bad_src.scan_source_node_id = Some("evil\n<script>".into());
    r.record_utxo_snapshot(&p, bad_src).unwrap();
    assert_eq!(r.entry(&a.address).unwrap().scan_source_node_id.as_deref(), Some("node-1"));
}

#[test]
fn regression_scan_marking_does_not_erase_the_utxo_snapshot() {
    // Legacy markWatchOnlyScanCoverage called recordWatchOnlySnapshot with utxos: [].
    let (mut r, _, _) = reg();
    let a = acct(1);
    r.register(&user("alice"), &a, &RegisterOpts::default()).unwrap();
    r.record_utxo_snapshot(&provider(), snap(&a, &[(1, 5_000)], Some(10))).unwrap();
    r.mark_scan_coverage(&provider(), &a.address, Some(12), Some("node-2"), Some(ScanState::Backfilled)).unwrap();
    let e = r.entry(&a.address).unwrap();
    assert_eq!(e.utxo_snapshot.as_ref().unwrap().count, 1);
    assert_eq!(e.last_scanned_height, Some(12));
    assert_eq!(e.last_snapshot_height, Some(10));
    assert_eq!(e.scan_state, Some(ScanState::Backfilled));
    assert_eq!(e.scan_source_node_id.as_deref(), Some("node-2"));
    assert_eq!(
        r.mark_scan_coverage(&provider(), &a.address, Some(11), None, None).unwrap_err(),
        Error::StaleSnapshot { have: 12, got: 11 }
    );
    assert_eq!(r.mark_scan_coverage(&user("alice"), &a.address, Some(13), None, None).unwrap_err(), Error::Forbidden("missing capability"));
}

#[test]
fn visibility_is_scoped_to_the_owner() {
    // Legacy GET /address/watchonly listed every user's address/pubkey pair to anyone.
    let (mut r, _, _) = reg();
    r.register(&user("alice"), &acct(1), &RegisterOpts::default()).unwrap();
    r.register(&user("bob"), &acct(2), &RegisterOpts::default()).unwrap();
    let alice = user("alice");
    let mine = r.list(&alice, None, None).unwrap();
    assert_eq!(mine.len(), 1);
    assert_eq!(mine[0].address, acct(1).address);
    assert_eq!(r.get(&alice, &acct(2).address).unwrap_err(), Error::NotFound);
    assert!(r.get(&alice, &acct(1).address).is_ok());
    assert_eq!(r.list(&AuthContext::anonymous(), None, None).unwrap_err(), Error::Unauthorized);
    let ops = ctx("ops", &[Capability::ReadAll]);
    assert_eq!(r.list(&ops, None, None).unwrap().len(), 2);
    assert_eq!(r.list(&ops, None, Some(&acct(2).address)).unwrap().len(), 1);
    assert_eq!(r.list(&ops, Some(Network::LTC_TEST), None).unwrap().len(), 2);
    assert!(r.list(&ops, Some(Network::BTC_TEST), None).unwrap().is_empty());
    // Uppercase bech32 resolves to the canonical key.
    assert!(r.get(&ops, &acct(1).address.to_uppercase()).is_ok());
    // Removal: owner or admin only.
    assert_eq!(r.remove(&user("bob"), &acct(1).address).unwrap_err(), Error::NotFound);
    r.remove(&alice, &acct(1).address).unwrap();
    r.remove(&admin(), &acct(2).address).unwrap();
    assert!(r.is_empty());
}

#[test]
fn coverage_matches_legacy_rules() {
    let (mut r, _, _) = reg();
    let a = acct(1);
    r.register(&user("alice"), &a, &RegisterOpts { imported: true, ..Default::default() }).unwrap();
    let c = r.coverage(&a.address, None).unwrap();
    assert!(c.needs_rescan && c.tip_from_registry);
    assert_eq!(c.reason, "scan coverage is stale");
    r.record_utxo_snapshot(&provider(), snap(&a, &[(1, 5_000)], Some(50))).unwrap();
    let c = r.coverage(&a.address, None).unwrap();
    assert!(!c.needs_rescan);
    assert_eq!(c.reason, "scan coverage is current");
    // A real tip beats the registry-derived one (the legacy "tip" was the max recorded height).
    let c = r.coverage(&a.address, Some(60)).unwrap();
    assert!(c.needs_rescan && !c.tip_from_registry);
    assert_eq!(c.current_tip_height, Some(60));
    assert!(r.coverage("nope", None).is_none());
    assert_eq!(rescan_start_height(Some(40), Some(50), None), Some(40));
    assert_eq!(rescan_start_height(None, None, None), None);
}

#[test]
fn bootstrap_is_admin_only_and_takes_accounts_only() {
    let (mut r, _, _) = reg();
    let d = dec(&acct(1).address);
    let seed = json!({"entries": [
        { "address": acct(1).address, "pubkey": acct(1).pubkey,
          "lastUtxoSnapshot": { "utxos": [{ "txid": txid(1).to_string(), "vout": 0, "amount": 99,
              "scriptPubKey": hex(d.script.as_bytes()) }] } },
        { "address": acct(2).address, "pubkey": pk_hex(&key(3)) },
        { "address": acct(3).address, "pubkey": acct(3).pubkey },
    ]});
    let mut src = FakeSeed(Ok(seed));
    assert_eq!(r.bootstrap(&user("alice"), &mut src, false).unwrap_err(), Error::Forbidden("missing capability"));
    let sum = r.bootstrap(&admin(), &mut src, false).unwrap();
    assert_eq!((sum.imported, sum.failed), (2, 1));
    assert!(r.entry(&acct(1).address).unwrap().utxo_snapshot.is_none(), "seed snapshots are ignored");
    assert_eq!(r.entry(&acct(1).address).unwrap().owner.as_ref().unwrap().as_str(), "bootstrap");
    // Non-empty registry: skipped unless forced.
    assert_eq!(r.bootstrap(&admin(), &mut src, false).unwrap().skipped, 2);
    assert_eq!(r.bootstrap(&admin(), &mut src, true).unwrap().refreshed, 2);
    let mut bad = FakeSeed(Err("boom".into()));
    assert!(r.bootstrap(&admin(), &mut bad, true).is_err());
    let mut junk = FakeSeed(Ok(json!({"entries": "no"})));
    assert!(r.bootstrap(&admin(), &mut junk, true).is_err());
}

#[test]
fn trade_layer_cache_is_bounded() {
    let limits = Limits { max_methods: 2, max_payload_bytes: 64, ..Limits::default() };
    let (mut r, _) = Registry::open(NET, limits, Policy::default(), MemoryStore::new(), ManualClock::new(1)).unwrap();
    let mk = |p: serde_json::Value| MethodSnapshot {
        updated_at: 1, route: None, address: None, provider_node_id: None, network: None,
        source_endpoint: None, summary: None, payload: p,
    };
    let p = provider();
    assert!(r.record_trade_layer_snapshot(&p, "tl_a", mk(json!(1))).unwrap());
    assert!(r.record_trade_layer_snapshot(&p, "TL_B", mk(json!(2))).unwrap());
    assert!(matches!(r.record_trade_layer_snapshot(&p, "tl_c", mk(json!(3))), Err(Error::TooMany { .. })));
    // Replacing an existing key is fine; an oversize payload is skipped, not stored.
    assert!(r.record_trade_layer_snapshot(&p, "tl_a", mk(json!(9))).unwrap());
    assert!(!r.record_trade_layer_snapshot(&p, "tl_a", mk(json!("x".repeat(100)))).unwrap());
    assert_eq!(r.state().trade_layer["tl_a"].payload, json!(9));
    assert!(r.state().trade_layer.contains_key("tl_b"));
    assert!(r.record_trade_layer_snapshot(&user("x"), "tl_a", mk(json!(1))).is_err());
}

#[test]
fn node_ids_and_text_are_sanitised() {
    assert_eq!(sanitize_node_id(" node-1:abc/def "), Some("node-1:abc/def".into()));
    for bad in ["", "   ", "a b", "x\ny", "<script>", &"a".repeat(129)] {
        assert_eq!(sanitize_node_id(bad), None, "{bad:?}");
    }
    assert_eq!(clip_text("ab\ncd", 3), "abc");
}
