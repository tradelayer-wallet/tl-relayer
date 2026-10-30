mod common;
use common::*;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use tl_relayer_core::address::hex;
use tl_relayer_core::attestation::*;
use tl_relayer_core::fakes::{FakeExternal, FakeIpIntel, ManualClock};
use tl_relayer_core::sochain::*;
use tl_relayer_core::utxo::{derive_first_funding, snapshot_hash};
use tl_relayer_core::Error;

fn page(d: &tl_relayer_core::address::DecodedAddress, rows: &[(u8, u32, &str)]) -> String {
    json!({"status": "success", "data": {"outputs": rows.iter().map(|(n, v, c)| json!({
        "hash": txid(*n).to_string(), "index": v, "value": c, "block": 3, "confirmations": 7,
        "script": hex(d.script.as_bytes())
    })).collect::<Vec<_>>()}})
    .to_string()
}

#[test]
fn external_snapshot_pages_until_a_short_page() {
    let d = dec(&p2wpkh(NET, &key(1)));
    let ext = FakeExternal::new();
    let full: Vec<(u8, u32, &str)> = (0..10).map(|i| (i + 1, 0, "0.001")).collect();
    ext.set_page(&d.text, 1, 200, &page(&d, &full));
    ext.set_page(&d.text, 2, 200, &page(&d, &[(50, 0, "2")]));
    let s = fetch_external_snapshot(&mut ext.clone(), &d, 42, &ExternalLimits::default()).unwrap();
    assert_eq!(s.count, 11);
    assert_eq!(s.total.sat(), 10 * 100_000 + 200_000_000);
    assert_eq!(s.checked_at, 42);
    assert_eq!(
        ext.requests(),
        vec![(d.text.clone(), 1), (d.text.clone(), 2)]
    );
    // Order-independent hash, identical to the local snapshot hash format.
    let mut rev = s.utxos.clone();
    rev.reverse();
    assert_eq!(snapshot_hash(&rev), s.hash);
    assert_eq!(sochain_code(NET), "LTCTEST");
}

#[test]
fn regression_partial_or_hostile_external_data_is_an_error_not_a_comparison() {
    // Legacy `break`s on any non-success page and compares the partial list as complete.
    let d = dec(&p2wpkh(NET, &key(1)));
    let lim = ExternalLimits::default();
    let full: Vec<(u8, u32, &str)> = (0..10).map(|i| (i + 1, 0, "0.001")).collect();
    let run = |pages: Vec<(u32, u16, String)>, lim: &ExternalLimits| {
        let ext = FakeExternal::new();
        for (p, s, b) in pages {
            ext.set_page(&d.text, p, s, &b);
        }
        fetch_external_snapshot(&mut ext.clone(), &d, 1, lim)
    };
    // Page 2 fails after a full page 1.
    let fail = json!({"status": "fail"}).to_string();
    assert!(run(
        vec![(1, 200, page(&d, &full)), (2, 200, fail.clone())],
        &lim
    )
    .is_err());
    assert!(
        run(vec![(1, 200, page(&d, &full))], &lim).is_err(),
        "missing page"
    );
    assert!(run(vec![(1, 503, page(&d, &[]))], &lim).is_err());
    assert!(run(vec![(1, 200, "<html>".into())], &lim).is_err());
    // Truncated at the page limit.
    let tiny = ExternalLimits {
        max_pages: 1,
        ..lim
    };
    assert_eq!(
        run(vec![(1, 200, page(&d, &full))], &tiny).unwrap_err(),
        Error::ExternalSource("listing truncated at page limit")
    );
    // Byte bound.
    let small = ExternalLimits {
        max_body_bytes: 100,
        ..lim
    };
    assert!(matches!(
        run(vec![(1, 200, page(&d, &full))], &small),
        Err(Error::TooLarge { .. })
    ));
    // UTXO bound and oversized page.
    let few = ExternalLimits {
        max_utxos: 3,
        ..lim
    };
    assert!(matches!(
        run(vec![(1, 200, page(&d, &full))], &few),
        Err(Error::TooMany { .. })
    ));
    let narrow = ExternalLimits {
        page_size: 2,
        ..lim
    };
    assert!(run(vec![(1, 200, page(&d, &full))], &narrow).is_err());
    // Duplicate, zero, malformed and foreign-script outputs.
    assert_eq!(
        run(vec![(1, 200, page(&d, &[(1, 0, "1"), (1, 0, "2")]))], &lim).unwrap_err(),
        Error::DuplicateOutpoint
    );
    assert!(run(vec![(1, 200, page(&d, &[(1, 0, "0")]))], &lim).is_err());
    assert!(run(vec![(1, 200, page(&d, &[(1, 0, "0.123456789")]))], &lim).is_err());
    let stranger = dec(&p2wpkh(NET, &key(9)));
    assert!(run(vec![(1, 200, page(&stranger, &[(1, 0, "1")]))], &lim).is_err());
    let bad_txid = json!({"status": "success", "data": {"outputs": [{"hash": "xyz", "index": 0, "value": "1"}]}}).to_string();
    assert!(run(vec![(1, 200, bad_txid)], &lim).is_err());
    let no_outputs = json!({"status": "success", "data": {}}).to_string();
    assert!(run(vec![(1, 200, no_outputs)], &lim).is_err());
    // An empty address is a valid, complete, empty listing.
    let empty = run(vec![(1, 200, page(&d, &[]))], &lim).unwrap();
    assert_eq!((empty.count, empty.total.sat()), (0, 0));
}

#[test]
fn comparison_verdicts_match_the_legacy_reasons() {
    let d = dec(&p2wpkh(NET, &key(1)));
    let ext = FakeExternal::new();
    ext.set_page(&d.text, 1, 200, &page(&d, &[(1, 0, "1")]));
    let e = fetch_external_snapshot(&mut ext.clone(), &d, 1, &ExternalLimits::default()).unwrap();
    assert_eq!(
        compare_snapshots(None, None).reason,
        "external utxo source unavailable"
    );
    assert!(!compare_snapshots(None, None).needs_rescan);
    assert_eq!(
        compare_snapshots(None, Some(&e)).reason,
        "local snapshot missing"
    );
    let local = tl_relayer_core::registry::UtxoSnapshot {
        hash: e.hash.clone(),
        count: e.count,
        total: e.total,
        updated_at: 1,
        scanned_height: Some(1),
        scan_source_node_id: None,
        utxos: e.utxos.clone(),
    };
    assert!(!compare_snapshots(Some(&local), Some(&e)).needs_rescan);
    let mut drift = local.clone();
    drift.hash = "00".repeat(32);
    assert!(compare_snapshots(Some(&drift), Some(&e)).needs_rescan);
    let mut drift = local;
    drift.count += 1;
    assert_eq!(
        compare_snapshots(Some(&drift), Some(&e)).reason,
        "local snapshot differs from external utxo set"
    );
}

#[test]
fn first_funding_derivation() {
    let rows = vec![
        ("bb".to_string(), 5),
        ("aa".to_string(), 5),
        ("cc".to_string(), 1),
        ("dd".to_string(), 0),
        (" ".to_string(), 9),
    ];
    assert_eq!(
        derive_first_funding(&rows, Some(100)),
        (Some(96), Some("aa".into()))
    );
    assert_eq!(derive_first_funding(&rows, None), (None, None));
    assert_eq!(
        derive_first_funding(&[("x".into(), 500)], Some(100)),
        (Some(0), Some("x".into()))
    );
    assert_eq!(
        derive_first_funding(&[("x".into(), 0)], Some(100)),
        (None, None)
    );
}

// -- attestation --------------------------------------------------------------

fn svc(
    cfg: AttestationConfig,
) -> (
    AttestationService<FakeIpIntel, ManualClock>,
    FakeIpIntel,
    ManualClock,
) {
    let i = FakeIpIntel::new();
    let c = ManualClock::new(1_000);
    (AttestationService::new(cfg, i.clone(), c.clone()), i, c)
}

fn ipinfo(country: &str, vpn: bool, proxy: bool) -> Value {
    json!({"ip": "203.0.113.5", "country": country, "privacy": {"vpn": vpn, "proxy": proxy}})
}

#[test]
fn ip_attestation_decisions() {
    let (mut s, i, _) = svc(AttestationConfig::default());
    i.set_ipinfo(Ok(ipinfo("DE", false, false)));
    let r = s.check_ip("203.0.113.5").unwrap();
    assert!(r.success && !r.is_blocked);
    assert_eq!(
        (r.source, r.country_code.as_deref(), r.message.as_str()),
        ("ipinfo", Some("DE"), "IP is clean and trusted.")
    );
    for (c, vpn, proxy, blocked) in [
        ("US", false, false, true),
        ("KP", false, false, true),
        ("DE", true, false, true),
        ("DE", false, true, true),
        ("FR", false, false, false),
    ] {
        let (mut s, i, _) = svc(AttestationConfig::default());
        i.set_ipinfo(Ok(ipinfo(c, vpn, proxy)));
        assert_eq!(
            s.check_ip("203.0.113.9").unwrap().is_blocked,
            blocked,
            "{c} {vpn} {proxy}"
        );
    }
    // CriminalIP adds darkweb / anonymous VPN and a country fallback.
    let (mut s, i, _) = svc(AttestationConfig::default());
    i.set_ipinfo(Ok(json!({"ip": "203.0.113.5", "privacy": {}})));
    i.set_criminalip(Ok(Some(
        json!({"issues": {"is_darkweb": true}, "whois": {"data": [{"org_country_code": "se"}]}}),
    )));
    let r = s.check_ip("203.0.113.5").unwrap();
    assert_eq!(
        (
            r.source,
            r.country_code.as_deref(),
            r.is_blocked,
            r.is_darkweb
        ),
        ("ipinfo+criminalip", Some("SE"), true, Some(true))
    );
    // Unknown country falls back to ip-api.
    let (mut s, i, _) = svc(AttestationConfig::default());
    i.set_ipinfo(Ok(json!({"ip": "203.0.113.5"})));
    i.set_ip_api(Ok(json!({"status": "success", "countryCode": "RU"})));
    let r = s.check_ip("203.0.113.5").unwrap();
    assert_eq!(
        (r.country_code.as_deref(), r.is_blocked),
        (Some("RU"), true)
    );
    assert!(i.calls().iter().any(|c| c.starts_with("ip-api:")));
    // Junk country values are not trusted as codes.
    assert_eq!(normalize_country(Some(&json!("United States"))), "UNKNOWN");
    assert_eq!(normalize_country(Some(&json!(" us "))), "US");
    assert_eq!(
        country_from_criminalip(&json!({"location": {"country": "gb"}})),
        "GB"
    );
}

#[test]
fn provider_failure_policy_and_cache() {
    let (mut s, i, clock) = svc(AttestationConfig::default());
    let r = s.check_ip("2001:db8::1").unwrap();
    assert!(!r.success && !r.is_blocked && r.source == "unknown");
    let n = i.calls().len();
    s.check_ip("2001:db8::1").unwrap();
    assert_eq!(i.calls().len(), n, "failure result cached");
    clock.advance(61_000);
    s.check_ip("2001:db8::1").unwrap();
    assert!(i.calls().len() > n, "failure cache expired");
    let closed = AttestationConfig {
        failure_policy: FailurePolicy::Closed,
        ..AttestationConfig::default()
    };
    let (mut s, _, _) = svc(closed);
    assert!(s.check_ip("203.0.113.5").unwrap().is_blocked);
    // Success is cached for the full TTL.
    let (mut s, i, clock) = svc(AttestationConfig::default());
    i.set_ipinfo(Ok(ipinfo("DE", false, false)));
    s.check_ip("203.0.113.5").unwrap();
    let n = i.calls().len();
    clock.advance(3_599_000);
    s.check_ip("203.0.113.5").unwrap();
    assert_eq!(i.calls().len(), n);
    clock.advance(2_000);
    s.check_ip("203.0.113.5").unwrap();
    assert!(i.calls().len() > n);
}

#[test]
fn regression_ip_input_is_strict_and_cache_is_bounded() {
    // Legacy interpolated the raw header value into provider URLs and kept an unbounded cache.
    for bad in [
        "",
        "evil.example/../x",
        "1.2.3.4/../../admin",
        "1.2.3.4?token=x",
        "1.2.3.4 5.6.7.8",
        "999.1.1.1",
        "::g",
        &"1".repeat(60),
    ] {
        assert!(normalize_ip(bad).is_err(), "{bad:?}");
    }
    assert_eq!(normalize_ip("::ffff:203.0.113.5").unwrap(), "203.0.113.5");
    assert_eq!(normalize_ip(" 2001:DB8::1 ").unwrap(), "2001:db8::1");
    let (mut s, i, _) = svc(AttestationConfig {
        max_cache_entries: 3,
        ..AttestationConfig::default()
    });
    i.set_ipinfo(Ok(ipinfo("DE", false, false)));
    for n in 0..20 {
        s.check_ip(&format!("198.51.100.{n}")).unwrap();
        assert!(s.cache_len() <= 3);
    }
    assert!(s.check_ip("not-an-ip").is_err());
    assert!(!i.calls().iter().any(|c| c.contains("not-an-ip")));
}

#[test]
fn client_ip_trust_is_explicit() {
    let h = |pairs: &[(&str, &str)]| {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect::<BTreeMap<_, _>>()
    };
    let spoof = h(&[
        ("cf-connecting-ip", "8.8.8.8"),
        ("x-real-ip", "8.8.4.4"),
        ("x-forwarded-for", "9.9.9.9, 10.0.0.1"),
    ]);
    // Untrusted: headers are ignored, the socket peer is used.
    let p = ClientIpPolicy::default();
    assert_eq!(
        client_ip(&p, "192.0.2.10", &spoof, Some("1.1.1.1")).as_deref(),
        Some("192.0.2.10")
    );
    // Trusted proxy: cf, then x-real-ip, then the right-most XFF entry (one trusted hop).
    let t = ClientIpPolicy {
        trust_proxy_headers: true,
        ..p
    };
    assert_eq!(
        client_ip(&t, "10.0.0.1", &spoof, None).as_deref(),
        Some("8.8.8.8")
    );
    let xr = h(&[("x-real-ip", "8.8.4.4")]);
    assert_eq!(
        client_ip(&t, "10.0.0.1", &xr, None).as_deref(),
        Some("8.8.4.4")
    );
    let xff = h(&[("x-forwarded-for", "6.6.6.6, 9.9.9.9")]);
    assert_eq!(
        client_ip(&t, "10.0.0.1", &xff, None).as_deref(),
        Some("9.9.9.9")
    );
    let two = ClientIpPolicy {
        xff_trusted_hops: 2,
        ..t
    };
    assert_eq!(
        client_ip(&two, "10.0.0.1", &xff, None).as_deref(),
        Some("6.6.6.6")
    );
    assert_eq!(
        client_ip(
            &two,
            "10.0.0.1",
            &h(&[("x-forwarded-for", "9.9.9.9")]),
            None
        )
        .as_deref(),
        Some("10.0.0.1")
    );
    // Garbage headers fall through to the peer.
    let junk = h(&[("cf-connecting-ip", "evil"), ("x-forwarded-for", "../x")]);
    assert_eq!(
        client_ip(&t, "10.0.0.1", &junk, None).as_deref(),
        Some("10.0.0.1")
    );
    // Body override only when enabled.
    let o = ClientIpPolicy {
        allow_body_override: true,
        ..p
    };
    assert_eq!(
        client_ip(&o, "10.0.0.1", &spoof, Some("1.1.1.1")).as_deref(),
        Some("1.1.1.1")
    );
    assert_eq!(
        client_ip(&o, "10.0.0.1", &spoof, Some("bad")).as_deref(),
        Some("10.0.0.1")
    );
    assert_eq!(client_ip(&p, "garbage", &spoof, None), None);
}
