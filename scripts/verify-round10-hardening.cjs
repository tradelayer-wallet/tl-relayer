#!/usr/bin/env node
// Regression probes for the round-10 findings (the round-8 watchdog and hostname cap).
// Each probe is written to fail on the round-8 behaviour it guards against.
//
// Runs on loopback with no network and no spawned relayer. Source is loaded through the
// TypeScript transpiler (no build needed).
//
// Usage: node scripts/verify-round10-hardening.cjs

'use strict';

const http = require('http');
const net = require('net');
const h = require('./lib/probe-harness.cjs');
const { results, assert, runCase, sleep, loadSource } = h;

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
// closeAllConnections: an upgraded socket that the test left open would otherwise hold close() forever.
const close = (server) => new Promise((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });

// Resolves true when the server closes the socket within `ms`, false when it stays open.
const closedWithin = (sock, ms) =>
  new Promise((resolve) => {
    // A paused socket never emits 'end', so the response bytes must be drained.
    sock.resume();
    const timer = setTimeout(() => resolve(false), ms);
    sock.once('close', () => { clearTimeout(timer); resolve(true); });
    sock.once('end', () => { clearTimeout(timer); resolve(true); });
  });

const connect = (port) =>
  new Promise((resolve) => {
    const sock = net.connect(port, '127.0.0.1');
    sock.on('error', () => {});
    sock.on('connect', () => resolve(sock));
  });

const readAll = (sock) => {
  let data = '';
  sock.on('data', (chunk) => { data += chunk.toString(); });
  return () => data;
};

const unitCases = () => {
  const watchdog = loadSource('src/services/http-deadlines.service.ts');
  const utils = loadSource('src/services/security-utils.service.ts');
  return [
    ['R10-WD a GET whose handler takes 31 s is answered (no body phase on a bodyless request)', async () => {
      const server = http.createServer(async (req, res) => {
        await sleep(31000);
        res.end('done');
      });
      watchdog.attachRequestDeadlines(server);
      const port = await listen(server);
      const sock = await connect(port);
      const read = readAll(sock);
      sock.write('GET /slow HTTP/1.1\r\nHost: x\r\n\r\n');
      await sleep(32000);
      const body = read();
      sock.destroy();
      await close(server);
      assert(/HTTP\/1\.1 200/.test(body), `no 200 response from a 31 s GET; got ${JSON.stringify(body.slice(0, 60))}`);
    }],
    ['R10-WD an idle keep-alive socket is closed at the idle deadline, not at the Node default', async () => {
      const server = http.createServer((req, res) => res.end('ok'));
      server.keepAliveTimeout = 60000;
      watchdog.attachRequestDeadlines(server, { headersMs: 5000, bodyMs: 5000, idleMs: 300 });
      const port = await listen(server);
      const sock = await connect(port);
      sock.write('GET / HTTP/1.1\r\nHost: x\r\n\r\n');
      const closed = await closedWithin(sock, 2000);
      sock.destroy();
      await close(server);
      assert(closed, 'idle keep-alive socket still open 2 s after a response (idle deadline 300 ms)');
    }],
    ['R10-WD a POST whose body stalls is closed at the body deadline', async () => {
      const server = http.createServer((req, res) => {
        req.resume();
        req.on('end', () => res.end('ok'));
      });
      watchdog.attachRequestDeadlines(server, { headersMs: 5000, bodyMs: 300, idleMs: 5000 });
      const port = await listen(server);
      const sock = await connect(port);
      sock.write('POST /p HTTP/1.1\r\nHost: x\r\nContent-Length: 100\r\n\r\n{"a":');
      const closed = await closedWithin(sock, 2000);
      sock.destroy();
      await close(server);
      assert(closed, 'stalled POST body still open after the body deadline');
    }],
    ['R10-WD two pipelined requests are both answered when the first handler is slower than the idle deadline', async () => {
      const server = http.createServer(async (req, res) => {
        if (req.url === '/slow') await sleep(600);
        res.end(req.url);
      });
      watchdog.attachRequestDeadlines(server, { headersMs: 5000, bodyMs: 5000, idleMs: 200 });
      const port = await listen(server);
      const sock = await connect(port);
      const read = readAll(sock);
      sock.write('GET /slow HTTP/1.1\r\nHost: x\r\n\r\nGET /fast HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n');
      await closedWithin(sock, 3000);
      const body = read();
      sock.destroy();
      await close(server);
      assert((body.match(/HTTP\/1\.1 200/g) || []).length === 2, `pipelined responses: ${(body.match(/HTTP\/1\.1 \d+/g) || []).join(',')}`);
    }],
    ['R10-WD an upgraded socket keeps no HTTP deadline', async () => {
      const server = http.createServer((req, res) => res.end());
      server.on('upgrade', (req, socket) => {
        socket.on('error', () => {});
        socket.on('data', () => {});
        socket.on('end', () => socket.destroy());
        socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: test\r\nConnection: Upgrade\r\n\r\n');
      });
      watchdog.attachRequestDeadlines(server, { headersMs: 200, bodyMs: 200, idleMs: 200 });
      const port = await listen(server);
      const sock = await connect(port);
      sock.write('GET /ws HTTP/1.1\r\nHost: x\r\nUpgrade: test\r\nConnection: Upgrade\r\n\r\n');
      const closed = await closedWithin(sock, 1200);
      sock.destroy();
      await close(server);
      assert(!closed, 'upgraded socket closed by an HTTP deadline');
    }],
    ['R10-HOST a valid 200-character DNS name is not refused as a bootstrap host', () => {
      const label = 'a'.repeat(50);
      const host = [label, label, label, label].join('.');
      assert(host.length === 203, `fixture length ${host.length}`);
      assert(utils.isBlockedBootstrapHost(host) === false, 'valid long DNS name refused');
    }],
    ['R10-HOST a 300-character host is still refused (longer than any DNS name)', () => {
      const label = 'a'.repeat(60);
      assert(utils.isBlockedBootstrapHost([label, label, label, label, label].join('.')) === true, 'oversize host accepted');
    }],
  ];
};

// A case that never settles fails instead of letting the process exit silently.
const withDeadline = (fn, ms) => () =>
  Promise.race([
    fn(),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`no result within ${ms} ms`)), ms)),
  ]);

const main = async () => {
  for (const [name, fn] of unitCases()) {
    await runCase(name, withDeadline(fn, 40000));
  }
  console.log(`\n${results.passed} passed, ${results.failed.length} failed`);
  process.exit(results.failed.length === 0 ? 0 : 1);
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
