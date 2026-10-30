//! Watch-only registry: registration, ownership, limits, snapshots, coverage.
//!
//! Port of `watchonly-registry.service.ts`. Every mutation is a transaction:
//! the new state is built on a copy, written through the [`RegistryStore`], and
//! only then becomes visible. A failed write leaves the registry unchanged and
//! returns an error (the legacy code logged "persist skipped" and reported
//! success while memory and disk diverged).

use crate::address::{bind_pubkey, decode_address, parse_pubkey, Binding, DecodedAddress};
use crate::auth::{AuthContext, Capability, Principal};
use crate::error::{Error, Result};
use crate::money::Amount;
use crate::network::Network;
use crate::persist;
use crate::ports::{Clock, RegistryStore, SeedSource};
use crate::utxo::{self, Utxo};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Limits {
    pub max_entries: usize,
    pub max_entries_per_principal: usize,
    pub max_batch: usize,
    pub max_utxos: usize,
    pub max_tokens: usize,
    pub max_methods: usize,
    pub max_payload_bytes: usize,
    pub max_text: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Limits {
            max_entries: 10_000,
            max_entries_per_principal: 1_000,
            max_batch: 100,
            max_utxos: 2_000,
            max_tokens: 256,
            max_methods: 64,
            max_payload_bytes: 256 * 1024,
            max_text: 256,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Policy {
    /// Accept P2WSH / arbitrary P2SH addresses whose keys cannot be checked.
    pub allow_unbound: bool,
    /// Refuse snapshots that carry no source block height.
    pub require_snapshot_height: bool,
}

impl Default for Policy {
    fn default() -> Self {
        Policy {
            allow_unbound: false,
            require_snapshot_height: true,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScanState {
    New,
    Imported,
    Backfilled,
    Live,
    Stale,
}

impl ScanState {
    pub fn as_str(self) -> &'static str {
        match self {
            ScanState::New => "new",
            ScanState::Imported => "imported",
            ScanState::Backfilled => "backfilled",
            ScanState::Live => "live",
            ScanState::Stale => "stale",
        }
    }

    pub fn parse(s: &str) -> Option<ScanState> {
        match s.trim().to_ascii_lowercase().as_str() {
            "new" => Some(ScanState::New),
            "imported" => Some(ScanState::Imported),
            "backfilled" => Some(ScanState::Backfilled),
            "live" => Some(ScanState::Live),
            "stale" => Some(ScanState::Stale),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct UtxoSnapshot {
    pub hash: String,
    pub count: usize,
    pub total: Amount,
    pub updated_at: u64,
    pub scanned_height: Option<u64>,
    pub scan_source_node_id: Option<String>,
    pub utxos: Vec<Utxo>,
}

/// Token amounts are kept as validated decimal text; the relayer never does
/// arithmetic on them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TokenBalance {
    pub property_id: String,
    pub ticker: Option<String>,
    pub amount: String,
    pub available: String,
    pub reserved: String,
    pub margin: String,
    pub vesting: String,
    pub channel: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct TokenSnapshot {
    pub updated_at: u64,
    pub scanned_height: Option<u64>,
    pub scan_source_node_id: Option<String>,
    pub balances: Vec<TokenBalance>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct MethodSnapshot {
    pub updated_at: u64,
    pub route: Option<String>,
    pub address: Option<String>,
    pub provider_node_id: Option<String>,
    pub network: Option<String>,
    pub source_endpoint: Option<String>,
    pub summary: Option<Value>,
    pub payload: Value,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Entry {
    pub address: String,
    pub pubkey: String,
    /// `None` only for entries migrated from a legacy file.
    pub owner: Option<Principal>,
    pub source: String,
    pub assigned_provider_node_id: Option<String>,
    pub assigned_at: Option<u64>,
    pub first_seen_at: u64,
    pub first_funding_height: Option<u64>,
    pub first_funding_txid: Option<String>,
    pub last_seen_at: u64,
    pub last_imported_at: Option<u64>,
    pub import_count: u64,
    pub scan_state: Option<ScanState>,
    pub last_scanned_at: Option<u64>,
    pub last_scanned_height: Option<u64>,
    pub scan_source_node_id: Option<String>,
    pub last_snapshot_height: Option<u64>,
    pub last_error: Option<String>,
    pub utxo_snapshot: Option<UtxoSnapshot>,
    pub token_snapshot: Option<TokenSnapshot>,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct State {
    pub entries: BTreeMap<String, Entry>,
    pub trade_layer_updated_at: Option<u64>,
    pub trade_layer: BTreeMap<String, MethodSnapshot>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct LoadReport {
    pub loaded: usize,
    pub dropped_invalid: usize,
    pub truncated: usize,
    pub legacy_format: bool,
}

/// Raw account as received from a client.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Account {
    pub address: String,
    pub pubkey: String,
}

#[derive(Debug, Clone, Default)]
pub struct RegisterOpts {
    pub source: Option<String>,
    /// The provider confirmed the import.
    pub imported: bool,
    pub provider_node_id: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RegisterOutcome {
    pub address: String,
    pub created: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BatchResult {
    pub address: String,
    pub pubkey: String,
    pub imported: bool,
    pub refreshed: bool,
    pub skipped: bool,
    pub updated: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct BatchSummary {
    pub imported: usize,
    pub refreshed: usize,
    pub skipped: usize,
    pub updated: usize,
    pub failed: usize,
    pub results: Vec<BatchResult>,
}

#[derive(Debug, Clone)]
pub struct SnapshotInput {
    pub address: String,
    pub utxos: Vec<Utxo>,
    pub scanned_height: Option<u64>,
    pub scan_source_node_id: Option<String>,
    pub scan_state: Option<ScanState>,
    pub first_funding_height: Option<u64>,
    pub first_funding_txid: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Coverage {
    pub address: String,
    pub pubkey: String,
    pub first_funding_height: Option<u64>,
    pub first_funding_txid: Option<String>,
    pub current_tip_height: Option<u64>,
    pub tip_from_registry: bool,
    pub last_scanned_height: Option<u64>,
    pub last_snapshot_height: Option<u64>,
    pub scan_state: ScanState,
    pub needs_rescan: bool,
    pub reason: &'static str,
}

struct Env {
    network: Network,
    limits: Limits,
    policy: Policy,
    now: u64,
}

pub struct Registry<S: RegistryStore, C: Clock> {
    network: Network,
    limits: Limits,
    policy: Policy,
    store: S,
    clock: C,
    state: State,
}

/// Provider / node identifiers are echoed into the registry; keep them small
/// and printable.
pub fn sanitize_node_id(s: &str) -> Option<String> {
    let t = s.trim();
    if t.is_empty()
        || t.len() > 128
        || !t
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._:@-/".contains(&b))
    {
        None
    } else {
        Some(t.to_string())
    }
}

pub fn clip_text(s: &str, max: usize) -> String {
    s.chars()
        .filter(|c| !c.is_control())
        .take(max)
        .collect::<String>()
}

impl<S: RegistryStore, C: Clock> Registry<S, C> {
    /// Load the registry from the store. A missing document is an empty
    /// registry; a document for a different network is an error.
    pub fn open(
        network: Network,
        limits: Limits,
        policy: Policy,
        mut store: S,
        clock: C,
    ) -> Result<(Self, LoadReport)> {
        let now = clock.now_ms();
        let (state, report) = match store.load().map_err(Error::Persist)? {
            None => (State::default(), LoadReport::default()),
            Some(text) => persist::decode(&text, network, &limits, &policy, now)?,
        };
        Ok((
            Registry {
                network,
                limits,
                policy,
                store,
                clock,
                state,
            },
            report,
        ))
    }

    pub fn network(&self) -> Network {
        self.network
    }

    pub fn limits(&self) -> &Limits {
        &self.limits
    }

    pub fn policy(&self) -> &Policy {
        &self.policy
    }

    pub fn len(&self) -> usize {
        self.state.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.state.entries.is_empty()
    }

    pub fn state(&self) -> &State {
        &self.state
    }

    pub fn now(&self) -> u64 {
        self.clock.now_ms()
    }

    fn commit<R>(&mut self, f: impl FnOnce(&Env, &mut State) -> Result<R>) -> Result<R> {
        let env = Env {
            network: self.network,
            limits: self.limits,
            policy: self.policy,
            now: self.clock.now_ms(),
        };
        let mut next = self.state.clone();
        let r = f(&env, &mut next)?;
        if next != self.state {
            let doc = persist::encode(&next, self.network, env.now);
            self.store.save(&doc).map_err(Error::Persist)?;
            self.state = next;
        }
        Ok(r)
    }

    // -- registration -----------------------------------------------------

    /// Register (or refresh) one watch-only account.
    pub fn register(
        &mut self,
        ctx: &AuthContext,
        acct: &Account,
        opts: &RegisterOpts,
    ) -> Result<RegisterOutcome> {
        let owner = ctx.require(Capability::Register)?.clone();
        self.commit(|env, st| apply_register(env, st, &owner, acct, opts))
    }

    /// Register a batch (bounded). Per-account failures are reported in the
    /// summary and do not abort the batch; persistence happens once.
    pub fn register_batch(
        &mut self,
        ctx: &AuthContext,
        accounts: &[Account],
        opts: &RegisterOpts,
    ) -> Result<BatchSummary> {
        let owner = ctx.require(Capability::Register)?.clone();
        if accounts.len() > self.limits.max_batch {
            return Err(Error::TooMany {
                what: "accounts",
                max: self.limits.max_batch,
            });
        }
        self.commit(|env, st| Ok(apply_batch(env, st, &owner, accounts, opts)))
    }

    /// Remove an entry: its owner or an administrator.
    pub fn remove(&mut self, ctx: &AuthContext, address: &str) -> Result<()> {
        let p = ctx.require(Capability::Register)?.clone();
        let admin = ctx.has(Capability::Admin);
        let address = canon(self.network, address);
        self.commit(|_, st| {
            let e = st.entries.get(&address).ok_or(Error::NotFound)?;
            if !admin && e.owner.as_ref() != Some(&p) {
                return Err(Error::NotFound);
            }
            st.entries.remove(&address);
            Ok(())
        })
    }

    // -- snapshots ----------------------------------------------------------

    /// Record the latest UTXO snapshot. Requires `WriteSnapshot`; the entry must
    /// exist; every output must pay the registered address; the source height
    /// must not move backwards.
    pub fn record_utxo_snapshot(&mut self, ctx: &AuthContext, input: SnapshotInput) -> Result<()> {
        ctx.require(Capability::WriteSnapshot)?;
        self.commit(|env, st| apply_utxo_snapshot(env, st, input))
    }

    /// Update scan coverage metadata only. The legacy `markWatchOnlyScanCoverage`
    /// recorded an empty UTXO snapshot and thereby erased the real one.
    pub fn mark_scan_coverage(
        &mut self,
        ctx: &AuthContext,
        address: &str,
        scanned_height: Option<u64>,
        scan_source_node_id: Option<&str>,
        scan_state: Option<ScanState>,
    ) -> Result<()> {
        ctx.require(Capability::WriteSnapshot)?;
        let address = canon(self.network, address);
        let src = scan_source_node_id.and_then(sanitize_node_id);
        self.commit(|env, st| {
            let e = st.entries.get_mut(&address).ok_or(Error::NotFound)?;
            if let (Some(old), Some(new)) = (e.last_scanned_height, scanned_height) {
                if new < old {
                    return Err(Error::StaleSnapshot { have: old, got: new });
                }
            }
            e.last_seen_at = env.now;
            e.last_scanned_at = Some(env.now);
            if scanned_height.is_some() {
                e.last_scanned_height = scanned_height;
            }
            if src.is_some() {
                e.scan_source_node_id = src;
            }
            e.scan_state = scan_state.or(e.scan_state).or(Some(ScanState::Backfilled));
            Ok(())
        })
    }

    pub fn record_token_snapshot(
        &mut self,
        ctx: &AuthContext,
        address: &str,
        balances: Vec<TokenBalance>,
        scanned_height: Option<u64>,
        scan_source_node_id: Option<&str>,
    ) -> Result<()> {
        ctx.require(Capability::WriteSnapshot)?;
        let address = canon(self.network, address);
        let src = scan_source_node_id.and_then(sanitize_node_id);
        self.commit(|env, st| {
            if balances.len() > env.limits.max_tokens {
                return Err(Error::TooMany {
                    what: "token balances",
                    max: env.limits.max_tokens,
                });
            }
            let e = st.entries.get_mut(&address).ok_or(Error::NotFound)?;
            e.last_seen_at = env.now;
            e.token_snapshot = Some(TokenSnapshot {
                updated_at: env.now,
                scanned_height,
                scan_source_node_id: src.or_else(|| e.scan_source_node_id.clone()),
                balances,
            });
            Ok(())
        })
    }

    /// Cache a routed TradeLayer RPC result. Keys are the (bounded) public
    /// method set and payloads are size-limited; oversize payloads are skipped.
    pub fn record_trade_layer_snapshot(
        &mut self,
        ctx: &AuthContext,
        method: &str,
        snap: MethodSnapshot,
    ) -> Result<bool> {
        ctx.require(Capability::WriteSnapshot)?;
        let method = method.trim().to_ascii_lowercase();
        if method.is_empty() || method.len() > 64 {
            return Err(Error::InvalidField("method"));
        }
        self.commit(|env, st| {
            if snap.payload.to_string().len() > env.limits.max_payload_bytes {
                return Ok(false);
            }
            if !st.trade_layer.contains_key(&method) && st.trade_layer.len() >= env.limits.max_methods
            {
                return Err(Error::TooMany {
                    what: "cached methods",
                    max: env.limits.max_methods,
                });
            }
            st.trade_layer_updated_at = Some(env.now);
            st.trade_layer.insert(method, snap);
            Ok(true)
        })
    }

    // -- reads ---------------------------------------------------------------

    /// One entry, visible to its owner or to holders of `ReadAll`.
    pub fn get(&self, ctx: &AuthContext, address: &str) -> Result<Entry> {
        let p = ctx.principal().ok_or(Error::Unauthorized)?;
        let e = self
            .state
            .entries
            .get(&canon(self.network, address))
            .ok_or(Error::NotFound)?;
        if ctx.has(Capability::ReadAll) || e.owner.as_ref() == Some(p) {
            Ok(e.clone())
        } else {
            Err(Error::NotFound)
        }
    }

    /// Entries visible to the caller. The legacy `GET /address/watchonly`
    /// returned every user's address/pubkey pair to anyone.
    pub fn list(
        &self,
        ctx: &AuthContext,
        network: Option<Network>,
        address: Option<&str>,
    ) -> Result<Vec<Entry>> {
        let p = ctx.principal().ok_or(Error::Unauthorized)?;
        if let Some(n) = network {
            if n != self.network {
                return Ok(Vec::new());
            }
        }
        let all = ctx.has(Capability::ReadAll);
        Ok(self
            .state
            .entries
            .values()
            .filter(|e| address.is_none_or(|a| e.address == canon(self.network, a)))
            .filter(|e| all || e.owner.as_ref() == Some(p))
            .cloned()
            .collect())
    }

    /// Port of `getWatchOnlyRegistrySummary` (`version` 1).
    pub fn summary(&self, ctx: &AuthContext) -> Result<(u64, Vec<Entry>)> {
        let entries = self.list(ctx, None, None)?;
        Ok((self.clock.now_ms(), entries))
    }

    /// Service-internal lookup (no visibility check).
    pub fn entry(&self, address: &str) -> Option<&Entry> {
        self.state.entries.get(&canon(self.network, address))
    }

    pub fn pubkey_of(&self, address: &str) -> Option<&str> {
        self.entry(address).map(|e| e.pubkey.as_str())
    }

    /// Highest block height recorded by any entry. This is *not* the chain tip;
    /// callers should pass a real tip to [`Registry::coverage`] when they have one.
    pub fn observed_tip(&self) -> Option<u64> {
        self.state
            .entries
            .values()
            .flat_map(|e| {
                [
                    e.last_snapshot_height,
                    e.last_scanned_height,
                    e.first_funding_height,
                ]
            })
            .flatten()
            .max()
    }

    /// Port of `getWatchOnlyCoverage`. `tip` is the chain tip when known.
    pub fn coverage(&self, address: &str, tip: Option<u64>) -> Option<Coverage> {
        let e = self.entry(address)?;
        let (tip, from_registry) = match tip {
            Some(t) => (Some(t), false),
            None => (self.observed_tip(), true),
        };
        let covered = e.last_snapshot_height.or(e.last_scanned_height);
        let needs = match tip {
            None => covered.is_none(),
            Some(t) => covered.is_none_or(|c| c < t),
        };
        let reason = if e.last_imported_at.is_none() {
            "not imported"
        } else if e.first_funding_height.is_some() && covered.is_none() {
            "scan coverage can start at first funding height"
        } else if needs {
            "scan coverage is stale"
        } else {
            "scan coverage is current"
        };
        Some(Coverage {
            address: e.address.clone(),
            pubkey: e.pubkey.clone(),
            first_funding_height: e.first_funding_height,
            first_funding_txid: e.first_funding_txid.clone(),
            current_tip_height: tip,
            tip_from_registry: from_registry,
            last_scanned_height: e.last_scanned_height,
            last_snapshot_height: e.last_snapshot_height,
            scan_state: e.scan_state.unwrap_or(ScanState::Imported),
            needs_rescan: needs,
            reason,
        })
    }

    // -- bootstrap -------------------------------------------------------------

    /// Seed the registry from the configured seed source. Only account pairs
    /// are taken from the seed; snapshots and tokens in the seed document are
    /// ignored because they would be unauthenticated provider data. The seed URL
    /// is operator configuration; a caller cannot choose it.
    pub fn bootstrap(
        &mut self,
        ctx: &AuthContext,
        seed: &mut dyn SeedSource,
        force: bool,
    ) -> Result<BatchSummary> {
        ctx.require(Capability::Admin)?;
        if !force && !self.state.entries.is_empty() {
            return Ok(BatchSummary {
                skipped: self.state.entries.len(),
                ..Default::default()
            });
        }
        let doc = seed.fetch(self.network).map_err(Error::Upstream)?;
        let arr = doc
            .get("entries")
            .and_then(Value::as_array)
            .or_else(|| doc.as_array())
            .ok_or(Error::InvalidField("seed document"))?;
        if arr.len() > self.limits.max_entries {
            return Err(Error::TooMany {
                what: "seed entries",
                max: self.limits.max_entries,
            });
        }
        let accounts: Vec<Account> = arr
            .iter()
            .map(|v| Account {
                address: v.get("address").and_then(Value::as_str).unwrap_or("").into(),
                pubkey: v.get("pubkey").and_then(Value::as_str).unwrap_or("").into(),
            })
            .collect();
        let owner = Principal::new("bootstrap")?;
        let opts = RegisterOpts {
            source: Some("bootstrap".into()),
            ..Default::default()
        };
        self.commit(|env, st| {
            let mut sum = BatchSummary::default();
            for chunk in accounts.chunks(env.limits.max_batch.max(1)) {
                let part = apply_batch(env, st, &owner, chunk, &opts);
                sum.imported += part.imported;
                sum.refreshed += part.refreshed;
                sum.skipped += part.skipped;
                sum.updated += part.updated;
                sum.failed += part.failed;
                sum.results.extend(part.results);
            }
            Ok(sum)
        })
    }
}

/// Port of `resolveWatchOnlyRescanStartHeight`: the lowest known height.
pub fn rescan_start_height(
    first_funding: Option<u64>,
    last_snapshot: Option<u64>,
    last_scanned: Option<u64>,
) -> Option<u64> {
    [first_funding, last_snapshot, last_scanned]
        .into_iter()
        .flatten()
        .min()
}

// ---------------------------------------------------------------------------
// State transitions (pure, applied on a copy)
// ---------------------------------------------------------------------------

/// Decode the address for `network`, parse the pubkey and check that the key
/// derives the address (or that the kind is explicitly allowed to be unbound).
pub fn validate_account(
    network: Network,
    policy: &Policy,
    acct: &Account,
) -> Result<(DecodedAddress, String)> {
    let dec = decode_address(acct.address.trim(), network)?;
    let (pk, pk_hex) = parse_pubkey(acct.pubkey.trim())?;
    match bind_pubkey(&pk, &dec)? {
        Binding::Bound => {}
        Binding::Unverifiable if policy.allow_unbound => {}
        Binding::Unverifiable => return Err(Error::PubkeyUnbindable),
    }
    Ok((dec, pk_hex))
}

fn apply_register(
    env: &Env,
    st: &mut State,
    owner: &Principal,
    acct: &Account,
    opts: &RegisterOpts,
) -> Result<RegisterOutcome> {
    let (dec, pk_hex) = validate_account(env.network, &env.policy, acct)?;
    let key = dec.text.clone();
    let source = opts
        .source
        .as_deref()
        .map(|s| clip_text(s, env.limits.max_text))
        .filter(|s| !s.is_empty());
    let provider = opts.provider_node_id.as_deref().and_then(sanitize_node_id);
    let err = opts
        .error
        .as_deref()
        .map(|s| clip_text(s, env.limits.max_text))
        .filter(|s| !s.is_empty());

    if let Some(e) = st.entries.get_mut(&key) {
        if e.pubkey != pk_hex {
            return Err(Error::PubkeyConflict);
        }
        e.last_seen_at = env.now;
        if let Some(s) = source {
            e.source = s;
        }
        if opts.imported {
            if e.last_imported_at.is_none() {
                e.import_count += 1;
                e.last_imported_at = Some(env.now);
            }
            if let Some(p) = provider {
                if e.assigned_provider_node_id.is_none() {
                    e.assigned_provider_node_id = Some(p);
                    e.assigned_at = Some(env.now);
                }
            }
            e.last_error = None;
        }
        if err.is_some() {
            e.last_error = err;
        }
        return Ok(RegisterOutcome {
            address: key,
            created: false,
        });
    }

    if st.entries.len() >= env.limits.max_entries {
        return Err(Error::TooMany {
            what: "registry entries",
            max: env.limits.max_entries,
        });
    }
    let owned = st
        .entries
        .values()
        .filter(|e| e.owner.as_ref() == Some(owner))
        .count();
    if owned >= env.limits.max_entries_per_principal {
        return Err(Error::TooMany {
            what: "entries for this principal",
            max: env.limits.max_entries_per_principal,
        });
    }
    let entry = Entry {
        address: key.clone(),
        pubkey: pk_hex,
        owner: Some(owner.clone()),
        source: source.unwrap_or_else(|| "sync-watchonly".into()),
        assigned_provider_node_id: provider.clone(),
        assigned_at: provider.as_ref().map(|_| env.now),
        first_seen_at: env.now,
        first_funding_height: None,
        first_funding_txid: None,
        last_seen_at: env.now,
        last_imported_at: opts.imported.then_some(env.now),
        import_count: u64::from(opts.imported),
        scan_state: Some(ScanState::Imported),
        last_scanned_at: None,
        last_scanned_height: None,
        scan_source_node_id: None,
        last_snapshot_height: None,
        last_error: if opts.imported { None } else { err },
        utxo_snapshot: None,
        token_snapshot: None,
    };
    st.entries.insert(key.clone(), entry);
    Ok(RegisterOutcome {
        address: key,
        created: true,
    })
}

fn apply_batch(
    env: &Env,
    st: &mut State,
    owner: &Principal,
    accounts: &[Account],
    opts: &RegisterOpts,
) -> BatchSummary {
    let mut sum = BatchSummary::default();
    let mut seen: BTreeSet<(String, String)> = BTreeSet::new();
    for a in accounts {
        let addr = a.address.trim().to_string();
        let pk = a.pubkey.trim().to_string();
        if addr.is_empty() || pk.is_empty() {
            sum.failed += 1;
            sum.results.push(BatchResult {
                address: addr,
                pubkey: pk,
                imported: false,
                refreshed: false,
                skipped: false,
                updated: false,
                error: Some("Invalid watch-only account".into()),
            });
            continue;
        }
        if !seen.insert((addr.clone(), pk.to_ascii_lowercase())) {
            sum.skipped += 1;
            sum.results.push(BatchResult {
                address: addr,
                pubkey: pk,
                imported: false,
                refreshed: false,
                skipped: true,
                updated: false,
                error: None,
            });
            continue;
        }
        // Each account is atomic: a failure leaves no partial entry behind.
        let mut scratch = st.clone();
        match apply_register(env, &mut scratch, owner, a, opts) {
            Ok(o) => {
                *st = scratch;
                if o.created {
                    sum.imported += 1;
                } else {
                    sum.refreshed += 1;
                    sum.skipped += 1;
                }
                sum.updated += 1;
                sum.results.push(BatchResult {
                    address: o.address,
                    pubkey: pk,
                    imported: o.created,
                    refreshed: !o.created,
                    skipped: !o.created,
                    updated: true,
                    error: None,
                });
            }
            Err(e) => {
                sum.failed += 1;
                sum.results.push(BatchResult {
                    address: addr,
                    pubkey: pk,
                    imported: false,
                    refreshed: false,
                    skipped: false,
                    updated: false,
                    error: Some(e.to_string()),
                });
            }
        }
    }
    sum
}

fn apply_utxo_snapshot(env: &Env, st: &mut State, input: SnapshotInput) -> Result<()> {
    let key = canon(env.network, &input.address);
    let e = st.entries.get_mut(&key).ok_or(Error::NotFound)?;
    if input.utxos.len() > env.limits.max_utxos {
        return Err(Error::TooMany {
            what: "utxos",
            max: env.limits.max_utxos,
        });
    }
    if env.policy.require_snapshot_height && input.scanned_height.is_none() {
        return Err(Error::SnapshotUnavailable("missing source block height"));
    }
    if let (Some(old), Some(new)) = (e.last_snapshot_height, input.scanned_height) {
        if new < old {
            return Err(Error::StaleSnapshot { have: old, got: new });
        }
    }
    let dec = decode_address(&e.address, env.network)?;
    let mut seen = BTreeSet::new();
    for u in &input.utxos {
        utxo::check_utxo_for(u, &dec)?;
        if !seen.insert(u.outpoint) {
            return Err(Error::DuplicateOutpoint);
        }
    }
    if let Some(t) = &input.first_funding_txid {
        utxo::parse_txid(t)?;
    }
    let total = utxo::total_amount(&input.utxos)?;
    let src = input
        .scan_source_node_id
        .as_deref()
        .and_then(sanitize_node_id)
        .or_else(|| e.scan_source_node_id.clone());
    // Stored outputs keep only what a snapshot needs.
    let utxos: Vec<Utxo> = input
        .utxos
        .iter()
        .map(|u| Utxo {
            witness_script: None,
            prev_tx: None,
            ..u.clone()
        })
        .collect();
    e.last_seen_at = env.now;
    e.scan_state = Some(input.scan_state.or(e.scan_state).unwrap_or(ScanState::Live));
    e.last_scanned_at = Some(env.now);
    if input.scanned_height.is_some() {
        e.last_scanned_height = input.scanned_height;
        e.last_snapshot_height = input.scanned_height;
    }
    if input.first_funding_height.is_some() {
        e.first_funding_height = input.first_funding_height;
    }
    if input.first_funding_txid.is_some() {
        e.first_funding_txid = input.first_funding_txid.clone();
    }
    if e.assigned_provider_node_id.is_none() {
        e.assigned_provider_node_id = src.clone();
    }
    e.scan_source_node_id = src.clone();
    e.utxo_snapshot = Some(UtxoSnapshot {
        hash: utxo::snapshot_hash(&utxos),
        count: utxos.len(),
        total,
        updated_at: env.now,
        scanned_height: input.scanned_height,
        scan_source_node_id: src,
        utxos,
    });
    Ok(())
}

/// Registry key for `address`: the canonical text when it decodes on `network`
/// (bech32 lowercased), otherwise the trimmed input (which simply will not match).
pub fn canon(network: Network, address: &str) -> String {
    decode_address(address.trim(), network)
        .map(|d| d.text)
        .unwrap_or_else(|_| address.trim().to_string())
}
