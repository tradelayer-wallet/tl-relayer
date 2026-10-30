//! Routed RPC: method allowlist, parameter validation and response mapping.
//!
//! Port of `routes/rpc.route.ts` plus the routing half of `address.service.ts`
//! (`callRpc`, `callAllocatedRpc`, listener-name mapping). The central rule is
//! type-level: a request can only be forwarded for a [`PublicMethod`] (parsed
//! against [`PUBLIC_RPC_METHODS`]) or an [`InternalMethod`] (constructed only by
//! this crate's services), so an arbitrary client-chosen method never reaches a
//! provider. The legacy fallback `rpcClient.call(method, ...)` forwarded any
//! method name when no collator was configured.

use crate::address::decode_address;
use crate::auth::AuthContext;
use crate::error::{Error, Result};
use crate::network::Network;
use crate::ports::{PayloadEncoder, RawReply, RoutedRequest, RpcTransport};
use crate::registry::{clip_text, sanitize_node_id};
use serde_json::{json, Map, Value};

/// `PUBLIC_RPC_METHODS` of `rpc.route.ts:6-32`, in source order.
pub const PUBLIC_RPC_METHODS: [&str; 25] = [
    "tl_getstatesnapshot",
    "tl_watchonly_register",
    "tl_watchonly_utxos",
    "tl_getsyncstatus",
    "tl_getallbalancesforaddress",
    "tl_getchannel",
    "tl_getchannelcolumn",
    "tl_getcontractinfo",
    "tl_getattestations",
    "tl_gettransaction",
    "tl_getclearlistbyid",
    "tl_listcontractseries",
    "tl_getinitmargin",
    "tl_channelbalanceforcommiter",
    "tl_getmaxsynth",
    "tl_contractposition",
    "tl_tokentradehistoryforaddress",
    "tl_contracttradehistoryforaddress",
    "tl_totaltradehistoryforaddress",
    "tl_getinfo",
    "tl_getbalance",
    "tl_getproperty",
    "tl_listproperties",
    "tl_createpayload_attestation",
    "tl_createpayload_commit_tochannel",
];

/// `TRADELAYER_LISTENER_METHODS` of `address.service.ts:60-84`: lowercase RPC
/// name to the listener/collator spelling.
pub const LISTENER_METHODS: [(&str, &str); 23] = [
    ("tl_getallbalancesforaddress", "tl_getAllBalancesForAddress"),
    ("tl_getstatesnapshot", "tl_getStateSnapshot"),
    ("tl_watchonly_register", "tl_watchonly_register"),
    ("tl_watchonly_utxos", "tl_watchonly_utxos"),
    ("tl_listproperties", "tl_listProperties"),
    ("tl_getproperty", "tl_getProperty"),
    ("tl_getbalance", "tl_getBalance"),
    ("tl_getinfo", "tl_getInfo"),
    ("tl_getchannel", "tl_getChannel"),
    ("tl_createrawtx_opreturn", "tl_createrawtx_opreturn"),
    ("tl_createrawtx_reference", "tl_createrawtx_reference"),
    ("tl_decodetransaction", "tl_decodeTx"),
    ("tl_getcontractinfo", "tl_getContractInfo"),
    (
        "tl_channelbalanceforcommiter",
        "tl_channelBalanceForCommiter",
    ),
    ("tl_getinitmargin", "tl_getInitMargin"),
    (
        "tl_tokentradehistoryforaddress",
        "tl_tokenTradeHistoryForAddress",
    ),
    (
        "tl_contracttradehistoryforaddress",
        "tl_contractTradeHistoryForAddress",
    ),
    (
        "tl_totaltradehistoryforaddress",
        "tl_totalTradeHistoryForAddress",
    ),
    ("tl_listcontractseries", "tl_listContractSeries"),
    ("tl_getattestations", "tl_getAttestations"),
    ("tl_getchannelcolumn", "tl_getChannelColumn"),
    ("tl_gettransaction", "tl_getTransaction"),
    ("tl_getclearlistbyid", "tl_getClearlistById"),
];

/// `TRADELAYER_LISTENER_GET_METHODS` (`address.service.ts:133-142`).
pub const LISTENER_GET_METHODS: [&str; 8] = [
    "tl_contractposition",
    "tl_channelbalanceforcommiter",
    "tl_getinitmargin",
    "tl_getcontractinfo",
    "tl_getmaxsynth",
    "tl_tokentradehistoryforaddress",
    "tl_contracttradehistoryforaddress",
    "tl_totaltradehistoryforaddress",
];

pub const MAX_PARAMS: usize = 16;
pub const MAX_PARAMS_BYTES: usize = 16 * 1024;
pub const MAX_TIMEOUT_MS: u64 = 30_000;
pub const MAX_ERROR_CHARS: usize = 512;

/// `normalizeRpcMethod`: `String(method || '').trim().toLowerCase()`.
pub fn normalize_method(m: &str) -> String {
    m.trim().to_lowercase()
}

pub fn listener_method(method: &str) -> Option<&'static str> {
    let n = normalize_method(method);
    LISTENER_METHODS
        .iter()
        .find(|(k, _)| *k == n)
        .map(|(_, v)| *v)
}

/// A method the public mesh may call.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PublicMethod(&'static str);

impl PublicMethod {
    pub fn parse(raw: &str) -> Result<PublicMethod> {
        let n = normalize_method(raw);
        PUBLIC_RPC_METHODS
            .iter()
            .find(|m| **m == n)
            .map(|m| PublicMethod(m))
            .ok_or(Error::RpcForbidden)
    }

    pub fn name(&self) -> &'static str {
        self.0
    }
}

/// Methods only this crate's services may invoke (never client-selectable).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InternalMethod {
    RescanBlockchain,
    SendToAddress,
    SendRawTransaction,
}

impl InternalMethod {
    pub fn name(&self) -> &'static str {
        match self {
            InternalMethod::RescanBlockchain => "rescanblockchain",
            InternalMethod::SendToAddress => "sendtoaddress",
            InternalMethod::SendRawTransaction => "sendrawtransaction",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RoutedMethod {
    Public(PublicMethod),
    Internal(InternalMethod),
}

impl RoutedMethod {
    fn name(&self) -> &'static str {
        match self {
            RoutedMethod::Public(p) => p.name(),
            RoutedMethod::Internal(i) => i.name(),
        }
    }

    /// The spelling put on the wire.
    pub fn wire_name(&self) -> &'static str {
        listener_method(self.name()).unwrap_or_else(|| self.name())
    }
}

/// Result of a routed call: payload and the (sanitised) provider id.
#[derive(Debug, Clone, PartialEq)]
pub struct RoutedOk {
    pub data: Value,
    pub provider_node_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RpcFailure {
    /// `no WebRTC RPC provider` (HTTP 503 `NO_RPC_PROVIDER`).
    NoProvider(String),
    /// Anything else the upstream reported (HTTP 502 `RPC_UPSTREAM_ERROR`).
    Upstream(String),
}

impl RpcFailure {
    pub fn message(&self) -> &str {
        match self {
            RpcFailure::NoProvider(m) | RpcFailure::Upstream(m) => m,
        }
    }
}

fn classify(msg: String) -> RpcFailure {
    if msg.to_ascii_lowercase().contains("no webrtc rpc provider") {
        RpcFailure::NoProvider(msg)
    } else {
        RpcFailure::Upstream(msg)
    }
}

fn clean(msg: &str) -> String {
    let c = clip_text(msg, MAX_ERROR_CHARS);
    if c.is_empty() {
        "Collator RPC failed".to_string()
    } else {
        c
    }
}

fn error_message_of(body: &Value) -> Option<String> {
    let e = body.get("error")?;
    e.get("message")
        .and_then(Value::as_str)
        .or_else(|| e.as_str())
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// Port of the response handling in `callAllocatedRpc` / `callRpc`
/// (`address.service.ts:356-391`): HTTP failures and `{ok:false}` bodies become
/// errors; success data is `result ?? data ?? payload`.
pub fn interpret_reply(
    r: std::result::Result<RawReply, String>,
) -> std::result::Result<RoutedOk, RpcFailure> {
    let reply = match r {
        Ok(r) => r,
        Err(m) => return Err(classify(clean(&m))),
    };
    if !(200..300).contains(&reply.status) {
        let m = error_message_of(&reply.body)
            .unwrap_or_else(|| format!("Request failed with status code {}", reply.status));
        return Err(classify(clean(&m)));
    }
    let payload = if reply.body.is_null() || reply.body == json!(false) || reply.body == json!(0) {
        json!({})
    } else {
        reply.body
    };
    if payload.get("ok") == Some(&Value::Bool(false)) {
        let m = error_message_of(&payload).unwrap_or_else(|| "Collator RPC failed".into());
        return Err(classify(clean(&m)));
    }
    let non_null = |k: &str| payload.get(k).filter(|v| !v.is_null()).cloned();
    let data = non_null("result")
        .or_else(|| non_null("data"))
        .unwrap_or_else(|| payload.clone());
    let provider = payload
        .get("providerNodeId")
        .and_then(Value::as_str)
        .and_then(sanitize_node_id);
    Ok(RoutedOk {
        data,
        provider_node_id: provider,
    })
}

#[derive(Debug, Clone, Default)]
pub struct CallOpts {
    pub preferred_provider_node_id: Option<String>,
    pub timeout_ms: Option<u64>,
}

/// Collator router with the service and network pinned by configuration.
pub struct Router<T: RpcTransport> {
    pub service: String,
    pub network: Network,
    pub transport: T,
}

impl<T: RpcTransport> Router<T> {
    pub fn new(service: &str, network: Network, transport: T) -> Self {
        Router {
            service: service.to_string(),
            network,
            transport,
        }
    }

    pub fn call(
        &mut self,
        method: RoutedMethod,
        params: Vec<Value>,
        opts: &CallOpts,
    ) -> std::result::Result<RoutedOk, RpcFailure> {
        let req = RoutedRequest {
            service: self.service.clone(),
            network: self.network,
            method: method.wire_name().to_string(),
            params,
            timeout_ms: opts.timeout_ms.map(|t| t.min(MAX_TIMEOUT_MS)),
            preferred_provider_node_id: opts
                .preferred_provider_node_id
                .as_deref()
                .and_then(sanitize_node_id),
            source_endpoint: "testnet-api",
        };
        interpret_reply(self.transport.route(&req))
    }
}

/// JSON body of the collator `/rpc/route` request.
pub fn route_body(req: &RoutedRequest) -> Value {
    let mut m = Map::new();
    m.insert("service".into(), req.service.clone().into());
    m.insert("network".into(), req.network.collator_name().into());
    m.insert("method".into(), req.method.clone().into());
    m.insert("params".into(), Value::Array(req.params.clone()));
    if let Some(t) = req.timeout_ms {
        m.insert("timeoutMs".into(), t.into());
    }
    if let Some(p) = &req.preferred_provider_node_id {
        m.insert("preferredProviderNodeId".into(), p.clone().into());
    }
    m.insert("sourceEndpoint".into(), req.source_endpoint.into());
    Value::Object(m)
}

// ---------------------------------------------------------------------------
// Listener-mode request builders (pure ports; the HTTP adapter is external)
// ---------------------------------------------------------------------------

fn obj(v: Option<&Value>) -> Option<&Map<String, Value>> {
    v.and_then(Value::as_object)
}

fn truthy(v: Option<&Value>) -> Option<&Value> {
    v.filter(|x| match x {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Value::String(s) => !s.is_empty(),
        _ => true,
    })
}

fn or_chain(candidates: &[Option<&Value>]) -> Value {
    for c in candidates {
        if let Some(v) = truthy(*c) {
            return v.clone();
        }
    }
    candidates
        .last()
        .copied()
        .flatten()
        .cloned()
        .unwrap_or(Value::Null)
}

/// Port of `buildListenerBody` (`address.service.ts:91-131`). `Null` stands for
/// JavaScript `undefined`.
pub fn build_listener_body(method: &str, params: &[Value]) -> Value {
    let m = normalize_method(method);
    let first = params.first();
    let p = |i: usize| params.get(i).cloned().unwrap_or(Value::Null);
    match m.as_str() {
        "tl_getattestations" => json!({"address": p(0), "id": p(1)}),
        "tl_getchannelcolumn" => {
            let body = obj(first);
            let g = |k: &str| body.and_then(|b| b.get(k));
            json!({
                "channelAddress": or_chain(&[g("channelAddress"), g("channel"), params.first()]),
                "newCommitAddress": or_chain(&[g("newCommitAddress"), g("myAddress"), g("myAddr"), g("buyerAddress"), params.get(1)]),
                "cpAddress": or_chain(&[g("cpAddress"), g("cpAddr"), params.get(2)]),
            })
        }
        "tl_gettransaction" => json!({"txid": p(0)}),
        "tl_getclearlistbyid" => json!({"id": p(0)}),
        "tl_watchonly_register" | "tl_watchonly_utxos" => {
            let acct = obj(first);
            let g = |k: &str| acct.and_then(|b| b.get(k));
            json!({
                "address": g("address").cloned().unwrap_or(Value::Null),
                "pubkey": or_chain(&[g("pubkey"), g("pubKey")]),
                "network": g("network").cloned().unwrap_or(Value::Null),
            })
        }
        _ => {
            let v = if params.len() <= 1 {
                p(0)
            } else {
                Value::Array(params.to_vec())
            };
            json!({ "params": v })
        }
    }
}

/// Port of `buildListenerQuery` (`address.service.ts:144-203`).
pub fn build_listener_query(method: &str, params: &[Value]) -> Value {
    let m = normalize_method(method);
    let body = obj(params.first());
    let b = |k: &str| body.and_then(|x| x.get(k)).filter(|v| !v.is_null());
    let p = |i: usize| params.get(i).cloned().unwrap_or(Value::Null);
    let nn = |a: Option<&Value>, i: usize| a.cloned().unwrap_or_else(|| p(i));
    match m.as_str() {
        "tl_contractposition" => json!({"address": nn(b("address"), 0), "contractId": p(1)}),
        "tl_channelbalanceforcommiter" => json!({"address": p(0), "propertyId": p(1)}),
        "tl_getinitmargin" => {
            json!({"contractId": nn(b("contractId"), 0), "price": nn(b("price"), 1)})
        }
        "tl_getcontractinfo" => json!({"contractId": nn(b("contractId"), 0)}),
        "tl_getmaxsynth" => json!({
            "address": nn(b("address"), 0),
            "propId": nn(b("propId").or(b("propertyId")), 1),
        }),
        "tl_tokentradehistoryforaddress" => {
            json!({"propertyId1": p(0), "propertyId2": p(1), "address": p(2)})
        }
        "tl_contracttradehistoryforaddress" => json!({"contractId": p(0), "address": p(1)}),
        "tl_totaltradehistoryforaddress" => json!({"address": p(0)}),
        _ => json!({}),
    }
}

// ---------------------------------------------------------------------------
// Gateway
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
pub struct GatewayReply {
    pub status: u16,
    pub body: Value,
}

fn coded(status: u16, code: &str, msg: &str) -> GatewayReply {
    GatewayReply {
        status,
        body: json!({"error": {"code": code, "message": msg}}),
    }
}

fn plain(status: u16, msg: &str) -> GatewayReply {
    GatewayReply {
        status,
        body: json!({"error": msg}),
    }
}

fn failure(f: &RpcFailure) -> GatewayReply {
    match f {
        RpcFailure::NoProvider(m) => coded(503, "NO_RPC_PROVIDER", m),
        RpcFailure::Upstream(m) => coded(502, "RPC_UPSTREAM_ERROR", m),
    }
}

/// An observed successful TradeLayer call (for the state cache).
#[derive(Debug, Clone)]
pub struct RpcEvent<'a> {
    pub method: &'static str,
    pub route: String,
    pub address: Option<String>,
    pub provider_node_id: Option<&'a str>,
    pub summary: Value,
    pub payload: &'a Value,
}

/// Services the gateway delegates to. The two `tl_watchonly_*` methods are in
/// the public allowlist but must go through registry validation and
/// authorization instead of being forwarded blindly.
pub trait GatewayHooks {
    fn watchonly_register(&mut self, ctx: &AuthContext, params: &[Value]) -> Result<Value>;
    fn watchonly_utxos(&mut self, ctx: &AuthContext, params: &[Value]) -> Result<Value>;
    fn observe(&mut self, ev: &RpcEvent<'_>);
}

/// Hooks that refuse the watch-only methods and ignore events.
pub struct NoHooks;

impl GatewayHooks for NoHooks {
    fn watchonly_register(&mut self, _: &AuthContext, _: &[Value]) -> Result<Value> {
        Err(Error::Forbidden("watch-only registration not wired"))
    }
    fn watchonly_utxos(&mut self, _: &AuthContext, _: &[Value]) -> Result<Value> {
        Err(Error::Forbidden("watch-only utxos not wired"))
    }
    fn observe(&mut self, _: &RpcEvent<'_>) {}
}

fn hook_error(e: &Error) -> GatewayReply {
    match e {
        Error::Unauthorized => coded(401, "UNAUTHORIZED", "authentication required"),
        Error::Forbidden(_) => coded(403, "FORBIDDEN", &e.to_string()),
        Error::Upstream(m) => coded(502, "RPC_UPSTREAM_ERROR", &clean(m)),
        Error::NoProvider(m) => coded(503, "NO_RPC_PROVIDER", &clean(m)),
        _ => coded(400, "BAD_RPC_REQUEST", &e.to_string()),
    }
}

pub struct Gateway<T: RpcTransport> {
    pub router: Router<T>,
}

fn int_arg(v: Option<&Value>) -> Option<i64> {
    match v? {
        Value::Number(n) => n.as_i64().filter(|x| *x >= 0),
        Value::String(s)
            if !s.is_empty() && s.len() <= 18 && s.bytes().all(|b| b.is_ascii_digit()) =>
        {
            s.parse().ok()
        }
        _ => None,
    }
}

fn prop_arg(v: Option<&Value>) -> Option<Value> {
    match v? {
        Value::Number(n) => n.as_i64().filter(|x| *x >= 0).map(Value::from),
        Value::String(s) => {
            let ok = !s.is_empty()
                && s.len() <= 40
                && (s.bytes().all(|b| b.is_ascii_digit()) || is_synthetic_id(s));
            ok.then(|| Value::String(s.clone()))
        }
        _ => None,
    }
}

fn is_synthetic_id(s: &str) -> bool {
    let mut it = s.split('-');
    it.next() == Some("s")
        && it.clone().count() == 2
        && it.all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()))
}

impl<T: RpcTransport> Gateway<T> {
    pub fn new(router: Router<T>) -> Self {
        Gateway { router }
    }

    fn addr_arg(&self, v: Option<&Value>) -> Option<String> {
        let s = v?.as_str()?;
        decode_address(s.trim(), self.router.network)
            .ok()
            .map(|d| d.text)
    }

    fn bound_params(body: &Value) -> std::result::Result<Vec<Value>, GatewayReply> {
        let params = body
            .get("params")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        if params.len() > MAX_PARAMS
            || Value::Array(params.clone()).to_string().len() > MAX_PARAMS_BYTES
        {
            return Err(coded(
                400,
                "BAD_RPC_REQUEST",
                "Too many or too large params",
            ));
        }
        Ok(params)
    }

    /// `POST /rpc/:method` (`handleGenericRpc`).
    pub fn handle_generic(
        &mut self,
        ctx: &AuthContext,
        method: &str,
        body: &Value,
        query_address: Option<&str>,
        hooks: &mut dyn GatewayHooks,
    ) -> GatewayReply {
        let pm = match PublicMethod::parse(method) {
            Ok(m) => m,
            Err(_) => {
                return coded(
                    403,
                    "RPC_METHOD_FORBIDDEN",
                    "RPC method is not available on the public mesh",
                )
            }
        };
        let mut params = match Self::bound_params(body) {
            Ok(p) => p,
            Err(r) => return r,
        };
        let name = pm.name();
        if name == "tl_getchannel" && params.is_empty() {
            if let Some(a) = query_address.map(str::trim).filter(|a| !a.is_empty()) {
                params = vec![Value::String(a.to_string())];
            }
        }
        match name {
            "tl_watchonly_register" => {
                return match hooks.watchonly_register(ctx, &params) {
                    Ok(v) => GatewayReply {
                        status: 200,
                        body: json!({"data": v}),
                    },
                    Err(e) => hook_error(&e),
                }
            }
            "tl_watchonly_utxos" => {
                return match hooks.watchonly_utxos(ctx, &params) {
                    Ok(v) => GatewayReply {
                        status: 200,
                        body: json!({"data": v}),
                    },
                    Err(e) => hook_error(&e),
                }
            }
            _ => {}
        }

        let raw = params.first();
        // Per-method validation and canonical parameter shaping.
        let (call_params, address, summary): (Vec<Value>, Option<String>, Value) = match name {
            "tl_getcontractinfo" => {
                let Some(cid) = int_arg(raw.and_then(|r| r.get("contractId"))) else {
                    return plain(400, "Invalid contractId");
                };
                (
                    vec![json!({"contractId": cid})],
                    None,
                    json!({"contractId": cid}),
                )
            }
            "tl_channelbalanceforcommiter" => {
                let (Some(a), Some(pid)) = (self.addr_arg(params.first()), int_arg(params.get(1)))
                else {
                    return plain(400, "Invalid address or propertyId");
                };
                (
                    vec![json!(a), json!(pid)],
                    Some(a),
                    json!({"propertyId": pid}),
                )
            }
            "tl_getinitmargin" => {
                let cid = int_arg(raw.and_then(|r| r.get("contractId")));
                let price = raw
                    .and_then(|r| r.get("price"))
                    .and_then(Value::as_f64)
                    .filter(|p| p.is_finite() && *p >= 0.0);
                let (Some(cid), Some(price)) = (cid, price) else {
                    return plain(400, "Invalid contractId or price");
                };
                (
                    vec![json!({"contractId": cid, "price": price})],
                    None,
                    json!({"contractId": cid, "price": price}),
                )
            }
            "tl_tokentradehistoryforaddress" => {
                let (Some(p1), Some(p2), Some(a)) = (
                    prop_arg(params.first()),
                    prop_arg(params.get(1)),
                    self.addr_arg(params.get(2)),
                ) else {
                    return plain(400, "Invalid propertyId1, propertyId2, or address");
                };
                (
                    vec![p1.clone(), p2.clone(), json!(a)],
                    Some(a),
                    json!({"propertyId1": p1, "propertyId2": p2}),
                )
            }
            "tl_contracttradehistoryforaddress" => {
                // Legacy reads the address from params[2] ?? params[1].
                let addr_v = params.get(2).filter(|v| !v.is_null()).or(params.get(1));
                let (Some(cid), Some(a)) = (int_arg(params.first()), self.addr_arg(addr_v)) else {
                    return plain(400, "Invalid contractId or address");
                };
                (
                    vec![json!(cid), json!(a)],
                    Some(a),
                    json!({"contractId": cid}),
                )
            }
            "tl_totaltradehistoryforaddress" => {
                let Some(a) = self.addr_arg(params.first()) else {
                    return plain(400, "Invalid address");
                };
                (vec![json!(a)], Some(a), json!({}))
            }
            "tl_getallbalancesforaddress" | "tl_getchannel" => {
                let Some(a) = self.addr_arg(params.first()) else {
                    return plain(400, "Invalid address");
                };
                (vec![json!(a)], Some(a), json!({"paramsCount": 1}))
            }
            "tl_gettransaction" => {
                let ok = params
                    .first()
                    .and_then(Value::as_str)
                    .is_some_and(|t| crate::utxo::parse_txid(t).is_ok());
                if !ok || params.len() != 1 {
                    return plain(400, "Invalid txid");
                }
                (params.clone(), None, json!({"paramsCount": 1}))
            }
            "tl_getproperty" | "tl_getclearlistbyid" => {
                let Some(id) = int_arg(params.first()) else {
                    return plain(400, "Invalid id");
                };
                (vec![json!(id)], None, json!({"paramsCount": 1}))
            }
            "tl_listproperties" | "tl_getsyncstatus" | "tl_getinfo" => {
                if !params.is_empty() {
                    return plain(400, "Unexpected params");
                }
                (Vec::new(), None, json!({"paramsCount": 0}))
            }
            _ => {
                let address = params
                    .first()
                    .and_then(Value::as_str)
                    .and_then(|s| decode_address(s.trim(), self.router.network).ok())
                    .map(|d| d.text);
                let n = params.len();
                (params.clone(), address, json!({"paramsCount": n}))
            }
        };

        let routed = RoutedMethod::Public(pm);
        match self.router.call(routed, call_params, &CallOpts::default()) {
            Err(f) => failure(&f),
            Ok(ok) => {
                hooks.observe(&RpcEvent {
                    method: name,
                    route: format!("/rpc/{name}"),
                    address,
                    provider_node_id: ok.provider_node_id.as_deref(),
                    summary,
                    payload: &ok.data,
                });
                let special = matches!(
                    name,
                    "tl_getcontractinfo"
                        | "tl_channelbalanceforcommiter"
                        | "tl_getinitmargin"
                        | "tl_tokentradehistoryforaddress"
                        | "tl_contracttradehistoryforaddress"
                        | "tl_totaltradehistoryforaddress"
                );
                // Special cases return the bare payload; the default
                // passthrough returns the `{data}` wrapper (legacy shapes).
                if special {
                    GatewayReply {
                        status: 200,
                        body: ok.data,
                    }
                } else {
                    GatewayReply {
                        status: 200,
                        body: json!({"data": ok.data}),
                    }
                }
            }
        }
    }

    /// `POST /rpc/allocated/:providerNodeId/:method` (`handleAllocatedRpc`).
    /// `service` and `network` are pinned to configuration; a request naming a
    /// different one is rejected rather than honoured.
    pub fn handle_allocated(
        &mut self,
        ctx: &AuthContext,
        provider_node_id: &str,
        method: &str,
        body: &Value,
        hooks: &mut dyn GatewayHooks,
    ) -> GatewayReply {
        let n = normalize_method(method);
        if n.is_empty() {
            return coded(400, "BAD_RPC_REQUEST", "Missing method");
        }
        let pm = match PublicMethod::parse(&n) {
            Ok(m) => m,
            Err(_) => {
                return coded(
                    403,
                    "RPC_METHOD_FORBIDDEN",
                    "RPC method is not available on the public mesh",
                )
            }
        };
        if let Some(s) = body.get("service").and_then(Value::as_str) {
            if s != self.router.service {
                return coded(400, "BAD_RPC_REQUEST", "service is fixed by configuration");
            }
        }
        if let Some(net) = body.get("network").and_then(Value::as_str) {
            match Network::parse(net) {
                Ok(parsed) if parsed == self.router.network => {}
                _ => return coded(400, "NETWORK_MISMATCH", "network is fixed by configuration"),
            }
        }
        let params = match body.get("params") {
            Some(Value::Array(a)) => a.clone(),
            Some(Value::Object(o)) => o
                .get("params")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default(),
            _ => Vec::new(),
        };
        if params.len() > MAX_PARAMS
            || Value::Array(params.clone()).to_string().len() > MAX_PARAMS_BYTES
        {
            return coded(400, "BAD_RPC_REQUEST", "Too many or too large params");
        }
        let timeout = match body.get("timeoutMs") {
            None | Some(Value::Null) => None,
            Some(v) => match v.as_u64() {
                Some(t) if (1..=MAX_TIMEOUT_MS).contains(&t) => Some(t),
                _ => return coded(400, "BAD_RPC_REQUEST", "timeoutMs out of range"),
            },
        };
        let preferred_raw = body
            .get("preferredProviderNodeId")
            .and_then(Value::as_str)
            .filter(|s| !s.trim().is_empty())
            .unwrap_or(provider_node_id);
        let preferred = if preferred_raw.trim().is_empty() {
            None
        } else {
            match sanitize_node_id(preferred_raw) {
                Some(p) => Some(p),
                None => return coded(400, "BAD_RPC_REQUEST", "invalid provider node id"),
            }
        };
        match pm.name() {
            "tl_watchonly_register" | "tl_watchonly_utxos" => {
                let r = if pm.name() == "tl_watchonly_register" {
                    hooks.watchonly_register(ctx, &params)
                } else {
                    hooks.watchonly_utxos(ctx, &params)
                };
                return match r {
                    Ok(v) => GatewayReply {
                        status: 200,
                        body: json!({"data": v}),
                    },
                    Err(e) => hook_error(&e),
                };
            }
            _ => {}
        }
        let opts = CallOpts {
            preferred_provider_node_id: preferred,
            timeout_ms: timeout,
        };
        match self.router.call(RoutedMethod::Public(pm), params, &opts) {
            Err(f) => failure(&f),
            Ok(ok) => {
                let mut m = Map::new();
                m.insert("data".into(), ok.data);
                if let Some(p) = ok.provider_node_id {
                    m.insert("providerNodeId".into(), p.into());
                }
                GatewayReply {
                    status: 200,
                    body: Value::Object(m),
                }
            }
        }
    }

    /// The three explicit routes (`/tl_getAttestations`, `/tl_getChannelColumn`,
    /// `/tl_listContractSeries`). Success returns the bare provider payload and
    /// failures use the legacy plain `{error}` body with status 502.
    pub fn handle_explicit(
        &mut self,
        name: &str,
        body: &Value,
        hooks: &mut dyn GatewayHooks,
    ) -> GatewayReply {
        let key = normalize_method(name);
        let (method, params, address, summary): (&str, Vec<Value>, Option<String>, Value) =
            match key.as_str() {
                "tl_getattestations" => {
                    let id = int_arg(body.get("id").filter(|v| v.is_number()));
                    let (Some(a), Some(id)) = (self.addr_arg(body.get("address")), id) else {
                        return plain(400, "Invalid address or id");
                    };
                    (
                        "tl_getattestations",
                        vec![json!(a), json!(id)],
                        Some(a),
                        json!({"id": id}),
                    )
                }
                "tl_getchannelcolumn" => {
                    let arr = body.get("params").and_then(Value::as_array);
                    let pick = |keys: &[&str], i: usize| -> Option<String> {
                        let v = keys
                            .iter()
                            .find_map(|k| body.get(*k).filter(|v| !v.is_null()))
                            .or_else(|| arr.and_then(|a| a.get(i)));
                        self.addr_arg(v)
                    };
                    let channel = pick(&["channelAddress", "channel"], 0);
                    let commit = pick(
                        &["newCommitAddress", "myAddress", "myAddr", "buyerAddress"],
                        1,
                    );
                    let cp = pick(&["cpAddress", "cpAddr"], 2);
                    let (Some(c), Some(n), Some(p)) = (channel, commit, cp) else {
                        return plain(
                            400,
                            "channelAddress, newCommitAddress, and cpAddress are required",
                        );
                    };
                    (
                        "tl_getchannelcolumn",
                        vec![json!(c), json!(n), json!(p)],
                        Some(n),
                        json!({"channelAddress": c, "cpAddress": p}),
                    )
                }
                "tl_listcontractseries" => {
                    let v = body
                        .get("contractId")
                        .filter(|v| v.is_number())
                        .or_else(|| body.get("params").and_then(|p| p.get("contractId")));
                    let Some(cid) = int_arg(v.filter(|v| v.is_number())) else {
                        return plain(400, "Missing or invalid contractId");
                    };
                    (
                        "tl_listcontractseries",
                        vec![json!({"contractId": cid})],
                        None,
                        json!({"contractId": cid}),
                    )
                }
                _ => return plain(404, "not found"),
            };
        let Ok(pm) = PublicMethod::parse(method) else {
            return plain(404, "not found");
        };
        match self
            .router
            .call(RoutedMethod::Public(pm), params, &CallOpts::default())
        {
            Err(f) => plain(502, &clean(f.message())),
            Ok(ok) => {
                hooks.observe(&RpcEvent {
                    method: pm.name(),
                    route: format!("/rpc/{}", name.trim()),
                    address,
                    provider_node_id: ok.provider_node_id.as_deref(),
                    summary,
                    payload: &ok.data,
                });
                GatewayReply {
                    status: 200,
                    body: ok.data,
                }
            }
        }
    }

    /// `POST /rpc/payload`: only the attestation and commit encoders are public.
    pub fn handle_payload(&self, body: &Value, encoder: &dyn PayloadEncoder) -> GatewayReply {
        let params = body.get("params");
        let Some(kind) = params.and_then(|p| p.get("type")).and_then(Value::as_str) else {
            return coded(400, "BAD_PAYLOAD_REQUEST", "Missing or invalid params.type");
        };
        let canonical = match normalize_method(kind).as_str() {
            "attestation" | "issueorrevokeattestation" => "attestation",
            "commit" | "commitchannel" | "commit_tochannel" => "commit",
            _ => {
                return coded(
                    403,
                    "PAYLOAD_TYPE_FORBIDDEN",
                    "Payload type is not available on the public mesh",
                )
            }
        };
        match params.map(|p| encoder.encode(canonical, p)) {
            Some(Ok(payload)) => GatewayReply {
                status: 200,
                body: json!({"payload": payload}),
            },
            Some(Err(e)) => plain(400, &clean(&e)),
            None => coded(400, "BAD_PAYLOAD_REQUEST", "Missing or invalid params.type"),
        }
    }
}
