//! Deterministic in-memory implementations of the adapter traits. They are part
//! of the public API so downstream integration tests can reuse them.

use crate::network::Network;
use crate::ports::*;
use bitcoin::OutPoint;
use serde_json::Value;
use std::cell::{Cell, RefCell};
use std::collections::{BTreeMap, VecDeque};
use std::rc::Rc;

/// Shared manual clock (clones observe the same time).
#[derive(Clone, Default)]
pub struct ManualClock(Rc<Cell<u64>>);

impl ManualClock {
    pub fn new(start_ms: u64) -> Self {
        ManualClock(Rc::new(Cell::new(start_ms)))
    }

    pub fn advance(&self, ms: u64) {
        self.0.set(self.0.get().saturating_add(ms));
    }

    pub fn set(&self, ms: u64) {
        self.0.set(ms);
    }
}

impl Clock for ManualClock {
    fn now_ms(&self) -> u64 {
        self.0.get()
    }
}

#[derive(Default)]
struct StoreInner {
    doc: Option<String>,
    fail_saves: bool,
    saves: usize,
}

/// In-memory registry store with fault injection.
#[derive(Clone, Default)]
pub struct MemoryStore(Rc<RefCell<StoreInner>>);

impl MemoryStore {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_doc(doc: &str) -> Self {
        let s = Self::default();
        s.0.borrow_mut().doc = Some(doc.to_string());
        s
    }

    pub fn set_fail_saves(&self, fail: bool) {
        self.0.borrow_mut().fail_saves = fail;
    }

    pub fn doc(&self) -> Option<String> {
        self.0.borrow().doc.clone()
    }

    pub fn saves(&self) -> usize {
        self.0.borrow().saves
    }
}

impl RegistryStore for MemoryStore {
    fn load(&mut self) -> Result<Option<String>, String> {
        Ok(self.0.borrow().doc.clone())
    }

    fn save(&mut self, doc: &str) -> Result<(), String> {
        let mut i = self.0.borrow_mut();
        if i.fail_saves {
            return Err("injected write failure".into());
        }
        i.doc = Some(doc.to_string());
        i.saves += 1;
        Ok(())
    }
}

type Handler = Box<dyn FnMut(&RoutedRequest) -> Result<RawReply, String>>;

#[derive(Default)]
struct TransportInner {
    queue: VecDeque<Result<RawReply, String>>,
    handler: Option<Handler>,
    calls: Vec<RoutedRequest>,
}

/// Scripted collator transport: replies are consumed in order, or produced by
/// a handler closure. Every request is recorded.
#[derive(Clone, Default)]
pub struct FakeTransport(Rc<RefCell<TransportInner>>);

impl FakeTransport {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn push_ok(&self, body: Value) {
        self.0
            .borrow_mut()
            .queue
            .push_back(Ok(RawReply { status: 200, body }));
    }

    pub fn push_err(&self, msg: &str) {
        self.0.borrow_mut().queue.push_back(Err(msg.to_string()));
    }

    pub fn push_reply(&self, status: u16, body: Value) {
        self.0
            .borrow_mut()
            .queue
            .push_back(Ok(RawReply { status, body }));
    }

    pub fn set_handler(&self, h: impl FnMut(&RoutedRequest) -> Result<RawReply, String> + 'static) {
        self.0.borrow_mut().handler = Some(Box::new(h));
    }

    pub fn calls(&self) -> Vec<RoutedRequest> {
        self.0.borrow().calls.clone()
    }
}

impl RpcTransport for FakeTransport {
    fn route(&mut self, req: &RoutedRequest) -> Result<RawReply, String> {
        let mut i = self.0.borrow_mut();
        i.calls.push(req.clone());
        if let Some(r) = i.queue.pop_front() {
            return r;
        }
        if let Some(h) = i.handler.as_mut() {
            return h(req);
        }
        Err("no scripted reply".into())
    }
}

type ExternalState = (BTreeMap<(String, u32), ExternalReply>, Vec<(String, u32)>);

/// External UTXO source keyed by `(address, page)`.
#[derive(Clone, Default)]
pub struct FakeExternal(Rc<RefCell<ExternalState>>);

impl FakeExternal {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn set_page(&self, address: &str, page: u32, status: u16, body: &str) {
        self.0.borrow_mut().0.insert(
            (address.to_string(), page),
            ExternalReply {
                status,
                body: body.to_string(),
            },
        );
    }

    pub fn requests(&self) -> Vec<(String, u32)> {
        self.0.borrow().1.clone()
    }
}

impl ExternalUtxoSource for FakeExternal {
    fn fetch_page(
        &mut self,
        _network: Network,
        address: &str,
        page: u32,
    ) -> Result<ExternalReply, String> {
        let mut i = self.0.borrow_mut();
        i.1.push((address.to_string(), page));
        i.0.get(&(address.to_string(), page))
            .cloned()
            .ok_or_else(|| "no page".to_string())
    }
}

/// Outpoint oracle over a fixed map.
#[derive(Clone, Default)]
pub struct FakeOracle(Rc<RefCell<BTreeMap<OutPoint, OracleOutput>>>);

impl FakeOracle {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn insert(&self, op: OutPoint, out: OracleOutput) {
        self.0.borrow_mut().insert(op, out);
    }
}

impl OutpointOracle for FakeOracle {
    fn unspent_output(&mut self, op: &OutPoint) -> Result<Option<OracleOutput>, String> {
        Ok(self.0.borrow().get(op).cloned())
    }
}

/// Scripted IP-intel providers.
#[derive(Clone, Default)]
pub struct FakeIpIntel(Rc<RefCell<IpIntelInner>>);

#[derive(Default)]
struct IpIntelInner {
    ipinfo: Option<Result<Value, String>>,
    criminalip: Option<Result<Option<Value>, String>>,
    ip_api: Option<Result<Value, String>>,
    calls: Vec<String>,
}

impl FakeIpIntel {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn set_ipinfo(&self, r: Result<Value, String>) {
        self.0.borrow_mut().ipinfo = Some(r);
    }

    pub fn set_criminalip(&self, r: Result<Option<Value>, String>) {
        self.0.borrow_mut().criminalip = Some(r);
    }

    pub fn set_ip_api(&self, r: Result<Value, String>) {
        self.0.borrow_mut().ip_api = Some(r);
    }

    pub fn calls(&self) -> Vec<String> {
        self.0.borrow().calls.clone()
    }
}

impl IpIntel for FakeIpIntel {
    fn ipinfo(&mut self, ip: &str) -> Result<Value, String> {
        let mut i = self.0.borrow_mut();
        i.calls.push(format!("ipinfo:{ip}"));
        i.ipinfo.clone().unwrap_or_else(|| Err("down".into()))
    }

    fn criminalip(&mut self, ip: &str) -> Result<Option<Value>, String> {
        let mut i = self.0.borrow_mut();
        i.calls.push(format!("criminalip:{ip}"));
        i.criminalip.clone().unwrap_or(Ok(None))
    }

    fn ip_api(&mut self, ip: &str) -> Result<Value, String> {
        let mut i = self.0.borrow_mut();
        i.calls.push(format!("ip-api:{ip}"));
        i.ip_api.clone().unwrap_or_else(|| Err("down".into()))
    }
}

/// Fixed seed document.
#[derive(Clone)]
pub struct FakeSeed(pub Result<Value, String>);

impl SeedSource for FakeSeed {
    fn fetch(&mut self, _network: Network) -> Result<Value, String> {
        self.0.clone()
    }
}

/// Payload encoder that echoes the kind and parameters.
#[derive(Clone, Default)]
pub struct FakeEncoder;

impl PayloadEncoder for FakeEncoder {
    fn encode(&self, kind: &str, params: &Value) -> Result<String, String> {
        Ok(format!("enc:{kind}:{params}"))
    }
}
