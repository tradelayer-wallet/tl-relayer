/-!
Unsigned-transaction builder model (`src/tx.rs`, functions `evaluate`, `finish`,
`build_unsigned`).

Same algorithm and branch structure as Rust, specialised to the case the vectors
exercise: every input and output is P2WPKH (68 vB per input, 31 vB per output), one
recipient, no data output. The Rust code generalises only the size estimate
(`in_vbytes`, `out_vbytes`); the decision structure below is identical:

  1. wait until `total >= need_nc`;
  2. if `total >= need_c` and the change is at least dust, pay change to the wallet;
  3. otherwise drop the change (the leftover goes to the fee);
  4. reject dust recipients and fees above `maxFee`.

`Nat` subtraction is truncated in Lean; every subtraction here is guarded by the
same comparison the Rust `checked_sub` encodes.
-/
namespace RelayerCore.Tx

inductive Mode where
  | sub | extra
  deriving DecidableEq

inductive Err where
  | dust | insufficient | feeTooHigh | tooManyInputs | overflow
  deriving DecidableEq

structure Params where
  rate : Nat
  dust : Nat
  maxFee : Nat
  maxInputs : Nat

structure Result where
  send : Nat
  change : Option Nat
  fee : Nat
  deriving DecidableEq

/-- `fee_for`: `ceil(vsize * rate / 1000)`. -/
def feeFor (vsize rate : Nat) : Nat := (vsize * rate + 999) / 1000

/-- `vsize` for `n` P2WPKH inputs, a P2WPKH recipient and an optional P2WPKH change. -/
def vsize (n : Nat) (withChange : Bool) : Nat :=
  11 + 68 * n + 31 + (if withChange then 31 else 0)

theorem feeFor_mono (a b rate : Nat) (h : a ≤ b) : feeFor a rate ≤ feeFor b rate := by
  unfold feeFor
  apply Nat.div_le_div_right
  have := Nat.mul_le_mul_right rate h
  omega

def need (mode : Mode) (amount fee : Nat) : Nat :=
  match mode with
  | .sub => amount
  | .extra => amount + fee

def sendFor (mode : Mode) (amount fee : Nat) : Option Nat :=
  match mode with
  | .sub => if fee ≤ amount then some (amount - fee) else none
  | .extra => some amount

def finish (P : Params) (total send : Nat) (change : Option Nat) : Except Err (Option Result) :=
  if total < send + change.getD 0 then .error .overflow
  else if P.maxFee < total - (send + change.getD 0) then .error .feeTooHigh
  else .ok (some ⟨send, change, total - (send + change.getD 0)⟩)

def evaluate (P : Params) (mode : Mode) (amount total n : Nat) : Except Err (Option Result) :=
  if total < need mode amount (feeFor (vsize n false) P.rate) then .ok none
  else if need mode amount (feeFor (vsize n true) P.rate) ≤ total ∧
      P.dust ≤ total - need mode amount (feeFor (vsize n true) P.rate) then
    match sendFor mode amount (feeFor (vsize n true) P.rate) with
    | none => .error .dust
    | some send =>
      if send < P.dust then .error .dust
      else finish P total send
        (some (total - need mode amount (feeFor (vsize n true) P.rate)))
  else
    match sendFor mode amount (feeFor (vsize n false) P.rate) with
    | none => .error .dust
    | some send => if send < P.dust then .error .dust else finish P total send none

theorem finish_spec (P : Params) (total send : Nat) (change : Option Nat) (r : Result)
    (h : finish P total send change = .ok (some r)) :
    r.send = send ∧ r.change = change ∧ r.send + r.change.getD 0 + r.fee = total ∧
      r.fee ≤ P.maxFee := by
  unfold finish at h
  split at h
  · simp at h
  · split at h
    · simp at h
    · injection h with h1
      injection h1 with h2
      subst h2
      refine ⟨rfl, rfl, ?_, ?_⟩ <;> simp only <;> omega

theorem sendFor_sub (amount fee send : Nat) (h : sendFor .sub amount fee = some send) :
    fee ≤ amount ∧ send = amount - fee := by
  by_cases hf : fee ≤ amount
  · simp [sendFor, hf] at h
    exact ⟨hf, h.symm⟩
  · simp [sendFor, hf] at h

theorem sendFor_extra (amount fee send : Nat) (h : sendFor .extra amount fee = some send) :
    send = amount := by
  simp [sendFor] at h; omega

/-- Everything `evaluate` accepts: conservation, fee bound, no dust outputs, and the
fee never below the relay minimum for the no-change size. -/
theorem evaluate_spec (P : Params) (mode : Mode) (amount total n : Nat) (r : Result)
    (h : evaluate P mode amount total n = .ok (some r)) :
    r.send + r.change.getD 0 + r.fee = total ∧ r.fee ≤ P.maxFee ∧ P.dust ≤ r.send ∧
      (∀ c, r.change = some c → P.dust ≤ c) ∧ (mode = .extra → r.send = amount) ∧
      feeFor (vsize n false) P.rate ≤ r.fee := by
  have mono : feeFor (vsize n false) P.rate ≤ feeFor (vsize n true) P.rate :=
    feeFor_mono _ _ _ (by simp [vsize])
  unfold evaluate at h
  split at h
  · simp at h
  · split at h
    · rename_i hn hc
      split at h
      · simp at h
      · rename_i send hs
        split at h
        · simp at h
        · rename_i hd
          obtain ⟨h1, h2, h3, h4⟩ := finish_spec _ _ _ _ _ h
          refine ⟨h3, h4, ?_, ?_, ?_, ?_⟩
          · omega
          · intro c hcc
            rw [h2] at hcc
            injection hcc with hcc'
            subst hcc'
            omega
          · intro hm
            subst hm
            rw [h1]
            exact sendFor_extra _ _ _ hs
          · rw [h2] at h3
            simp only [Option.getD_some] at h3
            cases mode
            · obtain ⟨hf, hsd⟩ := sendFor_sub _ _ _ hs
              simp only [need] at hc h3
              omega
            · have := sendFor_extra _ _ _ hs
              simp only [need] at hc h3
              omega
    · rename_i hn hc
      split at h
      · simp at h
      · rename_i send hs
        split at h
        · simp at h
        · rename_i hd
          obtain ⟨h1, h2, h3, h4⟩ := finish_spec _ _ _ _ _ h
          refine ⟨h3, h4, ?_, ?_, ?_, ?_⟩
          · omega
          · intro c hcc
            rw [h2] at hcc
            simp at hcc
          · intro hm
            subst hm
            rw [h1]
            exact sendFor_extra _ _ _ hs
          · rw [h2] at h3
            simp only [Option.getD_none] at h3
            cases mode
            · obtain ⟨hf, hsd⟩ := sendFor_sub _ _ _ hs
              simp only [need] at hn
              omega
            · have := sendFor_extra _ _ _ hs
              simp only [need] at hn
              omega

def evalPicked (P : Params) (mode : Mode) (amount : Nat) (picked : List Nat) :
    Except Err (Option Result) :=
  if picked = [] then .ok none else evaluate P mode amount picked.sum picked.length

/-- `build_unsigned`'s selection loop: evaluate, and while short, add the next
candidate (already in the deterministic largest-first order). -/
def build (P : Params) (mode : Mode) (amount : Nat) :
    List Nat → List Nat → Except Err (List Nat × Result)
  | picked, [] =>
    match evalPicked P mode amount picked with
    | .error e => .error e
    | .ok (some r) => .ok (picked, r)
    | .ok none => .error .insufficient
  | picked, x :: xs =>
    match evalPicked P mode amount picked with
    | .error e => .error e
    | .ok (some r) => .ok (picked, r)
    | .ok none =>
      if P.maxInputs ≤ picked.length then .error .tooManyInputs
      else build P mode amount (picked ++ [x]) xs

theorem evalPicked_spec (P : Params) (mode : Mode) (amount : Nat) (picked : List Nat) (r : Result)
    (h : evalPicked P mode amount picked = .ok (some r)) :
    r.send + r.change.getD 0 + r.fee = picked.sum ∧ r.fee ≤ P.maxFee ∧ P.dust ≤ r.send ∧
      (∀ c, r.change = some c → P.dust ≤ c) ∧ (mode = .extra → r.send = amount) := by
  unfold evalPicked at h
  split at h
  · simp at h
  · obtain ⟨a, b, c, d, e, _⟩ := evaluate_spec _ _ _ _ _ _ h
    exact ⟨a, b, c, d, e⟩

/-- Value conservation of the whole build: inputs = recipient + change + fee. -/
theorem build_spec (P : Params) (mode : Mode) (amount : Nat) :
    ∀ (rest picked ins : List Nat) (r : Result),
      build P mode amount picked rest = .ok (ins, r) →
      ins.sum = r.send + r.change.getD 0 + r.fee ∧ r.fee ≤ P.maxFee ∧ P.dust ≤ r.send ∧
        (∀ c, r.change = some c → P.dust ≤ c) ∧ (mode = .extra → r.send = amount) ∧
        (∃ k, ins = picked ++ rest.take k) ∧
        (picked.length ≤ P.maxInputs → ins.length ≤ P.maxInputs) := by
  intro rest
  induction rest with
  | nil =>
    intro picked ins r h
    unfold build at h
    split at h
    · simp at h
    · rename_i r' hr
      injection h with h1; injection h1 with h2 h3; subst h2; subst h3
      obtain ⟨a, b, c, d, e⟩ := evalPicked_spec _ _ _ _ _ hr
      exact ⟨a.symm, b, c, d, e, ⟨0, by simp⟩, fun hl => hl⟩
    · simp at h
  | cons x xs ih =>
    intro picked ins r h
    unfold build at h
    split at h
    · simp at h
    · rename_i r' hr
      injection h with h1; injection h1 with h2 h3; subst h2; subst h3
      obtain ⟨a, b, c, d, e⟩ := evalPicked_spec _ _ _ _ _ hr
      exact ⟨a.symm, b, c, d, e, ⟨0, by simp⟩, fun hl => hl⟩
    · split at h
      · rename_i hge
        simp at h
      · rename_i hlt
        obtain ⟨a, b, c, d, e, ⟨k, hk⟩, hl⟩ := ih (picked ++ [x]) ins r h
        refine ⟨a, b, c, d, e, ⟨k + 1, ?_⟩, fun _ => hl (by simp; omega)⟩
        rw [hk]
        simp

/-- Outputs of a built transaction: the recipient, then the change to the wallet. -/
def outputs (r : Result) (recipient wallet : Nat) : List (Nat × Nat) :=
  (recipient, r.send) :: (match r.change with | some c => [(wallet, c)] | none => [])

/-- Change goes to the wallet's own script; nothing else is ever paid. -/
theorem outputs_destinations (r : Result) (recipient wallet : Nat) :
    ∀ o ∈ outputs r recipient wallet, o.1 = recipient ∨ o.1 = wallet := by
  intro o ho
  unfold outputs at ho
  split at ho
  · simp at ho
    rcases ho with rfl | rfl <;> simp
  · simp at ho
    subst ho
    simp

theorem outputs_sum (r : Result) (recipient wallet : Nat) :
    ((outputs r recipient wallet).map (fun o => o.2)).sum = r.send + r.change.getD 0 := by
  unfold outputs
  rcases r with ⟨s, c, f⟩
  cases c <;> simp

/-- The headline theorem: inputs = outputs + fee, fee within the bound, outputs only to
the recipient or the wallet. -/
theorem build_conserves (P : Params) (mode : Mode) (amount : Nat) (rest picked ins : List Nat)
    (r : Result) (recipient wallet : Nat)
    (h : build P mode amount picked rest = .ok (ins, r)) :
    ((outputs r recipient wallet).map (fun o => o.2)).sum + r.fee = ins.sum ∧
      r.fee ≤ P.maxFee ∧ (∀ o ∈ outputs r recipient wallet, o.1 = recipient ∨ o.1 = wallet) := by
  obtain ⟨a, b, _⟩ := build_spec P mode amount rest picked ins r h
  refine ⟨?_, b, outputs_destinations r recipient wallet⟩
  rw [outputs_sum]
  omega

set_option maxRecDepth 100000

-- Vectors mirrored by `tests/tx.rs` (`vector_*`, `selection_adds_inputs_until_covered`).
def P0 : Params := ⟨10000, 546, 100000, 500⟩

example : feeFor 141 10000 = 1410 := rfl
example : feeFor 110 10000 = 1100 := rfl
example : evaluate P0 .sub 400000 1000000 1 = .ok (some ⟨398590, some 600000, 1410⟩) := by
  simp [evaluate, need, sendFor, finish, feeFor, vsize, P0]
example : evaluate P0 .extra 400000 1000000 1 = .ok (some ⟨400000, some 598590, 1410⟩) := by
  simp [evaluate, need, sendFor, finish, feeFor, vsize, P0]
example : evaluate P0 .sub 100000 100500 1 = .ok (some ⟨98900, none, 1600⟩) := by
  simp [evaluate, need, sendFor, finish, feeFor, vsize, P0]
example : evaluate ⟨10000, 546, 1000, 500⟩ .sub 400000 1000000 1 = .error .feeTooHigh := rfl
example : build P0 .sub 450000 [] [300000, 200000, 150000] =
    .ok ([300000, 200000], ⟨447910, some 50000, 2090⟩) := rfl
example : build P0 .sub 5000 [] [1000] = .error .insufficient := rfl
example : build P0 .sub 400000 [] [1000000] =
    .ok ([1000000], ⟨398590, some 600000, 1410⟩) := rfl

end RelayerCore.Tx
