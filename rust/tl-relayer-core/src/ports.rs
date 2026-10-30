//! Adapter boundaries. Production wiring (HTTP client, file store, wall clock,
//! IP-intel providers) implements these; tests use [`crate::fakes`].

use crate::network::Network;
use bitcoin::OutPoint;
use serde_json::Value;

/// Deterministic clock: milliseconds since the Unix epoch.
pub trait Clock {
    fn now_ms(&self) -> u64;
}

/// Durable registry storage. The core hands over the whole canonical document
/// and expects an atomic replace (temp file + rename in a file adapter).
pub trait RegistryStore {
    fn load(&mut self) -> Result<Option<String>, String>;
    fn save(&mut self, doc: &str) -> Result<(), String>;
}

/// Raw HTTP-level reply from the collator `/rpc/route` endpoint.
#[derive(Debug, Clone, PartialEq)]
pub struct RawReply {
    pub status: u16,
    pub body: Value,
}

/// Request sent to the collator. `method` is already the canonical (listener)
/// spelling; `network` is explicit.
#[derive(Debug, Clone, PartialEq)]
pub struct RoutedRequest {
    pub service: String,
    pub network: Network,
    pub method: String,
    pub params: Vec<Value>,
    pub timeout_ms: Option<u64>,
    pub preferred_provider_node_id: Option<String>,
    pub source_endpoint: &'static str,
}

/// Collator transport. `Err` is a transport-level failure (timeout, refused,
/// oversized body) already reduced to a message by the adapter.
pub trait RpcTransport {
    fn route(&mut self, req: &RoutedRequest) -> Result<RawReply, String>;
}

/// Raw reply of the external UTXO explorer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExternalReply {
    pub status: u16,
    pub body: String,
}

/// External UTXO source (SoChain). The adapter performs the HTTPS call; the
/// core validates size, shape and content.
pub trait ExternalUtxoSource {
    fn fetch_page(
        &mut self,
        network: Network,
        address: &str,
        page: u32,
    ) -> Result<ExternalReply, String>;
}

/// Trusted view of unspent outputs, used to verify caller-supplied inputs
/// (for example channel commit UTXOs) before they are signed over.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OracleOutput {
    pub amount_sat: u64,
    pub script_pubkey: Vec<u8>,
    pub confirmations: u64,
}

pub trait OutpointOracle {
    /// `Ok(None)` means spent or unknown.
    fn unspent_output(&mut self, op: &OutPoint) -> Result<Option<OracleOutput>, String>;
}

/// IP reputation providers; each returns the provider's raw JSON.
pub trait IpIntel {
    fn ipinfo(&mut self, ip: &str) -> Result<Value, String>;
    /// `Ok(None)` when no API key is configured.
    fn criminalip(&mut self, ip: &str) -> Result<Option<Value>, String>;
    fn ip_api(&mut self, ip: &str) -> Result<Value, String>;
}

/// Configured watch-only seed registry. The URL is operator configuration, never
/// request input.
pub trait SeedSource {
    fn fetch(&mut self, network: Network) -> Result<Value, String>;
}

/// Payload encoders stay in the protocol core (`tl-wire`); the relayer only
/// decides which payload types are public.
pub trait PayloadEncoder {
    fn encode(&self, kind: &str, params: &Value) -> Result<String, String>;
}
