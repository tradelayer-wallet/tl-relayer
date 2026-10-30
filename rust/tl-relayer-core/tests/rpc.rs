mod common;
use common::*;
use serde_json::{json, Value};
use tl_relayer_core::auth::{AuthContext, Capability};
use tl_relayer_core::fakes::{FakeEncoder, FakeTransport};
use tl_relayer_core::network::Network;
use tl_relayer_core::ports::RawReply;
use tl_relayer_core::rpc::*;
use tl_relayer_core::Error;

fn gw() -> (Gateway<FakeTransport>, FakeTransport) {
    let t = FakeTransport::new();
    (
        Gateway::new(Router::new("tradelayer.rpc", NET, t.clone())),
        t,
    )
}

fn anyone() -> AuthContext {
    user("alice")
}

fn good_addr() -> String {
    p2wpkh(NET, &key(1))
}

#[test]
fn allowlist_is_exactly_the_public_set() {
    let mut seen = std::collections::BTreeSet::new();
    for m in PUBLIC_RPC_METHODS {
        assert!(m.starts_with("tl_") && m == m.to_lowercase(), "{m}");
        assert!(seen.insert(m));
        assert_eq!(PublicMethod::parse(m).unwrap().name(), m);
        assert_eq!(PublicMethod::parse(&m.to_uppercase()).unwrap().name(), m);
    }
    assert_eq!(seen.len(), 25);
    assert_eq!(
        PublicMethod::parse("  TL_getInfo ").unwrap().name(),
        "tl_getinfo"
    );
    for bad in [
        "",
        " ",
        "getblockchaininfo",
        "sendtoaddress",
        "importpubkey",
        "listunspent",
        "rescanblockchain",
        "sendrawtransaction",
        "dumpprivkey",
        "tl_getinfo/../x",
        "tl_getinfo\0",
        "tl_getinfo;",
        "tl_getinfox",
        "stop",
        "tl_createrawtx_opreturn",
    ] {
        assert_eq!(
            PublicMethod::parse(bad),
            Err(Error::RpcForbidden),
            "{bad:?}"
        );
    }
}

#[test]
fn listener_names_map_like_the_legacy_table() {
    assert_eq!(LISTENER_METHODS.len(), 23);
    assert_eq!(
        listener_method("TL_getAllBalancesForAddress"),
        Some("tl_getAllBalancesForAddress")
    );
    assert_eq!(listener_method("tl_decodetransaction"), Some("tl_decodeTx"));
    assert_eq!(listener_method("tl_getsyncstatus"), None);
    assert_eq!(listener_method("getinfo"), None);
    let m = RoutedMethod::Public(PublicMethod::parse("tl_getclearlistbyid").unwrap());
    assert_eq!(m.wire_name(), "tl_getClearlistById");
    let m = RoutedMethod::Public(PublicMethod::parse("tl_getsyncstatus").unwrap());
    assert_eq!(m.wire_name(), "tl_getsyncstatus");
    assert_eq!(
        RoutedMethod::Internal(InternalMethod::SendRawTransaction).wire_name(),
        "sendrawtransaction"
    );
}

#[test]
fn listener_body_and_query_builders() {
    let v = |x: Value| vec![x];
    assert_eq!(
        build_listener_body("tl_getattestations", &[json!("a"), json!(7)]),
        json!({"address": "a", "id": 7})
    );
    assert_eq!(
        build_listener_body("tl_gettransaction", &v(json!("t"))),
        json!({"txid": "t"})
    );
    assert_eq!(
        build_listener_body("tl_getclearlistbyid", &v(json!(4))),
        json!({"id": 4})
    );
    assert_eq!(
        build_listener_body(
            "tl_getchannelcolumn",
            &v(json!({"channel": "c", "myAddr": "m", "cpAddr": "p"}))
        ),
        json!({"channelAddress": "c", "newCommitAddress": "m", "cpAddress": "p"})
    );
    assert_eq!(
        build_listener_body("tl_getchannelcolumn", &[json!("c"), json!("m"), json!("p")]),
        json!({"channelAddress": "c", "newCommitAddress": "m", "cpAddress": "p"})
    );
    assert_eq!(
        build_listener_body(
            "tl_watchonly_utxos",
            &v(json!({"address": "a", "pubKey": "k", "network": "n"}))
        ),
        json!({"address": "a", "pubkey": "k", "network": "n"})
    );
    assert_eq!(
        build_listener_body("tl_getinfo", &[]),
        json!({"params": null})
    );
    assert_eq!(
        build_listener_body("tl_getinfo", &v(json!(3))),
        json!({"params": 3})
    );
    assert_eq!(
        build_listener_body("tl_getinfo", &[json!(1), json!(2)]),
        json!({"params": [1, 2]})
    );
    assert_eq!(
        build_listener_query("tl_contractposition", &[json!("a"), json!(9)]),
        json!({"address": "a", "contractId": 9})
    );
    assert_eq!(
        build_listener_query(
            "tl_getinitmargin",
            &v(json!({"contractId": 2, "price": 1.5}))
        ),
        json!({"contractId": 2, "price": 1.5})
    );
    assert_eq!(
        build_listener_query(
            "tl_getmaxsynth",
            &v(json!({"address": "a", "propertyId": 3}))
        ),
        json!({"address": "a", "propId": 3})
    );
    assert_eq!(
        build_listener_query(
            "tl_tokentradehistoryforaddress",
            &[json!(1), json!(2), json!("a")]
        ),
        json!({"propertyId1": 1, "propertyId2": 2, "address": "a"})
    );
    assert_eq!(build_listener_query("tl_getinfo", &[]), json!({}));
    for m in LISTENER_GET_METHODS {
        assert_ne!(
            build_listener_query(m, &[json!("a"), json!(1), json!("b")]),
            json!({}),
            "{m}"
        );
    }
}

#[test]
fn collator_replies_are_interpreted_like_the_legacy_mapping() {
    let ok = |b: Value| {
        interpret_reply(Ok(RawReply {
            status: 200,
            body: b,
        }))
    };
    assert_eq!(ok(json!({"result": [1]})).unwrap().data, json!([1]));
    assert_eq!(
        ok(json!({"result": null, "data": {"a": 1}})).unwrap().data,
        json!({"a": 1})
    );
    assert_eq!(ok(json!({"foo": 1})).unwrap().data, json!({"foo": 1}));
    assert_eq!(ok(Value::Null).unwrap().data, json!({}));
    let r = ok(json!({"result": 1, "providerNodeId": "  node-1 "})).unwrap();
    assert_eq!(r.provider_node_id.as_deref(), Some("node-1"));
    assert_eq!(
        ok(json!({"result": 1, "providerNodeId": "bad id!"}))
            .unwrap()
            .provider_node_id,
        None
    );
    assert_eq!(
        ok(json!({"ok": false, "error": {"message": "boom"}})),
        Err(RpcFailure::Upstream("boom".into()))
    );
    assert_eq!(
        ok(json!({"ok": false, "error": "plain"})),
        Err(RpcFailure::Upstream("plain".into()))
    );
    assert_eq!(
        ok(json!({"ok": false})),
        Err(RpcFailure::Upstream("Collator RPC failed".into()))
    );
    assert!(matches!(
        ok(json!({"ok": false, "error": "No WebRTC RPC provider for x"})),
        Err(RpcFailure::NoProvider(_))
    ));
    let http = |s: u16, b: Value| interpret_reply(Ok(RawReply { status: s, body: b }));
    assert_eq!(
        http(503, json!({"error": {"message": "down"}})),
        Err(RpcFailure::Upstream("down".into()))
    );
    assert_eq!(
        http(500, json!({})),
        Err(RpcFailure::Upstream(
            "Request failed with status code 500".into()
        ))
    );
    assert!(
        matches!(interpret_reply(Err("timeout".into())), Err(RpcFailure::Upstream(m)) if m == "timeout")
    );
    // Hostile upstream text is clipped and stripped of control characters.
    let long = format!("{}\n\u{7}", "x".repeat(2_000));
    let Err(RpcFailure::Upstream(m)) = ok(json!({"ok": false, "error": long})) else {
        panic!()
    };
    assert_eq!(m.chars().count(), MAX_ERROR_CHARS);
    assert!(!m.contains('\n'));
}

#[test]
fn route_body_carries_the_pinned_service_and_network() {
    let (mut g, t) = gw();
    t.push_ok(json!({"result": {"x": 1}}));
    let r = g.handle_generic(
        &anyone(),
        "tl_getinfo",
        &json!({"params": []}),
        None,
        &mut NoHooks,
    );
    assert_eq!(r.status, 200);
    assert_eq!(r.body, json!({"data": {"x": 1}}));
    let c = t.calls();
    assert_eq!(c.len(), 1);
    assert_eq!(c[0].method, "tl_getInfo");
    let b = route_body(&c[0]);
    assert_eq!(b["service"], "tradelayer.rpc");
    assert_eq!(b["network"], "litecoin.testnet");
    assert_eq!(b["sourceEndpoint"], "testnet-api");
}

#[test]
fn regression_arbitrary_rpc_methods_are_never_forwarded() {
    // Legacy callRpc fell back to rpcClient.call(method, ...) for any method name.
    let (mut g, t) = gw();
    for m in [
        "getblockchaininfo",
        "sendtoaddress",
        "dumpprivkey",
        "importpubkey",
        "listunspent",
        "stop",
        "TL_GETINFO/x",
    ] {
        let r = g.handle_generic(&anyone(), m, &json!({"params": ["x"]}), None, &mut NoHooks);
        assert_eq!(r.status, 403, "{m}");
        assert_eq!(r.body["error"]["code"], "RPC_METHOD_FORBIDDEN");
        let r = g.handle_allocated(&anyone(), "node-1", m, &json!({}), &mut NoHooks);
        assert_eq!(r.status, 403, "{m}");
    }
    assert!(t.calls().is_empty(), "nothing reached the transport");
}

#[test]
fn param_bounds_apply() {
    let (mut g, t) = gw();
    let many: Vec<Value> = (0..17).map(|i| json!(i)).collect();
    let r = g.handle_generic(
        &anyone(),
        "tl_getinfo",
        &json!({"params": many}),
        None,
        &mut NoHooks,
    );
    assert_eq!(
        (r.status, &r.body["error"]["code"]),
        (400, &json!("BAD_RPC_REQUEST"))
    );
    let big = json!({"params": ["x".repeat(20_000)]});
    assert_eq!(
        g.handle_generic(&anyone(), "tl_getinfo", &big, None, &mut NoHooks)
            .status,
        400
    );
    assert!(t.calls().is_empty());
}

#[test]
fn special_cases_validate_and_shape_params() {
    let (mut g, t) = gw();
    let a = good_addr();
    // contract info
    let r = g.handle_generic(
        &anyone(),
        "tl_getcontractinfo",
        &json!({"params": [{"contractId": "x"}]}),
        None,
        &mut NoHooks,
    );
    assert_eq!(
        (r.status, r.body),
        (400, json!({"error": "Invalid contractId"}))
    );
    let r = g.handle_generic(
        &anyone(),
        "tl_getcontractinfo",
        &json!({"params": [{"contractId": null}]}),
        None,
        &mut NoHooks,
    );
    assert_eq!(r.status, 400, "null is not coerced to 0");
    t.push_ok(json!({"result": {"id": 3}}));
    let r = g.handle_generic(
        &anyone(),
        "tl_getcontractinfo",
        &json!({"params": [{"contractId": "3", "evil": 1}]}),
        None,
        &mut NoHooks,
    );
    assert_eq!((r.status, r.body), (200, json!({"id": 3})));
    assert_eq!(t.calls()[0].params, vec![json!({"contractId": 3})]);
    // channel balance: address checked against the network
    let r = g.handle_generic(
        &anyone(),
        "tl_channelbalanceforcommiter",
        &json!({"params": ["nope", 1]}),
        None,
        &mut NoHooks,
    );
    assert_eq!(
        (r.status, r.body),
        (400, json!({"error": "Invalid address or propertyId"}))
    );
    let btc = p2wpkh(Network::BTC_TEST, &key(1));
    assert_eq!(
        g.handle_generic(
            &anyone(),
            "tl_channelbalanceforcommiter",
            &json!({"params": [btc, 1]}),
            None,
            &mut NoHooks
        )
        .status,
        400
    );
    t.push_ok(json!({"result": 12}));
    let r = g.handle_generic(
        &anyone(),
        "tl_channelbalanceforcommiter",
        &json!({"params": [a.to_uppercase(), 1]}),
        None,
        &mut NoHooks,
    );
    assert_eq!((r.status, r.body), (200, json!(12)));
    assert_eq!(t.calls()[1].params, vec![json!(a), json!(1)]);
    // init margin
    for p in [
        json!({"contractId": 1, "price": "x"}),
        json!({"contractId": 1, "price": -1}),
        json!({"contractId": 1.5, "price": 1}),
    ] {
        let r = g.handle_generic(
            &anyone(),
            "tl_getinitmargin",
            &json!({"params": [p]}),
            None,
            &mut NoHooks,
        );
        assert_eq!(r.status, 400);
    }
    // trade history shapes
    let r = g.handle_generic(
        &anyone(),
        "tl_tokentradehistoryforaddress",
        &json!({"params": [1, null, a]}),
        None,
        &mut NoHooks,
    );
    assert_eq!(r.status, 400);
    t.push_ok(json!({"result": []}));
    let r = g.handle_generic(
        &anyone(),
        "tl_tokentradehistoryforaddress",
        &json!({"params": [1, "s-3-4", a]}),
        None,
        &mut NoHooks,
    );
    assert_eq!(r.status, 200);
    // contract history reads the address from params[2] ?? params[1]
    t.push_ok(json!({"result": []}));
    let r = g.handle_generic(
        &anyone(),
        "tl_contracttradehistoryforaddress",
        &json!({"params": [5, a]}),
        None,
        &mut NoHooks,
    );
    assert_eq!(r.status, 200);
    t.push_ok(json!({"result": []}));
    g.handle_generic(
        &anyone(),
        "tl_contracttradehistoryforaddress",
        &json!({"params": [5, "ignored", a]}),
        None,
        &mut NoHooks,
    );
    let calls = t.calls();
    assert_eq!(calls[calls.len() - 1].params, vec![json!(5), json!(a)]);
    // tl_getchannel falls back to the ?address= query parameter
    t.push_ok(json!({"result": {"c": 1}}));
    let r = g.handle_generic(
        &anyone(),
        "tl_getchannel",
        &json!({}),
        Some(&a),
        &mut NoHooks,
    );
    assert_eq!(r.status, 200);
    assert_eq!(
        g.handle_generic(&anyone(), "tl_getchannel", &json!({}), None, &mut NoHooks)
            .status,
        400
    );
    // txid format
    assert_eq!(
        g.handle_generic(
            &anyone(),
            "tl_gettransaction",
            &json!({"params": ["zz"]}),
            None,
            &mut NoHooks
        )
        .status,
        400
    );
}

#[test]
fn upstream_failures_map_to_502_and_503() {
    let (mut g, t) = gw();
    t.push_ok(json!({"ok": false, "error": {"message": "no WebRTC RPC provider available"}}));
    let r = g.handle_generic(&anyone(), "tl_getinfo", &json!({}), None, &mut NoHooks);
    assert_eq!(
        (r.status, &r.body["error"]["code"]),
        (503, &json!("NO_RPC_PROVIDER"))
    );
    t.push_ok(json!({"ok": false, "error": "bad"}));
    let r = g.handle_generic(&anyone(), "tl_getinfo", &json!({}), None, &mut NoHooks);
    assert_eq!(
        (r.status, &r.body["error"]["code"]),
        (502, &json!("RPC_UPSTREAM_ERROR"))
    );
    t.push_err("connect refused");
    let a = good_addr();
    let r = g.handle_generic(
        &anyone(),
        "tl_totaltradehistoryforaddress",
        &json!({"params": [a]}),
        None,
        &mut NoHooks,
    );
    assert_eq!(r.status, 502);
}

#[test]
fn regression_allocated_route_pins_service_network_and_timeout() {
    // Legacy handleAllocatedRpc forwarded client-chosen service, network and timeoutMs.
    let (mut g, t) = gw();
    let body = |b: Value| b;
    let r = g.handle_allocated(
        &anyone(),
        "n1",
        "tl_getinfo",
        &body(json!({"service": "wallet.rpc"})),
        &mut NoHooks,
    );
    assert_eq!(r.status, 400);
    let r = g.handle_allocated(
        &anyone(),
        "n1",
        "tl_getinfo",
        &body(json!({"network": "litecoin.mainnet"})),
        &mut NoHooks,
    );
    assert_eq!(
        (r.status, &r.body["error"]["code"]),
        (400, &json!("NETWORK_MISMATCH"))
    );
    let r = g.handle_allocated(
        &anyone(),
        "n1",
        "tl_getinfo",
        &body(json!({"network": "bogus"})),
        &mut NoHooks,
    );
    assert_eq!(r.status, 400);
    for bad in [json!(0), json!(30_001), json!(-5), json!("5"), json!(1.5)] {
        let r = g.handle_allocated(
            &anyone(),
            "n1",
            "tl_getinfo",
            &body(json!({"timeoutMs": bad})),
            &mut NoHooks,
        );
        assert_eq!(r.status, 400);
    }
    let r = g.handle_allocated(
        &anyone(),
        "bad id!",
        "tl_getinfo",
        &body(json!({})),
        &mut NoHooks,
    );
    assert_eq!(r.status, 400);
    assert!(t.calls().is_empty());

    t.push_ok(json!({"result": {"ok": 1}, "providerNodeId": "node-9"}));
    let r = g.handle_allocated(
        &anyone(),
        "node-1",
        "TL_GETINFO",
        &body(json!({"service": "tradelayer.rpc", "network": "LTCTEST", "timeoutMs": 2500, "params": {"params": [1]}})),
        &mut NoHooks,
    );
    assert_eq!(r.status, 200);
    assert_eq!(
        r.body,
        json!({"data": {"ok": 1}, "providerNodeId": "node-9"})
    );
    let c = &t.calls()[0];
    assert_eq!(c.preferred_provider_node_id.as_deref(), Some("node-1"));
    assert_eq!(c.timeout_ms, Some(2500));
    assert_eq!(c.params, vec![json!(1)]);
    assert_eq!(c.network, NET);
    // body preferredProviderNodeId wins over the path segment
    t.push_ok(json!({"result": 1}));
    g.handle_allocated(
        &anyone(),
        "node-1",
        "tl_getinfo",
        &body(json!({"preferredProviderNodeId": "node-2"})),
        &mut NoHooks,
    );
    assert_eq!(
        t.calls()[1].preferred_provider_node_id.as_deref(),
        Some("node-2")
    );
}

#[test]
fn watchonly_methods_never_bypass_the_service() {
    let (mut g, t) = gw();
    let body = json!({"params": [{"address": good_addr(), "pubkey": pk_hex(&key(1))}]});
    for m in ["tl_watchonly_register", "tl_watchonly_utxos"] {
        let r = g.handle_generic(&anyone(), m, &body, None, &mut NoHooks);
        assert_eq!(r.status, 403, "{m}");
        let r = g.handle_allocated(&anyone(), "n1", m, &body, &mut NoHooks);
        assert_eq!(r.status, 403, "{m}");
    }
    assert!(t.calls().is_empty());
}

#[test]
fn payload_route_only_encodes_public_types() {
    let (g, _) = gw();
    let enc = FakeEncoder;
    let r = g.handle_payload(&json!({"params": {"type": "Attestation", "a": 1}}), &enc);
    assert_eq!(r.status, 200);
    assert!(r.body["payload"]
        .as_str()
        .unwrap()
        .starts_with("enc:attestation:"));
    assert!(g
        .handle_payload(&json!({"params": {"type": "commit_tochannel"}}), &enc)
        .body["payload"]
        .as_str()
        .unwrap()
        .starts_with("enc:commit:"));
    for ty in [
        "tokenissue",
        "send",
        "constructor",
        "__proto__",
        "encodeSend",
    ] {
        let r = g.handle_payload(&json!({"params": {"type": ty}}), &enc);
        assert_eq!(
            (r.status, &r.body["error"]["code"]),
            (403, &json!("PAYLOAD_TYPE_FORBIDDEN")),
            "{ty}"
        );
    }
    assert_eq!(g.handle_payload(&json!({"params": {}}), &enc).status, 400);
    assert_eq!(g.handle_payload(&json!({}), &enc).status, 400);
}

#[test]
fn explicit_routes() {
    let (mut g, t) = gw();
    let a = good_addr();
    let b = p2wpkh(NET, &key(2));
    let c = p2wpkh(NET, &key(3));
    t.push_ok(json!({"result": ["att"]}));
    let r = g.handle_explicit(
        "tl_getAttestations",
        &json!({"address": a, "id": 4}),
        &mut NoHooks,
    );
    assert_eq!((r.status, r.body), (200, json!(["att"])));
    assert_eq!(t.calls()[0].method, "tl_getAttestations");
    assert_eq!(
        g.handle_explicit(
            "tl_getAttestations",
            &json!({"address": a, "id": "4"}),
            &mut NoHooks
        )
        .status,
        400
    );
    assert_eq!(
        g.handle_explicit(
            "tl_getChannelColumn",
            &json!({"channelAddress": a}),
            &mut NoHooks
        )
        .status,
        400
    );
    t.push_ok(json!({"result": {"col": 1}}));
    let r = g.handle_explicit(
        "tl_getChannelColumn",
        &json!({"params": [a, b, c]}),
        &mut NoHooks,
    );
    assert_eq!(r.status, 200);
    assert_eq!(t.calls()[1].params, vec![json!(a), json!(b), json!(c)]);
    t.push_ok(json!({"result": []}));
    assert_eq!(
        g.handle_explicit(
            "tl_listContractSeries",
            &json!({"params": {"contractId": 2}}),
            &mut NoHooks
        )
        .status,
        200
    );
    assert_eq!(
        g.handle_explicit(
            "tl_listContractSeries",
            &json!({"contractId": "2"}),
            &mut NoHooks
        )
        .status,
        400
    );
    assert_eq!(
        g.handle_explicit("tl_dumpprivkey", &json!({}), &mut NoHooks)
            .status,
        404
    );
    t.push_ok(json!({"ok": false, "error": "x"}));
    assert_eq!(
        g.handle_explicit(
            "tl_listContractSeries",
            &json!({"contractId": 2}),
            &mut NoHooks
        )
        .status,
        502
    );
}

#[test]
fn anonymous_and_capabilities_are_enforced_by_hooks() {
    // The gateway itself serves public reads; mutations are authorised by the hooks.
    struct Deny;
    impl GatewayHooks for Deny {
        fn watchonly_register(
            &mut self,
            ctx: &AuthContext,
            _: &[Value],
        ) -> tl_relayer_core::Result<Value> {
            ctx.require(Capability::Register).map(|_| json!(1))
        }
        fn watchonly_utxos(
            &mut self,
            ctx: &AuthContext,
            _: &[Value],
        ) -> tl_relayer_core::Result<Value> {
            ctx.require(Capability::Register).map(|_| json!(2))
        }
        fn observe(&mut self, _: &RpcEvent<'_>) {}
    }
    let (mut g, _) = gw();
    let r = g.handle_generic(
        &AuthContext::anonymous(),
        "tl_watchonly_register",
        &json!({}),
        None,
        &mut Deny,
    );
    assert_eq!(
        (r.status, &r.body["error"]["code"]),
        (401, &json!("UNAUTHORIZED"))
    );
    let r = g.handle_generic(
        &anyone(),
        "tl_watchonly_register",
        &json!({}),
        None,
        &mut Deny,
    );
    assert_eq!((r.status, r.body), (200, json!({"data": 1})));
}
