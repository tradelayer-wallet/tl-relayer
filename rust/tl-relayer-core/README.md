# tl-relayer-core

Rust port of the contracts of the TradeLayer relayer (`tl-relayer`): watch-only registry,
address validation, unsigned-PSBT building, routed-RPC policy, external UTXO validation and
IP attestation. All I/O (HTTP, sockets, wallet/collator RPC, disk, wall clock, IP providers)
sits behind the traits in `src/ports.rs`; deterministic in-memory fakes are in `src/fakes.rs`.
No HTTP framework. The legacy Node service is not modified and keeps running.

- Baseline: `tl-relayer` `main` at `63c89cf24b5cbd17d49beeb1cf6d22e7dc2bf744`
  ("Add routed watch-only preflight and channel contract"). Branch `feat/rust-port`.
- Charter task: "Capture watch-only, unsigned-PSBT and routed-RPC contracts".
- Nothing here has been pushed, deployed, or run against a live node, collator or provider.
  CI (`.github/workflows/rust-tl-relayer-core.yml`) has not run; it runs only after a push.

## Inspected legacy sources (blob SHAs at the baseline)

| File | Blob |
|---|---|
| `src/services/watchonly-registry.service.ts` | `e477f924e7d841cb86a38d19a326aafbb70ea0cd` |
| `src/services/address.service.ts` | `66b3d3305f197a514a53119ee27a0e6d38ebc3f6` |
| `src/services/tx.service.ts` | `adc9ac05f8e19ddb0213729d72377c53757e5042` |
| `src/services/sochain.service.ts` | `00addc7f25227177d3b88e78f76a3b6dcf5e86b7` |
| `src/services/attestation.service.ts` | `c895e76e8311adb8c520a22b4e0b6ead2686e3c1` |
| `src/routes/rpc.route.ts` | `aa815103254e5b65837a521c7811f81900b24ef6` |
| `src/services/watchonly-external.service.ts` | `4cd2b0fb5f8438ff2ce75425ee6f839ca1600910` |
| `src/routes/address.route.ts` | `4e2a1f60031e20b7cf7432615b2a10ed096f2504` |
| `src/routes/tx.route.ts` | `612e382a4a6fdc6f13e86a077191ba125b0e329b` |

Also read: `routes/attestation.route.ts`, `routes/clearlist.route.ts` (header only), `config/*`,
`index.ts`, `libs/rpc-calls`, `agents.md`, `scripts/verify-routed-watchonly-flow.cjs`.

## What is ported

| Rust module | Legacy source | Contents |
|---|---|---|
| `network` | `tx.service.ts` `networks`, `watchonly-external.service.ts` `normalizeNetwork` | `Chain` x `Net` (Bitcoin/Litecoin/Dogecoin, main/test), exact-token parse, version bytes, HRPs, dust and money bounds |
| `money` | `safeNumber`, float arithmetic throughout | `Amount` in satoshis, exact decimal parse (no floats), checked arithmetic |
| `address` | `validateAddress`, `bitcoinjs` address use | per-network base58/bech32/bech32m decode, `validateaddress`-shaped JSON, compressed-pubkey parse, pubkey-to-address binding (P2PKH, P2WPKH, P2SH-P2WPKH, P2TR) |
| `utxo` | `normalizeSnapshotUtxo`, `computeSnapshotHash`, `deriveFirstFundingScanInfo` | validated `Utxo`, list validation (bounds, script ownership, duplicates), order-independent hash |
| `auth` | (none; PR #2 area) | `Principal`, `Capability`, `AuthContext`; authentication itself is an adapter concern |
| `registry` | `watchonly-registry.service.ts` | entries, ownership, limits, idempotent/batched registration, UTXO/token/scan snapshots, coverage, rescan start, bootstrap, transactional persistence through `RegistryStore` |
| `persist` | `persistRegistryEntries`, `loadRegistryFromDisk`, `toEntry` | v2 document encode/decode; tolerant legacy-file decode (array, `entries`, `accounts`) |
| `rpc` | `rpc.route.ts`, `callRpc`/`callAllocatedRpc`, listener builders | allowlist, `PublicMethod`/`InternalMethod` types, collator request/response mapping, per-method validation, gateway for `/:method`, `/allocated/...`, `/payload` and the three explicit routes, listener-mode body/query builders |
| `service` | `address.service.ts`, `sochain.service.ts` `listunspent`/`rescan`, `tx.service.ts` build/broadcast/decode | import via provider, `list_unspent`, balance, coverage verification, rescan, build (plain and trade), broadcast, faucet, request parsing |
| `tx` | `getEnoughInputs2`, `buildTx`, `buildTradeTx`, `buildLTCTradeTx`, `buildPsbt` | selection, size-based fee, change, OP_RETURN, PSBT assembly, wallet-side `audit_psbt` |
| `sochain` | `watchonly-external.service.ts`, `verifyWatchOnlyAccountCoverage` | bounded paging and strict response mapping behind `ExternalUtxoSource`, snapshot comparison |
| `attestation` | `attestation.service.ts`, `attestation.route.ts` | decision logic, bounded clock-driven cache, strict IP parse, explicit client-IP trust policy |
| `base64` | - | PSBT transport encoding only |

## Dependencies

- `bitcoin = "0.32"` (default features off, `std`): script/address/PSBT/consensus types and
  `base58`, `bech32`, `hashes`, `secp256k1` re-exports. No crypto is implemented here; no
  signing happens in this crate.
- `serde_json = "1"`: JSON values for RPC params, the persistence document and the parity
  fixture. No `serde` derive, no `arbitrary_precision` (amounts are parsed from text).
- Lockfile is committed; builds use `--locked --offline` against the WSL cargo cache.

## Compatibility table

Legend: **P** preserved contract, **R** repaired defect (regression test named), **V** versioned
change, **U** unresolved question.

### Repaired defects

| # | Legacy (file:line) | Defect | New behaviour | Regression test |
|---|---|---|---|---|
| R1 | `address.route.ts:71-118,208-241,270-415`; `watchonly-registry.service.ts` whole | Registry mutation (register, bootstrap, scan, snapshot, rescan) has no authentication | Every mutation needs an authenticated principal and a capability (`Register`, `WriteSnapshot`, `Admin`) | `registration_requires_an_authenticated_capability`, `regression_snapshot_mutation_needs_authorization_and_proof_of_ownership`, `bootstrap_is_admin_only_and_takes_accounts_only` |
| R2 | `watchonly-registry.service.ts:683-701`; `address.service.ts:622-639` | A later caller silently replaces the stored pubkey of an address; no check that the pubkey derives the address | Pubkey must be a valid compressed key that derives the address (unbindable kinds refused unless opted in); a different pubkey for a registered address is `PubkeyConflict` | `regression_victim_address_cannot_be_rebound_to_another_pubkey`, `pubkey_parsing_and_binding` |
| R3 | `address.route.ts:349-361`; `watchonly-registry.service.ts:1010-1074` | `POST /watchonly/snapshot` stores caller-supplied UTXOs for any address and creates entries with arbitrary pubkeys | Provider capability, entry must exist, every output must pay the registered script, no duplicates, bounded, source height required and never decreasing | same as R1 plus `snapshots_are_monotonic_bounded_and_height_stamped` |
| R4 | `watchonly-registry.service.ts:950-971` | Marking scan coverage records an empty UTXO snapshot and erases the real one | Coverage update touches scan metadata only | `regression_scan_marking_does_not_erase_the_utxo_snapshot` |
| R5 | registry, `address.route.ts:80-96`, `sochain.service.ts` | Unbounded entries, batches, UTXO lists, token lists, cached payloads, upstream error text | `Limits` on entries, per-principal quota, batch size, UTXOs, tokens, cached methods, payload bytes, text length; errors clipped to 512 chars | `regression_unbounded_registrations`, `trade_layer_cache_is_bounded`, `collator_replies_are_interpreted_like_the_legacy_mapping` |
| R6 | registry (`persist skipped`, e.g. lines 551, 670, 709, 736, 774, 1070) | Persistence failures are logged and success is returned; memory and disk diverge | Write-through transaction: state is replaced only after `RegistryStore::save` succeeds, otherwise `Error::Persist` and no change | `regression_persist_failure_is_an_error_and_state_is_unchanged` |
| R7 | `address.route.ts:139,349`; `sochain.service.ts:124,224` | Missing `await`: the summary is a Promise (serialised as `{}`), the snapshot route always replies `ok` with `{}`, snapshot writes race | Synchronous state transitions; every result is returned | by construction (no async in core) |
| R8 | `address.route.ts:136-141`; `address.service.ts:706` | Anyone can list every user's address/pubkey pairs and snapshots; the sync response embeds the whole registry | Reads are scoped to the owner unless `ReadAll`; sync returns only the submitted accounts | `visibility_is_scoped_to_the_owner`, `import_accounts_is_bounded_and_returns_only_submitted_results` |
| R9 | `address.route.ts:228-232`; `watchonly-registry.service.ts:566-616` | Bootstrap fetches a caller-chosen URL (SSRF) and merges its entries, snapshots and tokens | Admin only; the seed is operator configuration (`SeedSource`); only address/pubkey pairs are taken and they are validated | `bootstrap_is_admin_only_and_takes_accounts_only` |
| R10 | `address.service.ts:324-329,465-477`; `tx.service.ts:235-237`; `sochain.service.ts:479` | Without a collator, any method name goes to the listener/wallet RPC; `rescanblockchain` is routed through the generic path | `PublicMethod::parse` is the only way to make a client name forwardable; service-only methods are a closed enum | `regression_arbitrary_rpc_methods_are_never_forwarded`, Lean `gateway_sound`, `gateway_never_internal` |
| R11 | `rpc.route.ts:273-325` | Allocated route forwards client-chosen `service`, `network`, `timeoutMs`, provider | Service and network are pinned by configuration (mismatch is a 400), timeout 1-30000 ms, provider id sanitised | `regression_allocated_route_pins_service_network_and_timeout` |
| R12 | `rpc.route.ts:7-9,517-519` | `tl_watchonly_register`/`tl_watchonly_utxos` are on the public list and forwarded raw, bypassing any registry rule | Routed to `GatewayHooks` (the service), which enforces capability, binding, network and validation | `watchonly_methods_never_bypass_the_service`, `gateway_hooks_route_watchonly_methods_through_the_service` |
| R13 | `rpc.route.ts:369-478` | Address/id params are unvalidated (`String(obj)`, `Number(null) === 0`) and unbounded | Addresses must decode on the configured network, ids must be non-negative integers, params bounded (16 items / 16 KiB) | `special_cases_validate_and_shape_params`, `param_bounds_apply` |
| R14 | `tx.service.ts:174,379,472,548-552`; `watchonly-external.service.ts:102`; registry `:1061` | Money as binary floats (`Math.round(x*1e8)`, `toFixed`) | Integer satoshis; amounts parsed exactly from decimal text; more than 8 decimals is an error | `amounts_parse_exactly`, `conservation_holds_over_pseudo_random_cases` |
| R15 | `tx.service.ts:472-482,346` | `buildTx` has no change output: a 1,000,000 sat input paying 400,000 burns 601,000 as fee; fee is a constant 0.00001 | Size-based fee, change to the wallet's own script, hard fee ceiling, dust handling | `regression_change_always_pays_the_wallet_and_nothing_is_burnt`, Lean `build_conserves` |
| R16 | `tx.service.ts:552,625-630` | Trade builders can produce a negative change, use another constant fee | Same checked builder; negative or sub-dust change cannot occur | `required_inputs_are_always_spent_and_topped_up`, `trade_tx_uses_oracle_values_for_commit_outputs` |
| R17 | `tx.service.ts:533` | `cUtxo.vout === cUtxo.vout` is always true: every output of a commit txid is excluded | Only the exact commit outpoint is excluded | `trade_selection_only_excludes_the_exact_commit_outpoint` |
| R18 | `tx.service.ts:449-450,518,612-619,375-390` | Caller-supplied inputs, amounts and scripts go straight into `witnessUtxo` | Inputs come from a fresh validated provider snapshot (caller can only narrow it); commit outputs come from an `OutpointOracle`; P2WSH witness script must hash to the output; non-segwit inputs need the verified previous transaction | `regression_build_request_rejects_client_fee_and_change_and_unverified_inputs`, `trade_tx_uses_oracle_values_for_commit_outputs`, `legacy_chain_inputs_need_their_previous_transaction` |
| R19 | `tx.service.ts:138-145`; `tx.route.ts:196`; `watchonly-external.service.ts:28-37` | Network inferred from the address prefix (default BTC mainnet, `bcrt` mislabelled), unknown network falls back to LTC, any `*TEST*` string maps to LTCTEST | Network is explicit everywhere; addresses of another network are `AddressOnOtherNetwork` | `regression_network_never_inferred_from_prefix`, `network_parse_is_exact`, `regression_network_mismatch_between_addresses` |
| R20 | `address.route.ts:60-69`; `address.service.ts:598-604` | Unauthenticated faucet on any network named `*TEST`, no limit | `Faucet` capability, explicit test network, fixed amount, per-address cooldown, bounded log | `regression_faucet_is_capability_gated_network_gated_and_rate_limited` |
| R21 | `watchonly-external.service.ts:75-92`; `sochain.service.ts:16` | A non-success page ends the loop and the partial list is compared as complete; 20-page truncation is silent; no size bounds; a BlockCypher token is hard-coded in source | Any failure, truncation, oversize, duplicate or foreign script is an error (verification then reports "unavailable"); the token is not carried over (rotate it) | `regression_partial_or_hostile_external_data_is_an_error_not_a_comparison` |
| R22 | `attestation.route.ts:11-32`; `attestation.service.ts:122-148,232-252` | Forwarding headers are trusted from anyone; the raw value is interpolated into provider URLs; cache is unbounded | Headers honoured only with `trust_proxy_headers` (right-most trusted hop for XFF); IPs parsed as literals; bounded cache | `regression_ip_input_is_strict_and_cache_is_bounded`, `client_ip_trust_is_explicit` |
| R23 | `sochain.service.ts:34-40` (found by the parity harness) | `Number(null)` is `0`, so an unknown tip height yields a bogus first-funding height 0 | Unknown stays unknown | `first_funding_and_rescan_start_match_legacy` |
| R24 | `watchonly-registry.service.ts:259-262,845-854` (found by the parity harness) | `normalizeHeight(null)` is `0`: one unknown height forces a rescan from block 0 | Only known heights are considered | `first_funding_and_rescan_start_match_legacy` |
| R25 | `sochain.service.ts:464-467`; `address.route.ts:270-321` | `force: true` in an unauthenticated body bypasses `WATCHONLY_RESCAN_OPT_IN` and triggers a wallet rescan | Administrators only, and no rescan without the opt-in even with `force` | `regression_rescan_requires_admin_and_opt_in_even_with_force` |
| R26 | `watchonly-registry.service.ts:624-637` | "Chain tip" for coverage is the maximum height the registry itself recorded, so staleness cannot be detected | `coverage(addr, tip)` takes a real tip; the registry-derived value is flagged `tip_from_registry` | `coverage_matches_legacy_rules` |
| R27 | `address.service.ts:582-592` | On any error cached token balances are returned regardless of age | Cached data is served only within `snapshot_max_age_ms`; flagged `from_cache` | `balance_records_and_falls_back_to_a_fresh_cache_only`, `cache_fallback_is_bounded_by_age` |

### Preserved contracts (checked against the legacy code by the parity oracle where noted)

- The 25-method public allowlist and its order (oracle), method normalisation (oracle).
- The 23-entry listener-name table and `getTradeLayerListenerMethod` (oracle), `buildListenerBody`
  and `buildListenerQuery` for all documented methods (oracle), the GET method set.
- Collator `/rpc/route` body fields (`service`, `network`, `method`, `params`, `timeoutMs`,
  `preferredProviderNodeId`, `sourceEndpoint`); `result ?? data ?? payload` data mapping;
  `ok:false` and non-2xx handling; `no WebRTC RPC provider` to 503 `NO_RPC_PROVIDER`, other
  failures 502 `RPC_UPSTREAM_ERROR`, forbidden 403 `RPC_METHOD_FORBIDDEN`/`PAYLOAD_TYPE_FORBIDDEN`.
- Response shapes: bare payload for the special-case methods, `{data}` for the default
  passthrough, `{error:"..."}` for special-case 400s, `{error:{code,message}}` for coded errors.
- Registry field names and scan states (`new`, `imported`, `backfilled`, `live`, `stale`); coverage
  reason strings; external-comparison reason strings; first-funding derivation (oracle) and rescan
  start height for known heights (oracle).
- Largest-first candidate order (oracle); recipient pays the fee by default (`SubtractFromAmount`
  mirrors "recipient receives amount - fee"); OP_RETURN payload is the UTF-8 bytes of the string;
  PSBT version 2, `witnessUtxo`/`witnessScript`, final sequence `0xffffffff`.
- Attestation decision logic, banned list (oracle), source labels and messages, cache TTLs.

### Versioned changes

| # | Change |
|---|---|
| V1 | Registry file format v2 (`version`, `network`, `owner`, `amountSat`, token amounts as text). Legacy files load with validation; invalid entries are dropped and counted in `LoadReport`. |
| V2 | UTXO set hash: `sha256("v2\n" + "txid:vout:sats\n"...)` sorted, instead of SHA-256 of float JSON. Local and external hashes use the same format. |
| V3 | Fee is `ceil(vsize * rate / 1000)` with `rate` and `max_fee` configuration (defaults 10 sat/vB and 0.01 coin); the legacy 1000-sat constant is gone. |
| V4 | `validateaddress` is computed locally for the configured network. |
| V5 | Building requires an explicit network equal to the service network and a registered, fresh, height-stamped snapshot. |
| V6 | Pubkeys must be compressed; P2WSH and arbitrary P2SH addresses are refused unless `Policy::allow_unbound`. |
| V7 | Registry entries have owners; legacy entries are ownerless and visible only to `ReadAll` holders. |
| V8 | Amounts with more than 8 decimals are rejected instead of rounded (a client sending `0.1 + 0.2` gets an error). |
| V9 | Payload-encoder failures return 400 (legacy 500). |

### Unresolved questions (blockers carried from the charter)

1. **PR #2 (auth/WS/bootstrap/IP-trust) was not rebased onto or compared with this crate.** The
   capability names, how a principal is established, the trusted-proxy configuration and the
   WebSocket relay (`ws-relay.service.ts`, `socket.service.ts`) must be reconciled before cutover.
2. **Snapshot trust.** A snapshot is a provider assertion: `providerNodeId` is self-reported by
   the collator path, there is no multi-provider quorum, no signature over snapshots, and the
   SoChain comparison is advisory. A single malicious or lagging provider that passes the shape
   checks can still lie about balances within the monotonic-height rule.
3. **Reorgs.** Rejecting a lower source height protects against lagging providers but also blocks a
   legitimate rollback; an explicit reorg policy (administrator override or hash-linked heights)
   is needed.
4. **Unconfirmed and pending spends.** Snapshots do not model outputs already spent by an
   unconfirmed transaction the wallet built earlier; the same UTXO can be offered twice.
5. **Staleness windows and tip.** `snapshot_max_age_ms` (5 min) is arbitrary and the real chain tip
   must come from a trusted source; the registry-derived tip is only a fallback.
6. **P2WSH / channel watch-only addresses.** Binding is impossible for them; whether the product
   needs them registered (and with what authorisation) is undecided.
7. **Legacy entries are ownerless** and only `ReadAll` holders can see them; an adoption procedure
   is needed.
8. **Fee, dust and sequence policy** per chain (Dogecoin parameters are from chainparams, not
   verified against a node), P2SH-P2WPKH inputs unsupported, sequence kept final (no RBF).
9. **Attestation fails open** (preserved) when providers are unreachable; `FailurePolicy::Closed`
   exists but the product decision is open. Unknown country is never banned.
10. **Trade-layer state cache** is keyed by method only, so results for different addresses overwrite
    each other; nothing in the ported code reads it back, so its purpose is unknown.
11. Legacy `routeLegacyWatchOnlyCall` returns hard-coded `{ismine:false}`/`{blocks:null}` for
    `getaddressinfo`/`getblockchaininfo`; the port drops those calls instead of emulating them.
12. Token amounts are kept as validated decimal text; the divisible/indivisible representation of
    the provider API needs a contract with `tl-rpc`.
13. Legacy CORS is `origin: true, credentials: true` (`index.ts:46-50`) and the socket server uses
    `origin: "*"`; both belong to the adapter layer and are not addressed here.

## Not ported (and why)

- Fastify server, CORS, route registration, process start-up, the 5-minute reconcile timer and
  the atomic file writer: adapters. The `Registry` takes any `RegistryStore`.
- `ws-relay.service.ts`, `socket.service.ts`: WebSocket/socket.io transport (PR #2 area).
- `clearlist.route.ts`, `token.*`, `chain.*`: thin RPC wrappers outside this task's charter.
- `txEncoder.ts`: payload serialisation stays owned by the protocol core (`tl-wire`); the
  gateway only decides which payload types are public (`PayloadEncoder` trait).
- `finalizePsbt` and `computeMultisigData`: finalisation needs signature handling and is a
  signing-boundary concern; not required by the charter task.
- Direct-listener HTTP mode (collator unset): only the pure request builders are ported.
- Logging (the legacy code logs pubkeys, full request bodies and raw transactions); the core
  logs nothing.

## Commands

```
TOOLS=/mnt/c/Users/patri/Documents/Codex/2026-10-30/new-chat/work/tools
C=C:/Users/patri/Documents/Codex/2026-10-30/new-chat/work/repos/tl-relayer/rust/tl-relayer-core
MSYS_NO_PATHCONV=1 wsl.exe -d Ubuntu-24.04 -- bash $TOOLS/rust.sh $C test --locked --offline
MSYS_NO_PATHCONV=1 wsl.exe -d Ubuntu-24.04 -- bash $TOOLS/rust.sh $C clippy --locked --offline --all-targets -- -D warnings
MSYS_NO_PATHCONV=1 wsl.exe -d Ubuntu-24.04 -- bash $TOOLS/rust.sh $C fmt --all -- --check
MSYS_NO_PATHCONV=1 wsl.exe -d Ubuntu-24.04 -- bash $TOOLS/lean.sh $C/lean        # prints LEAN_CHECK_OK
node --experimental-strip-types scripts/compare-legacy.cjs                          # regenerate fixtures/legacy-parity.json (Node >= 22.6)
```

## Parity harness

`scripts/compare-legacy.cjs` loads the pinned legacy `.ts` files (it refuses to run if a blob
SHA differs), replaces imports with inert shims, lets Node strip the types, and records the
outputs of the pure functions (listener table and builders, allowlist, normalisation,
first-funding, rescan start, `getEnoughInputs2` ordering and constant fee, network inference,
`safeNumber`, attestation helpers) for fixed inputs. It never touches the network and installs
nothing. `tests/parity.rs` replays the same inputs against the Rust port. The two repaired
`Number(null) === 0` behaviours (R23, R24) were found this way and are asserted as intended
divergences. Not covered by the oracle: anything that needs `bitcoinjs-lib`, `axios`, `fastify`
or the filesystem (PSBT bytes, HTTP, persistence).

## Lean

`lean/` (Lean 4 v4.34.1, core only, no Mathlib, no `sorry`/`axiom`). The models are
re-statements of the Rust decision functions, not extracted code.

| Lean definition | Models | Abstraction |
|---|---|---|
| `Rpc.gateway`, `Rpc.forwardable` | `PublicMethod::parse`, `RoutedMethod` | `norm` stands for `trim().to_lowercase()`; vectors use `id` |
| `Registry.register`, `insertStep`, `lookup`, `count` | `Registry::register`, `apply_register` | addresses/pubkeys/principals are `Nat`; `bind` is the opaque `bind_pubkey`; timestamps and counters dropped |
| `Registry.visible`, `recordHeight`, `commit` | `Registry::list`, `apply_utxo_snapshot` height rule, `Registry::commit` | |
| `Tx.evaluate`, `finish`, `build`, `outputs` | `tx::evaluate`, `finish`, `build_unsigned` loop | P2WPKH-only sizes (68/31 vB), one recipient, no data output; the Rust size table generalises only `vsize` |

Theorems (all in `AxiomCheck.lean`, axioms limited to `propext`/`Quot.sound`):

- `Rpc`: `allowlist_length`, `allowlist_nodup`, `allowlist_internal_disjoint`, `gateway_sound`,
  `gateway_rejects`, `gateway_never_internal`, `gateway_forwardable`, `unlisted_not_forwardable`.
- `Registry`: `register_authorized` (success needs an authenticated caller with the capability),
  `register_binds`, `register_anonymous`, `register_size` (never above `maxEntries`),
  `insertStep_quota` (never above `maxPer` per principal), `insertStep_preserves` (entries and
  owners are never replaced), `insertStep_conflict`, `insertStep_idempotent`,
  `register_idempotent`, `visible_scoped`, `recordHeight_monotone`, `recordHeight_rejects_older`,
  `commit_failed_unchanged`.
- `Tx`: `feeFor_mono`, `finish_spec`, `evaluate_spec` (conservation, fee bound, no dust outputs,
  fee at least the no-change relay fee), `build_spec` (also: inputs are the required list plus a
  prefix of the ordered candidates, and the input count stays within the bound),
  `outputs_destinations` (outputs go only to the recipient or the wallet), `outputs_sum`,
  `build_conserves` (inputs = outputs + fee, fee <= bound, destinations restricted).

Vectors tied to Rust: `feeFor 141 10000 = 1410`, `feeFor 110 10000 = 1100`; evaluate/build
vectors (1,000,000 input paying 400,000 gives 398,590 + 600,000 change + 1,410 fee; the
dust-change case 98,900 + 1,600 fee; the `[300000,200000,150000]` selection gives
447,910 + 50,000 + 2,090) are asserted in `tests/tx.rs`; registry and allowlist vectors mirror
`tests/registry.rs` and `tests/rpc.rs`.

## Remaining gaps

- No live check against a collator, provider, wallet node, SoChain or the IP vendors.
- `tl_watchonly_*` request/response shapes follow the legacy code and `agents.md`; the provider
  side (`tl-collator`, node) was not read.
- Dogecoin support is address/PSBT-level only and untested against a node.
- Lean does not model PSBT bytes, address decoding, JSON handling or the persistence format; those
  are covered by Rust tests only.
- Concurrency: the core is single-writer by construction (`&mut self`); multi-writer access to
  one state file needs an adapter-level lock.
