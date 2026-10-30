//! Unsigned transaction / PSBT building: UTXO selection, fee, change.
//!
//! Replaces `buildTx`, `buildTradeTx`, `buildLTCTradeTx`, `getEnoughInputs2` and
//! `buildPsbt` (`tx.service.ts:325-679`). Differences are listed in the README;
//! in short: integer satoshis, a size-based fee with a hard bound, a change
//! output that always pays the wallet's own address, explicit network, and no
//! trust in caller-supplied amounts or scripts.
//!
//! Invariant (checked on every build and modelled in `lean/RelayerCore/Tx.lean`):
//! `sum(inputs) = sum(outputs) + fee`, `fee <= max_fee`, and every non-data
//! output pays either the recipient or the wallet.

use crate::address::DecodedAddress;
use crate::error::{Error, Result};
use crate::money::Amount;
use crate::network::Network;
use crate::utxo::Utxo;
use bitcoin::absolute::LockTime;
use bitcoin::script::PushBytesBuf;
use bitcoin::transaction::Version;
use bitcoin::{Amount as BAmount, OutPoint, Psbt, ScriptBuf, Sequence, Transaction, TxIn, TxOut};
use bitcoin::{WScriptHash, Witness};
use std::collections::BTreeSet;

pub const MIN_FEE_RATE: u64 = 1_000; // sat per kvB (1 sat/vB)
pub const MAX_FEE_RATE: u64 = 1_000_000; // sat per kvB (1000 sat/vB)
pub const MAX_INPUTS: usize = 500;
pub const MAX_CANDIDATES: usize = 5_000;
pub const MAX_PAYLOAD_BYTES: usize = 80;
pub const MAX_PSBT_BYTES: usize = 1_000_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FeePolicy {
    /// Satoshis per 1000 virtual bytes.
    pub rate_sat_per_kvb: u64,
    /// Absolute fee ceiling in satoshis (includes dropped dust change).
    pub max_fee_sat: u64,
}

impl Default for FeePolicy {
    fn default() -> Self {
        FeePolicy {
            rate_sat_per_kvb: 10_000,
            max_fee_sat: 1_000_000,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FeeMode {
    /// Legacy behaviour: the recipient receives `amount - fee`.
    SubtractFromAmount,
    /// The recipient receives `amount`; the fee is paid on top.
    ExtraOnTop,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    Recipient,
    Change,
    Data,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OutputSpec {
    pub script: ScriptBuf,
    pub value: Amount,
    pub role: Role,
}

#[derive(Debug, Clone)]
pub struct BuildPlan<'a> {
    /// Wallet-owned address: change is always paid here.
    pub from: &'a DecodedAddress,
    pub to: &'a DecodedAddress,
    pub amount: Amount,
    /// Inputs that must be spent (channel commit outputs).
    pub required: Vec<Utxo>,
    /// Wallet outputs that may be selected.
    pub candidates: Vec<Utxo>,
    /// Optional OP_RETURN data (at most 80 bytes).
    pub payload: Option<Vec<u8>>,
    pub fee: FeePolicy,
    pub fee_mode: FeeMode,
}

#[derive(Debug, Clone)]
pub struct UnsignedTx {
    pub network: Network,
    pub inputs: Vec<Utxo>,
    pub outputs: Vec<OutputSpec>,
    pub fee: Amount,
    pub psbt: Psbt,
}

impl UnsignedTx {
    pub fn psbt_hex(&self) -> String {
        crate::address::hex(&self.psbt.serialize())
    }

    pub fn psbt_base64(&self) -> String {
        crate::base64::encode(&self.psbt.serialize())
    }

    pub fn total_in(&self) -> Result<Amount> {
        Amount::sum(self.inputs.iter().map(|u| u.amount))
    }

    pub fn total_out(&self) -> Result<Amount> {
        Amount::sum(self.outputs.iter().map(|o| o.value))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum InKind {
    P2wpkh,
    P2tr,
    P2wsh { sigs: u64, script_len: u64 },
    P2pkh,
}

fn varint_len(n: u64) -> u64 {
    match n {
        0..=252 => 1,
        253..=0xffff => 3,
        0x1_0000..=0xffff_ffff => 5,
        _ => 9,
    }
}

fn in_vbytes(k: InKind) -> u64 {
    match k {
        InKind::P2wpkh => 68,
        InKind::P2tr => 58,
        InKind::P2pkh => 148,
        InKind::P2wsh { sigs, script_len } => {
            // outpoint 36 + sequence 4 + empty scriptSig 1 = 41 bytes of base;
            // witness: count + dummy + sigs*(len+73) + script.
            let wit = 2 + sigs * 74 + varint_len(script_len) + script_len;
            41 + wit.div_ceil(4)
        }
    }
}

fn out_vbytes(script_len: usize) -> u64 {
    8 + varint_len(script_len as u64) + script_len as u64
}

fn classify_input(u: &Utxo, network: Network) -> Result<InKind> {
    let s = &u.script_pubkey;
    if s.is_p2wpkh() || s.is_p2tr() || s.is_p2wsh() {
        if !network.has_segwit() {
            return Err(Error::UnsupportedInputScript);
        }
        if s.is_p2wpkh() {
            return Ok(InKind::P2wpkh);
        }
        if s.is_p2tr() {
            return Ok(InKind::P2tr);
        }
        let ws = u
            .witness_script
            .as_ref()
            .ok_or(Error::UnsupportedInputScript)?;
        let expect = ScriptBuf::new_p2wsh(&WScriptHash::from(ws.as_script()));
        if &expect != s {
            return Err(Error::UnsupportedInputScript);
        }
        let l = ws.len() as u64;
        return Ok(InKind::P2wsh {
            sigs: (l.saturating_sub(3) / 34).clamp(1, 20),
            script_len: l,
        });
    }
    if s.is_p2pkh() {
        let prev = u.prev_tx.as_ref().ok_or(Error::UnsupportedInputScript)?;
        if prev.compute_txid() != u.outpoint.txid {
            return Err(Error::InputNotVerified);
        }
        let out = prev
            .output
            .get(u.outpoint.vout as usize)
            .ok_or(Error::InputNotVerified)?;
        if out.value.to_sat() != u.amount.sat() || out.script_pubkey != u.script_pubkey {
            return Err(Error::InputNotVerified);
        }
        return Ok(InKind::P2pkh);
    }
    Err(Error::UnsupportedInputScript)
}

fn vsize(kinds: &[InKind], out_script_lens: &[usize], any_witness: bool) -> u64 {
    let base = if any_witness { 11 } else { 10 };
    base + kinds.iter().map(|k| in_vbytes(*k)).sum::<u64>()
        + out_script_lens.iter().map(|l| out_vbytes(*l)).sum::<u64>()
}

fn fee_for(vsize: u64, rate: u64) -> u64 {
    let v = u128::from(vsize) * u128::from(rate);
    let c = v.div_ceil(1000);
    u64::try_from(c).unwrap_or(u64::MAX)
}

fn op_return_script(data: &[u8]) -> Result<ScriptBuf> {
    if data.is_empty() || data.len() > MAX_PAYLOAD_BYTES {
        return Err(Error::TooLarge {
            what: "payload",
            max: MAX_PAYLOAD_BYTES,
        });
    }
    let push = PushBytesBuf::try_from(data.to_vec()).map_err(|_| Error::InvalidField("payload"))?;
    Ok(ScriptBuf::new_op_return(&push))
}

/// Deterministic candidate order: largest amount first, then outpoint.
pub fn order_candidates(c: &mut [Utxo]) {
    c.sort_by(|a, b| {
        b.amount
            .cmp(&a.amount)
            .then_with(|| {
                a.outpoint
                    .txid
                    .to_string()
                    .cmp(&b.outpoint.txid.to_string())
            })
            .then_with(|| a.outpoint.vout.cmp(&b.outpoint.vout))
    });
}

struct Evaluated {
    outputs: Vec<OutputSpec>,
    fee: Amount,
}

#[allow(clippy::too_many_arguments)]
fn evaluate(
    plan: &BuildPlan<'_>,
    inputs: &[Utxo],
    kinds: &[InKind],
    total: u64,
    data_script: &Option<ScriptBuf>,
    dust: u64,
) -> Result<Option<Evaluated>> {
    let any_witness = kinds.iter().any(|k| !matches!(k, InKind::P2pkh));
    let mut lens_nc = vec![plan.to.script.len()];
    if let Some(d) = data_script {
        lens_nc.push(d.len());
    }
    let mut lens_c = lens_nc.clone();
    lens_c.push(plan.from.script.len());
    let rate = plan.fee.rate_sat_per_kvb;
    let fee_nc = fee_for(vsize(kinds, &lens_nc, any_witness), rate);
    let fee_c = fee_for(vsize(kinds, &lens_c, any_witness), rate);
    let amount = plan.amount.sat();

    let need_nc = match plan.fee_mode {
        FeeMode::SubtractFromAmount => amount,
        FeeMode::ExtraOnTop => amount.checked_add(fee_nc).ok_or(Error::AmountOverflow)?,
    };
    if total < need_nc {
        return Ok(None);
    }
    let need_c = match plan.fee_mode {
        FeeMode::SubtractFromAmount => amount,
        FeeMode::ExtraOnTop => amount.checked_add(fee_c).ok_or(Error::AmountOverflow)?,
    };
    let _ = inputs;

    // With change?
    if total >= need_c {
        let change = total - need_c;
        if change >= dust {
            let send = match plan.fee_mode {
                FeeMode::SubtractFromAmount => {
                    amount.checked_sub(fee_c).ok_or(Error::DustOutput)?
                }
                FeeMode::ExtraOnTop => amount,
            };
            if send < dust {
                return Err(Error::DustOutput);
            }
            return finish(plan, send, Some(change), data_script, total);
        }
    }
    // No change: leftover below dust is added to the fee.
    let send = match plan.fee_mode {
        FeeMode::SubtractFromAmount => amount.checked_sub(fee_nc).ok_or(Error::DustOutput)?,
        FeeMode::ExtraOnTop => amount,
    };
    if send < dust {
        return Err(Error::DustOutput);
    }
    finish(plan, send, None, data_script, total)
}

fn finish(
    plan: &BuildPlan<'_>,
    send: u64,
    change: Option<u64>,
    data_script: &Option<ScriptBuf>,
    total: u64,
) -> Result<Option<Evaluated>> {
    let mut outputs = vec![OutputSpec {
        script: plan.to.script.clone(),
        value: Amount::from_sat(send),
        role: Role::Recipient,
    }];
    if let Some(c) = change {
        outputs.push(OutputSpec {
            script: plan.from.script.clone(),
            value: Amount::from_sat(c),
            role: Role::Change,
        });
    }
    if let Some(d) = data_script {
        outputs.push(OutputSpec {
            script: d.clone(),
            value: Amount::ZERO,
            role: Role::Data,
        });
    }
    let out_sum = Amount::sum(outputs.iter().map(|o| o.value))?.sat();
    let fee = total.checked_sub(out_sum).ok_or(Error::AmountOverflow)?;
    if fee > plan.fee.max_fee_sat {
        return Err(Error::FeeTooHigh {
            fee,
            max: plan.fee.max_fee_sat,
        });
    }
    Ok(Some(Evaluated {
        outputs,
        fee: Amount::from_sat(fee),
    }))
}

/// Select inputs, compute the fee and change, and assemble the unsigned PSBT.
pub fn build_unsigned(plan: &BuildPlan<'_>) -> Result<UnsignedTx> {
    let network = plan.from.network;
    if plan.to.network != network {
        return Err(Error::NetworkMismatch {
            expected: network.legacy_code().into(),
            found: plan.to.network.legacy_code().into(),
        });
    }
    let rate = plan.fee.rate_sat_per_kvb;
    if !(MIN_FEE_RATE..=MAX_FEE_RATE).contains(&rate) {
        return Err(Error::FeeRateOutOfRange);
    }
    if plan.amount == Amount::ZERO {
        return Err(Error::InvalidAmount("zero"));
    }
    plan.amount.check_money(network)?;
    let dust = network.dust_sats();
    if plan.amount.sat() < dust {
        return Err(Error::DustOutput);
    }
    if plan.candidates.len() > MAX_CANDIDATES || plan.required.len() > MAX_INPUTS {
        return Err(Error::TooMany {
            what: "inputs",
            max: MAX_INPUTS,
        });
    }
    let data_script = match &plan.payload {
        Some(p) => Some(op_return_script(p)?),
        None => None,
    };

    // Candidates must be spendable by the wallet and unique; required inputs
    // must not also appear as candidates.
    let mut seen: BTreeSet<OutPoint> = BTreeSet::new();
    for u in plan.required.iter().chain(plan.candidates.iter()) {
        u.amount.check_money(network)?;
        if !seen.insert(u.outpoint) {
            return Err(Error::DuplicateOutpoint);
        }
    }
    for u in &plan.candidates {
        if u.script_pubkey != plan.from.script {
            return Err(Error::ForeignScript);
        }
    }

    let mut pool: Vec<Utxo> = Vec::new();
    for u in &plan.candidates {
        let k = classify_input(u, network)?;
        // Skip outputs that cost more to spend than they are worth.
        if u.amount.sat() > fee_for(in_vbytes(k), rate) {
            pool.push(u.clone());
        }
    }
    order_candidates(&mut pool);

    let mut inputs: Vec<Utxo> = plan.required.clone();
    let mut kinds: Vec<InKind> = Vec::new();
    for u in &inputs {
        kinds.push(classify_input(u, network)?);
    }
    let mut total = Amount::sum(inputs.iter().map(|u| u.amount))?.sat();
    let mut next = 0usize;
    let evaluated = loop {
        if !inputs.is_empty() {
            if let Some(ev) = evaluate(plan, &inputs, &kinds, total, &data_script, dust)? {
                break ev;
            }
        }
        if next >= pool.len() {
            let need = plan.amount.sat();
            return Err(Error::InsufficientFunds { have: total, need });
        }
        if inputs.len() >= MAX_INPUTS {
            return Err(Error::TooMany {
                what: "inputs",
                max: MAX_INPUTS,
            });
        }
        let u = pool[next].clone();
        next += 1;
        kinds.push(classify_input(&u, network)?);
        total = total
            .checked_add(u.amount.sat())
            .ok_or(Error::AmountOverflow)?;
        inputs.push(u);
    };

    let psbt = assemble_psbt(&inputs, &evaluated.outputs)?;
    let tx = UnsignedTx {
        network,
        inputs,
        outputs: evaluated.outputs,
        fee: evaluated.fee,
        psbt,
    };
    check_invariants(&tx, plan)?;
    Ok(tx)
}

fn assemble_psbt(inputs: &[Utxo], outputs: &[OutputSpec]) -> Result<Psbt> {
    let tx = Transaction {
        version: Version::TWO,
        lock_time: LockTime::ZERO,
        input: inputs
            .iter()
            .map(|u| TxIn {
                previous_output: u.outpoint,
                script_sig: ScriptBuf::new(),
                sequence: Sequence::MAX,
                witness: Witness::new(),
            })
            .collect(),
        output: outputs
            .iter()
            .map(|o| TxOut {
                value: BAmount::from_sat(o.value.sat()),
                script_pubkey: o.script.clone(),
            })
            .collect(),
    };
    let mut psbt = Psbt::from_unsigned_tx(tx).map_err(|e| Error::Psbt(e.to_string()))?;
    for (i, u) in inputs.iter().enumerate() {
        let txout = TxOut {
            value: BAmount::from_sat(u.amount.sat()),
            script_pubkey: u.script_pubkey.clone(),
        };
        if u.script_pubkey.is_p2pkh() {
            psbt.inputs[i].non_witness_utxo = u.prev_tx.clone();
        } else {
            psbt.inputs[i].witness_utxo = Some(txout);
            if u.script_pubkey.is_p2wsh() {
                psbt.inputs[i].witness_script = u.witness_script.clone();
            }
        }
    }
    Ok(psbt)
}

fn check_invariants(tx: &UnsignedTx, plan: &BuildPlan<'_>) -> Result<()> {
    let total_in = tx.total_in()?;
    let total_out = tx.total_out()?;
    let rebuilt = total_out.checked_add(tx.fee)?;
    if rebuilt != total_in {
        return Err(Error::Psbt("conservation violated".into()));
    }
    if tx.fee.sat() > plan.fee.max_fee_sat {
        return Err(Error::FeeTooHigh {
            fee: tx.fee.sat(),
            max: plan.fee.max_fee_sat,
        });
    }
    for o in &tx.outputs {
        let ok = match o.role {
            Role::Recipient => o.script == plan.to.script,
            Role::Change => o.script == plan.from.script,
            Role::Data => o.script.is_op_return() && o.value == Amount::ZERO,
        };
        if !ok {
            return Err(Error::Psbt("output destination".into()));
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Wallet-side audit of an unsigned PSBT
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct AuditRules<'a> {
    pub wallet_script: &'a ScriptBuf,
    pub allowed_recipients: &'a [ScriptBuf],
    pub max_fee_sat: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuditReport {
    pub total_in: Amount,
    pub total_out: Amount,
    pub fee: Amount,
}

/// Parse and audit a PSBT before signing: every input must carry its funding
/// output, every output must pay the wallet, an approved recipient, or be a
/// zero-value data output, and the implied fee must be within bounds.
pub fn audit_psbt(bytes: &[u8], rules: &AuditRules<'_>) -> Result<AuditReport> {
    if bytes.len() > MAX_PSBT_BYTES {
        return Err(Error::TooLarge {
            what: "psbt",
            max: MAX_PSBT_BYTES,
        });
    }
    let psbt = Psbt::deserialize(bytes).map_err(|e| Error::Psbt(e.to_string()))?;
    let mut total_in = Amount::ZERO;
    for (i, inp) in psbt.inputs.iter().enumerate() {
        let vout = psbt.unsigned_tx.input[i].previous_output.vout as usize;
        let v = if let Some(w) = &inp.witness_utxo {
            w.value.to_sat()
        } else if let Some(prev) = &inp.non_witness_utxo {
            let want = psbt.unsigned_tx.input[i].previous_output.txid;
            if prev.compute_txid() != want {
                return Err(Error::InputNotVerified);
            }
            prev.output
                .get(vout)
                .ok_or(Error::InputNotVerified)?
                .value
                .to_sat()
        } else {
            return Err(Error::InputNotVerified);
        };
        total_in = total_in.checked_add(Amount::from_sat(v))?;
    }
    let mut total_out = Amount::ZERO;
    for o in &psbt.unsigned_tx.output {
        let data = o.script_pubkey.is_op_return() && o.value.to_sat() == 0;
        let known = &o.script_pubkey == rules.wallet_script
            || rules.allowed_recipients.contains(&o.script_pubkey);
        if !data && !known {
            return Err(Error::ForeignScript);
        }
        total_out = total_out.checked_add(Amount::from_sat(o.value.to_sat()))?;
    }
    let fee = total_in.checked_sub(total_out)?;
    if fee.sat() > rules.max_fee_sat {
        return Err(Error::FeeTooHigh {
            fee: fee.sat(),
            max: rules.max_fee_sat,
        });
    }
    Ok(AuditReport {
        total_in,
        total_out,
        fee,
    })
}
