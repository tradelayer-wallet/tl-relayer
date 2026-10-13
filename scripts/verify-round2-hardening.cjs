#!/usr/bin/env node
// Regression probes for the issue #1 round 2 findings (NEW-1 .. NEW-6).
//
// Unit section: loads src/services/security-utils.service.ts through the
// TypeScript transpiler and checks the IP resolver, CIDR matching, SSRF host
// classification and credential-query scrubbing.
//
// E2E section: spawns dist/index.js (run `npm run build` first) on free ports.
// Reputation-provider traffic is routed through an offline stub via
// HTTP(S)_PROXY, so no external service is contacted.
//
// Usage: node scripts/verify-round2-hardening.cjs

'use strict';

const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DIST_ENTRY = path.join(ROOT, 'dist', 'index.js');

const RELAYER_KEY = 'RELAYERKEY-7f3a91';
const ADMIN_KEY = 'ADMINKEY-9c1d42';
const HANG_IPS = ['198.51.100.7', '198.51.100.9'];

let passed = 0;
const failed = [];

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const runCase = async (name, fn) => {
  try {
    await fn();
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    failed.push(name);
    console.log(`FAIL ${name}: ${error && error.message ? error.message : error}`);
  }
};

// ---------------------------------------------------------------- unit section

const loadSource = (relativePath) => {
  const ts = require('typescript');
  if (!require.extensions['.ts']) {
    require.extensions['.ts'] = (mod, filename) => {
      const out = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
        fileName: filename,
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019, esModuleInterop: true },
      });
      mod._compile(out.outputText, filename);
    };
  }
  return require(path.join(ROOT, relativePath));
};

const unitCases = () => {
  const utils = loadSource('src/services/security-utils.service.ts');

  const resolve = (peer, headers, trusted) => utils.resolveClientIp(peer, headers, trusted);
  const TEN = ['10.0.0.0/8'];

  return [
    ['NEW-2 untrusted peer: forwarding headers ignored', () => {
      assert(resolve('198.51.100.1', { 'x-forwarded-for': '9.9.9.9' }, TEN) === '198.51.100.1', 'spoofed XFF honored');
    }],
    ['NEW-2 no trusted proxies configured: peer used', () => {
      assert(resolve('127.0.0.1', { 'x-forwarded-for': '9.9.9.9' }, []) === '127.0.0.1', 'headers honored without trust list');
    }],
    ['NEW-2 trusted peer: rightmost untrusted XFF hop is the client', () => {
      const got = resolve('10.0.0.2', { 'x-forwarded-for': '1.1.1.1, 203.0.113.9, 10.0.0.7' }, TEN);
      assert(got === '203.0.113.9', `got ${got}`);
    }],
    ['NEW-2 trusted peer: all XFF hops trusted -> leftmost hop', () => {
      const got = resolve('10.0.0.2', { 'x-forwarded-for': '10.0.0.5, 10.0.0.7' }, TEN);
      assert(got === '10.0.0.5', `got ${got}`);
    }],
    ['NEW-2 trusted peer: malformed XFF hop fails closed to peer', () => {
      assert(resolve('10.0.0.2', { 'x-forwarded-for': '1.1.1.1, garbage, 10.0.0.7' }, TEN) === '10.0.0.2', 'malformed hop not failed closed');
    }],
    ['NEW-2 trusted peer: repeated x-real-ip fails closed to peer', () => {
      assert(resolve('10.0.0.2', { 'x-real-ip': ['1.1.1.1', '2.2.2.2'] }, TEN) === '10.0.0.2', 'repeated header not failed closed');
    }],
    ['NEW-2 trusted peer: cf-connecting-ip takes precedence', () => {
      const got = resolve('10.0.0.2', { 'cf-connecting-ip': '203.0.113.4', 'x-forwarded-for': '203.0.113.9' }, TEN);
      assert(got === '203.0.113.4', `got ${got}`);
    }],
    ['NEW-2 IPv4-mapped IPv6 peer matches IPv4 CIDR', () => {
      const got = resolve('::ffff:10.0.0.2', { 'x-forwarded-for': '203.0.113.9' }, TEN);
      assert(got === '203.0.113.9', `got ${got}`);
    }],
    ['NEW-2 CIDR membership and prefix validation', () => {
      assert(utils.isIpInCidr('10.1.2.3', '10.0.0.0/8'), 'v4 in /8');
      assert(utils.isIpInCidr('::ffff:10.1.2.3', '10.0.0.0/8'), 'mapped v4 in /8');
      assert(!utils.isIpInCidr('11.0.0.1', '10.0.0.0/8'), 'v4 outside /8');
      assert(utils.isIpInCidr('2001:db8::5', '2001:db8::/32'), 'v6 in /32');
      assert(!utils.isIpInCidr('2001:db9::5', '2001:db8::/32'), 'v6 outside /32');
      assert(utils.isIpInCidr('203.0.113.9', '203.0.113.9'), 'bare address entry');
      for (const bad of ['10.0.0.0/33', '10.0.0.0/', '10.0.0.0/x', 'not-an-ip', '::1/129', '']) {
        assert(!utils.isValidProxyCidr(bad), `accepted invalid entry "${bad}"`);
      }
      assert(utils.isValidProxyCidr('10.0.0.0/8') && utils.isValidProxyCidr('2001:db8::/32'), 'rejected valid entry');
    }],
    ['NEW-4 SIIT-translated IPv4 in IPv6 is blocked like its IPv4 form', () => {
      for (const host of ['::ffff:0:127.0.0.1', '[::ffff:0:7f00:1]', '::ffff:0:169.254.169.254', '::ffff:0:10.1.2.3']) {
        assert(utils.isBlockedBootstrapHost(host), `not blocked: ${host}`);
      }
      for (const host of ['::ffff:0:8.8.8.8', '::ffff:8.8.8.8', '8.8.8.8']) {
        assert(!utils.isBlockedBootstrapHost(host), `public address blocked: ${host}`);
      }
    }],
    ['NEW-4 bootstrap URL with SIIT loopback literal is rejected', () => {
      const result = utils.validateBootstrapSourceUrl('https://[::ffff:0:7f00:1]:8443/registry', false);
      assert(result.ok === false, 'SIIT loopback seed URL accepted');
    }],
    ['NEW-3 scrubSensitiveQuery redacts log values and removes dispatch values', () => {
      const redacted = utils.scrubSensitiveQuery('/ws?apiKey=SECRET-1&x=1', 'redact');
      assert(!redacted.includes('SECRET-1') && redacted.includes('x=1'), `redact leaked or dropped params: ${redacted}`);
      const removed = utils.scrubSensitiveQuery('/address/balance/a?apiKey=SECRET-2&network=LTC', 'remove');
      assert(removed === '/address/balance/a?network=LTC', `remove gave ${removed}`);
      assert(utils.scrubSensitiveQuery('/plain', 'remove') === '/plain', 'no-query URL changed');
    }],
  ];
};

// ----------------------------------------------------------------- e2e helpers

const freePort = () =>
  new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });

const startProviderStub = () =>
  new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      // Never answer for the hang IPs: exercises the provider deadline.
      if (HANG_IPS.some((ip) => String(req.url).includes(ip))) return;
      res.statusCode = 404;
      res.end('{}');
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const startRelayer = async (env, stubPort, { expectExit = false } = {}) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-relayer-r2-'));
  const port = await freePort();
  const rpcPort = await freePort();
  const stubUrl = `http://127.0.0.1:${stubPort}`;
  const child = spawn(process.execPath, [DIST_ENTRY], {
    cwd,
    env: {
      PATH: process.env.PATH,
      SERVER_PORT: String(port),
      RPC_HOST: '127.0.0.1',
      RPC_PORT: String(rpcPort),
      WATCHONLY_REGISTRY_PATH: path.join(cwd, 'registry.json'),
      NO_PROXY: '127.0.0.1,localhost',
      HTTP_PROXY: stubUrl,
      HTTPS_PROXY: stubUrl,
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', (chunk) => { logs += chunk; });
  child.stderr.on('data', (chunk) => { logs += chunk; });

  const exited = new Promise((resolve) => child.on('close', (code) => resolve(code)));
  const started = await new Promise((resolve) => {
    const timer = setInterval(() => {
      if (logs.includes('Server Started On Port')) { clearInterval(timer); resolve(true); }
    }, 50);
    exited.then(() => { clearInterval(timer); resolve(false); });
    setTimeout(() => { clearInterval(timer); resolve(false); }, 30000);
  });

  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await exited;
    fs.rmSync(cwd, { recursive: true, force: true });
  };

  return { child, port, started, exited, getLogs: () => logs, stop };
};

const httpRequest = (port, { method = 'GET', target = '/', headers = {}, body } = {}) =>
  new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const reqHeaders = { ...headers };
    if (payload !== undefined) {
      reqHeaders['content-type'] = 'application/json';
      reqHeaders['content-length'] = Buffer.byteLength(payload);
    }
    const req = http.request(
      { host: '127.0.0.1', port, method, path: target, headers: reqHeaders, agent: false, timeout: 20000 },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { text += chunk; });
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(text); } catch { json = null; }
          resolve({ status: res.statusCode, text, json });
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error(`timeout ${method} ${target}`)));
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });

// WebSocket relay call: returns the handshake status when rejected, or the reply
// to `message` (matched by id) when the handshake succeeds.
const wsCall = (port, query, message) => {
  const WebSocket = require('ws');
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws${query}`);
    const timer = setTimeout(() => { ws.terminate(); reject(new Error('ws timeout')); }, 20000);
    ws.on('unexpected-response', (_req, res) => {
      clearTimeout(timer);
      resolve({ handshakeStatus: res.statusCode });
      res.resume();
    });
    ws.on('error', (error) => { clearTimeout(timer); reject(error); });
    ws.on('open', () => ws.send(JSON.stringify({ id: message.id, ...message })));
    ws.on('message', (raw) => {
      const parsed = JSON.parse(String(raw));
      if (parsed.id !== message.id) return;
      clearTimeout(timer);
      ws.close();
      resolve({ reply: parsed });
    });
  });
};

const waitFor = async (predicate, timeoutMs = 3000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(50);
  }
  return false;
};

// ----------------------------------------------------------------- e2e cases

const e2eCases = async (stubPort) => {
  // Group A: API key gate, faucet credential handling, WS credential handling.
  const a = await startRelayer(
    {
      RELAYER_API_KEY: RELAYER_KEY,
      ADMIN_API_KEY: ADMIN_KEY,
      FAUCET_ENABLED: 'true',
    },
    stubPort,
  );
  try {
    assert(a.started, 'group A server did not start');

    await runCase('NEW-1 absolute-form faucet GET without key -> 401', async () => {
      const res = await httpRequest(a.port, { target: 'http://evil.example/address/faucet/abc' });
      assert(res.status === 401, `status ${res.status}`);
    });

    await runCase('NEW-1 percent-encoded faucet GET without key -> 401', async () => {
      const res = await httpRequest(a.port, { target: '/address/%66aucet/abc' });
      assert(res.status === 401, `status ${res.status}`);
    });

    await runCase('NEW-1 absolute-form unsafe route without key -> 401', async () => {
      const res = await httpRequest(a.port, {
        method: 'POST',
        target: 'http://evil.example/address/utxo/abc',
        body: {},
      });
      assert(res.status === 401, `status ${res.status}`);
    });

    await runCase('NEW-1 unmatched unsafe route without key -> 401', async () => {
      const res = await httpRequest(a.port, { method: 'POST', target: '/no-such-route', body: {} });
      assert(res.status === 401, `status ${res.status}`);
    });

    await runCase('NEW-1 public unsafe allowlist route without key is not gated', async () => {
      const res = await httpRequest(a.port, { method: 'POST', target: '/tx/decode', body: {} });
      assert(res.status !== 401, `status ${res.status}`);
    });

    await runCase('NEW-6 faucet with RELAYER key passes hook, handler still needs admin key', async () => {
      const res = await httpRequest(a.port, {
        target: '/address/faucet/abc',
        headers: { 'x-api-key': RELAYER_KEY },
      });
      assert(res.status === 403, `status ${res.status}`);
    });

    await runCase('NEW-6 faucet with ADMIN key in x-api-key reaches handler', async () => {
      const res = await httpRequest(a.port, {
        target: '/address/faucet/abc',
        headers: { 'x-api-key': ADMIN_KEY },
      });
      assert(res.status === 200 && res.text.includes('TESTNET'), `status ${res.status} body ${res.text}`);
    });

    await runCase('NEW-6 faucet with ADMIN key in x-admin-api-key reaches handler', async () => {
      const res = await httpRequest(a.port, {
        target: '/address/faucet/abc',
        headers: { 'x-admin-api-key': ADMIN_KEY },
      });
      assert(res.status === 200, `status ${res.status}`);
    });

    await runCase('NEW-3 rejected WS handshake logs redacted URL only', async () => {
      const res = await wsCall(a.port, '?apiKey=WRONGKEY-5e2b', { id: 'h1', method: 'GET', path: '/address/balance/x' }).catch((e) => ({ error: e }));
      assert(res.handshakeStatus === 401, `handshake ${res.handshakeStatus || res.error}`);
      await sleep(200);
      assert(!a.getLogs().includes('WRONGKEY-5e2b'), 'rejected key value appears in logs');
    });

    await runCase('NEW-3 WS relay dispatch strips query credentials before logging', async () => {
      const res = await wsCall(a.port, `?apiKey=${RELAYER_KEY}`, {
        id: 'q1',
        method: 'GET',
        path: '/address/balance/x',
        query: { apiKey: 'LEAKPROBE-3d4e' },
      });
      assert(res.reply && res.reply.statusCode, `no reply: ${JSON.stringify(res)}`);
      await sleep(200);
      assert(!a.getLogs().includes('LEAKPROBE-3d4e'), 'query credential appears in logs');
      assert(!a.getLogs().includes(RELAYER_KEY), 'handshake key appears in logs');
    });

    await runCase('NEW-6 WS relay forwards x-admin-api-key to faucet after handshake', async () => {
      const res = await wsCall(a.port, `?apiKey=${RELAYER_KEY}`, {
        id: 'f1',
        method: 'GET',
        path: '/address/faucet/abc',
        headers: { 'x-admin-api-key': ADMIN_KEY },
      });
      assert(res.reply && res.reply.statusCode === 200, `statusCode ${res.reply && res.reply.statusCode}`);
    });
  } finally {
    await a.stop();
  }

  // Group B: trusted proxy with a known CIDR; per-client quota; deadline; in-flight cap.
  const b = await startRelayer(
    {
      TRUST_PROXY: '1',
      TRUST_PROXY_CIDRS: '127.0.0.0/8',
      ATTESTATION_RATE_LIMIT_PER_MIN: '2',
      ATTESTATION_MAX_IN_FLIGHT: '1',
      ATTESTATION_PROVIDER_TIMEOUT_MS: '1000',
    },
    stubPort,
  );
  try {
    assert(b.started, 'group B server did not start');
    const check = (xff) => httpRequest(b.port, {
      method: 'POST',
      target: '/attestation/check',
      headers: { 'x-forwarded-for': xff },
      body: {},
    });

    await runCase('NEW-2 trusted peer: XFF client IP is honored (control)', async () => {
      const res = await check('198.51.100.20');
      assert(res.json && res.json.ip === '198.51.100.20', `ip ${res.json && res.json.ip}`);
    });

    await runCase('NEW-5 provider lookup is bounded by ATTESTATION_PROVIDER_TIMEOUT_MS', async () => {
      const started = Date.now();
      const res = await check('198.51.100.7');
      const elapsed = Date.now() - started;
      assert(res.status === 200 && res.json && res.json.success === false, `status ${res.status}`);
      assert(elapsed < 4000, `took ${elapsed}ms`);
    });

    await runCase('NEW-5 per-client quota returns 429 after the window budget', async () => {
      const first = await check('198.51.100.30');
      const second = await check('198.51.100.30');
      const third = await check('198.51.100.30');
      assert(first.status === 200 && second.status === 200, `first ${first.status} second ${second.status}`);
      assert(third.status === 429, `third ${third.status}`);
      const other = await check('198.51.100.31');
      assert(other.status === 200, `other client ${other.status}`);
    });

    await runCase('NEW-5 global in-flight cap returns 503 while a lookup is pending', async () => {
      const pending = check('198.51.100.9').catch((error) => ({ status: 0, error }));
      await sleep(200);
      try {
        const second = await check('198.51.100.8');
        assert(second.status === 503, `second ${second.status}`);
      } finally {
        await pending;
      }
    });
  } finally {
    await b.stop();
  }

  // Group C: trusted proxy CIDR that does NOT contain the test client.
  const c = await startRelayer(
    {
      TRUST_PROXY: '1',
      TRUST_PROXY_CIDRS: '10.0.0.0/8',
      ATTESTATION_ALLOW_IP_OVERRIDE: '1',
    },
    stubPort,
  );
  try {
    assert(c.started, 'group C server did not start');

    await runCase('NEW-2 untrusted peer: spoofed XFF is ignored', async () => {
      const res = await httpRequest(c.port, {
        method: 'POST',
        target: '/attestation/check',
        headers: { 'x-forwarded-for': '198.51.100.20' },
        body: {},
      });
      assert(res.json && res.json.ip === '127.0.0.1', `ip ${res.json && res.json.ip}`);
    });

    await runCase('NEW-2 untrusted peer: body IP override is ignored', async () => {
      const res = await httpRequest(c.port, {
        method: 'POST',
        target: '/attestation/check',
        body: { ip: '198.51.100.21' },
      });
      assert(res.json && res.json.ip === '127.0.0.1', `ip ${res.json && res.json.ip}`);
    });
  } finally {
    await c.stop();
  }
};

const startupCases = async (stubPort) => {
  const expectRefusal = (name, env, mustMention) => runCase(name, async () => {
    const srv = await startRelayer(env, stubPort);
    try {
      assert(!srv.started, 'server started with invalid configuration');
      await srv.exited;
      assert(srv.getLogs().includes(mustMention), `message does not mention ${mustMention}`);
    } finally {
      await srv.stop();
    }
  });

  await expectRefusal('NEW-2 TRUST_PROXY=1 without TRUST_PROXY_CIDRS refuses to start', { TRUST_PROXY: '1' }, 'TRUST_PROXY_CIDRS');
  await expectRefusal('NEW-2 invalid TRUST_PROXY_CIDRS entry refuses to start', { TRUST_PROXY: '1', TRUST_PROXY_CIDRS: '10.0.0.0/33' }, 'TRUST_PROXY_CIDRS');
  await expectRefusal('NEW-5 malformed ATTESTATION_RATE_LIMIT_PER_MIN refuses to start', { ATTESTATION_RATE_LIMIT_PER_MIN: 'ten' }, 'ATTESTATION_RATE_LIMIT_PER_MIN');
};

// ------------------------------------------------------------------------ main

const main = async () => {
  for (const [name, fn] of unitCases()) {
    await runCase(name, fn);
  }

  if (!fs.existsSync(DIST_ENTRY)) {
    console.log(`SKIP e2e: ${path.relative(ROOT, DIST_ENTRY)} missing (run npm run build)`);
    failed.push('e2e: dist missing');
  } else {
    const stub = await startProviderStub();
    try {
      await e2eCases(stub.port);
      await startupCases(stub.port);
    } finally {
      stub.server.close();
    }
  }

  console.log(`\n${passed} passed, ${failed.length} failed`);
  process.exit(failed.length === 0 ? 0 : 1);
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
