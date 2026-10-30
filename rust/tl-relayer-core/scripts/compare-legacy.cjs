#!/usr/bin/env node
// Legacy parity oracle for pure functions of tl-relayer (no network, no npm install).
//
// It loads the *pinned* TypeScript sources, erases imports (replaced by inert shims),
// lets Node strip the types (Node >= 22.18 / 23.6), imports the result and records the
// outputs of pure functions for fixed inputs. The Rust test `tests/parity.rs` replays
// the same inputs against the Rust port and compares with fixtures/legacy-parity.json.
//
// Usage: node scripts/compare-legacy.cjs [--legacy <repo root>] [--out fixtures/legacy-parity.json]
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');

const PINNED = {
  'src/services/address.service.ts': '66b3d3305f197a514a53119ee27a0e6d38ebc3f6',
  'src/routes/rpc.route.ts': 'aa815103254e5b65837a521c7811f81900b24ef6',
  'src/services/sochain.service.ts': '00addc7f25227177d3b88e78f76a3b6dcf5e86b7',
  'src/services/watchonly-registry.service.ts': 'e477f924e7d841cb86a38d19a326aafbb70ea0cd',
  'src/services/tx.service.ts': 'adc9ac05f8e19ddb0213729d72377c53757e5042',
  'src/services/attestation.service.ts': 'c895e76e8311adb8c520a22b4e0b6ead2686e3c1',
};

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
}

const root = path.resolve(arg('legacy', path.join(__dirname, '..', '..', '..')));
const out = path.resolve(arg('out', path.join(__dirname, '..', 'fixtures', 'legacy-parity.json')));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-relayer-parity-'));

function blobSha(buf) {
  return crypto.createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');
}

async function load(rel, privates = []) {
  const p = path.join(root, rel);
  const raw = fs.readFileSync(p);
  // Normalise CRLF checkouts before hashing so the blob id matches git's.
  const norm = Buffer.from(raw.toString('utf8').replace(/\r\n/g, '\n'), 'utf8');
  const sha = blobSha(norm);
  if (sha !== PINNED[rel]) {
    throw new Error(`${rel}: blob ${sha} does not match pinned ${PINNED[rel]}`);
  }
  let src = norm.toString('utf8');
  // Erase every import (single or multi line) and bind each imported name to an inert
  // shim: these modules only touch their dependencies when a function runs.
  const names = new Set();
  src = src.replace(/^import\s([\s\S]*?)\sfrom\s+['"][^'"]+['"];?/gm, (_m, spec) => {
    for (const part of spec.replace(/[{}]/g, ',').replace(/\*\s+as\s+/g, '').split(',')) {
      const t = part.trim().split(/\s+as\s+/).pop().trim();
      if (/^[A-Za-z_$][\w$]*$/.test(t)) names.add(t);
    }
    return '';
  });
  const prelude = [
    "import { createRequire } from 'node:module';",
    'const require = createRequire(import.meta.url);',
    'const shim = new Proxy(function () {}, { get: () => shim, apply: () => undefined, construct: () => ({}) });',
    ...[...names].map((n) => `const ${n} = shim;`),
  ].join('\n');
  const file = path.join(tmp, rel.replace(/[\\/]/g, '__') + '.mts');
  const exp = privates.length ? `\nexport const __priv = { ${privates.join(', ')} };\n` : '';
  fs.writeFileSync(file, `${prelude}\n${src}${exp}\n`);
  return import(pathToFileURL(file).href);
}

// JSON.stringify drops `undefined`; mirror that so Rust (which uses null for
// `undefined`) can compare after stripping nulls.
const j = (v) => JSON.parse(JSON.stringify(v === undefined ? null : v));

async function main() {
  const address = (await load('src/services/address.service.ts', ['getTradeLayerListenerMethod', 'buildListenerBody', 'buildListenerQuery'])).__priv;
  const rpcRoute = await load('src/routes/rpc.route.ts').catch((e) => ({ __error: String(e.message) }));
  const sochain = (await load('src/services/sochain.service.ts', ['deriveFirstFundingScanInfo'])).__priv;
  const registry = await load('src/services/watchonly-registry.service.ts');
  const txs = (await load('src/services/tx.service.ts', ['getEnoughInputs2', 'inferNetworkFromOutputs', 'safeNumber'])).__priv;
  const att = await load('src/services/attestation.service.ts');

  const result = { pinned: PINNED, generatedBy: 'scripts/compare-legacy.cjs', cases: {} };

  // 1. listener method table and lookup
  const lookupInputs = ['tl_getallbalancesforaddress', ' TL_getInfo ', 'tl_decodetransaction', 'tl_getsyncstatus', 'getblockchaininfo', '', 'TL_GETCLEARLISTBYID'];
  result.cases.listener_lookup = lookupInputs.map((m) => ({ in: m, out: j(address.getTradeLayerListenerMethod?.(m) ?? null) }));
  // 2. body / query builders
  const A = 'tltc1qexampleaddressexampleaddressexamplexyz';
  const bodyInputs = [
    ['tl_getattestations', [A, 7]],
    ['tl_getchannelcolumn', [{ channel: 'c', myAddr: 'm', cpAddr: 'p' }]],
    ['tl_getchannelcolumn', [{ channelAddress: 'c1', buyerAddress: 'b', cpAddress: 'p1' }]],
    ['tl_getchannelcolumn', ['c', 'm', 'p']],
    ['tl_gettransaction', ['abcd']],
    ['tl_getclearlistbyid', [4]],
    ['tl_watchonly_register', [{ address: A, pubKey: 'k', network: 'n' }]],
    ['tl_watchonly_utxos', [{ address: A, pubkey: 'k2' }]],
    ['tl_getinfo', []],
    ['tl_getinfo', [3]],
    ['tl_getinfo', [1, 2]],
    ['TL_GETBALANCE', [A, 5]],
  ];
  result.cases.listener_body = bodyInputs.map(([m, p]) => ({ method: m, params: p, out: j(address.buildListenerBody?.(m, p)) }));
  const queryInputs = [
    ['tl_contractposition', [A, 9]],
    ['tl_contractposition', [{ address: A }, 9]],
    ['tl_channelbalanceforcommiter', [A, 3]],
    ['tl_getinitmargin', [{ contractId: 2, price: 1.5 }]],
    ['tl_getinitmargin', [2, 1.5]],
    ['tl_getcontractinfo', [{ contractId: 8 }]],
    ['tl_getmaxsynth', [{ address: A, propertyId: 3 }]],
    ['tl_getmaxsynth', [A, 4]],
    ['tl_tokentradehistoryforaddress', [1, 2, A]],
    ['tl_contracttradehistoryforaddress', [5, A]],
    ['tl_totaltradehistoryforaddress', [A]],
    ['tl_getinfo', [1]],
  ];
  result.cases.listener_query = queryInputs.map(([m, p]) => ({ method: m, params: p, out: j(address.buildListenerQuery?.(m, p)) }));

  // 3. public RPC allowlist and method normalisation (rpc.route.ts is exercised as text:
  // its imports pull in fastify; the Set literal is read from the pinned source).
  const routeSrc = fs.readFileSync(path.join(root, 'src/routes/rpc.route.ts'), 'utf8');
  const setBody = routeSrc.match(/const PUBLIC_RPC_METHODS = new Set\(\[([\s\S]*?)\]\);/)[1];
  result.cases.public_methods = [...setBody.matchAll(/'([^']+)'/g)].map((m) => m[1]);
  const norm = (m) => String(m || '').trim().toLowerCase();
  result.cases.normalize_method = ['  TL_X ', '', 'tl_getinfo', 'ÄB'].map((m) => ({ in: m, out: norm(m) }));

  // 4. first-funding derivation (sochain.service.ts)
  const fundingInputs = [
    [[{ txid: 'bb', confirmations: 5 }, { txid: 'aa', confirmations: 5 }, { txid: 'cc', confirmations: 1 }, { txid: 'dd', confirmations: 0 }], 100],
    [[{ txid: 'x', confirmations: 500 }], 100],
    [[{ txid: 'x', confirmations: 0 }], 100],
    [[{ txid: 'x', confirmations: 3 }], null],
    [[], 10],
  ];
  result.cases.first_funding = fundingInputs.map(([u, h]) => ({ utxos: u, height: h, out: j(sochain.deriveFirstFundingScanInfo(u, h)) }));

  // 5. rescan start height (registry)
  const rescanInputs = [[40, 50, 60], [null, 50, 20], [null, null, null], [0, 5, 9], [7, null, null]];
  result.cases.rescan_start = rescanInputs.map(([f, s, l]) => ({
    firstFundingHeight: f,
    lastSnapshotHeight: s,
    lastScannedHeight: l,
    out: j(registry.resolveWatchOnlyRescanStartHeight({ firstFundingHeight: f, lastSnapshotHeight: s, lastScannedHeight: l })),
  }));

  // 6. legacy input ordering and the constant legacy fee (getEnoughInputs2)
  const sel = [
    { utxos: [{ txid: 'a', amount: 0.003 }, { txid: 'b', amount: 0.01 }, { txid: 'c', amount: 0.0005 }, { txid: 'd', amount: 0.007 }], amount: 0.012 },
    { utxos: [{ txid: 'a', amount: 0.3 }, { txid: 'b', amount: 0.2 }, { txid: 'c', amount: 0.15 }], amount: 0.45 },
    { utxos: [{ txid: 'a', amount: 1 }], amount: 0.5 },
  ];
  result.cases.legacy_selection = sel.map((s) => {
    const r = txs.getEnoughInputs2(s.utxos, s.amount);
    return { utxos: s.utxos, amount: s.amount, selected: r.finalInputs.map((u) => u.txid), legacyFee: r.fee };
  });
  // The legacy fee is a constant 0.00001 regardless of size or input count.
  result.cases.legacy_inference = ['tltc1qx', 'ltc1qx', 'tb1qx', 'bcrt1qx', 'bc1qx', 'D8x', 'mxyz'].map((a) => ({
    in: a,
    out: txs.inferNetworkFromOutputs({ [a]: 1 }),
  }));
  result.cases.safe_number = [[0.1 + 0.2, 8], [1e-9, 8], [123456789.123456789, 8]].map(([v, d]) => ({ in: v, decimals: d, out: txs.safeNumber(v, d) }));

  // 7. attestation helpers
  const svc = new att.AttestationService();
  const ctry = [
    { location: { country: 'gb' } },
    { country_code: ' de ' },
    { whois: { data: [{ org_country_code: 'se' }] } },
    { summary: { country: 'fr' } },
    {},
  ];
  result.cases.criminalip_country = ctry.map((d) => ({ in: d, out: svc.countryFromCriminalIpData(d, d.whois?.data || []) }));
  result.cases.normalize_ip = ['::ffff:203.0.113.5', ' 203.0.113.5 ', '2001:db8::1', ''].map((v) => ({ in: v, out: svc.normalizeIp(v) }));
  result.cases.banned_countries = svc.bannedCountries;

  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(result, null, 2) + '\n');
  process.stdout.write(`wrote ${out}\n`);
}

main()
  .catch((e) => { process.stderr.write(`${e.stack || e}\n`); process.exitCode = 1; })
  .finally(() => fs.rmSync(tmp, { recursive: true, force: true }));
