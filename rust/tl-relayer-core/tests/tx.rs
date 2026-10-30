mod common;
use bitcoin::blockdata::opcodes::all::{OP_CHECKMULTISIG, OP_PUSHNUM_2};
use bitcoin::blockdata::script::Builder;
use bitcoin::{Psbt, ScriptBuf};
use common::*;
use tl_relayer_core::address::decode_address;
use tl_relayer_core::network::Network;
use tl_relayer_core::tx::*;
use tl_relayer_core::utxo::Utxo;
use tl_relayer_core::{Amount, Error};

struct W {
    from: tl_relayer_core::address::DecodedAddress,
    to: tl_relayer_core::address::DecodedAddress,
}

fn wallet() -> W {
    W {
        from: dec(&p2wpkh(NET, &key(1))),
        to: dec(&p2wpkh(NET, &key(2))),
    }
}

fn plan<'a>(w: &'a W, amount: u64, cands: Vec<Utxo>) -> BuildPlan<'a> {
    BuildPlan {
        from: &w.from,
        to: &w.to,
        amount: Amount::from_sat(amount),
        required: vec![],
        candidates: cands,
        payload: None,
        fee: FeePolicy {
            rate_sat_per_kvb: 10_000,
            max_fee_sat: 100_000,
        },
        fee_mode: FeeMode::SubtractFromAmount,
    }
}

fn roles(t: &UnsignedTx) -> Vec<(Role, u64)> {
    t.outputs.iter().map(|o| (o.role, o.value.sat())).collect()
}

// Vectors mirrored in lean/RelayerCore/Tx.lean (fee 1410 with change, 1100 without).
#[test]
fn vector_single_input_with_change_subtract() {
    let w = wallet();
    let t = build_unsigned(&plan(&w, 400_000, vec![utxo_for(&w.from, 1, 0, 1_000_000)])).unwrap();
    assert_eq!(
        roles(&t),
        vec![(Role::Recipient, 398_590), (Role::Change, 600_000)]
    );
    assert_eq!(t.fee.sat(), 1_410);
    assert_eq!(t.total_in().unwrap().sat(), 1_000_000);
    assert_eq!(t.total_out().unwrap().sat() + t.fee.sat(), 1_000_000);
}

#[test]
fn vector_extra_on_top() {
    let w = wallet();
    let mut p = plan(&w, 400_000, vec![utxo_for(&w.from, 1, 0, 1_000_000)]);
    p.fee_mode = FeeMode::ExtraOnTop;
    let t = build_unsigned(&p).unwrap();
    assert_eq!(
        roles(&t),
        vec![(Role::Recipient, 400_000), (Role::Change, 598_590)]
    );
    assert_eq!(t.fee.sat(), 1_410);
}

#[test]
fn vector_dust_change_is_added_to_fee() {
    let w = wallet();
    let t = build_unsigned(&plan(&w, 100_000, vec![utxo_for(&w.from, 1, 0, 100_500)])).unwrap();
    assert_eq!(roles(&t), vec![(Role::Recipient, 98_900)]);
    assert_eq!(t.fee.sat(), 1_600);
}

#[test]
fn selection_prefers_largest_and_stops_early() {
    let w = wallet();
    let c = vec![
        utxo_for(&w.from, 1, 0, 300_000),
        utxo_for(&w.from, 2, 0, 800_000),
        utxo_for(&w.from, 3, 0, 50_000),
    ];
    let t = build_unsigned(&plan(&w, 500_000, c)).unwrap();
    assert_eq!(t.inputs.len(), 1);
    assert_eq!(t.inputs[0].amount.sat(), 800_000);
}

#[test]
fn selection_adds_inputs_until_covered() {
    let w = wallet();
    let c = vec![
        utxo_for(&w.from, 1, 0, 300_000),
        utxo_for(&w.from, 2, 0, 200_000),
        utxo_for(&w.from, 3, 0, 150_000),
    ];
    let t = build_unsigned(&plan(&w, 450_000, c)).unwrap();
    let ins: Vec<u64> = t.inputs.iter().map(|u| u.amount.sat()).collect();
    assert_eq!(ins, vec![300_000, 200_000]);
    assert_eq!(t.total_in().unwrap().sat(), 500_000);
    // Same vector as `build P0 .sub 450000 [] [300000, 200000, 150000]` in lean/RelayerCore/Tx.lean.
    assert_eq!(
        roles(&t),
        vec![(Role::Recipient, 447_910), (Role::Change, 50_000)]
    );
    assert_eq!(t.fee.sat(), 2_090);
}

#[test]
fn deterministic_under_candidate_permutation() {
    let w = wallet();
    let base: Vec<Utxo> = (1..=6)
        .map(|i| utxo_for(&w.from, i, 0, 100_000 + u64::from(i % 3) * 7))
        .collect();
    let mut rev = base.clone();
    rev.reverse();
    let a = build_unsigned(&plan(&w, 250_000, base)).unwrap();
    let b = build_unsigned(&plan(&w, 250_000, rev)).unwrap();
    assert_eq!(a.psbt_hex(), b.psbt_hex());
}

#[test]
fn failures_are_typed() {
    let w = wallet();
    assert!(matches!(
        build_unsigned(&plan(&w, 5_000, vec![utxo_for(&w.from, 1, 0, 1_000)])),
        Err(Error::InsufficientFunds { .. })
    ));
    assert!(matches!(
        build_unsigned(&plan(&w, 5_000, vec![])),
        Err(Error::InsufficientFunds { have: 0, .. })
    ));
    assert_eq!(
        build_unsigned(&plan(&w, 0, vec![])).unwrap_err(),
        Error::InvalidAmount("zero")
    );
    assert_eq!(
        build_unsigned(&plan(&w, 100, vec![utxo_for(&w.from, 1, 0, 9_000)])).unwrap_err(),
        Error::DustOutput
    );
    // Fee bound.
    let mut p = plan(&w, 400_000, vec![utxo_for(&w.from, 1, 0, 1_000_000)]);
    p.fee.max_fee_sat = 1_000;
    assert_eq!(
        build_unsigned(&p).unwrap_err(),
        Error::FeeTooHigh {
            fee: 1_410,
            max: 1_000
        }
    );
    // Fee rate range.
    for rate in [0, 999, 1_000_001] {
        let mut p = plan(&w, 400_000, vec![utxo_for(&w.from, 1, 0, 1_000_000)]);
        p.fee.rate_sat_per_kvb = rate;
        assert_eq!(build_unsigned(&p).unwrap_err(), Error::FeeRateOutOfRange);
    }
    // Beyond the chain money bound.
    let mut p = plan(&w, 85_000_000 * 100_000_000, vec![]);
    assert!(build_unsigned(&p).is_err());
    p.amount = Amount::from_sat(u64::MAX);
    assert!(build_unsigned(&p).is_err());
}

#[test]
fn outputs_below_cost_are_skipped_not_selected() {
    let w = wallet();
    // 600 sat costs 680 sat to spend at 10 sat/vB: never selected.
    let c = vec![
        utxo_for(&w.from, 1, 0, 600),
        utxo_for(&w.from, 2, 0, 1_000_000),
    ];
    let t = build_unsigned(&plan(&w, 400_000, c)).unwrap();
    assert_eq!(t.inputs.len(), 1);
}

#[test]
fn input_count_is_bounded() {
    let w = wallet();
    let c: Vec<Utxo> = (0..=255u8)
        .flat_map(|i| (0..3u32).map(move |v| (i, v)))
        .map(|(i, v)| utxo_for(&w.from, i, v, 1_000))
        .collect();
    assert!(c.len() > MAX_INPUTS);
    let r = build_unsigned(&plan(&w, 600_000, c));
    assert!(
        matches!(r, Err(Error::TooMany { what: "inputs", .. })),
        "{r:?}"
    );
}

#[test]
fn regression_change_always_pays_the_wallet_and_nothing_is_burnt() {
    // Legacy buildTx (tx.service.ts:472-482) created one output of `amount - 0.00001`
    // and no change: a 1,000,000 sat input paying 400,000 burnt 601,000 as fee.
    let w = wallet();
    let t = build_unsigned(&plan(&w, 400_000, vec![utxo_for(&w.from, 1, 0, 1_000_000)])).unwrap();
    assert!(t.fee.sat() < 2_000);
    let change = t.outputs.iter().find(|o| o.role == Role::Change).unwrap();
    assert_eq!(change.script, w.from.script);
    assert_eq!(change.value.sat(), 600_000);
    for o in &t.outputs {
        assert!(o.script == w.from.script || o.script == w.to.script);
    }
}

#[test]
fn regression_candidates_must_belong_to_the_wallet() {
    let w = wallet();
    let stranger = dec(&p2wpkh(NET, &key(9)));
    let r = build_unsigned(&plan(&w, 100_000, vec![utxo_for(&stranger, 1, 0, 500_000)]));
    assert_eq!(r.unwrap_err(), Error::ForeignScript);
    // Duplicates are rejected, not double counted.
    let u = utxo_for(&w.from, 1, 0, 500_000);
    assert_eq!(
        build_unsigned(&plan(&w, 100_000, vec![u.clone(), u])).unwrap_err(),
        Error::DuplicateOutpoint
    );
}

#[test]
fn regression_network_mismatch_between_addresses() {
    let from = dec(&p2wpkh(NET, &key(1)));
    let to = decode_address(&p2wpkh(Network::BTC_TEST, &key(2)), Network::BTC_TEST).unwrap();
    let p = BuildPlan {
        from: &from,
        to: &to,
        amount: Amount::from_sat(10_000),
        required: vec![],
        candidates: vec![utxo_for(&from, 1, 0, 500_000)],
        payload: None,
        fee: FeePolicy::default(),
        fee_mode: FeeMode::SubtractFromAmount,
    };
    assert!(matches!(
        build_unsigned(&p),
        Err(Error::NetworkMismatch { .. })
    ));
}

#[test]
fn payload_is_an_op_return_output_with_zero_value() {
    let w = wallet();
    let mut p = plan(&w, 400_000, vec![utxo_for(&w.from, 1, 0, 1_000_000)]);
    p.payload = Some(b"tl2payload".to_vec());
    let t = build_unsigned(&p).unwrap();
    let last = t.outputs.last().unwrap();
    assert_eq!(last.role, Role::Data);
    assert_eq!(last.value, Amount::ZERO);
    assert!(last.script.is_op_return());
    assert_eq!(t.total_out().unwrap().sat() + t.fee.sat(), 1_000_000);
    for bad in [vec![], vec![b'a'; 81]] {
        let mut p = plan(&w, 400_000, vec![utxo_for(&w.from, 1, 0, 1_000_000)]);
        p.payload = Some(bad);
        assert!(matches!(
            build_unsigned(&p),
            Err(Error::TooLarge {
                what: "payload",
                ..
            })
        ));
    }
}

#[test]
fn psbt_round_trips_and_audits() {
    let w = wallet();
    let t = build_unsigned(&plan(&w, 400_000, vec![utxo_for(&w.from, 1, 0, 1_000_000)])).unwrap();
    let bytes = tl_relayer_core::base64::decode(&t.psbt_base64()).unwrap();
    assert_eq!(bytes, t.psbt.serialize());
    let psbt = Psbt::deserialize(&bytes).unwrap();
    assert_eq!(
        psbt.inputs[0].witness_utxo.as_ref().unwrap().value.to_sat(),
        1_000_000
    );
    assert_eq!(psbt.unsigned_tx.input[0].previous_output, op(1, 0));
    let rules = AuditRules {
        wallet_script: &w.from.script,
        allowed_recipients: std::slice::from_ref(&w.to.script),
        max_fee_sat: 5_000,
    };
    let rep = audit_psbt(&bytes, &rules).unwrap();
    assert_eq!(rep.fee.sat(), 1_410);

    // An extra output to an attacker is refused.
    let mut evil = psbt.clone();
    let attacker = dec(&p2wpkh(NET, &key(30)));
    evil.unsigned_tx.output.push(bitcoin::TxOut {
        value: bitcoin::Amount::from_sat(1_000),
        script_pubkey: attacker.script.clone(),
    });
    evil.outputs.push(Default::default());
    assert_eq!(
        audit_psbt(&evil.serialize(), &rules).unwrap_err(),
        Error::ForeignScript
    );

    // Understated output (inflated fee) is refused by the fee bound.
    let mut greedy = psbt.clone();
    greedy.unsigned_tx.output[1].value = bitcoin::Amount::from_sat(100_000);
    assert!(matches!(
        audit_psbt(&greedy.serialize(), &rules),
        Err(Error::FeeTooHigh { .. })
    ));

    // A missing funding output is refused.
    let mut blind = psbt;
    blind.inputs[0].witness_utxo = None;
    assert_eq!(
        audit_psbt(&blind.serialize(), &rules).unwrap_err(),
        Error::InputNotVerified
    );
    assert!(audit_psbt(&vec![0u8; MAX_PSBT_BYTES + 1], &rules).is_err());
    assert!(audit_psbt(b"not a psbt", &rules).is_err());
}

fn multisig() -> ScriptBuf {
    Builder::new()
        .push_opcode(OP_PUSHNUM_2)
        .push_key(&key(11))
        .push_key(&key(12))
        .push_opcode(OP_PUSHNUM_2)
        .push_opcode(OP_CHECKMULTISIG)
        .into_script()
}

#[test]
fn commit_input_p2wsh_requires_a_matching_witness_script() {
    let w = wallet();
    let ws = multisig();
    let addr = dec(&p2wsh(NET, &ws));
    let mut commit = utxo_for(&addr, 7, 1, 700_000);
    commit.witness_script = Some(ws.clone());
    let mut p = plan(&w, 650_000, vec![]);
    p.required = vec![commit.clone()];
    let t = build_unsigned(&p).unwrap();
    assert_eq!(t.inputs.len(), 1);
    assert_eq!(t.psbt.inputs[0].witness_script.as_ref(), Some(&ws));
    // 700k - 650k with a P2WSH input: change would be dust-sized or small.
    assert_eq!(t.total_out().unwrap().sat() + t.fee.sat(), 700_000);

    let mut bad = commit.clone();
    bad.witness_script = Some(ScriptBuf::from_bytes(vec![0x51]));
    p.required = vec![bad];
    assert_eq!(
        build_unsigned(&p).unwrap_err(),
        Error::UnsupportedInputScript
    );
    let mut none = commit;
    none.witness_script = None;
    p.required = vec![none];
    assert_eq!(
        build_unsigned(&p).unwrap_err(),
        Error::UnsupportedInputScript
    );
}

#[test]
fn required_inputs_are_always_spent_and_topped_up() {
    let w = wallet();
    let ws = multisig();
    let addr = dec(&p2wsh(NET, &ws));
    let mut commit = utxo_for(&addr, 7, 1, 100_000);
    commit.witness_script = Some(ws);
    let mut p = plan(
        &w,
        400_000,
        vec![
            utxo_for(&w.from, 1, 0, 900_000),
            utxo_for(&w.from, 2, 0, 50_000),
        ],
    );
    p.required = vec![commit];
    let t = build_unsigned(&p).unwrap();
    assert_eq!(t.inputs[0].outpoint, op(7, 1));
    assert!(t.inputs.len() >= 2);
    assert_eq!(
        t.total_out().unwrap().sat() + t.fee.sat(),
        t.total_in().unwrap().sat()
    );
    assert!(t
        .outputs
        .iter()
        .any(|o| o.role == Role::Change && o.script == w.from.script));
}

#[test]
fn legacy_chain_inputs_need_their_previous_transaction() {
    // Dogecoin has no segwit: P2PKH inputs carry non_witness_utxo.
    let net = Network::DOGE_TEST;
    let from = decode_address(&p2pkh(net, &key(1)), net).unwrap();
    let to = decode_address(&p2pkh(net, &key(2)), net).unwrap();
    let prev = bitcoin::Transaction {
        version: bitcoin::transaction::Version::TWO,
        lock_time: bitcoin::absolute::LockTime::ZERO,
        input: vec![],
        output: vec![bitcoin::TxOut {
            value: bitcoin::Amount::from_sat(900_000_000),
            script_pubkey: from.script.clone(),
        }],
    };
    let mut u = utxo_for(&from, 1, 0, 900_000_000);
    u.outpoint = bitcoin::OutPoint {
        txid: prev.compute_txid(),
        vout: 0,
    };
    let mk = |u: Utxo| BuildPlan {
        from: &from,
        to: &to,
        amount: Amount::from_sat(300_000_000),
        required: vec![],
        candidates: vec![u],
        payload: None,
        fee: FeePolicy {
            rate_sat_per_kvb: 10_000,
            max_fee_sat: 50_000_000,
        },
        fee_mode: FeeMode::SubtractFromAmount,
    };
    assert_eq!(
        build_unsigned(&mk(u.clone())).unwrap_err(),
        Error::UnsupportedInputScript
    );
    let mut with_prev = u.clone();
    with_prev.prev_tx = Some(prev.clone());
    let t = build_unsigned(&mk(with_prev)).unwrap();
    assert!(t.psbt.inputs[0].non_witness_utxo.is_some());
    assert!(t.psbt.inputs[0].witness_utxo.is_none());
    assert_eq!(t.total_out().unwrap().sat() + t.fee.sat(), 900_000_000);
    // A lying previous transaction (wrong amount) is rejected.
    let mut lie = u;
    let mut p2 = prev;
    p2.output[0].value = bitcoin::Amount::from_sat(1);
    lie.outpoint.txid = p2.compute_txid();
    lie.prev_tx = Some(p2);
    assert_eq!(
        build_unsigned(&mk(lie)).unwrap_err(),
        Error::InputNotVerified
    );
}

#[test]
fn conservation_holds_over_pseudo_random_cases() {
    let w = wallet();
    let mut s: u64 = 0x2545_F491_4F6C_DD1D;
    let mut next = move || {
        s ^= s << 13;
        s ^= s >> 7;
        s ^= s << 17;
        s
    };
    let mut ok = 0;
    for case in 0..400u32 {
        let n = 1 + (next() % 8) as u8;
        let cands: Vec<Utxo> = (0..n)
            .map(|i| utxo_for(&w.from, i + 1, case % 3, 700 + next() % 2_000_000))
            .collect();
        let amount = 546 + next() % 3_000_000;
        let mut p = plan(&w, amount, cands);
        p.fee_mode = if next() % 2 == 0 {
            FeeMode::SubtractFromAmount
        } else {
            FeeMode::ExtraOnTop
        };
        if let Ok(t) = build_unsigned(&p) {
            ok += 1;
            let tin = t.total_in().unwrap().sat();
            let tout = t.total_out().unwrap().sat();
            assert_eq!(tin, tout + t.fee.sat(), "case {case}");
            assert!(t.fee.sat() <= p.fee.max_fee_sat);
            for o in &t.outputs {
                if o.role != Role::Data {
                    assert!(o.value.sat() >= 546);
                    assert!(o.script == w.from.script || o.script == w.to.script);
                }
            }
            if p.fee_mode == FeeMode::ExtraOnTop {
                assert_eq!(t.outputs[0].value.sat(), amount);
            }
        }
    }
    assert!(ok > 100, "enough successful cases: {ok}");
}
