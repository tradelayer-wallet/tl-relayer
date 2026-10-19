#!/usr/bin/env node
// Regression checks for the round-19 findings: watch-only registry rebinding (R2), registry file
// corruption (R3), writes on balance reads (R4) and the commit-UTXO exclusion in buildLTCTradeTx (R5).
//
// Loads src/ through the TypeScript transpiler (no build needed). The collator is a loopback stub; the
// registry file lives in a temp directory. Nothing else is contacted.
//
// Usage: node scripts/verify-round19-hardening.cjs

'use strict';

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const bitcoin = require('bitcoinjs-lib');
const h = require('./lib/probe-harness.cjs');
const { results, assert, runCase, loadSource } = h;

const LTC_NET = {
  messagePrefix: '\x19Litecoin Signed Message:\n',
  bech32: 'ltc',
  bip32: { public: 0x019da462, private: 0x019d9cfe },
  pubKeyHash: 0x30,
  scriptHash: 0x32,
  wif: 0xb0,
};

// Public constants: the secp256k1 points 1G, 2G, 3G, 4G (compressed), and 1G uncompressed.
const P1 = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';
const P2 = '02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5';
const P3 = '02f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9';
const P4 = '02e493dbf1c10d80f3581e4904930b1404cc6c13900ee0758474fa94abe8c4cd13';
const P1_UNCOMPRESSED = '0479be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8';

const p2pkh = (hex) => bitcoin.payments.p2pkh({ pubkey: Buffer.from(hex, 'hex'), network: LTC_NET }).address;
const p2wpkh = (hex) => bitcoin.payments.p2wpkh({ pubkey: Buffer.from(hex, 'hex'), network: LTC_NET }).address;
const p2shP2wpkh = (hex) => {
  const redeem = bitcoin.payments.p2wpkh({ pubkey: Buffer.from(hex, 'hex'), network: LTC_NET });
  return bitcoin.payments.p2sh({ redeem, network: LTC_NET }).address;
};

const expectRefusal = async (promise, pattern) => {
  let error = null;
  try {
    await promise;
  } catch (e) {
    error = e;
  }
  assert(error, 'expected a refusal, but the call completed');
  assert(pattern.test(String(error.message)), `refusal does not name the cause: ${error.message}`);
};

const readOrNull = (file) => (fs.existsSync(file) ? fs.readFileSync(file) : null);

// ------------------------------------------------------------ loopback collator stub

const startCollatorStub = () => new Promise((resolve) => {
  const calls = [];
  const stub = { calls, answer: () => ({ ok: true, result: null, providerNodeId: 'stub-node' }) };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const parsed = body ? JSON.parse(body) : {};
      calls.push(parsed.method);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(stub.answer(parsed)));
    });
  });
  server.listen(0, '127.0.0.1', () => {
    stub.url = `http://127.0.0.1:${server.address().port}`;
    stub.server = server;
    resolve(stub);
  });
});

// ------------------------------------------------------------ fresh module state per case

const TEMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-relayer-r19-'));
const REGISTRY_REL = path.join('src', 'services', 'watchonly-registry.service.ts');
const ADDRESS_REL = path.join('src', 'services', 'address.service.ts');
const TX_REL = path.join('src', 'services', 'tx.service.ts');
const CHAIN_MODULES = [REGISTRY_REL, ADDRESS_REL, TX_REL];

const { envConfig } = loadSource(path.join('src', 'config', 'env.config.ts'));
const stub = { current: null };

// Each case gets its own registry file and its own module instances, so no in-memory cache leaks between
// cases. Modules that import the registry are reloaded after it.
const freshRegistry = (name) => {
  const dir = path.join(TEMP_DIR, name);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'watchonly-registry.json');
  envConfig.WATCHONLY_REGISTRY_PATH = file;
  envConfig.NETWORK = 'LTC';
  for (const rel of CHAIN_MODULES) delete require.cache[path.join(h.ROOT, rel)];
  const reg = loadSource(REGISTRY_REL);
  return { file, dir, reg };
};

const freshAddressService = () => loadSource(ADDRESS_REL);

const importCalls = () => stub.current.calls.filter((m) => m === 'importpubkey').length;

// ------------------------------------------------------------ R2: pubkey must derive the address; no rebinding

const r2 = async () => {
  await runCase('R2 an address already registered refuses a different pubkey, with no node call and no change', async () => {
    const address = p2pkh(P1);
    const { file, reg } = freshRegistry('r2-conflict');
    const first = await reg.upsertWatchOnlyAccounts([{ address, pubkey: P1 }], { source: 'sync-watchonly' });
    assert(!first.results[0].error, `honest first import failed: ${first.results[0].error}`);
    const before = importCalls();
    const second = await reg.upsertWatchOnlyAccounts([{ address, pubkey: P2 }], { source: 'sync-watchonly' });
    assert(second.results[0].error, `second import with another pubkey was accepted (updated=${second.results[0].updated})`);
    assert(/different pubkey/.test(second.results[0].error), `conflict error does not say why: ${second.results[0].error}`);
    assert(importCalls() === before, 'a refused import still reached importpubkey');
    assert(await reg.resolveWatchOnlyPubkey(address) === P1, 'the stored pubkey changed after a refused import');
    assert(JSON.parse(fs.readFileSync(file, 'utf8')).entries[0].pubkey === P1, 'the file on disk changed after a refused import');
  });

  await runCase('R2 a pubkey that does not derive the address is refused before any node call', async () => {
    const { file, reg } = freshRegistry('r2-derive');
    const address = p2pkh(P1);
    const res = await reg.upsertWatchOnlyAccounts([{ address, pubkey: P2 }], { source: 'sync-watchonly' });
    assert(res.results[0].error, 'a pubkey that does not derive the address was accepted');
    assert(/does not derive/.test(res.results[0].error), `derivation error does not say why: ${res.results[0].error}`);
    assert(importCalls() === 0, 'an underivable pair reached importpubkey');
    assert(!fs.existsSync(file), 'an underivable pair was written to the registry');
  });

  await runCase('R2 honest single-key addresses import: P2PKH (compressed and uncompressed), P2WPKH, P2SH-P2WPKH', async () => {
    const { reg } = freshRegistry('r2-honest');
    const accounts = [
      { address: p2pkh(P2), pubkey: P2 },
      { address: p2pkh(P1_UNCOMPRESSED), pubkey: P1_UNCOMPRESSED },
      { address: p2wpkh(P3), pubkey: P3 },
      { address: p2shP2wpkh(P4), pubkey: P4 },
    ];
    const res = await reg.upsertWatchOnlyAccounts(accounts, { source: 'sync-watchonly' });
    const errors = res.results.map((r) => r.error).filter(Boolean);
    assert(errors.length === 0, `honest imports refused: ${errors.join('; ')}`);
    assert(res.imported === accounts.length, `expected ${accounts.length} imports, got ${res.imported}`);
  });

  await runCase('R2 re-importing the same pair skips the node call (idempotent)', async () => {
    const { reg } = freshRegistry('r2-idem');
    const account = { address: p2pkh(P3), pubkey: P3 };
    await reg.upsertWatchOnlyAccounts([account], { source: 'sync-watchonly' });
    const before = importCalls();
    const res = await reg.upsertWatchOnlyAccounts([account], { source: 'sync-watchonly' });
    assert(!res.results[0].error, `re-import failed: ${res.results[0].error}`);
    assert(importCalls() === before, 'the same pair reached importpubkey again');
  });
};

// ------------------------------------------------------------ R3: an unreadable registry file is never replaced

const r3 = async () => {
  const seed = async (name) => {
    const ctx = freshRegistry(name);
    const accounts = [P1, P2, P3].map((pubkey) => ({ address: p2pkh(pubkey), pubkey }));
    const res = await ctx.reg.upsertWatchOnlyAccounts(accounts, { source: 'sync-watchonly' });
    assert(res.failed === 0, 'seeding the registry failed');
    return ctx;
  };
  const extra = { address: p2pkh(P4), pubkey: P4 };

  await runCase('R3 a truncated registry file refuses writes, names the file, and is left untouched', async () => {
    const { file, reg } = await seed('r3-truncated');
    const good = fs.readFileSync(file);
    fs.writeFileSync(file, good.subarray(0, Math.floor(good.length * 0.6)));
    const damaged = fs.readFileSync(file);
    await expectRefusal(reg.upsertWatchOnlyAccounts([extra], { source: 'sync-watchonly' }), new RegExp(file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert(Buffer.compare(readOrNull(file), damaged) === 0, 'the damaged registry file was replaced');
  });

  await runCase('R3 an empty registry file refuses writes and is left untouched', async () => {
    const { file, reg } = await seed('r3-empty');
    fs.writeFileSync(file, '');
    await expectRefusal(reg.upsertWatchOnlyAccounts([extra], { source: 'sync-watchonly' }), /r3-empty/);
    assert(fs.readFileSync(file).length === 0, 'the empty registry file was replaced');
  });

  await runCase('R3 a registry file of the wrong shape refuses writes and is left untouched', async () => {
    for (const [label, text] of [['object without entries', '{"version":1,"foo":[]}'], ['scalar', '42'], ['entries not an array', '{"entries":"x"}']]) {
      const { file, reg } = freshRegistry(`r3-shape-${label.replace(/\W+/g, '-')}`);
      fs.writeFileSync(file, text);
      await expectRefusal(reg.upsertWatchOnlyAccounts([extra], { source: 'sync-watchonly' }), /cannot be read/);
      assert(fs.readFileSync(file, 'utf8') === text, `${label}: the file was replaced`);
    }
  });

  await runCase('R3 a good registry file loads, and a write keeps every entry', async () => {
    const { file, reg } = await seed('r3-good');
    assert(reg.listWatchOnlyEntries && (await reg.listWatchOnlyEntries()).length === 3, 'good file did not load 3 entries');
    const res = await reg.upsertWatchOnlyAccounts([extra], { source: 'sync-watchonly' });
    assert(!res.results[0].error, `write failed: ${res.results[0].error}`);
    assert(JSON.parse(fs.readFileSync(file, 'utf8')).entries.length === 4, 'the write did not keep the 3 loaded entries');
  });

  await runCase('R3 an absent registry file starts empty and the first write creates it with no backup', async () => {
    const { file, dir, reg } = freshRegistry('r3-absent');
    const res = await reg.upsertWatchOnlyAccounts([extra], { source: 'sync-watchonly' });
    assert(!res.results[0].error, `first write failed: ${res.results[0].error}`);
    assert(JSON.parse(fs.readFileSync(file, 'utf8')).entries.length === 1, 'first write did not create one entry');
    assert(!fs.existsSync(`${file}.bak`), 'a backup was made from a file that did not exist');
    assert(fs.readdirSync(dir).every((name) => !name.endsWith('.tmp')), 'a temp file was left behind');
  });

  await runCase('R3 each write keeps one previous generation as registry.json.bak', async () => {
    const { file, reg } = freshRegistry('r3-backup');
    await reg.upsertWatchOnlyAccounts([{ address: p2pkh(P1), pubkey: P1 }], { source: 'sync-watchonly' });
    const previous = fs.readFileSync(file);
    await reg.upsertWatchOnlyAccounts([{ address: p2pkh(P2), pubkey: P2 }], { source: 'sync-watchonly' });
    assert(fs.existsSync(`${file}.bak`), 'no registry.json.bak after an overwrite');
    assert(Buffer.compare(fs.readFileSync(`${file}.bak`), previous) === 0, 'registry.json.bak is not the previous generation');
    assert(JSON.parse(fs.readFileSync(file, 'utf8')).entries.length === 2, 'the new generation lost an entry');
  });

  await runCase('R3 after the file is repaired the next write goes through (no cached failure)', async () => {
    const { file, reg } = await seed('r3-repair');
    const good = fs.readFileSync(file);
    fs.writeFileSync(file, good.subarray(0, 10));
    await expectRefusal(reg.upsertWatchOnlyAccounts([extra], { source: 'sync-watchonly' }), /cannot be read/);
    fs.writeFileSync(file, good);
    const res = await reg.upsertWatchOnlyAccounts([extra], { source: 'sync-watchonly' });
    assert(!res.results[0].error, `write still refused after repair: ${res.results[0].error}`);
    assert(JSON.parse(fs.readFileSync(file, 'utf8')).entries.length === 4, 'the repaired registry did not keep its entries');
  });
};

// ------------------------------------------------------------ R4: a balance read never writes

const r4 = async () => {
  await runCase('R4 a balance read of a never-imported address creates no registry entry and no file', async () => {
    const { file, reg } = freshRegistry('r4-read-fresh');
    const addressSvc = freshAddressService();
    for (const pubkey of [P1, P2, P3]) {
      const out = await addressSvc.getAddressBalance(p2pkh(pubkey));
      assert(Array.isArray(out), 'balance read did not return the stub balances');
    }
    assert(!fs.existsSync(file), 'balance reads created the registry file');
    assert((await reg.listWatchOnlyEntries()).length === 0, 'balance reads created registry entries');
  });

  await runCase('R4 a balance read leaves an imported entry byte-identical on disk', async () => {
    const { file, reg } = freshRegistry('r4-read-known');
    await reg.upsertWatchOnlyAccounts([{ address: p2pkh(P1), pubkey: P1 }], { source: 'sync-watchonly' });
    const before = fs.readFileSync(file);
    const addressSvc = freshAddressService();
    await addressSvc.getAddressBalance(p2pkh(P1));
    assert(Buffer.compare(fs.readFileSync(file), before) === 0, 'the balance read rewrote the registry file');
  });
};

// ------------------------------------------------------------ R5: commit UTXO exclusion matches on vout

const r5 = async () => {
  const T = 'aa'.repeat(32);
  const buyer = p2pkh(P1);
  const seller = p2pkh(P2);
  const spk = bitcoin.payments.p2pkh({ pubkey: Buffer.from(P1, 'hex'), network: LTC_NET }).output.toString('hex');
  const normal = { txid: T, vout: 0, amount: 3.5, scriptPubKey: spk, address: buyer };
  const commit = (vout) => ({ txid: T, vout, amount: 0.5, scriptPubKey: spk, address: buyer });

  const build = async (commitUTXOs) => {
    const addressSvc = freshAddressService();
    addressSvc.callAllocatedRpc = async (method) => (method === 'listunspent'
      ? { data: [normal] }
      : { error: `unexpected ${method}` });
    const tx = loadSource(TX_REL);
    return tx.buildLTCTradeTx({
      buyerKeyPair: { address: buyer, pubkey: P1 },
      sellerKeyPair: { address: seller, pubkey: P2 },
      amount: 3.9,
      payload: '00',
      commitUTXOs,
      network: 'LTC',
    }, false);
  };

  await runCase('R5 a normal UTXO is not excluded by a commit UTXO on another vout of the same tx', async () => {
    const res = await build([commit(1)]);
    assert(!res.error, `honest trade refused: ${res.error}`);
    assert(res.data.inputs.length === 2, `expected the commit and the normal input, got ${res.data.inputs.length} inputs`);
  });

  await runCase('R5 a commit UTXO on the same outpoint still excludes the normal UTXO', async () => {
    const res = await build([commit(0)]);
    assert(res.error && /Not enough UTXOs/.test(res.error), `expected the outpoint to be excluded, got ${res.error || 'a build'}`);
  });
};

const main = async () => {
  stub.current = await startCollatorStub();
  envConfig.COLLATOR_URL = stub.current.url;
  await r2();
  await r3();
  await r4();
  await r5();
  stub.current.server.close();
  fs.rmSync(TEMP_DIR, { recursive: true, force: true });
  console.log(`\n${results.passed} passed, ${results.failed.length} failed`);
  process.exit(results.failed.length === 0 ? 0 : 1);
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
