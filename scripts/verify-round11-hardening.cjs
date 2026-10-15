#!/usr/bin/env node
// Regression probes for the round-11 unification pass. The characterization cases pin
// the behaviour of every caller of a rule that is collapsed into one function. The bug
// cases (marked BUG) fail on the behaviour they guard against.
//
// Unit section: loads src/ through the TypeScript transpiler (no build needed).
// E2E section: spawns dist/index.js (run `npm run build` first) on loopback ports.
//
// Usage: node scripts/verify-round11-hardening.cjs

'use strict';

const http = require('http');
const net = require('net');
const h = require('./lib/probe-harness.cjs');
const { results, assert, runCase, sleep, loadSource, httpRequest, startRelayer, startProviderStub, ADMIN_KEY, RELAYER_KEY, DIST_ENTRY, ROOT } = h;

const MIB = 1024 * 1024;

// The collator URL is read from the environment when the config module loads, so it is
// set before any service is required in this process.
const collatorStub = { mode: 'ok', server: null, port: 0 };
const startCollatorStub = () =>
  new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        if (collatorStub.mode === 'payload-error') {
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ ok: false, error: { message: 'boom' } }));
        } else if (collatorStub.mode === 'http-500') {
          res.statusCode = 500;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ error: { message: 'bad' } }));
        } else {
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ ok: true, result: 42 }));
        }
      });
    });
    server.listen(0, '127.0.0.1', () => {
      collatorStub.server = server;
      collatorStub.port = server.address().port;
      process.env.TL_COLLATOR_URL = `http://127.0.0.1:${collatorStub.port}`;
      resolve();
    });
  });

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

// ------------------------------------------------------------------ unit cases

const ipCases = () => {
  const utils = loadSource('src/services/security-utils.service.ts');
  const TEN = ['10.0.0.0/8'];
  const resolve = (peer, xff, trusted = TEN) => utils.resolveClientIp(peer, xff === undefined ? {} : { 'x-forwarded-for': xff }, trusted);
  const expectIp = (name, peer, xff, want, trusted) => [name, () => {
    const got = resolve(peer, xff, trusted);
    assert(got === want, `resolveClientIp(${peer}, ${JSON.stringify(xff)}) = ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  }];
  return [
    expectIp('R11-IP untrusted peer ignores XFF', '203.0.113.5', '198.51.100.9', '203.0.113.5'),
    expectIp('R11-IP trusted peer, no XFF header -> peer', '10.0.0.2', undefined, '10.0.0.2'),
    expectIp('R11-IP trusted peer, empty XFF -> peer', '10.0.0.2', '   ', '10.0.0.2'),
    expectIp('R11-IP trusted peer, single client hop', '10.0.0.2', '198.51.100.9', '198.51.100.9'),
    expectIp('R11-IP rightmost untrusted hop wins over client-chosen prefix', '10.0.0.2', '192.0.2.66, 198.51.100.9, 10.0.0.8', '198.51.100.9'),
    expectIp('R11-IP all hops trusted -> peer (fail closed)', '10.0.0.2', '10.0.0.9, 10.0.0.8', '10.0.0.2'),
    expectIp('R11-IP empty hop anywhere -> peer (current rule)', '10.0.0.2', '198.51.100.9, , 10.0.0.8', '10.0.0.2'),
    expectIp('R11-IP malformed hop anywhere -> peer (current rule)', '10.0.0.2', 'not-an-ip, 198.51.100.9', '10.0.0.2'),
    expectIp('R11-IP IPv4-mapped trusted peer is matched as IPv4', '::ffff:10.0.0.2', '198.51.100.9', '198.51.100.9'),
    expectIp('R11-IP IPv4-mapped XFF hop is canonical dotted IPv4', '10.0.0.2', '::FFFF:102:304', '1.2.3.4'),
    expectIp('R11-IP IPv6 peer in an IPv6 trusted range', '2001:db8::1', '198.51.100.9', '198.51.100.9', ['2001:db8::/32']),
    expectIp('R11-IP IPv6 client hop keeps the text it arrived with (lowercased)', '10.0.0.2', '2001:0DB8:0:0::5', '2001:0db8:0:0::5'),
    ['R11-IP cf-connecting-ip and x-real-ip are ignored even when present', () => {
      const got = utils.resolveClientIp('10.0.0.2', { 'cf-connecting-ip': '198.51.100.9', 'x-real-ip': '198.51.100.8' }, TEN);
      assert(got === '10.0.0.2', `got ${got}`);
    }],
  ];
};

const authCases = () => [
  ['R11-AUTH header credential comparison is case-sensitive on the secret and matches by exact header name', () => {
    const utils = loadSource('src/services/security-utils.service.ts');
    assert(utils.headerCredentialMatches({ 'x-api-key': 'K1' }, ['x-api-key'], 'K1') === true, 'exact key rejected');
    assert(utils.headerCredentialMatches({ 'x-api-key': 'k1' }, ['x-api-key'], 'K1') === false, 'case-folded key accepted');
    assert(utils.headerCredentialMatches({ 'x-admin-api-key': 'K1' }, ['x-api-key'], 'K1') === false, 'wrong header name accepted');
    assert(utils.headerCredentialMatches({ 'x-api-key': 'K1' }, ['x-api-key'], '') === false, 'empty expected key accepted');
  }],
];

const outboundCases = () => [
  ['R11-OUT a collator payload error is returned as its message', async () => {
    collatorStub.mode = 'payload-error';
    const service = loadSource('src/services/address.service.ts');
    const res = await service.callAllocatedRpc('tl_getinfo', []);
    assert(res.error === 'boom', `error ${JSON.stringify(res)}`);
  }],
  ['R11-OUT a collator HTTP 500 body error is returned as its message', async () => {
    collatorStub.mode = 'http-500';
    const service = loadSource('src/services/address.service.ts');
    const res = await service.callAllocatedRpc('tl_getinfo', []);
    assert(res.error === 'bad', `error ${JSON.stringify(res)}`);
  }],
  ['R11-OUT a collator success returns the result and no error', async () => {
    collatorStub.mode = 'ok';
    const service = loadSource('src/services/address.service.ts');
    const res = await service.callAllocatedRpc('tl_getinfo', []);
    assert(res.data === 42 && !res.error, `result ${JSON.stringify(res)}`);
  }],
];

const rpcClientCases = () => [
  ['R11-RPC an RPC node that never answers yields ETIMEDOUT at the configured timeout', async () => {
    const silent = net.createServer(() => {});
    const port = await listen(silent);
    const { RpcClient } = loadSource('src/libs/rpc-calls/index.ts');
    const client = new RpcClient({ host: '127.0.0.1', port, username: 'u', password: 'p', timeout: 200 });
    const started = Date.now();
    const res = await client.call('getblockcount');
    const elapsed = Date.now() - started;
    silent.close();
    silent.closeAllConnections?.();
    assert(res.error === 'ETIMEDOUT', `error ${JSON.stringify(res)}`);
    assert(elapsed < 2000, `took ${elapsed} ms`);
  }],
];

// ------------------------------------------------------------------ e2e cases

const faucetCases = async (stubPort) => {
  const a = await startRelayer({ FAUCET_ENABLED: '1', ADMIN_API_KEY: ADMIN_KEY }, stubPort);
  try {
    assert(a.started, 'faucet relayer did not start');
    await runCase('R11-FAU handler refuses the faucet with no credential (403, RELAYER_API_KEY unset)', async () => {
      const res = await httpRequest(a.port, { target: '/address/faucet/abc' });
      assert(res.status === 403 && res.json && res.json.error === 'Forbidden', `status ${res.status} ${res.text}`);
    });
    await runCase('R11-FAU handler refuses a wrong admin key in either header', async () => {
      const res = await httpRequest(a.port, { target: '/address/faucet/abc', headers: { 'x-admin-api-key': 'WRONG-ADMIN' } });
      assert(res.status === 403, `status ${res.status}`);
      const res2 = await httpRequest(a.port, { target: '/address/faucet/abc', headers: { 'x-api-key': 'WRONG-ADMIN' } });
      assert(res2.status === 403, `status ${res2.status}`);
    });
    await runCase('R11-FAU the admin key in x-admin-api-key passes the handler gate', async () => {
      const res = await httpRequest(a.port, { target: '/address/faucet/abc', headers: { 'x-admin-api-key': ADMIN_KEY } });
      assert(res.status === 200 && res.text.includes('TESTNET'), `status ${res.status} ${res.text}`);
    });
  } finally {
    await a.stop();
  }

  const b = await startRelayer({ FAUCET_ENABLED: '1', ADMIN_API_KEY: ADMIN_KEY, RELAYER_API_KEY: RELAYER_KEY }, stubPort);
  try {
    assert(b.started, 'faucet+relayer-key server did not start');
    await runCase('R11-FAU hook refuses the relayer key on the faucet (401)', async () => {
      const res = await httpRequest(b.port, { target: '/address/faucet/abc', headers: { 'x-api-key': RELAYER_KEY } });
      assert(res.status === 401, `status ${res.status}`);
    });
    await runCase('R11-FAU hook and handler both accept the admin key in x-admin-api-key', async () => {
      const res = await httpRequest(b.port, { target: '/address/faucet/abc', headers: { 'x-admin-api-key': ADMIN_KEY } });
      assert(res.status === 200, `status ${res.status}`);
    });
    await runCase('R11-FAU a non-faucet mutating route accepts the relayer key', async () => {
      const res = await httpRequest(b.port, { method: 'POST', target: '/tx/decode', headers: { 'x-api-key': RELAYER_KEY }, body: {} });
      assert(res.status !== 401, `status ${res.status}`);
      const res2 = await httpRequest(b.port, { method: 'POST', target: '/address/watchonly/bootstrap', headers: { 'x-api-key': ADMIN_KEY }, body: {} });
      assert(res2.status === 401, `admin key opened a relayer-key route: ${res2.status}`);
    });
  } finally {
    await b.stop();
  }
};

const bodyLimitCases = async (stubPort) => {
  const c = await startRelayer({}, stubPort);
  try {
    assert(c.started, 'body-limit relayer did not start');
    await runCase('R11-BODY an HTTP body of 1 MiB plus 64 bytes is refused with 413', async () => {
      const big = 'a'.repeat(MIB + 52);
      const res = await httpRequest(c.port, { method: 'POST', target: '/tx/decode', body: { rawtx: big } });
      assert(res.status === 413, `status ${res.status}`);
    });
    await runCase('R11-BODY a 1 KiB body is not refused for size', async () => {
      const res = await httpRequest(c.port, { method: 'POST', target: '/tx/decode', body: { rawtx: 'a'.repeat(1024) } });
      assert(res.status !== 413, `status ${res.status}`);
    });
  } finally {
    await c.stop();
  }
};

// ------------------------------------------------------------------ main

const main = async () => {
  await startCollatorStub();
  const unit = [
    ...ipCases(),
    ...authCases(),
    ...outboundCases(),
    ...rpcClientCases(),
  ];
  for (const [name, fn] of unit) {
    await runCase(name, fn);
  }

  if (!require('fs').existsSync(DIST_ENTRY)) {
    console.log(`SKIP e2e: ${require('path').relative(ROOT, DIST_ENTRY)} missing (run npm run build)`);
    results.failed.push('e2e: dist missing');
  } else {
    const stub = await startProviderStub();
    try {
      await faucetCases(stub.port);
      await bodyLimitCases(stub.port);
    } finally {
      stub.server.close();
      collatorStub.server.close();
    }
  }

  console.log(`\n${results.passed} passed, ${results.failed.length} failed`);
  process.exit(results.failed.length === 0 ? 0 : 1);
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
