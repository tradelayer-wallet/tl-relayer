//! Watch-only service: registration through a provider, UTXO and balance reads,
//! coverage verification, rescan planning, unsigned transaction building and
//! the faucet. Port of `address.service.ts`, `sochain.service.ts` (`listunspent`,
//! `rescanWatchOnlyAccounts`) and the build/broadcast half of `tx.service.ts`.

use crate::address::{decode_address, hex, parse_pubkey, DecodedAddress};
use crate::auth::{AuthContext, Capability};
use crate::error::{Error, Result};
use crate::money::Amount;
use crate::network::Network;
use crate::ports::{Clock, ExternalUtxoSource, OutpointOracle, RegistryStore, RpcTransport};
use crate::registry::{
    clip_text, rescan_start_height, sanitize_node_id, validate_account, Account, Limits,
    MethodSnapshot, RegisterOpts, Registry, ScanState, SnapshotInput, TokenBalance,
};
use crate::rpc::{
    CallOpts, GatewayHooks, InternalMethod, PublicMethod, RoutedMethod, Router, RpcEvent,
    RpcFailure, MAX_PARAMS,
};
use crate::sochain::{compare_snapshots, fetch_external_snapshot, ExternalLimits};
use crate::tx::{self, BuildPlan, FeeMode, FeePolicy, UnsignedTx};
use crate::utxo::{self, derive_first_funding, validate_utxos, Utxo};
use bitcoin::consensus::encode;
use bitcoin::{OutPoint, ScriptBuf, Transaction, WScriptHash};
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, BTreeSet};

pub const MAX_RAW_TX_BYTES: usize = 400_000;
pub const MAX_BALANCES_RESPONSE: usize = 4_096;
pub const FAUCET_LOG_MAX: usize = 10_000;

#[derive(Debug, Clone)]
pub struct ServiceConfig {
    pub network: Network,
    /// Oldest cached snapshot that may be served when a provider call fails.
    pub snapshot_max_age_ms: u64,
    pub fee: FeePolicy,
    pub fee_mode: FeeMode,
    /// `WATCHONLY_RESCAN_OPT_IN`: rescans never run without it, `force` or not.
    pub rescan_opt_in: bool,
    pub rescan_lookback_blocks: u64,
    pub faucet_cooldown_ms: u64,
    pub faucet_amount: Amount,
    pub external: ExternalLimits,
}

impl ServiceConfig {
    pub fn new(network: Network) -> Self {
        ServiceConfig {
            network,
            snapshot_max_age_ms: 5 * 60 * 1000,
            fee: FeePolicy::default(),
            fee_mode: FeeMode::SubtractFromAmount,
            rescan_opt_in: false,
            rescan_lookback_blocks: 10,
            faucet_cooldown_ms: 24 * 60 * 60 * 1000,
            faucet_amount: Amount::from_sat(100_000_000),
            external: ExternalLimits::default(),
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct UtxoReply {
    pub address: String,
    pub utxos: Vec<Utxo>,
    pub height: Option<u64>,
    pub provider_node_id: Option<String>,
    pub from_cache: bool,
    pub cached_at: Option<u64>,
    pub recorded: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct BalanceReply {
    pub balances: Vec<Value>,
    pub from_cache: bool,
    pub cached_at: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImportOutcome {
    pub address: String,
    pub imported: bool,
    pub skipped: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ImportSummary {
    pub imported: usize,
    pub skipped: usize,
    pub failed: usize,
    pub results: Vec<ImportOutcome>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct VerifyReport {
    pub address: String,
    pub network: Network,
    pub local_hash: Option<String>,
    pub local_count: Option<usize>,
    pub external_hash: Option<String>,
    pub external_count: Option<usize>,
    pub needs_rescan: bool,
    pub reason: &'static str,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RescanReport {
    pub executed: bool,
    pub from_height: u64,
    pub to_height: Option<u64>,
    pub refreshed: usize,
    pub failed: usize,
}

pub struct WatchOnlyService<S: RegistryStore, C: Clock, T: RpcTransport> {
    pub cfg: ServiceConfig,
    pub registry: Registry<S, C>,
    pub router: Router<T>,
    faucet_log: BTreeMap<String, u64>,
}

fn public(name: &str) -> Result<RoutedMethod> {
    Ok(RoutedMethod::Public(PublicMethod::parse(name)?))
}

fn to_error(f: RpcFailure) -> Error {
    match f {
        RpcFailure::NoProvider(m) => Error::NoProvider(m),
        RpcFailure::Upstream(m) => Error::Upstream(m),
    }
}

fn coin_json(a: Amount) -> Value {
    serde_json::from_str(&a.to_coin_string()).unwrap_or(Value::Null)
}

pub fn utxo_json(u: &Utxo) -> Value {
    json!({
        "id": u.id(),
        "txid": u.outpoint.txid.to_string(),
        "vout": u.outpoint.vout,
        "amount": coin_json(u.amount),
        "confirmations": u.confirmations,
        "scriptPubKey": hex(u.script_pubkey.as_bytes()),
    })
}

impl<S: RegistryStore, C: Clock, T: RpcTransport> WatchOnlyService<S, C, T> {
    pub fn new(cfg: ServiceConfig, registry: Registry<S, C>, router: Router<T>) -> Result<Self> {
        if registry.network() != cfg.network || router.network != cfg.network {
            return Err(Error::Config("registry, router and service networks differ"));
        }
        Ok(WatchOnlyService {
            cfg,
            registry,
            router,
            faucet_log: BTreeMap::new(),
        })
    }

    fn net(&self) -> Network {
        self.cfg.network
    }

    fn check_network(&self, requested: Option<&str>) -> Result<()> {
        if let Some(r) = requested.map(str::trim).filter(|s| !s.is_empty()) {
            let n = Network::parse(r)?;
            if n != self.net() {
                return Err(Error::NetworkMismatch {
                    expected: self.net().legacy_code().into(),
                    found: n.legacy_code().into(),
                });
            }
        }
        Ok(())
    }

    fn preferred_provider(&self, address: &str) -> Option<String> {
        let e = self.registry.entry(address)?;
        e.assigned_provider_node_id
            .clone()
            .or_else(|| e.scan_source_node_id.clone())
            .or_else(|| e.utxo_snapshot.as_ref()?.scan_source_node_id.clone())
            .or_else(|| e.token_snapshot.as_ref()?.scan_source_node_id.clone())
    }

    fn account_payload(&self, address: &str, pubkey: &str) -> Value {
        json!({
            "address": address,
            "pubkey": pubkey,
            "network": self.net().collator_name(),
        })
    }

    // -- registration -------------------------------------------------------

    /// Register an address/pubkey pair and import it on a provider. Order: the
    /// pair is validated and recorded first (so quota or conflict failures never
    /// reach a provider), then the provider is called, then the outcome is
    /// recorded. A provider already confirmed for this pair is not called again.
    pub fn import_pubkey(&mut self, ctx: &AuthContext, acct: &Account) -> Result<ImportOutcome> {
        ctx.require(Capability::Register)?;
        let (dec, pk_hex) = validate_account(self.net(), self.registry.policy(), acct)?;
        let already = self
            .registry
            .entry(&dec.text)
            .is_some_and(|e| e.pubkey == pk_hex && e.last_imported_at.is_some());
        let canonical = Account {
            address: dec.text.clone(),
            pubkey: pk_hex.clone(),
        };
        self.registry
            .register(ctx, &canonical, &RegisterOpts::default())?;
        if already {
            return Ok(ImportOutcome {
                address: dec.text,
                imported: false,
                skipped: true,
                error: None,
            });
        }
        let opts = CallOpts {
            preferred_provider_node_id: self.preferred_provider(&dec.text),
            timeout_ms: None,
        };
        let params = vec![self.account_payload(&dec.text, &pk_hex)];
        match self.router.call(public("tl_watchonly_register")?, params, &opts) {
            Ok(ok) => {
                self.registry.register(
                    ctx,
                    &canonical,
                    &RegisterOpts {
                        source: Some("sync-watchonly".into()),
                        imported: true,
                        provider_node_id: ok.provider_node_id,
                        error: None,
                    },
                )?;
                Ok(ImportOutcome {
                    address: dec.text,
                    imported: true,
                    skipped: false,
                    error: None,
                })
            }
            Err(f) => {
                self.registry.register(
                    ctx,
                    &canonical,
                    &RegisterOpts {
                        error: Some(f.message().to_string()),
                        ..Default::default()
                    },
                )?;
                Err(to_error(f))
            }
        }
    }

    /// `POST /address/sync-watchonly`. Returns only the submitted accounts'
    /// results; the legacy response embedded the whole registry.
    pub fn import_accounts(&mut self, ctx: &AuthContext, accounts: &[Account]) -> Result<ImportSummary> {
        ctx.require(Capability::Register)?;
        let max = self.registry.limits().max_batch;
        if accounts.len() > max {
            return Err(Error::TooMany {
                what: "accounts",
                max,
            });
        }
        let mut sum = ImportSummary::default();
        let mut seen = BTreeSet::new();
        for a in accounts {
            let key = (a.address.trim().to_string(), a.pubkey.trim().to_ascii_lowercase());
            if !seen.insert(key) {
                sum.skipped += 1;
                continue;
            }
            match self.import_pubkey(ctx, a) {
                Ok(o) => {
                    if o.imported {
                        sum.imported += 1;
                    } else {
                        sum.skipped += 1;
                    }
                    sum.results.push(o);
                }
                Err(e) => {
                    sum.failed += 1;
                    sum.results.push(ImportOutcome {
                        address: a.address.trim().to_string(),
                        imported: false,
                        skipped: false,
                        error: Some(clip_text(&e.to_string(), 256)),
                    });
                }
            }
        }
        Ok(sum)
    }

    /// Port of the reconcile loop: retry providers for entries that are not yet
    /// imported. Administrators only.
    pub fn reconcile(&mut self, ctx: &AuthContext) -> Result<ImportSummary> {
        ctx.require(Capability::Admin)?;
        let todo: Vec<Account> = self
            .registry
            .state()
            .entries
            .values()
            .filter(|e| e.last_imported_at.is_none())
            .map(|e| Account {
                address: e.address.clone(),
                pubkey: e.pubkey.clone(),
            })
            .collect();
        let mut sum = ImportSummary::default();
        for a in todo {
            match self.import_pubkey(ctx, &a) {
                Ok(o) => {
                    sum.imported += usize::from(o.imported);
                    sum.skipped += usize::from(o.skipped);
                    sum.results.push(o);
                }
                Err(e) => {
                    sum.failed += 1;
                    sum.results.push(ImportOutcome {
                        address: a.address,
                        imported: false,
                        skipped: false,
                        error: Some(clip_text(&e.to_string(), 256)),
                    });
                }
            }
        }
        Ok(sum)
    }

    // -- UTXOs ----------------------------------------------------------------

    /// `POST /address/utxo/:address`. The provider answer is validated (address,
    /// network, script ownership, bounds) before it is recorded or returned; if
    /// the provider fails, a cached snapshot is served only while fresh.
    pub fn list_unspent(
        &mut self,
        ctx: &AuthContext,
        address: &str,
        pubkey: Option<&str>,
        network: Option<&str>,
    ) -> Result<UtxoReply> {
        ctx.require(Capability::Register)?;
        self.check_network(network)?;
        let dec = decode_address(address.trim(), self.net())?;
        let pk = match pubkey.map(str::trim).filter(|p| !p.is_empty()) {
            Some(p) => p.to_string(),
            None => self
                .registry
                .pubkey_of(&dec.text)
                .map(str::to_string)
                .ok_or(Error::InvalidField("pubkey"))?,
        };
        let (_, pk_hex) = parse_pubkey(&pk)?;
        match self.registry.entry(&dec.text) {
            Some(e) if e.pubkey != pk_hex => return Err(Error::PubkeyConflict),
            Some(_) => {}
            None => {
                self.import_pubkey(
                    ctx,
                    &Account {
                        address: dec.text.clone(),
                        pubkey: pk_hex.clone(),
                    },
                )?;
            }
        }
        let opts = CallOpts {
            preferred_provider_node_id: self.preferred_provider(&dec.text),
            timeout_ms: None,
        };
        let params = vec![self.account_payload(&dec.text, &pk_hex)];
        match self.router.call(public("tl_watchonly_utxos")?, params, &opts) {
            Err(f) => self.cached_or(&dec, to_error(f)),
            Ok(ok) => self.accept_provider_utxos(&dec, &pk_hex, ok.data, ok.provider_node_id),
        }
    }

    fn cached_or(&self, dec: &DecodedAddress, err: Error) -> Result<UtxoReply> {
        let now = self.registry.now();
        if let Some(s) = self
            .registry
            .entry(&dec.text)
            .and_then(|e| e.utxo_snapshot.as_ref())
        {
            if now.saturating_sub(s.updated_at) <= self.cfg.snapshot_max_age_ms {
                return Ok(UtxoReply {
                    address: dec.text.clone(),
                    utxos: s.utxos.clone(),
                    height: s.scanned_height,
                    provider_node_id: s.scan_source_node_id.clone(),
                    from_cache: true,
                    cached_at: Some(s.updated_at),
                    recorded: false,
                });
            }
        }
        Err(err)
    }

    fn accept_provider_utxos(
        &mut self,
        dec: &DecodedAddress,
        pk_hex: &str,
        payload: Value,
        provider: Option<String>,
    ) -> Result<UtxoReply> {
        let obj = payload
            .as_object()
            .ok_or_else(|| Error::Upstream("malformed UTXO payload".into()))?;
        if let Some(a) = obj.get("address").and_then(Value::as_str) {
            if decode_address(a, self.net()).map(|d| d.text).ok().as_deref() != Some(dec.text.as_str()) {
                return Err(Error::Upstream("provider answered for a different address".into()));
            }
        }
        if let Some(n) = obj.get("network").and_then(Value::as_str) {
            self.check_network(Some(n))?;
        }
        if let Some(k) = obj.get("pubkey").and_then(Value::as_str) {
            if k.to_ascii_lowercase() != pk_hex {
                return Err(Error::Upstream("provider answered for a different pubkey".into()));
            }
        }
        let raw = obj
            .get("utxos")
            .and_then(Value::as_array)
            .ok_or_else(|| Error::Upstream("malformed UTXO payload".into()))?;
        let utxos = validate_utxos(raw, dec, self.registry.limits().max_utxos)?;
        let height = obj
            .get("snapshot")
            .and_then(|s| s.get("sourceBlock"))
            .and_then(|b| b.get("height"))
            .and_then(Value::as_u64);
        let confs: Vec<(String, u64)> = utxos
            .iter()
            .map(|u| (u.outpoint.txid.to_string(), u.confirmations))
            .collect();
        let (ffh, fft) = derive_first_funding(&confs, height);
        let provider = provider.as_deref().and_then(sanitize_node_id);
        let sys = AuthContext::system();
        let rec = self.registry.record_utxo_snapshot(
            &sys,
            SnapshotInput {
                address: dec.text.clone(),
                utxos: utxos.clone(),
                scanned_height: height,
                scan_source_node_id: provider.clone(),
                scan_state: Some(ScanState::Live),
                first_funding_height: ffh,
                first_funding_txid: fft,
            },
        );
        let recorded = match rec {
            Ok(()) => true,
            Err(Error::StaleSnapshot { have, got }) => return Err(Error::StaleSnapshot { have, got }),
            Err(Error::Persist(m)) => return Err(Error::Persist(m)),
            Err(_) => false,
        };
        Ok(UtxoReply {
            address: dec.text.clone(),
            utxos,
            height,
            provider_node_id: provider,
            from_cache: false,
            cached_at: None,
            recorded,
        })
    }

    // -- balances ---------------------------------------------------------------

    /// `GET /address/balance/:address`.
    pub fn balance(&mut self, ctx: &AuthContext, address: &str) -> Result<BalanceReply> {
        ctx.require(Capability::Register)?;
        let dec = decode_address(address.trim(), self.net())?;
        let opts = CallOpts {
            preferred_provider_node_id: self.preferred_provider(&dec.text),
            timeout_ms: None,
        };
        let res = self.router.call(
            public("tl_getallbalancesforaddress")?,
            vec![json!(dec.text)],
            &opts,
        );
        match res {
            Ok(ok) => {
                let arr = ok.data.as_array().cloned().unwrap_or_default();
                if arr.len() > MAX_BALANCES_RESPONSE {
                    return Err(Error::TooMany {
                        what: "balances",
                        max: MAX_BALANCES_RESPONSE,
                    });
                }
                let rows: Vec<TokenBalance> = arr.iter().filter_map(token_balance).collect();
                if self.registry.entry(&dec.text).is_some() {
                    let max = self.registry.limits().max_tokens;
                    let rows: Vec<TokenBalance> = rows.into_iter().take(max).collect();
                    let _ = self.registry.record_token_snapshot(
                        &AuthContext::system(),
                        &dec.text,
                        rows,
                        None,
                        ok.provider_node_id.as_deref(),
                    );
                }
                Ok(BalanceReply {
                    balances: arr,
                    from_cache: false,
                    cached_at: None,
                })
            }
            Err(f) => {
                let now = self.registry.now();
                if let Some(t) = self
                    .registry
                    .entry(&dec.text)
                    .and_then(|e| e.token_snapshot.as_ref())
                {
                    if !t.balances.is_empty()
                        && now.saturating_sub(t.updated_at) <= self.cfg.snapshot_max_age_ms
                    {
                        let rows = t.balances.iter().map(balance_json).collect();
                        return Ok(BalanceReply {
                            balances: rows,
                            from_cache: true,
                            cached_at: Some(t.updated_at),
                        });
                    }
                }
                Err(to_error(f))
            }
        }
    }

    // -- coverage ------------------------------------------------------------------

    pub fn verify_coverage(
        &mut self,
        ctx: &AuthContext,
        address: &str,
        external: &mut dyn ExternalUtxoSource,
    ) -> Result<VerifyReport> {
        ctx.require(Capability::Register)?;
        let dec = decode_address(address.trim(), self.net())?;
        let local = self.registry.get(ctx, &dec.text)?;
        let ext = fetch_external_snapshot(external, &dec, self.registry.now(), &self.cfg.external).ok();
        let verdict = compare_snapshots(local.utxo_snapshot.as_ref(), ext.as_ref());
        Ok(VerifyReport {
            address: dec.text,
            network: self.net(),
            local_hash: local.utxo_snapshot.as_ref().map(|s| s.hash.clone()),
            local_count: local.utxo_snapshot.as_ref().map(|s| s.count),
            external_hash: ext.as_ref().map(|e| e.hash.clone()),
            external_count: ext.as_ref().map(|e| e.count),
            needs_rescan: verdict.needs_rescan,
            reason: verdict.reason,
        })
    }

    /// Port of `rescanWatchOnlyAccounts`. Administrators only, and the wallet
    /// rescan is run only when the deployment opted in (`force` cannot bypass it,
    /// unlike the legacy route). Entries are then refreshed through the provider.
    pub fn rescan(
        &mut self,
        ctx: &AuthContext,
        address: Option<&str>,
        from_height: Option<u64>,
        to_height: Option<u64>,
        force: bool,
        tip: Option<u64>,
    ) -> Result<RescanReport> {
        ctx.require(Capability::Admin)?;
        let addrs: Vec<String> = match address {
            Some(a) => {
                let d = decode_address(a.trim(), self.net())?;
                if self.registry.entry(&d.text).is_none() {
                    return Err(Error::NotFound);
                }
                vec![d.text]
            }
            None => self.registry.state().entries.keys().cloned().collect(),
        };
        let lookback = self.cfg.rescan_lookback_blocks;
        let mut starts = Vec::new();
        let mut stale = false;
        for a in &addrs {
            if let Some(c) = self.registry.coverage(a, tip) {
                if c.needs_rescan || force {
                    stale = true;
                    if let Some(h) = rescan_start_height(
                        c.first_funding_height,
                        c.last_snapshot_height,
                        c.last_scanned_height,
                    ) {
                        starts.push(h.saturating_sub(lookback));
                    }
                }
            }
        }
        let from = from_height
            .or_else(|| starts.iter().min().copied())
            .unwrap_or_else(|| tip.or(self.registry.observed_tip()).unwrap_or(0).saturating_sub(lookback));
        const MAX_HEIGHT: u64 = 100_000_000;
        if from > MAX_HEIGHT || to_height.is_some_and(|t| t > MAX_HEIGHT || t < from) {
            return Err(Error::InvalidField("height range"));
        }
        let executed = self.cfg.rescan_opt_in && (force || stale);
        if executed {
            let params: Vec<Value> = match to_height {
                Some(t) => vec![json!(from), json!(t)],
                None => vec![json!(from)],
            };
            self.router
                .call(
                    RoutedMethod::Internal(InternalMethod::RescanBlockchain),
                    params,
                    &CallOpts::default(),
                )
                .map_err(to_error)?;
        }
        let (mut refreshed, mut failed) = (0, 0);
        for a in addrs {
            let pk = self.registry.pubkey_of(&a).map(str::to_string);
            match self.list_unspent(ctx, &a, pk.as_deref(), None) {
                Ok(_) => refreshed += 1,
                Err(_) => failed += 1,
            }
        }
        Ok(RescanReport {
            executed,
            from_height: from,
            to_height,
            refreshed,
            failed,
        })
    }

    // -- unsigned transactions --------------------------------------------------------

    fn fresh_utxos(&mut self, ctx: &AuthContext, dec: &DecodedAddress, pubkey: &str) -> Result<UtxoReply> {
        let r = self.list_unspent(ctx, &dec.text, Some(pubkey), None)?;
        if r.from_cache || r.height.is_none() {
            return Err(Error::SnapshotUnavailable(
                "a fresh provider snapshot with a source height is required to build",
            ));
        }
        Ok(r)
    }

    /// Build an unsigned PSBT paying `to`. Inputs come from a fresh provider
    /// snapshot of the registered `from` address; caller-supplied inputs only
    /// narrow that set. Change always returns to `from`.
    pub fn build_unsigned(&mut self, ctx: &AuthContext, req: &BuildTxRequest) -> Result<UnsignedTx> {
        ctx.require(Capability::Register)?;
        self.check_network(Some(&req.network))?;
        let from = decode_address(&req.from_address, self.net())?;
        let to = decode_address(&req.to_address, self.net())?;
        let pubkey = req
            .from_pubkey
            .clone()
            .or_else(|| self.registry.pubkey_of(&from.text).map(str::to_string))
            .ok_or(Error::InvalidField("pubkey"))?;
        let reply = self.fresh_utxos(ctx, &from, &pubkey)?;
        let candidates: Vec<Utxo> = if req.inputs.is_empty() {
            reply.utxos
        } else {
            let wanted: BTreeSet<OutPoint> = req.inputs.iter().copied().collect();
            let have: BTreeSet<OutPoint> = reply.utxos.iter().map(|u| u.outpoint).collect();
            if !wanted.is_subset(&have) {
                return Err(Error::InputNotVerified);
            }
            reply.utxos.into_iter().filter(|u| wanted.contains(&u.outpoint)).collect()
        };
        tx::build_unsigned(&BuildPlan {
            from: &from,
            to: &to,
            amount: req.amount,
            required: Vec::new(),
            candidates,
            payload: req.payload.clone(),
            fee: self.cfg.fee,
            fee_mode: self.cfg.fee_mode,
        })
    }

    /// Build the unsigned trade transaction: channel commit outputs are spent
    /// first (their amount and script come from `oracle`, never from the
    /// caller), the buyer's wallet outputs top up, the seller is paid and the
    /// change returns to the buyer.
    pub fn build_trade_unsigned(
        &mut self,
        ctx: &AuthContext,
        req: &TradeTxRequest,
        oracle: &mut dyn OutpointOracle,
    ) -> Result<UnsignedTx> {
        ctx.require(Capability::Register)?;
        self.check_network(Some(&req.network))?;
        let buyer = decode_address(&req.buyer_address, self.net())?;
        let seller = decode_address(&req.seller_address, self.net())?;
        let pubkey = req
            .buyer_pubkey
            .clone()
            .or_else(|| self.registry.pubkey_of(&buyer.text).map(str::to_string))
            .ok_or(Error::InvalidField("pubkey"))?;
        let mut required = Vec::new();
        let mut commit_ops = BTreeSet::new();
        for c in &req.commit_utxos {
            if !commit_ops.insert(c.outpoint) {
                return Err(Error::DuplicateOutpoint);
            }
            let out = oracle
                .unspent_output(&c.outpoint)
                .map_err(|_| Error::InputNotVerified)?
                .ok_or(Error::InputNotVerified)?;
            let script = ScriptBuf::from_bytes(out.script_pubkey);
            let witness_script = match &c.redeem_script {
                Some(ws) => {
                    if ScriptBuf::new_p2wsh(&WScriptHash::from(ws.as_script())) != script {
                        return Err(Error::InputNotVerified);
                    }
                    Some(ws.clone())
                }
                None => None,
            };
            required.push(Utxo {
                outpoint: c.outpoint,
                amount: Amount::from_sat(out.amount_sat),
                confirmations: out.confirmations,
                script_pubkey: script,
                witness_script,
                prev_tx: None,
            });
        }
        let reply = self.fresh_utxos(ctx, &buyer, &pubkey)?;
        let mut candidates: Vec<Utxo> = reply
            .utxos
            .into_iter()
            .filter(|u| !commit_ops.contains(&u.outpoint))
            .collect();
        if !req.inputs.is_empty() {
            let wanted: BTreeSet<OutPoint> = req.inputs.iter().copied().collect();
            candidates.retain(|u| wanted.contains(&u.outpoint));
        }
        tx::build_unsigned(&BuildPlan {
            from: &buyer,
            to: &seller,
            amount: req.amount,
            required,
            candidates,
            payload: req.payload.clone(),
            fee: self.cfg.fee,
            fee_mode: self.cfg.fee_mode,
        })
    }

    /// Validate a signed raw transaction and hand it to the provider. Returns
    /// the txid the provider reports.
    pub fn broadcast(&mut self, ctx: &AuthContext, raw_hex: &str) -> Result<Value> {
        ctx.require(Capability::Register)?;
        let tx = parse_raw_tx(raw_hex)?;
        if tx.input.iter().any(|i| i.script_sig.is_empty() && i.witness.is_empty()) {
            return Err(Error::InvalidField("transaction is not fully signed"));
        }
        let ok = self
            .router
            .call(
                RoutedMethod::Internal(InternalMethod::SendRawTransaction),
                vec![json!(raw_hex.trim().to_ascii_lowercase())],
                &CallOpts::default(),
            )
            .map_err(to_error)?;
        Ok(json!({ "txid": ok.data }))
    }

    /// Testnet faucet: capability, explicit network, fixed amount, per-address
    /// cooldown and a bounded log. (Legacy: unauthenticated, any network whose
    /// name ends in `TEST`, no limit.)
    pub fn faucet(&mut self, ctx: &AuthContext, address: &str) -> Result<Value> {
        ctx.require(Capability::Faucet)?;
        if !self.net().is_test() {
            return Err(Error::Forbidden("Faucet is allowed only on a test network"));
        }
        let dec = decode_address(address.trim(), self.net())?;
        let now = self.registry.now();
        if let Some(last) = self.faucet_log.get(&dec.text) {
            if now.saturating_sub(*last) < self.cfg.faucet_cooldown_ms {
                return Err(Error::Forbidden("faucet cooldown active"));
            }
        }
        if self.faucet_log.len() >= FAUCET_LOG_MAX {
            let cutoff = self.cfg.faucet_cooldown_ms;
            self.faucet_log.retain(|_, t| now.saturating_sub(*t) < cutoff);
            if self.faucet_log.len() >= FAUCET_LOG_MAX {
                return Err(Error::Forbidden("faucet is busy"));
            }
        }
        let ok = self
            .router
            .call(
                RoutedMethod::Internal(InternalMethod::SendToAddress),
                vec![json!(dec.text), coin_json(self.cfg.faucet_amount)],
                &CallOpts::default(),
            )
            .map_err(to_error)?;
        self.faucet_log.insert(dec.text, now);
        Ok(json!({ "txid": ok.data }))
    }
}

fn token_balance(v: &Value) -> Option<TokenBalance> {
    use crate::persist::decimal_text;
    let o = v.as_object()?;
    let pid = ["propertyId", "propertyid", "id", "propertyID"]
        .iter()
        .find_map(|k| o.get(*k).filter(|x| !x.is_null()))?;
    let property_id = match pid {
        Value::String(s) => s.trim().to_string(),
        Value::Number(n) => n.to_string(),
        _ => return None,
    };
    if property_id.is_empty() || property_id.len() > 32 {
        return None;
    }
    let f = |k: &str| o.get(k).and_then(decimal_text);
    Some(TokenBalance {
        property_id,
        ticker: ["ticker", "name", "label"]
            .iter()
            .find_map(|k| o.get(*k).and_then(Value::as_str))
            .map(|s| clip_text(s, 64)),
        amount: f("amount")?,
        available: f("available")?,
        reserved: f("reserved")?,
        margin: f("margin")?,
        vesting: f("vesting")?,
        channel: f("channel")?,
    })
}

fn balance_json(b: &TokenBalance) -> Value {
    let num = |s: &str| serde_json::from_str::<Value>(s).unwrap_or(Value::Null);
    json!({
        "propertyId": b.property_id,
        "ticker": b.ticker,
        "amount": num(&b.amount),
        "available": num(&b.available),
        "reserved": num(&b.reserved),
        "margin": num(&b.margin),
        "vesting": num(&b.vesting),
        "channel": num(&b.channel),
    })
}

// ---------------------------------------------------------------------------
// Request parsing
// ---------------------------------------------------------------------------

const FORBIDDEN_CLIENT_KEYS: [&str; 7] = [
    "fee",
    "fees",
    "feeRate",
    "change",
    "changeAddress",
    "changeKeyPair",
    "changeTo",
];

fn str_field<'a>(o: &'a Map<String, Value>, k: &'static str) -> Result<&'a str> {
    o.get(k)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or(Error::InvalidField(k))
}

fn key_pair(o: &Map<String, Value>, k: &'static str) -> Result<(String, Option<String>)> {
    let kp = o
        .get(k)
        .and_then(Value::as_object)
        .ok_or(Error::InvalidField(k))?;
    let addr = str_field(kp, "address")?.to_string();
    let pk = kp
        .get("pubkey")
        .and_then(Value::as_str)
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    Ok((addr, pk))
}

fn outpoint_of(v: &Value) -> Result<OutPoint> {
    let o = v.as_object().ok_or(Error::InvalidOutpoint("not an object"))?;
    let txid = utxo::parse_txid(str_field(o, "txid")?)?;
    let vout = o
        .get("vout")
        .and_then(Value::as_u64)
        .and_then(|n| u32::try_from(n).ok())
        .ok_or(Error::InvalidOutpoint("vout"))?;
    Ok(OutPoint { txid, vout })
}

fn outpoints(o: &Map<String, Value>, k: &str) -> Result<Vec<OutPoint>> {
    match o.get(k) {
        None | Some(Value::Null) => Ok(Vec::new()),
        Some(Value::Array(a)) => {
            if a.len() > MAX_PARAMS * 32 {
                return Err(Error::TooMany {
                    what: "inputs",
                    max: MAX_PARAMS * 32,
                });
            }
            a.iter().map(outpoint_of).collect()
        }
        _ => Err(Error::InvalidField("inputs")),
    }
}

fn payload_of(o: &Map<String, Value>) -> Result<Option<Vec<u8>>> {
    match o.get("payload") {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) if s.is_empty() => Ok(None),
        Some(Value::String(s)) => Ok(Some(s.as_bytes().to_vec())),
        _ => Err(Error::InvalidField("payload")),
    }
}

fn reject_client_fee_fields(o: &Map<String, Value>) -> Result<()> {
    if FORBIDDEN_CLIENT_KEYS.iter().any(|k| o.contains_key(*k)) {
        return Err(Error::InvalidField(
            "fee and change destination are chosen by the relayer",
        ));
    }
    Ok(())
}

#[derive(Debug, Clone)]
pub struct BuildTxRequest {
    pub network: String,
    pub from_address: String,
    pub from_pubkey: Option<String>,
    pub to_address: String,
    pub amount: Amount,
    pub payload: Option<Vec<u8>>,
    pub inputs: Vec<OutPoint>,
}

impl BuildTxRequest {
    /// Parse `txConfig` (the body's top-level `network` fills a missing one).
    pub fn from_json(tx_config: &Value, body_network: Option<&str>) -> Result<Self> {
        let o = tx_config.as_object().ok_or(Error::InvalidField("txConfig"))?;
        reject_client_fee_fields(o)?;
        let (from_address, from_pubkey) = key_pair(o, "fromKeyPair")?;
        let (to_address, _) = key_pair(o, "toKeyPair")?;
        let network = o
            .get("network")
            .and_then(Value::as_str)
            .or(body_network)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .ok_or(Error::InvalidField("network"))?
            .to_string();
        Ok(BuildTxRequest {
            network,
            from_address,
            from_pubkey,
            to_address,
            amount: Amount::from_json_coin(o.get("amount").ok_or(Error::InvalidField("amount"))?)?,
            payload: payload_of(o)?,
            inputs: outpoints(o, "inputs")?,
        })
    }
}

#[derive(Debug, Clone)]
pub struct CommitRef {
    pub outpoint: OutPoint,
    pub redeem_script: Option<ScriptBuf>,
}

#[derive(Debug, Clone)]
pub struct TradeTxRequest {
    pub network: String,
    pub buyer_address: String,
    pub buyer_pubkey: Option<String>,
    pub seller_address: String,
    pub amount: Amount,
    pub payload: Option<Vec<u8>>,
    pub commit_utxos: Vec<CommitRef>,
    pub inputs: Vec<OutPoint>,
}

impl TradeTxRequest {
    pub fn from_json(cfg: &Value) -> Result<Self> {
        let o = cfg.as_object().ok_or(Error::InvalidField("config"))?;
        reject_client_fee_fields(o)?;
        let (buyer_address, buyer_pubkey) = key_pair(o, "buyerKeyPair")?;
        let (seller_address, _) = key_pair(o, "sellerKeyPair")?;
        let mut commit_utxos = Vec::new();
        if let Some(Value::Array(a)) = o.get("commitUTXOs") {
            if a.len() > MAX_PARAMS * 32 {
                return Err(Error::TooMany {
                    what: "commit utxos",
                    max: MAX_PARAMS * 32,
                });
            }
            for c in a {
                let redeem_script = match c.get("redeemScript").and_then(Value::as_str) {
                    Some(s) => Some(utxo::parse_script_hex(s)?),
                    None => None,
                };
                commit_utxos.push(CommitRef {
                    outpoint: outpoint_of(c)?,
                    redeem_script,
                });
            }
        }
        Ok(TradeTxRequest {
            network: str_field(o, "network")?.to_string(),
            buyer_address,
            buyer_pubkey,
            seller_address,
            amount: Amount::from_json_coin(o.get("amount").ok_or(Error::InvalidField("amount"))?)?,
            payload: payload_of(o)?,
            commit_utxos,
            inputs: outpoints(o, "inputs")?,
        })
    }
}

/// Response body for an unsigned transaction.
pub fn unsigned_json(t: &UnsignedTx) -> Value {
    let outputs: Vec<Value> = t
        .outputs
        .iter()
        .map(|o| {
            json!({
                "role": match o.role {
                    tx::Role::Recipient => "recipient",
                    tx::Role::Change => "change",
                    tx::Role::Data => "data",
                },
                "scriptPubKey": hex(o.script.as_bytes()),
                "amount": coin_json(o.value),
            })
        })
        .collect();
    json!({
        "rawtx": encode::serialize_hex(&t.psbt.unsigned_tx),
        "psbtHex": t.psbt_hex(),
        "psbtBase64": t.psbt_base64(),
        "inputs": t.inputs.iter().map(utxo_json).collect::<Vec<_>>(),
        "outputs": outputs,
        "fee": coin_json(t.fee),
        "feeSat": t.fee.sat(),
    })
}

/// Bounded hex to consensus transaction.
pub fn parse_raw_tx(raw_hex: &str) -> Result<Transaction> {
    let t = raw_hex.trim();
    if t.len() > MAX_RAW_TX_BYTES * 2 {
        return Err(Error::TooLarge {
            what: "transaction",
            max: MAX_RAW_TX_BYTES,
        });
    }
    let bytes = crate::address::unhex(t).ok_or(Error::InvalidField("transaction hex"))?;
    encode::deserialize::<Transaction>(&bytes).map_err(|_| Error::InvalidField("transaction"))
}

/// Port of the local `decoderawtransaction` (`tx.service.ts:210`).
pub fn decode_raw_tx(raw_hex: &str) -> Result<Value> {
    let tx = parse_raw_tx(raw_hex)?;
    Ok(json!({
        "txid": tx.compute_txid().to_string(),
        "hash": tx.compute_wtxid().to_string(),
        "size": tx.total_size(),
        "vin": tx.input.iter().map(|i| json!({
            "txid": i.previous_output.txid.to_string(),
            "vout": i.previous_output.vout,
            "sequence": i.sequence.0,
        })).collect::<Vec<_>>(),
        "vout": tx.output.iter().enumerate().map(|(n, o)| json!({
            "n": n,
            "value": coin_json(Amount::from_sat(o.value.to_sat())),
            "scriptPubKey": hex(o.script_pubkey.as_bytes()),
        })).collect::<Vec<_>>(),
    }))
}

// ---------------------------------------------------------------------------
// Gateway hooks
// ---------------------------------------------------------------------------

fn account_of(params: &[Value]) -> Result<(Account, Option<String>)> {
    let o = params
        .first()
        .and_then(Value::as_object)
        .ok_or(Error::RpcBadRequest("address and pubkey are required"))?;
    let address = str_field(o, "address")?.to_string();
    let pubkey = o
        .get("pubkey")
        .or_else(|| o.get("pubKey"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or(Error::RpcBadRequest("address and pubkey are required"))?
        .to_string();
    let network = o.get("network").and_then(Value::as_str).map(str::to_string);
    Ok((Account { address, pubkey }, network))
}

/// Adapter binding a service to the RPC gateway. The caller's context is
/// passed through unchanged, so the watch-only methods keep their capability
/// checks even when reached through the public RPC surface.
pub struct ServiceHooks<'a, S: RegistryStore, C: Clock, T: RpcTransport> {
    pub service: &'a mut WatchOnlyService<S, C, T>,
}

impl<S: RegistryStore, C: Clock, T: RpcTransport> GatewayHooks for ServiceHooks<'_, S, C, T> {
    fn watchonly_register(&mut self, ctx: &AuthContext, params: &[Value]) -> Result<Value> {
        let (acct, network) = account_of(params)?;
        self.service.check_network(network.as_deref())?;
        let o = self.service.import_pubkey(ctx, &acct)?;
        Ok(json!({"address": o.address, "imported": o.imported, "skipped": o.skipped}))
    }

    fn watchonly_utxos(&mut self, ctx: &AuthContext, params: &[Value]) -> Result<Value> {
        let (acct, network) = account_of(params)?;
        let r = self
            .service
            .list_unspent(ctx, &acct.address, Some(&acct.pubkey), network.as_deref())?;
        Ok(json!({
            "address": r.address,
            "network": self.service.net().collator_name(),
            "utxos": r.utxos.iter().map(utxo_json).collect::<Vec<_>>(),
            "snapshot": { "sourceBlock": { "height": r.height }, "fromCache": r.from_cache },
        }))
    }

    fn observe(&mut self, ev: &RpcEvent<'_>) {
        let net = self.service.net().collator_name().to_string();
        let snap = MethodSnapshot {
            updated_at: self.service.registry.now(),
            route: Some(ev.route.clone()),
            address: ev.address.clone(),
            provider_node_id: ev.provider_node_id.map(str::to_string),
            network: Some(net),
            source_endpoint: Some("testnet-api".into()),
            summary: Some(ev.summary.clone()),
            payload: ev.payload.clone(),
        };
        // Cache failures never fail the request.
        let _ = self
            .service
            .registry
            .record_trade_layer_snapshot(&AuthContext::system(), ev.method, snap);
    }
}

/// Registry limits helper for adapters.
pub fn default_limits() -> Limits {
    Limits::default()
}
