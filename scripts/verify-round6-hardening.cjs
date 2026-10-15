#!/usr/bin/env node
// Regression probes for the round-6 findings (F-A1 .. F-A4, see the commit message).
// Each probe is written to fail on the round-5 behaviour it guards against.
//
// Unit section: loads src/ through the TypeScript transpiler (no build needed).
// E2E section: spawns dist/index.js (run `npm run build` first) on loopback ports.
//
// Usage: node scripts/verify-round6-hardening.cjs

'use strict';

const fs = require('fs');
const path = require('path');
const h = require('./lib/probe-harness.cjs');
const {
  ROOT, DIST_ENTRY, RELAYER_KEY, ADMIN_KEY, results, assert, runCase, sleep,
  httpRequest, startRelayer, startProviderStub, loadSource,
} = h;

// ---------------------------------------------------------------- unit section

const unitCases = () => {
  const utils = loadSource('src/services/security-utils.service.ts');
  const TEN = ['10.0.0.0/8'];

  return [
    ['F-A3 broad CIDR detector flags every entry that covers all IPv4 addresses', () => {
      assert(typeof utils.isBroadProxyCidr === 'function', 'isBroadProxyCidr missing');
      for (const entry of ['0.0.0.0/0', '::/0', '::/1', '::ffff:0:0/96', '::/64', '0:0:0:0:0:ffff:0:0/96']) {
        assert(utils.isBroadProxyCidr(entry), `${entry} not flagged as broad`);
      }
    }],
    ['F-A3 broad CIDR detector leaves ordinary proxy entries alone', () => {
      for (const entry of ['10.0.0.0/8', '203.0.113.7', '2001:db8::/32', '::1', '::ffff:10.0.0.0/104', '0.0.0.0/8', '2001::/16']) {
        assert(!utils.isBroadProxyCidr(entry), `${entry} wrongly flagged as broad`);
      }
    }],
    ['F-A4 IPv4-mapped IPv6 spellings share one canonical client identity', () => {
      const viaHex = utils.resolveClientIp('10.0.0.2', { 'x-forwarded-for': '::FFFF:102:304' }, TEN);
      const viaDotted = utils.resolveClientIp('10.0.0.2', { 'x-forwarded-for': '::ffff:1.2.3.4' }, TEN);
      assert(viaHex === '1.2.3.4' && viaDotted === '1.2.3.4', `identities differ: ${viaHex} vs ${viaDotted}`);
      assert(utils.rateLimitKey('::ffff:102:304') === '1.2.3.4', 'hex-mapped IPv4 not bucketed as IPv4');
    }],
    ['F-A4 hex-mapped IPv4 no longer collapses into one IPv6 /64 quota bucket', () => {
      assert(utils.rateLimitKey('::ffff:102:304') !== utils.rateLimitKey('::ffff:506:708'), 'distinct mapped IPv4 share a bucket');
    }],
  ];
};

// ----------------------------------------------------------------- e2e cases

const e2eCases = async (stubPort) => {
  // F-A2: the faucet must not answer HEAD. Old behaviour: HEAD ran the funding handler (200).
  const a = await startRelayer(
    { RELAYER_API_KEY: RELAYER_KEY, ADMIN_API_KEY: ADMIN_KEY, FAUCET_ENABLED: 'true' },
    stubPort,
  );
  try {
    assert(a.started, 'faucet server did not start');

    await runCase('F-A2 HEAD to the faucet does not reach the funding handler', async () => {
      const res = await httpRequest(a.port, {
        method: 'HEAD',
        target: '/address/faucet/abc',
        headers: { 'x-api-key': ADMIN_KEY },
      });
      assert(res.status === 404, `HEAD faucet answered ${res.status}`);
    });

    await runCase('F-A2 GET to the faucet still reaches its handler (control)', async () => {
      const res = await httpRequest(a.port, {
        target: '/address/faucet/abc',
        headers: { 'x-api-key': ADMIN_KEY },
      });
      assert(res.status !== 404 && res.status !== 401, `GET faucet answered ${res.status}`);
    });
  } finally {
    await a.stop();
  }

  // F-A1: a JSON `null` frame and a protocol-invalid frame must not take the process down.
  const WebSocket = require('ws');
  const net = require('net');
  const b = await startRelayer({}, stubPort);
  try {
    assert(b.started, 'ws server did not start');

    await runCase('F-A1 WS message "null" closes only that connection, server stays up', async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${b.port}/ws/address/balance/x`);
      await new Promise((resolve, reject) => {
        ws.on('open', resolve);
        ws.on('error', reject);
      });
      ws.send('null');
      await sleep(500);
      assert(b.child.exitCode === null, `process exited with ${b.child.exitCode}`);
      const res = await httpRequest(b.port, { target: '/address/validate/abc' });
      assert(res.status > 0, 'server no longer answers HTTP');
      try { ws.terminate(); } catch { /* already closed */ }
    });

    await runCase('F-A1 unmasked WS frame closes only that connection, server stays up', async () => {
      const sock = net.connect(b.port, '127.0.0.1');
      sock.on('error', () => {});
      await new Promise((resolve) => sock.on('connect', resolve));
      sock.write('GET /ws/address/balance/x HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n');
      await sleep(300);
      sock.write(Buffer.from([0x81, 0x02, 0x68, 0x69]));
      await sleep(500);
      assert(b.child.exitCode === null, `process exited with ${b.child.exitCode}`);
      sock.destroy();
    });
  } finally {
    await b.stop();
  }
};

// Startup refusal for broad trust entries (F-A3).
const startupCases = async (stubPort) => {
  await runCase('F-A3 TRUST_PROXY_CIDRS=0.0.0.0/0 refuses to start by default', async () => {
    const s = await startRelayer({ TRUST_PROXY: '1', TRUST_PROXY_CIDRS: '0.0.0.0/0' }, stubPort);
    try {
      assert(!s.started, 'server started with 0.0.0.0/0 trusted');
    } finally {
      await s.stop();
    }
  });

  await runCase('F-A3 TRUST_PROXY_CIDRS=::/0 refuses to start by default', async () => {
    const s = await startRelayer({ TRUST_PROXY: '1', TRUST_PROXY_CIDRS: '::/0' }, stubPort);
    try {
      assert(!s.started, 'server started with ::/0 trusted');
    } finally {
      await s.stop();
    }
  });

  await runCase('F-A3 broad CIDR starts only with the explicit opt-in', async () => {
    const s = await startRelayer(
      { TRUST_PROXY: '1', TRUST_PROXY_CIDRS: '0.0.0.0/0', TRUST_PROXY_ALLOW_BROAD_CIDRS: '1' },
      stubPort,
    );
    try {
      assert(s.started, 'opt-in did not allow broad CIDR');
    } finally {
      await s.stop();
    }
  });

  await runCase('F-A3 a narrow proxy CIDR still starts without the opt-in', async () => {
    const s = await startRelayer({ TRUST_PROXY: '1', TRUST_PROXY_CIDRS: '127.0.0.1/32' }, stubPort);
    try {
      assert(s.started, 'narrow proxy CIDR refused');
    } finally {
      await s.stop();
    }
  });
};

// ------------------------------------------------------------------------ main

const main = async () => {
  for (const [name, fn] of unitCases()) {
    await runCase(name, fn);
  }

  if (!fs.existsSync(DIST_ENTRY)) {
    console.log(`SKIP e2e: ${path.relative(ROOT, DIST_ENTRY)} missing (run npm run build)`);
    results.failed.push('e2e: dist missing');
  } else {
    const stub = await startProviderStub();
    try {
      await e2eCases(stub.port);
      await startupCases(stub.port);
    } finally {
      stub.server.close();
    }
  }

  console.log(`\n${results.passed} passed, ${results.failed.length} failed`);
  process.exit(results.failed.length === 0 ? 0 : 1);
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
