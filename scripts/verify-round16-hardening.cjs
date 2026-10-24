#!/usr/bin/env node
// Regression probes for the round-16 finding in buildTx: the transaction paid the recipient `amount - fee`
// and nothing else, so inputs beyond `amount` (a large UTXO chosen largest-first) became miner fee.
//
// Loads src/ through the TypeScript transpiler (no build needed).
//
// Usage: node scripts/verify-round16-hardening.cjs

'use strict';

const h = require('./lib/probe-harness.cjs');
const { results, assert, runCase, loadSource } = h;

const SATS = 1e8;

// A real regtest-style P2WPKH script and the LTCTEST address it encodes.
const bitcoin = require('bitcoinjs-lib');
const ltctest = { messagePrefix: '\x19Litecoin Signed Message:\n', bech32: 'tltc', bip32: { public: 0x043587cf, private: 0x04358394 }, pubKeyHash: 0x6f, scriptHash: 0x3a, wif: 0xef };
const p2wpkh = (byte) => bitcoin.payments.p2wpkh({ hash: Buffer.alloc(20, byte), network: ltctest });

const utxo = (txidByte, vout, amount, payment) => ({
  txid: Buffer.alloc(32, txidByte).toString('hex'),
  vout,
  amount,
  scriptPubKey: payment.output.toString('hex'),
});

const build = async (inputs, amount) => {
  process.env.NETWORK = 'LTCTEST';
  const tx = loadSource('src/services/tx.service.ts');
  const from = p2wpkh(0x11);
  const to = p2wpkh(0x22);
  const res = await tx.buildTx({
    fromKeyPair: { address: from.address, pubkey: '02' + '11'.repeat(32) },
    toKeyPair: { address: to.address },
    amount,
    inputs: inputs(from),
    network: 'LTCTEST',
  }, true);
  return { res, from, to };
};

const outputsOf = (data) => {
  const tx = bitcoin.Transaction.fromHex(data.rawtx);
  const inSats = data.inputs.reduce((s, i) => s + Math.round(i.amount * SATS), 0);
  const outs = tx.outs.map((o) => ({ address: bitcoin.address.fromOutputScript(o.script, ltctest), value: o.value }));
  return { inSats, outs, impliedFee: inSats - outs.reduce((s, o) => s + o.value, 0) };
};

const main = async () => {
  await runCase('R16-1 a 10 LTC input sending 1 LTC returns the rest as change, so the fee is the fee', async () => {
    const { res, from, to } = await build((f) => [utxo(0xaa, 0, 10, f)], 1);
    assert(res && res.data && res.data.rawtx, `buildTx failed: ${JSON.stringify(res)}`);
    const { outs, impliedFee } = outputsOf(res.data);
    assert(impliedFee <= 0.0001 * SATS, `implied fee ${impliedFee / SATS} LTC; outputs ${JSON.stringify(outs)}`);
    const toOut = outs.find((o) => o.address === to.address);
    const changeOut = outs.find((o) => o.address === from.address);
    assert(toOut && toOut.value === Math.round((1 - 0.00001) * SATS), `recipient output ${JSON.stringify(toOut)}`);
    assert(changeOut && changeOut.value === 9 * SATS, `change output ${JSON.stringify(changeOut)}`);
  });

  await runCase('R16-2 inputs that cover the amount exactly need no change output', async () => {
    const { res } = await build((f) => [utxo(0xab, 0, 1, f)], 1);
    const { outs, impliedFee } = outputsOf(res.data);
    assert(outs.length === 1, `outputs ${JSON.stringify(outs)}`);
    assert(impliedFee === Math.round(0.00001 * SATS), `implied fee ${impliedFee}`);
  });

  await runCase('R16-3 change below the dust floor goes to the fee, and the fee stays small', async () => {
    const { res } = await build((f) => [utxo(0xac, 0, 1.00005, f)], 1);
    const { outs, impliedFee } = outputsOf(res.data);
    assert(outs.length === 1, `outputs ${JSON.stringify(outs)}`);
    assert(impliedFee < 0.0002 * SATS, `implied fee ${impliedFee}`);
  });

  await runCase('R16-4 several inputs: change is the sum of the inputs minus the amount', async () => {
    const { res, from } = await build((f) => [utxo(0xad, 0, 0.6, f), utxo(0xae, 1, 0.7, f), utxo(0xaf, 2, 3, f)], 2.5);
    const { outs, impliedFee } = outputsOf(res.data);
    assert(impliedFee <= 0.0001 * SATS, `implied fee ${impliedFee / SATS} LTC; outputs ${JSON.stringify(outs)}`);
    const changeOut = outs.find((o) => o.address === from.address);
    assert(changeOut && changeOut.value === Math.round((3 - 2.5) * SATS), `change ${JSON.stringify(changeOut)}`);
  });

  console.log(`\n${results.passed} passed, ${results.failed.length} failed`);
  process.exit(results.failed.length === 0 ? 0 : 1);
};

main().catch((e) => { console.error(e); process.exit(1); });
