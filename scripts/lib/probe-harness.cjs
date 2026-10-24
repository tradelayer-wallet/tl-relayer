// Shared harness for the tl-relayer hardening probes (scripts/verify-*.cjs).
// Starts dist/index.js on free loopback ports with reputation-provider traffic
// routed through an offline stub, so no external service is contacted.
'use strict';

const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const DIST_ENTRY = path.join(ROOT, 'dist', 'index.js');

const RELAYER_KEY = 'RELAYERKEY-7f3a91';
const ADMIN_KEY = 'ADMINKEY-9c1d42';
const HANG_IPS = ['198.51.100.7', '198.51.100.9'];

const results = { passed: 0, failed: [] };

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const runCase = async (name, fn) => {
  try {
    await fn();
    results.passed += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    results.failed.push(name);
    console.log(`FAIL ${name}: ${error && error.message ? error.message : error}`);
  }
};

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

module.exports = {
  ROOT,
  DIST_ENTRY,
  RELAYER_KEY,
  ADMIN_KEY,
  HANG_IPS,
  results,
  assert,
  runCase,
  loadSource,
  freePort,
  startProviderStub,
  sleep,
  startRelayer,
  httpRequest,
  wsCall,
  waitFor,
};
