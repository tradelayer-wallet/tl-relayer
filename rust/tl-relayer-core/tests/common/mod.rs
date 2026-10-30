//! Shared synthetic fixtures. Keys are derived from fixed bytes; nothing here is
//! a real key and every network used for transactions is a test network.
#![allow(dead_code)]

use bitcoin::bech32::{self, Hrp};
use bitcoin::hashes::Hash;
use bitcoin::key::PublicKey;
use bitcoin::secp256k1::{Secp256k1, SecretKey, XOnlyPublicKey};
use bitcoin::{OutPoint, ScriptBuf, Txid};
use serde_json::{json, Value};
use std::str::FromStr;
use tl_relayer_core::address::{decode_address, hex, DecodedAddress};
use tl_relayer_core::auth::{AuthContext, Capability, Principal};
use tl_relayer_core::fakes::{FakeTransport, ManualClock, MemoryStore};
use tl_relayer_core::network::Network;
use tl_relayer_core::registry::{Limits, Policy, Registry};
use tl_relayer_core::rpc::Router;
use tl_relayer_core::service::{ServiceConfig, WatchOnlyService};
use tl_relayer_core::{Amount, Result};

pub const NET: Network = Network::LTC_TEST;

pub fn key(n: u8) -> PublicKey {
    let secp = Secp256k1::new();
    let mut b = [0u8; 32];
    b[31] = n;
    b[0] = 7;
    let sk = SecretKey::from_slice(&b).unwrap();
    PublicKey::new(bitcoin::secp256k1::PublicKey::from_secret_key(&secp, &sk))
}

pub fn pk_hex(pk: &PublicKey) -> String {
    hex(&pk.to_bytes())
}

pub fn p2wpkh(net: Network, pk: &PublicKey) -> String {
    let hrp = Hrp::parse(net.bech32_hrp().unwrap()).unwrap();
    bech32::segwit::encode_v0(hrp, pk.wpubkey_hash().unwrap().as_byte_array()).unwrap()
}

pub fn p2tr_bip86(net: Network, pk: &PublicKey) -> String {
    let secp = Secp256k1::new();
    let x = XOnlyPublicKey::from(pk.inner);
    let s = ScriptBuf::new_p2tr(&secp, x, None);
    let hrp = Hrp::parse(net.bech32_hrp().unwrap()).unwrap();
    bech32::segwit::encode_v1(hrp, &s.as_bytes()[2..]).unwrap()
}

pub fn p2wsh(net: Network, script: &ScriptBuf) -> String {
    let hrp = Hrp::parse(net.bech32_hrp().unwrap()).unwrap();
    bech32::segwit::encode_v0(hrp, script.wscript_hash().as_byte_array()).unwrap()
}

pub fn p2pkh(net: Network, pk: &PublicKey) -> String {
    let mut v = vec![net.p2pkh_version()];
    v.extend_from_slice(pk.pubkey_hash().as_byte_array());
    bitcoin::base58::encode_check(&v)
}

pub fn p2sh_p2wpkh(net: Network, pk: &PublicKey) -> String {
    let redeem = ScriptBuf::new_p2wpkh(&pk.wpubkey_hash().unwrap());
    let mut v = vec![net.p2sh_version()];
    v.extend_from_slice(redeem.script_hash().as_byte_array());
    bitcoin::base58::encode_check(&v)
}

pub fn dec(addr: &str) -> DecodedAddress {
    decode_address(addr, NET).unwrap()
}

pub fn txid(n: u8) -> Txid {
    Txid::from_str(&format!("{:02x}{}", n, "11".repeat(31))).unwrap()
}

pub fn op(n: u8, vout: u32) -> OutPoint {
    OutPoint {
        txid: txid(n),
        vout,
    }
}

pub fn utxo_for(d: &DecodedAddress, n: u8, vout: u32, sat: u64) -> tl_relayer_core::utxo::Utxo {
    tl_relayer_core::utxo::Utxo {
        outpoint: op(n, vout),
        amount: Amount::from_sat(sat),
        confirmations: 3,
        script_pubkey: d.script.clone(),
        witness_script: None,
        prev_tx: None,
    }
}

pub fn utxo_value(d: &DecodedAddress, n: u8, vout: u32, coins: &str) -> Value {
    json!({
        "txid": txid(n).to_string(),
        "vout": vout,
        "amount": coins.parse::<f64>().unwrap(),
        "confirmations": 5,
        "scriptPubKey": hex(d.script.as_bytes()),
    })
}

pub fn ctx(name: &str, caps: &[Capability]) -> AuthContext {
    AuthContext::new(Principal::new(name).unwrap(), caps)
}

pub fn user(name: &str) -> AuthContext {
    ctx(name, &[Capability::Register])
}

pub fn admin() -> AuthContext {
    ctx("admin", &[Capability::Admin])
}

pub fn registry(
    store: MemoryStore,
    clock: ManualClock,
) -> Registry<MemoryStore, ManualClock> {
    Registry::open(NET, Limits::default(), Policy::default(), store, clock)
        .unwrap()
        .0
}

pub type Svc = WatchOnlyService<MemoryStore, ManualClock, FakeTransport>;

pub struct Rig {
    pub svc: Svc,
    pub store: MemoryStore,
    pub clock: ManualClock,
    pub transport: FakeTransport,
}

pub fn rig() -> Rig {
    rig_with(Limits::default(), ServiceConfig::new(NET))
}

pub fn rig_with(limits: Limits, cfg: ServiceConfig) -> Rig {
    let store = MemoryStore::new();
    let clock = ManualClock::new(1_000_000);
    let transport = FakeTransport::new();
    let (reg, _) = Registry::open(NET, limits, Policy::default(), store.clone(), clock.clone()).unwrap();
    let router = Router::new("tradelayer.rpc", NET, transport.clone());
    let svc = WatchOnlyService::new(cfg, reg, router).unwrap();
    Rig {
        svc,
        store,
        clock,
        transport,
    }
}

/// Provider reply for `tl_watchonly_utxos`.
pub fn utxos_reply(d: &DecodedAddress, rows: &[(u8, u32, &str)], height: u64, provider: &str) -> Value {
    json!({
        "ok": true,
        "providerNodeId": provider,
        "result": {
            "address": d.text,
            "utxos": rows.iter().map(|(n, v, c)| utxo_value(d, *n, *v, c)).collect::<Vec<_>>(),
            "snapshot": { "sourceBlock": { "height": height } },
        }
    })
}

pub fn ok_reply(provider: &str) -> Value {
    json!({"ok": true, "providerNodeId": provider, "result": {"registered": true}})
}

pub fn expect_err<T: std::fmt::Debug>(r: Result<T>) -> tl_relayer_core::Error {
    r.expect_err("expected an error")
}
