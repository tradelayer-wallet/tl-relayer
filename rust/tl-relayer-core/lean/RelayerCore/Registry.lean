/-!
Watch-only registry model (`src/registry.rs`, functions `Registry::register`,
`apply_register`, `record_utxo_snapshot`, `list`, `commit`).

Abstractions: addresses, pubkeys and principals are `Nat`s; the cryptographic
pubkey-to-address check is the opaque predicate `bind` (Rust: `bind_pubkey`);
timestamps, import counters and the other bookkeeping fields are dropped because
they never influence authorisation, ownership or the size bounds. The decision
order is the Rust order: authentication, capability, binding, existing entry
(idempotent refresh or conflict), global bound, per-principal quota, insert.
-/
namespace RelayerCore.Registry

structure Entry where
  addr : Nat
  pk : Nat
  owner : Nat
  deriving DecidableEq

structure Limits where
  maxEntries : Nat
  maxPer : Nat

inductive Err where
  | unauthorized | forbidden | mismatch | conflict | full | quota | stale
  deriving DecidableEq

def lookup : List Entry → Nat → Option Entry
  | [], _ => none
  | e :: es, a => if e.addr = a then some e else lookup es a

def count (p : Nat) (st : List Entry) : Nat :=
  (st.filter (fun e => decide (e.owner = p))).length

/-- `apply_register` after the authorisation gates. -/
def insertStep (L : Limits) (p : Nat) (st : List Entry) (a pk : Nat) :
    Except Err (List Entry × Bool) :=
  match lookup st a with
  | some e => if e.pk = pk then .ok (st, false) else .error .conflict
  | none =>
    if L.maxEntries ≤ st.length then .error .full
    else if L.maxPer ≤ count p st then .error .quota
    else .ok (st ++ [⟨a, pk, p⟩], true)

/-- `Registry::register`. `caller = none` is an unauthenticated request, `cap` is
whether the caller holds `Capability::Register`. -/
def register (L : Limits) (bind : Nat → Nat → Bool) (caller : Option Nat) (cap : Bool)
    (st : List Entry) (a pk : Nat) : Except Err (List Entry × Bool) :=
  match caller with
  | none => .error .unauthorized
  | some p =>
    if cap = false then .error .forbidden
    else if bind a pk = false then .error .mismatch
    else insertStep L p st a pk

theorem register_ok_decomp (L : Limits) (bind : Nat → Nat → Bool) (caller : Option Nat)
    (cap : Bool) (st : List Entry) (a pk : Nat) (r : List Entry × Bool)
    (h : register L bind caller cap st a pk = .ok r) :
    ∃ p, caller = some p ∧ cap = true ∧ bind a pk = true ∧ insertStep L p st a pk = .ok r := by
  unfold register at h
  cases caller with
  | none => simp at h
  | some p =>
    by_cases hc : cap = false
    · simp [hc] at h
    · by_cases hb : bind a pk = false
      · simp [hc, hb] at h
      · have h' : insertStep L p st a pk = .ok r := by simpa [hc, hb] using h
        exact ⟨p, rfl, by simpa using hc, by simpa using hb, h'⟩

/-- Authorization: a successful registration needs an authenticated caller holding the capability. -/
theorem register_authorized (L : Limits) (bind : Nat → Nat → Bool) (caller : Option Nat)
    (cap : Bool) (st : List Entry) (a pk : Nat) (r : List Entry × Bool)
    (h : register L bind caller cap st a pk = .ok r) :
    caller.isSome = true ∧ cap = true := by
  obtain ⟨p, hp, hc, _, _⟩ := register_ok_decomp L bind caller cap st a pk r h
  subst hp
  exact ⟨rfl, hc⟩

/-- Binding: a successful registration carries a pubkey that derives the address. -/
theorem register_binds (L : Limits) (bind : Nat → Nat → Bool) (caller : Option Nat)
    (cap : Bool) (st : List Entry) (a pk : Nat) (r : List Entry × Bool)
    (h : register L bind caller cap st a pk = .ok r) : bind a pk = true := by
  obtain ⟨_, _, _, hb, _⟩ := register_ok_decomp L bind caller cap st a pk r h
  exact hb

theorem register_anonymous (L : Limits) (bind : Nat → Nat → Bool) (cap : Bool)
    (st : List Entry) (a pk : Nat) :
    register L bind none cap st a pk = .error .unauthorized := rfl

/-- Size bound: the registry never exceeds `maxEntries`. -/
theorem insertStep_size (L : Limits) (p : Nat) (st : List Entry) (a pk : Nat)
    (st' : List Entry) (c : Bool) (hle : st.length ≤ L.maxEntries)
    (h : insertStep L p st a pk = .ok (st', c)) : st'.length ≤ L.maxEntries := by
  unfold insertStep at h
  split at h
  · split at h
    · injection h with h1; injection h1 with h2 _; subst h2; exact hle
    · simp at h
  · split at h
    · simp at h
    · split at h
      · simp at h
      · injection h with h1; injection h1 with h2 _; subst h2
        simp only [List.length_append, List.length_singleton]
        omega

theorem register_size (L : Limits) (bind : Nat → Nat → Bool) (caller : Option Nat)
    (cap : Bool) (st : List Entry) (a pk : Nat) (st' : List Entry) (c : Bool)
    (hle : st.length ≤ L.maxEntries)
    (h : register L bind caller cap st a pk = .ok (st', c)) : st'.length ≤ L.maxEntries := by
  obtain ⟨p, _, _, _, hi⟩ := register_ok_decomp L bind caller cap st a pk (st', c) h
  exact insertStep_size L p st a pk st' c hle hi

theorem count_snoc (q : Nat) (st : List Entry) (x : Entry) :
    count q (st ++ [x]) = count q st + (if x.owner = q then 1 else 0) := by
  unfold count
  rw [List.filter_append]
  by_cases hx : x.owner = q <;> simp [hx]

/-- Quota: no principal ever owns more than `maxPer` entries. -/
theorem insertStep_quota (L : Limits) (p : Nat) (st : List Entry) (a pk : Nat)
    (st' : List Entry) (c : Bool) (q : Nat) (hq : count q st ≤ L.maxPer)
    (h : insertStep L p st a pk = .ok (st', c)) : count q st' ≤ L.maxPer := by
  unfold insertStep at h
  split at h
  · split at h
    · injection h with h1; injection h1 with h2 _; subst h2; exact hq
    · simp at h
  · split at h
    · simp at h
    · split at h
      · simp at h
      · injection h with h1; injection h1 with h2 _; subst h2
        rw [count_snoc]
        by_cases hqp : p = q
        · subst hqp
          simp
          omega
        · simp [hqp]
          exact hq

/-- Ownership is never taken over: every existing entry survives unchanged. -/
theorem insertStep_preserves (L : Limits) (p : Nat) (st : List Entry) (a pk : Nat)
    (st' : List Entry) (c : Bool) (h : insertStep L p st a pk = .ok (st', c)) :
    ∀ e, e ∈ st → e ∈ st' := by
  unfold insertStep at h
  intro e he
  split at h
  · split at h
    · injection h with h1; injection h1 with h2 _; subst h2; exact he
    · simp at h
  · split at h
    · simp at h
    · split at h
      · simp at h
      · injection h with h1; injection h1 with h2 _; subst h2
        exact List.mem_append_left _ he

/-- A different pubkey for a registered address is a conflict, never an overwrite. -/
theorem insertStep_conflict (L : Limits) (p : Nat) (st : List Entry) (a pk : Nat) (e : Entry)
    (hl : lookup st a = some e) (hne : e.pk ≠ pk) :
    insertStep L p st a pk = .error .conflict := by
  simp [insertStep, hl, hne]

theorem lookup_snoc_none (st : List Entry) (a : Nat) (x : Entry) (hx : x.addr = a)
    (hn : lookup st a = none) : lookup (st ++ [x]) a = some x := by
  induction st with
  | nil => simp [lookup, hx]
  | cons e es ih =>
    by_cases he : e.addr = a
    · simp [lookup, he] at hn
    · simp only [lookup, he, ite_false] at hn
      simp only [List.cons_append, lookup, he, ite_false]
      exact ih hn

/-- Idempotence: repeating a successful registration changes nothing. -/
theorem insertStep_idempotent (L : Limits) (p : Nat) (st : List Entry) (a pk : Nat)
    (st1 : List Entry) (c : Bool) (h : insertStep L p st a pk = .ok (st1, c)) :
    insertStep L p st1 a pk = .ok (st1, false) := by
  have key : ∃ e, lookup st1 a = some e ∧ e.pk = pk := by
    unfold insertStep at h
    split at h
    · rename_i e hl
      split at h
      · rename_i hpk
        injection h with h1; injection h1 with h2 _; subst h2
        exact ⟨e, hl, hpk⟩
      · simp at h
    · rename_i hl
      split at h
      · simp at h
      · split at h
        · simp at h
        · injection h with h1; injection h1 with h2 _; subst h2
          exact ⟨⟨a, pk, p⟩, lookup_snoc_none st a ⟨a, pk, p⟩ rfl hl, rfl⟩
  obtain ⟨e, hl, hpk⟩ := key
  simp [insertStep, hl, hpk]

theorem register_idempotent (L : Limits) (bind : Nat → Nat → Bool) (caller : Option Nat)
    (cap : Bool) (st : List Entry) (a pk : Nat) (st1 : List Entry) (c : Bool)
    (h : register L bind caller cap st a pk = .ok (st1, c)) :
    register L bind caller cap st1 a pk = .ok (st1, false) := by
  obtain ⟨p, hp, hc, hb, hi⟩ := register_ok_decomp L bind caller cap st a pk (st1, c) h
  subst hp
  have := insertStep_idempotent L p st a pk st1 c hi
  simp [register, hc, hb, this]

/-- Visibility: a caller without `ReadAll` sees only their own entries. -/
def visible (caller : Nat) (readAll : Bool) (st : List Entry) : List Entry :=
  st.filter (fun e => readAll || decide (e.owner = caller))

theorem visible_scoped (caller : Nat) (readAll : Bool) (st : List Entry) :
    ∀ e, e ∈ visible caller readAll st → readAll = true ∨ e.owner = caller := by
  intro e he
  unfold visible at he
  rw [List.mem_filter] at he
  simpa using he.2

/-- Snapshot heights never move backwards (`StaleSnapshot`). -/
def recordHeight (old : Option Nat) (new : Nat) : Except Err Nat :=
  match old with
  | none => .ok new
  | some o => if new < o then .error .stale else .ok new

theorem recordHeight_monotone (old : Option Nat) (new n : Nat)
    (h : recordHeight old new = .ok n) : ∀ o, old = some o → o ≤ n := by
  intro o ho
  subst ho
  by_cases hlt : new < o
  · simp [recordHeight, hlt] at h
  · simp [recordHeight, hlt] at h
    omega

theorem recordHeight_rejects_older (o new : Nat) (h : new < o) :
    recordHeight (some o) new = .error .stale := by
  simp [recordHeight, h]

/-- Transactional commit: a failed write leaves the state unchanged. -/
def commit {σ : Type} (cur next : σ) (saveOk : Bool) : σ := if saveOk then next else cur

theorem commit_failed_unchanged {σ : Type} (cur next : σ) : commit cur next false = cur := rfl

theorem commit_ok {σ : Type} (cur next : σ) : commit cur next true = next := rfl

-- Vectors mirrored by `tests/registry.rs`.
def L2 : Limits := ⟨3, 2⟩

example : register L2 (fun _ _ => true) none true [] 10 20 = .error .unauthorized := rfl
example : register L2 (fun _ _ => true) (some 1) false [] 10 20 = .error .forbidden := rfl
example : register L2 (fun _ _ => false) (some 1) true [] 10 20 = .error .mismatch := rfl
example : register L2 (fun _ _ => true) (some 1) true [] 10 20 =
    .ok ([⟨10, 20, 1⟩], true) := rfl
-- idempotent refresh keeps the first owner
example : register L2 (fun _ _ => true) (some 2) true [⟨10, 20, 1⟩] 10 20 =
    .ok ([⟨10, 20, 1⟩], false) := rfl
-- conflicting pubkey
example : register L2 (fun _ _ => true) (some 2) true [⟨10, 20, 1⟩] 10 21 = .error .conflict := rfl
-- per-principal quota (2) and global bound (3)
example : register L2 (fun _ _ => true) (some 1) true [⟨10, 20, 1⟩, ⟨11, 21, 1⟩] 12 22 =
    .error .quota := rfl
example : register L2 (fun _ _ => true) (some 4) true [⟨10, 20, 1⟩, ⟨11, 21, 2⟩, ⟨12, 22, 3⟩] 13 23 =
    .error .full := rfl
example : recordHeight (some 100) 99 = .error .stale := rfl
example : recordHeight (some 100) 100 = .ok 100 := rfl

end RelayerCore.Registry
