use std::fmt;

/// Typed errors. Nothing in this crate panics on untrusted input.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Error {
    InvalidNetwork(String),
    NetworkMismatch { expected: String, found: String },
    InvalidAddress(&'static str),
    AddressOnOtherNetwork(String),
    InvalidPubkey(&'static str),
    PubkeyAddressMismatch,
    PubkeyUnbindable,
    InvalidAmount(&'static str),
    AmountOverflow,
    InvalidOutpoint(&'static str),
    InvalidUtxo(&'static str),
    ForeignScript,
    DuplicateOutpoint,
    TooMany { what: &'static str, max: usize },
    TooLarge { what: &'static str, max: usize },
    InvalidField(&'static str),
    Unauthorized,
    Forbidden(&'static str),
    NotFound,
    PubkeyConflict,
    StaleSnapshot { have: u64, got: u64 },
    SnapshotUnavailable(&'static str),
    InsufficientFunds { have: u64, need: u64 },
    FeeTooHigh { fee: u64, max: u64 },
    FeeRateOutOfRange,
    DustOutput,
    UnsupportedInputScript,
    InputNotVerified,
    Psbt(String),
    Persist(String),
    RpcForbidden,
    RpcBadRequest(&'static str),
    Upstream(String),
    NoProvider(String),
    ExternalSource(&'static str),
    Config(&'static str),
}

pub type Result<T> = std::result::Result<T, Error>;

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        use Error::*;
        match self {
            InvalidNetwork(s) => write!(f, "unknown network {s:?}"),
            NetworkMismatch { expected, found } => {
                write!(f, "network mismatch: expected {expected}, found {found}")
            }
            InvalidAddress(why) => write!(f, "invalid address: {why}"),
            AddressOnOtherNetwork(n) => write!(f, "address belongs to network {n}"),
            InvalidPubkey(why) => write!(f, "invalid pubkey: {why}"),
            PubkeyAddressMismatch => write!(f, "pubkey does not derive the address"),
            PubkeyUnbindable => write!(f, "address kind cannot be bound to a pubkey"),
            InvalidAmount(why) => write!(f, "invalid amount: {why}"),
            AmountOverflow => write!(f, "amount overflow"),
            InvalidOutpoint(why) => write!(f, "invalid outpoint: {why}"),
            InvalidUtxo(why) => write!(f, "invalid utxo: {why}"),
            ForeignScript => write!(f, "utxo script does not pay the address"),
            DuplicateOutpoint => write!(f, "duplicate outpoint"),
            TooMany { what, max } => write!(f, "too many {what} (max {max})"),
            TooLarge { what, max } => write!(f, "{what} too large (max {max})"),
            InvalidField(w) => write!(f, "invalid field: {w}"),
            Unauthorized => write!(f, "authentication required"),
            Forbidden(w) => write!(f, "forbidden: {w}"),
            NotFound => write!(f, "not found"),
            PubkeyConflict => write!(f, "address already registered with a different pubkey"),
            StaleSnapshot { have, got } => {
                write!(f, "snapshot height {got} is older than recorded {have}")
            }
            SnapshotUnavailable(w) => write!(f, "snapshot unavailable: {w}"),
            InsufficientFunds { have, need } => {
                write!(f, "insufficient funds: have {have}, need {need}")
            }
            FeeTooHigh { fee, max } => write!(f, "fee {fee} exceeds bound {max}"),
            FeeRateOutOfRange => write!(f, "fee rate out of range"),
            DustOutput => write!(f, "output below dust threshold"),
            UnsupportedInputScript => write!(f, "unsupported input script"),
            InputNotVerified => write!(f, "input not verified against a trusted utxo view"),
            Psbt(s) => write!(f, "psbt: {s}"),
            Persist(s) => write!(f, "persistence failed: {s}"),
            RpcForbidden => write!(f, "RPC method is not available on the public mesh"),
            RpcBadRequest(w) => write!(f, "{w}"),
            Upstream(s) => write!(f, "{s}"),
            NoProvider(s) => write!(f, "{s}"),
            ExternalSource(w) => write!(f, "external source: {w}"),
            Config(w) => write!(f, "configuration: {w}"),
        }
    }
}

impl std::error::Error for Error {}
