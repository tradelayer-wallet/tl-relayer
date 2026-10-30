mod common;
use common::*;
use serde_json::json;
use tl_relayer_core::address::*;
use tl_relayer_core::network::Network;
use tl_relayer_core::{Amount, Error};

#[test]
fn network_parse_is_exact() {
    assert_eq!(Network::parse("LTCTEST").unwrap(), Network::LTC_TEST);
    assert_eq!(Network::parse(" ltc ").unwrap(), Network::LTC);
    assert_eq!(
        Network::parse("litecoin.testnet").unwrap(),
        Network::LTC_TEST
    );
    assert_eq!(Network::parse("DOGETEST").unwrap(), Network::DOGE_TEST);
    assert_eq!(Network::parse("bitcoin.mainnet").unwrap(), Network::BTC);
    // Legacy `normalizeNetwork` mapped any unknown "*TEST*" string to LTCTEST.
    for bad in [
        "",
        "TEST",
        "MYTESTNET",
        "LTC-TEST",
        "ltctestnet",
        "regtest",
        "x".repeat(40).as_str(),
    ] {
        assert!(Network::parse(bad).is_err(), "{bad}");
    }
}

#[test]
fn amounts_parse_exactly() {
    let ok = [
        ("0", 0u64),
        ("1", 100_000_000),
        ("0.00001", 1_000),
        ("1e-5", 1_000),
        ("1.5E2", 15_000_000_000),
        ("0.12345678", 12_345_678),
        ("21000000", 2_100_000_000_000_000),
        ("0.10000000", 10_000_000),
        ("000.5", 50_000_000),
    ];
    for (s, sat) in ok {
        assert_eq!(Amount::parse_coin(s).unwrap().sat(), sat, "{s}");
    }
    for bad in [
        "",
        "-1",
        "+1",
        "1.",
        ".",
        "0.123456789",
        "1e",
        "1e-9",
        "abc",
        "1,5",
        " 1",
        "1e400",
        "99999999999999999999999",
    ] {
        assert!(Amount::parse_coin(bad).is_err(), "{bad}");
    }
    // 0.1 + 0.2 as an IEEE double is not an 8-decimal amount: rejected, not rounded.
    assert!(Amount::from_json_coin(&json!(0.1 + 0.2)).is_err());
    assert_eq!(
        Amount::from_json_coin(&json!(0.00001)).unwrap().sat(),
        1_000
    );
    assert_eq!(
        Amount::from_json_coin(&json!("2.5")).unwrap().sat(),
        250_000_000
    );
    assert!(Amount::from_json_coin(&json!(null)).is_err());
    assert_eq!(
        Amount::from_sat(1_234_567_890).to_coin_string(),
        "12.34567890"
    );
    assert!(Amount::from_sat(u64::MAX)
        .checked_add(Amount::from_sat(1))
        .is_err());
    assert!(Amount::from_sat(22_000_000 * 100_000_000)
        .check_money(Network::BTC)
        .is_err());
    assert!(Amount::from_sat(22_000_000 * 100_000_000)
        .check_money(Network::LTC)
        .is_ok());
}

#[test]
fn addresses_decode_per_network() {
    let pk = key(1);
    for net in [
        Network::BTC,
        Network::BTC_TEST,
        Network::LTC,
        Network::LTC_TEST,
    ] {
        let w = p2wpkh(net, &pk);
        let d = decode_address(&w, net).unwrap();
        assert_eq!(d.kind, AddressKind::P2wpkh);
        assert!(d.is_witness());
        let l = p2pkh(net, &pk);
        assert_eq!(decode_address(&l, net).unwrap().kind, AddressKind::P2pkh);
        let n = p2sh_p2wpkh(net, &pk);
        assert_eq!(decode_address(&n, net).unwrap().kind, AddressKind::P2sh);
        let t = p2tr_bip86(net, &pk);
        assert_eq!(decode_address(&t, net).unwrap().kind, AddressKind::P2tr);
    }
    for net in [Network::DOGE, Network::DOGE_TEST] {
        let l = p2pkh(net, &pk);
        assert_eq!(decode_address(&l, net).unwrap().kind, AddressKind::P2pkh);
        assert!(decode_address("tltc1qq", net).is_err());
    }
}

#[test]
fn regression_network_never_inferred_from_prefix() {
    let pk = key(2);
    let ltc_test = p2wpkh(Network::LTC_TEST, &pk);
    let btc_test = p2wpkh(Network::BTC_TEST, &pk);
    // The right network works; the wrong one is a typed mismatch, not a fallback.
    assert!(decode_address(&ltc_test, Network::LTC_TEST).is_ok());
    assert_eq!(
        decode_address(&ltc_test, Network::BTC_TEST),
        Err(Error::AddressOnOtherNetwork("LTCTEST".into()))
    );
    assert_eq!(
        decode_address(&btc_test, Network::LTC_TEST),
        Err(Error::AddressOnOtherNetwork("BTCTEST".into()))
    );
    // Base58 versions: testnet P2PKH is shared by BTCTEST and LTCTEST (0x6f), so the
    // address is valid on both; the caller's explicit network decides.
    let shared = p2pkh(Network::LTC_TEST, &pk);
    assert!(decode_address(&shared, Network::BTC_TEST).is_ok());
    assert!(decode_address(&shared, Network::LTC).is_err());
}

#[test]
fn malformed_addresses_are_rejected() {
    let pk = key(3);
    let good = p2wpkh(NET, &pk);
    let mut bad = vec![
        String::new(),
        " ".to_string() + &good,
        good.clone() + "\n",
        good.to_uppercase() + "x",
        "x".repeat(200),
        good[..good.len() - 1].to_string(),
        "tltc1".to_string(),
        "1BoatSLRHtKNngkdXEeobR76b53LETtpyT".to_string(),
        "ltc1\u{e9}".to_string(),
    ];
    // Flip one character: bad checksum.
    let mut c: Vec<char> = good.chars().collect();
    let last = c.len() - 1;
    c[last] = if c[last] == 'q' { 'p' } else { 'q' };
    bad.push(c.into_iter().collect());
    // Mixed case.
    let mut mixed = good.clone();
    mixed.replace_range(8..9, &good[8..9].to_uppercase());
    bad.push(mixed);
    for b in bad {
        assert!(decode_address(&b, NET).is_err(), "{b:?}");
    }
    // All-uppercase bech32 is valid and canonicalised to lowercase.
    let d = decode_address(&good.to_uppercase(), NET).unwrap();
    assert_eq!(d.text, good);
}

#[test]
fn validate_address_matches_node_shape() {
    let pk = key(4);
    let a = p2wpkh(NET, &pk);
    let v = validate_address(&a, NET);
    assert_eq!(v["isvalid"], true);
    assert_eq!(v["iswitness"], true);
    assert_eq!(v["isscript"], false);
    assert_eq!(v["witness_version"], 0);
    assert_eq!(v["witness_program"].as_str().unwrap().len(), 40);
    assert_eq!(validate_address("nonsense", NET), json!({"isvalid": false}));
    assert_eq!(
        validate_address(&a, Network::BTC),
        json!({"isvalid": false})
    );
}

#[test]
fn pubkey_parsing_and_binding() {
    let pk = key(5);
    let h = pk_hex(&pk);
    assert!(parse_pubkey(&h).is_ok());
    assert_eq!(parse_pubkey(&h.to_uppercase()).unwrap().1, h);
    for bad in [
        "",
        &h[..64],
        &("04".to_string() + &h[2..]),
        &"00".repeat(33),
        &"zz".repeat(33),
        &format!("02{}", "ff".repeat(32)),
    ] {
        assert!(parse_pubkey(bad).is_err(), "{bad}");
    }
    let other = key(6);
    let cases = [
        (p2wpkh(NET, &pk), Binding::Bound),
        (p2pkh(NET, &pk), Binding::Bound),
        (p2sh_p2wpkh(NET, &pk), Binding::Bound),
        (p2tr_bip86(NET, &pk), Binding::Bound),
    ];
    for (a, want) in cases {
        let d = decode_address(&a, NET).unwrap();
        assert_eq!(bind_pubkey(&pk, &d).unwrap(), want, "{a}");
        let mismatch = bind_pubkey(&other, &d);
        if d.kind == AddressKind::P2sh {
            // A bare P2SH may hide any script: unknowable, so not "bound".
            assert_eq!(mismatch, Ok(Binding::Unverifiable), "{a}");
        } else {
            assert_eq!(mismatch, Err(Error::PubkeyAddressMismatch), "{a}");
        }
    }
    let ws = bitcoin::ScriptBuf::from_bytes(vec![0x51]);
    let d = decode_address(&p2wsh(NET, &ws), NET).unwrap();
    assert_eq!(bind_pubkey(&pk, &d).unwrap(), Binding::Unverifiable);
}
