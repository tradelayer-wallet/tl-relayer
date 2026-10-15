#!/usr/bin/env node
// Regression probes for the round-7 findings (F-B1 .. F-B6, see the commit message).
// Each probe is written to fail on the round-6 behaviour it guards against.
//
// Unit section: loads src/ through the TypeScript transpiler (no build needed).
// E2E section: spawns dist/index.js (run `npm run build` first) on loopback ports.
//
// Usage: node scripts/verify-round7-hardening.cjs

'use strict';

const fs = require('fs');
const net = require('net');
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
    ['F-B1 prefix-too-broad CIDRs are flagged (IPv4 < /8, IPv6 < /16, mapped IPv4 < /8)', () => {
      for (const entry of ['1.0.0.0/7', '0.0.0.0/1', '::/15', '::ffff:10.0.0.0/100', '::ffff:0.0.0.0/98']) {
        assert(utils.isBroadProxyCidr(entry), `${entry} not flagged as broad`);
      }
    }],
    ['F-B1 ordinary and boundary CIDRs are not flagged', () => {
      for (const entry of ['10.0.0.0/8', '0.0.0.0/8', '2001::/16', '::ffff:10.0.0.0/104', '203.0.113.7', '::1']) {
        assert(!utils.isBroadProxyCidr(entry), `${entry} wrongly flagged as broad`);
      }
    }],
    ['F-B2 XFF whose hops are all trusted resolves to the TCP peer, not the leftmost hop', () => {
      const got = utils.resolveClientIp('10.0.0.2', { 'x-forwarded-for': '10.0.0.9, 10.0.0.8' }, TEN);
      assert(got === '10.0.0.2', `all-trusted XFF resolved to ${got}`);
    }],
    ['F-B2 XFF with a real client hop still resolves to that client', () => {
      const got = utils.resolveClientIp('10.0.0.2', { 'x-forwarded-for': '198.51.100.9, 10.0.0.8' }, TEN);
      assert(got === '198.51.100.9', `client hop resolved to ${got}`);
    }],
  ];
};

// ----------------------------------------------------------------- e2e cases

const wsOnce = (port, message) => {
  const WebSocket = require('ws');
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/address/validate/abc`);
    let reply = null;
    const timer = setTimeout(() => { try { ws.terminate(); } catch { /* closed */ } resolve(reply); }, 2000);
    ws.on('error', () => {});
    ws.on('message', (raw) => {
      const text = String(raw);
      if (text.includes('"statusCode"')) reply = JSON.parse(text);
    });
    ws.on('open', () => ws.send(message));
    ws.on('close', () => { clearTimeout(timer); resolve(reply); });
  });
};

const e2eCases = async (stubPort) => {
  const b = await startRelayer({}, stubPort);
  try {
    assert(b.started, 'relayer did not start');
    const alive = () => b.child.exitCode === null && b.child.signalCode === null;

    await runCase('F-B3 WS method outside the relay allowlist gets a 400 and does not crash', async () => {
      for (const method of ['\u0000', 'G ET', 'A'.repeat(100), 'TRACE']) {
        const reply = await wsOnce(b.port, JSON.stringify({ method, path: '/address/validate/abc' }));
        await sleep(200);
        assert(alive(), `process exited after method ${JSON.stringify(method.slice(0, 12))} (code ${b.child.exitCode})`);
        assert(reply && reply.statusCode === 400, `method ${JSON.stringify(method.slice(0, 12))} answered ${JSON.stringify(reply)}`);
      }
      const res = await httpRequest(b.port, { target: '/address/validate/abc' });
      assert(res.status > 0, 'server no longer answers HTTP');
    });

    await runCase('F-B3 WS non-string method gets a 400 and does not crash', async () => {
      const reply = await wsOnce(b.port, JSON.stringify({ method: 1, path: '/address/validate/abc' }));
      await sleep(200);
      assert(alive(), `process exited on numeric method (code ${b.child.exitCode})`);
      assert(reply && reply.statusCode === 400, `numeric method answered ${JSON.stringify(reply)}`);
    });

  } finally {
    await b.stop();
  }

  // F-B4 runs on its own relayer: a crash from an earlier case must not satisfy or fail it.
  const c = await startRelayer({}, stubPort);
  try {
    assert(c.started, 'relayer for F-B4 did not start');
    const alive = () => c.child.exitCode === null && c.child.signalCode === null;
    await runCase('F-B4 an Upgrade request to a non-/ws path is closed, not left open', async () => {
      const sock = net.connect(c.port, '127.0.0.1');
      let closed = false;
      sock.on('error', () => {});
      sock.on('close', () => { closed = true; });
      await new Promise((resolve) => { sock.on('connect', resolve); sock.on('error', resolve); });
      sock.write('GET /address/validate/abc HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n');
      await sleep(1000);
      sock.destroy();
      assert(closed, 'non-/ws upgrade socket stayed open after 1s');
      assert(alive(), 'process exited after non-/ws upgrade');
    });
  } finally {
    await c.stop();
  }

  // F-B5: HEAD on a GET route must not run its handler; the faucet and every other GET are covered.
  const a = await startRelayer(
    { RELAYER_API_KEY: RELAYER_KEY, ADMIN_API_KEY: ADMIN_KEY, FAUCET_ENABLED: 'true' },
    stubPort,
  );
  try {
    assert(a.started, 'faucet relayer did not start');
    for (const target of ['/address/balance/abc', '/attestation/ip', '/address/watchonly/abc/verify', '/address/faucet/abc']) {
      await runCase(`F-B5 HEAD ${target} does not reach its GET handler`, async () => {
        const res = await httpRequest(a.port, { method: 'HEAD', target, headers: { 'x-api-key': ADMIN_KEY } });
        assert(res.status === 404, `HEAD ${target} answered ${res.status}`);
      });
    }
    await runCase('F-B5 GET /attestation/ip still reaches its handler (control)', async () => {
      const res = await httpRequest(a.port, { target: '/attestation/ip' });
      assert(res.status !== 404, `GET /attestation/ip answered ${res.status}`);
    });
  } finally {
    await a.stop();
  }
};

// F-B6: a broad-prefix trust entry refuses to start unless the opt-in is set.
const startupCases = async (stubPort) => {
  await runCase('F-B6 TRUST_PROXY_CIDRS=1.0.0.0/7 refuses to start by default', async () => {
    const s = await startRelayer({ TRUST_PROXY: '1', TRUST_PROXY_CIDRS: '1.0.0.0/7' }, stubPort);
    try {
      assert(!s.started, 'server started with a /7 trusted');
    } finally {
      await s.stop();
    }
  });

  await runCase('F-B6 TRUST_PROXY_CIDRS=::/15 refuses to start by default', async () => {
    const s = await startRelayer({ TRUST_PROXY: '1', TRUST_PROXY_CIDRS: '::/15' }, stubPort);
    try {
      assert(!s.started, 'server started with a ::/15 trusted');
    } finally {
      await s.stop();
    }
  });

  await runCase('F-B6 prefix-too-broad CIDR starts only with the explicit opt-in', async () => {
    const s = await startRelayer(
      { TRUST_PROXY: '1', TRUST_PROXY_CIDRS: '1.0.0.0/7', TRUST_PROXY_ALLOW_BROAD_CIDRS: '1' },
      stubPort,
    );
    try {
      assert(s.started, 'opt-in did not allow a /7');
    } finally {
      await s.stop();
    }
  });

  await runCase('F-B6 a /8 proxy CIDR still starts without the opt-in', async () => {
    const s = await startRelayer({ TRUST_PROXY: '1', TRUST_PROXY_CIDRS: '10.0.0.0/8' }, stubPort);
    try {
      assert(s.started, '/8 proxy CIDR refused');
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
