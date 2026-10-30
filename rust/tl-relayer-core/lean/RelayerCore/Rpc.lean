/-!
Routed-RPC policy model (`src/rpc.rs`).

`allowlist` is `PUBLIC_RPC_METHODS` (25 entries, same order as `rpc.route.ts:6-32`).
`gateway` models `PublicMethod::parse`: the only way a client-chosen method name
becomes forwardable. `internalMethods` are the methods only services may route
(`InternalMethod`); they are disjoint from the allowlist, so no client name reaches
them. `norm` abstracts `String::trim().to_lowercase()`.
-/
namespace RelayerCore.Rpc

def allowlist : List String :=
  [ "tl_getstatesnapshot", "tl_watchonly_register", "tl_watchonly_utxos", "tl_getsyncstatus"
  , "tl_getallbalancesforaddress", "tl_getchannel", "tl_getchannelcolumn", "tl_getcontractinfo"
  , "tl_getattestations", "tl_gettransaction", "tl_getclearlistbyid", "tl_listcontractseries"
  , "tl_getinitmargin", "tl_channelbalanceforcommiter", "tl_getmaxsynth", "tl_contractposition"
  , "tl_tokentradehistoryforaddress", "tl_contracttradehistoryforaddress"
  , "tl_totaltradehistoryforaddress", "tl_getinfo", "tl_getbalance", "tl_getproperty"
  , "tl_listproperties", "tl_createpayload_attestation", "tl_createpayload_commit_tochannel" ]

def internalMethods : List String :=
  [ "rescanblockchain", "sendtoaddress", "sendrawtransaction" ]

/-- `PublicMethod::parse`: normalise, then accept only allowlisted names. -/
def gateway (norm : String → String) (raw : String) : Option String :=
  if norm raw ∈ allowlist then some (norm raw) else none

/-- What a transport may be asked to send: public names or service-only names. -/
def forwardable (m : String) : Bool :=
  decide (m ∈ allowlist ∨ m ∈ internalMethods)

theorem allowlist_length : allowlist.length = 25 := by decide

theorem allowlist_nodup : allowlist.Nodup := by decide

theorem allowlist_internal_disjoint :
    ∀ m, m ∈ allowlist → m ∉ internalMethods := by decide

/-- Soundness: whatever the gateway accepts is on the allowlist. -/
theorem gateway_sound (norm : String → String) (raw m : String)
    (h : gateway norm raw = some m) : m ∈ allowlist := by
  unfold gateway at h
  split at h
  · rename_i hc
    injection h with h'
    subst h'
    exact hc
  · cases h

/-- A name outside the allowlist is never accepted. -/
theorem gateway_rejects (norm : String → String) (raw : String)
    (h : norm raw ∉ allowlist) : gateway norm raw = none := by
  unfold gateway
  simp [h]

/-- No client-supplied name reaches an internal-only method. -/
theorem gateway_never_internal (norm : String → String) (raw m : String)
    (h : gateway norm raw = some m) : m ∉ internalMethods :=
  allowlist_internal_disjoint m (gateway_sound norm raw m h)

/-- Everything the gateway accepts is forwardable. -/
theorem gateway_forwardable (norm : String → String) (raw m : String)
    (h : gateway norm raw = some m) : forwardable m = true := by
  have := gateway_sound norm raw m h
  simp [forwardable, this]

/-- Nothing outside `allowlist ∪ internalMethods` is forwardable. -/
theorem unlisted_not_forwardable (m : String)
    (h1 : m ∉ allowlist) (h2 : m ∉ internalMethods) : forwardable m = false := by
  simp [forwardable, h1, h2]

-- Concrete vectors (also asserted by `tests/rpc.rs`), with `norm := id`.
example : gateway id "tl_getinfo" = some "tl_getinfo" := by decide
example : gateway id "getblockchaininfo" = none := by decide
example : gateway id "sendtoaddress" = none := by decide
example : gateway id "rescanblockchain" = none := by decide
example : gateway id "dumpprivkey" = none := by decide
example : forwardable "sendrawtransaction" = true := by decide
example : forwardable "dumpprivkey" = false := by decide

end RelayerCore.Rpc
