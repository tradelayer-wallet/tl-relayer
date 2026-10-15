#!/usr/bin/env node
// Regression probes for the round-8 findings (see the commit message).
// Each probe is written to fail on the round-7 behaviour it guards against.
//
// Unit section: loads src/ through the TypeScript transpiler (no build needed).
// E2E section: spawns dist/index.js (run `npm run build` first) on loopback ports.
// Provider, chain.so and bootstrap traffic goes through a local stub via HTTP(S)_PROXY,
// so no external service is contacted.
//
// Usage: node scripts/verify-round8-hardening.cjs

'use strict';

const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');
const h = require('./lib/probe-harness.cjs');
const {
  ROOT, DIST_ENTRY, RELAYER_KEY, results, assert, runCase, sleep,
  httpRequest, startRelayer, loadSource,
} = h;

const MIB = 1024 * 1024;

// A local HTTP stub. The handler sees the absolute URL that axios sends through the proxy.
const startStub = (handler) =>
  new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });

// ---------------------------------------------------------------- unit section

const unitCases = () => {
  const rpc = loadSource('src/libs/rpc-calls/index.ts');
  const utils = loadSource('src/services/security-utils.service.ts');
  return [
    ['R8-REDOS a 100 kB dot run in a trusted X-Forwarded-For hop resolves in under 250 ms', () => {
      const hostile = `${'.'.repeat(100000)}x`;
      const started = Date.now();
      const got = utils.resolveClientIp('10.0.0.2', { 'x-forwarded-for': `${hostile}, 10.0.0.9` }, ['10.0.0.0/8']);
      const elapsed = Date.now() - started;
      assert(elapsed < 250, `resolveClientIp took ${elapsed} ms on a 100 kB hop`);
      assert(got === '10.0.0.2', `hostile hop resolved to ${got}, expected the TCP peer`);
    }],
    ['R8-REDOS a 100 kB dot run in a bootstrap host is refused without a long scan', () => {
      const started = Date.now();
      const blocked = utils.isBlockedBootstrapHost(`${'.'.repeat(100000)}x`);
      const elapsed = Date.now() - started;
      assert(elapsed < 250, `isBlockedBootstrapHost took ${elapsed} ms`);
      assert(blocked === true, 'oversize host literal was not refused');
    }],
    ['R8-ADDR chain.so address shape rejects path, query and fragment characters', () => {
      for (const bad of ['x/../../y', 'x?apikey=1', 'x#frag', 'x%2Fy', '', 'short', 'a'.repeat(101)]) {
        assert(!utils.isOutboundSafeAddress(bad), `${JSON.stringify(bad)} accepted`);
      }
      assert(utils.isOutboundSafeAddress('ltc1qw508d6qejxtdg4y5r3zarvary0c5xw7kgmn4n9'), 'bech32 address refused');
      assert(utils.isOutboundSafeAddress('LdP8Qox1VAhCzLJNqrr74YovaWYyNBUWvL'), 'base58 address refused');
    }],
    ['R8-RPC Content-Length is the body byte length for non-ASCII params', async () => {
      const seen = { contentLength: null, bodyBytes: null };
      const server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
          const body = Buffer.concat(chunks);
          seen.contentLength = Number(req.headers['content-length']);
          seen.bodyBytes = body.length;
          let parsed = null;
          try { parsed = JSON.parse(body.toString('utf8')); } catch { parsed = null; }
          res.setHeader('content-type', 'application/json');
          if (!parsed) { res.statusCode = 400; res.end('{"result":null,"error":{"code":-32700,"message":"parse"}}'); return; }
          res.end(JSON.stringify({ result: parsed.params[0], error: null, id: parsed.id }));
        });
      });
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      try {
        const client = new rpc.RpcClient({
          host: '127.0.0.1', port: server.address().port, username: 'u', password: 'p', timeout: 3000,
        });
        const text = 'café über 中文 '.repeat(4);
        const out = await client.call('echo', text);
        assert(seen.contentLength === seen.bodyBytes, `Content-Length ${seen.contentLength} != body bytes ${seen.bodyBytes}`);
        assert(out.data === text, `echoed param mismatch (${out.error || 'no error'})`);
      } finally {
        server.close();
      }
    }],
  ];
};

// ----------------------------------------------------------------- e2e helpers

const openWs = (port, pathAndQuery, headers = {}) => {
  const WebSocket = require('ws');
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${pathAndQuery}`, { headers });
    const timer = setTimeout(() => { ws.terminate(); reject(new Error('ws open timeout')); }, 5000);
    ws.on('open', () => { clearTimeout(timer); resolve(ws); });
    ws.on('error', (error) => { clearTimeout(timer); reject(error); });
  });
};

// Sends one relay request on a fresh socket; resolves with the reply (or the close code).
const wsRelay = (port, message, rawText) =>
  new Promise(async (resolve) => {
    let ws;
    try {
      ws = await openWs(port, '/ws/address/validate/abc');
    } catch (error) {
      resolve({ error: error.message });
      return;
    }
    const timer = setTimeout(() => { ws.terminate(); resolve({ timeout: true }); }, 5000);
    ws.on('error', () => {});
    ws.on('message', (raw) => {
      const parsed = JSON.parse(String(raw));
      if (parsed.id === (message && message.id)) {
        clearTimeout(timer);
        ws.close();
        resolve({ reply: parsed });
      }
    });
    ws.on('close', (code) => { clearTimeout(timer); resolve({ closed: code }); });
    ws.send(rawText !== undefined ? rawText : JSON.stringify(message));
  });

// Raw TCP upgrade request; `reset` aborts the socket with a TCP RST right after writing.
const rawUpgrade = (port, target, { reset = false } = {}) =>
  new Promise((resolve) => {
    const sock = net.connect(port, '127.0.0.1');
    let data = '';
    sock.on('data', (chunk) => { data += chunk; });
    sock.on('error', () => {});
    sock.on('close', () => resolve(data));
    sock.on('connect', () => {
      sock.write(
        `GET ${target} HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n',
      );
      if (reset) sock.resetAndDestroy();
      else setTimeout(() => sock.destroy(), 200);
    });
  });

// Waits for the socket to be closed by the server (or the deadline).
const closedWithin = (sock, ms) =>
  new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    sock.on('close', () => { clearTimeout(timer); resolve(true); });
    sock.on('end', () => { clearTimeout(timer); resolve(true); });
  });

const waitForLog = (child, getLogs, needle, ms) => {
  const deadline = Date.now() + ms;
  return (async () => {
    while (Date.now() < deadline) {
      if (getLogs().includes(needle)) return true;
      await sleep(100);
    }
    return false;
  })();
};

// ----------------------------------------------------------------- e2e cases

const relayCases = async (stubPort) => {
  const b = await startRelayer({}, stubPort);
  try {
    assert(b.started, 'relayer did not start');
    const alive = () => b.child.exitCode === null && b.child.signalCode === null;

    await runCase('R8-WS a 4 MiB relay message is refused with 1009 (maxPayload) and does not reach the router', async () => {
      const big = 'x'.repeat(4 * MIB);
      const reply = await wsRelay(b.port, { id: 'big-1', method: 'POST', path: '/address/validate/abc', body: { pad: big } });
      await sleep(200);
      assert(alive(), 'process exited on oversize WS message');
      assert(reply.closed === 1009, `oversize message answered ${JSON.stringify(reply).slice(0, 120)} instead of close 1009`);
    });

    await runCase('R8-WS a relay message under 1 MiB is still served', async () => {
      const reply = await wsRelay(b.port, { id: 'ok-1', method: 'GET', path: '/address/validate/abc' });
      const status = reply.reply && reply.reply.statusCode;
      assert(status === 400 || status === 200, `small message not served: ${JSON.stringify(reply).slice(0, 160)}`);
    });

    await runCase('R8-WS unknown JSON shapes and field types never kill the process', async () => {
      const variants = [
        { id: 't1', method: 'GET', path: '/address/validate/abc', body: 12345 },
        { id: 't2', method: 'GET', path: '/address/validate/abc', body: true },
        { id: 't3', method: 'GET', path: '/address/validate/abc', body: 1.5 },
        { id: 't4', method: 'GET', path: '/address/validate/abc', body: [] },
        { id: 't5', method: 'GET', path: 5 },
        { id: 't6', method: 'GET', path: ['x'] },
        { id: 't7', method: 'GET', path: '/address/validate/abc', query: 'abc' },
        { id: 't8', method: 'GET', path: '/address/validate/abc', query: [1, 2] },
        { id: 't9', method: 'GET', path: '/address/validate/abc', headers: 'x' },
        { id: 't10', method: 'GET', path: '/address/validate/abc', headers: [1] },
        { id: 't11', method: 'GET', path: '/address/validate/abc', headers: { 'a b': 'x' } },
        { id: 't12', method: 'GET', path: '/address/validate/abc', headers: { 'x-ok': 'a\u0001b' } },
        { id: 't13', method: 'GET', path: '/address/validate/abc', id: { nested: true } },
      ];
      for (const v of variants) {
        await wsRelay(b.port, v);
        await sleep(60);
        assert(alive(), `process exited on ${JSON.stringify(v).slice(0, 100)} (code ${b.child.exitCode})`);
      }
      await wsRelay(b.port, null, '['.repeat(200000) + ']'.repeat(200000));
      await sleep(100);
      assert(alive(), 'process exited on a 400 KB nested JSON array');
    });

    await runCase('R8-HTTP a request that stalls in its headers is closed within the header timeout', async () => {
      const sock = net.connect(b.port, '127.0.0.1');
      sock.on('error', () => {});
      await new Promise((resolve) => sock.on('connect', resolve));
      sock.write('GET /address/validate/abc HTTP/1.1\r\nHost: 127.0.0.1\r\n');
      const closed = await closedWithin(sock, 15000);
      sock.destroy();
      assert(closed, 'stalled-header connection still open after 15 s');
    });

    await runCase('R8-HTTP a request whose body stalls is closed within the request timeout', async () => {
      const sock = net.connect(b.port, '127.0.0.1');
      sock.on('error', () => {});
      await new Promise((resolve) => sock.on('connect', resolve));
      sock.write('POST /rpc/tl_getinfo HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{');
      const closed = await closedWithin(sock, 40000);
      sock.destroy();
      assert(closed, 'stalled-body connection still open after 40 s');
    });

    await runCase('R8-WS an authorised idle WebSocket survives the HTTP request timeout', async () => {
      const ws = await openWs(b.port, '/ws/address/validate/abc');
      await sleep(35000);
      assert(ws.readyState === 1, `idle WebSocket closed by the server (state ${ws.readyState})`);
      const reply = await new Promise((resolve) => {
        const timer = setTimeout(() => resolve(null), 3000);
        ws.once('message', (raw) => { clearTimeout(timer); resolve(JSON.parse(String(raw))); });
        ws.send(JSON.stringify({ id: 'idle-1', method: 'GET', path: '/address/validate/abc' }));
      });
      ws.close();
      assert(reply && reply.id === 'idle-1', 'idle WebSocket could not be used after 35 s');
      assert(alive(), 'process exited during the idle WebSocket probe');
    });
  } finally {
    await b.stop();
  }
};

const upgradeCases = async (stubPort) => {
  const b = await startRelayer({ RELAYER_API_KEY: RELAYER_KEY }, stubPort);
  try {
    assert(b.started, 'relayer (auth) did not start');
    const alive = () => b.child.exitCode === null && b.child.signalCode === null;

    await runCase('R8-UPG an unauthenticated upgrade is answered 401 and the socket is closed', async () => {
      const data = await rawUpgrade(b.port, '/ws/address/validate/abc');
      assert(data.startsWith('HTTP/1.1 401'), `unexpected answer: ${data.slice(0, 60)}`);
    });

    await runCase('R8-UPG resetting unauthenticated upgrades (to /ws and to other paths) never crash the relayer', async () => {
      for (let i = 0; i < 40; i += 1) {
        await rawUpgrade(b.port, i % 2 ? '/ws/address/validate/abc' : '/nope', { reset: true });
      }
      await sleep(400);
      assert(alive(), `process exited after reset upgrades (code ${b.child.exitCode}): ${b.getLogs().slice(-300)}`);
    });
  } finally {
    await b.stop();
  }
};

const providerCases = async () => {
  const hopHits = { count: 0 };
  const hop = await startStub((req, res) => { hopHits.count += 1; res.end('{}'); });
  const provider = { mode: 'big', hits: 0 };
  const providerStub = await startStub((req, res) => {
    const url = String(req.url || '');
    if (url.includes('ipinfo.io')) {
      provider.hits += 1;
      if (provider.mode === 'redirect') {
        // Redirect hop: a provider that answers with 302 must not be followed.
        res.statusCode = 302;
        res.setHeader('location', `http://127.0.0.1:${hop.port}/hop?token=PROVIDER-TOKEN-XYZ`);
        res.end('');
        return;
      }
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      // A 4 MiB reputation body: well above any real ipinfo answer.
      const pad = 'p'.repeat(4 * MIB);
      res.end(JSON.stringify({ ip: '127.0.0.1', country: 'DE', privacy: {}, pad }));
      return;
    }
    res.statusCode = 404;
    res.end('{}');
  });

  const b = await startRelayer({ ATTESTATION_CACHE_TTL_MS: '0', ATTESTATION_FAILURE_CACHE_TTL_MS: '0' }, providerStub.port);
  try {
    assert(b.started, 'relayer (provider) did not start');
    await runCase('R8-PROV an oversize provider body is rejected, not parsed into a success answer', async () => {
      const r = await httpRequest(b.port, { target: '/attestation/ip' });
      assert(r.json && r.json.success === false, `4 MiB provider body accepted: ${r.text.slice(0, 160)}`);
    });
  } finally {
    await b.stop();
  }

  provider.mode = 'redirect';
  const r = await startRelayer({ ATTESTATION_CACHE_TTL_MS: '0', ATTESTATION_FAILURE_CACHE_TTL_MS: '0' }, providerStub.port);
  try {
    assert(r.started, 'relayer (redirect) did not start');
    await runCase('R8-PROV a provider 302 is not followed (no token-bearing request to another host)', async () => {
      hopHits.count = 0;
      provider.hits = 0;
      await httpRequest(r.port, { target: '/attestation/ip' });
      await sleep(300);
      assert(provider.hits > 0, 'provider was never asked, so the redirect was not exercised');
      assert(hopHits.count === 0, `redirect followed ${hopHits.count} time(s)`);
    });
  } finally {
    await r.stop();
  }
  providerStub.server.close();
  hop.server.close();
};

const watchOnlyCases = async () => {
  const chainHits = [];
  const chainStub = await startStub((req, res) => {
    const url = String(req.url || '');
    if (url.includes('chain.so')) {
      chainHits.push({ url, key: req.headers['api-key'] || null });
    }
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ status: 'success', data: { outputs: [] } }));
  });
  const b = await startRelayer({ WATCHONLY_EXTERNAL_API_KEY: 'SOCHAIN-PROBE-KEY' }, chainStub.port);
  try {
    assert(b.started, 'relayer (watch-only) did not start');
    await runCase('R8-WO the verify route refuses a path-injected address (no chain.so request with ".." or the payload)', async () => {
      const injected = encodeURIComponent('x/../../api-probe');
      const r = await httpRequest(b.port, { target: `/address/watchonly/${injected}/verify` });
      await sleep(300);
      const bad = chainHits.filter((hit) => hit.url.includes('..') || hit.url.includes('api-probe'));
      assert(bad.length === 0, `path-injected chain.so request sent: ${JSON.stringify(bad).slice(0, 200)} (status ${r.status})`);
    });
    await runCase('R8-WO a query-injected address does not reach chain.so either', async () => {
      chainHits.length = 0;
      await httpRequest(b.port, { target: `/address/watchonly/${encodeURIComponent('x?apikey=stolen')}/verify` });
      await sleep(300);
      const bad = chainHits.filter((hit) => hit.url.includes('apikey') || hit.url.includes('?'));
      assert(bad.length === 0, `query-injected chain.so request sent: ${JSON.stringify(bad).slice(0, 200)}`);
    });
  } finally {
    await b.stop();
    chainStub.server.close();
  }
};

const bootstrapCases = async () => {
  let seedHits = 0;
  const seedStub = await startStub((req, res) => {
    if (String(req.url || '').includes('seed.r8.example')) {
      seedHits += 1;
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      // 40 MiB seed body: above the bootstrap cap. The registry is empty, so the fetch runs.
      res.write('{"entries":[],"pad":"');
      res.write('s'.repeat(40 * MIB));
      res.end('"}');
      return;
    }
    res.statusCode = 404;
    res.end('{}');
  });
  const b = await startRelayer({ WATCHONLY_REGISTRY_SEED_URL: 'https://seed.r8.example' }, seedStub.port);
  try {
    assert(b.started, 'relayer (bootstrap) did not start');
    await runCase('R8-BOOT an oversize bootstrap seed body is refused by a size cap', async () => {
      const seen = await waitForLog(b.child, b.getLogs, 'maxContentLength', 8000);
      assert(seedHits > 0, 'bootstrap seed was never requested');
      assert(seen, `oversize seed body was not refused by a size cap: ${b.getLogs().slice(-200)}`);
    });
  } finally {
    await b.stop();
    seedStub.server.close();
  }
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
    const stub = await startStub((req, res) => { res.statusCode = 404; res.end('{}'); });
    try {
      await relayCases(stub.port);
      await upgradeCases(stub.port);
      await providerCases();
      await watchOnlyCases();
      await bootstrapCases();
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
