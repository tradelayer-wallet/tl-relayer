//! Pure Rust contracts for the TradeLayer relayer (`tl-relayer`).
//!
//! The crate ports the watch-only registry, address validation, unsigned-PSBT
//! building, routed-RPC policy, external UTXO validation and IP attestation of the
//! legacy TypeScript service. All I/O (HTTP, sockets, wallet RPC, disk, wall clock)
//! sits behind the traits in [`ports`]; deterministic in-memory fakes live in
//! [`fakes`]. Money is integer satoshis, the chain and network are always explicit,
//! and every list or payload is bounded.
#![forbid(unsafe_code)]

pub mod address;
pub mod attestation;
pub mod auth;
pub mod base64;
pub mod error;
pub mod fakes;
pub mod money;
pub mod network;
pub mod persist;
pub mod ports;
pub mod registry;
pub mod rpc;
pub mod service;
pub mod sochain;
pub mod tx;
pub mod utxo;

pub use error::{Error, Result};
pub use money::Amount;
pub use network::{Chain, Net, Network};
