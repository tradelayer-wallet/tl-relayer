#!/usr/bin/env node
// Regression probes for the round-3 findings (F1 .. F10, see the commit messages).
// Each probe is written to fail on the round-2 behaviour it guards against.
//
// Unit section: loads src/ through the TypeScript transpiler (no build needed).
// E2E section: spawns dist/index.js (run `npm run build` first) on loopback ports.
//
// Usage: node scripts/verify-round3-hardening.cjs

'use strict';

const fs = require('fs');
const path = require('path');
const h = require('./lib/probe-harness.cjs');
const {
  ROOT, DIST_ENTRY, RELAYER_KEY, ADMIN_KEY, results, assert, runCase, sleep,
  httpRequest, wsCall, startRelayer, startProviderStub, loadSource,
} = h;

// ---------------------------------------------------------------- unit section

const unitCases = () => {
  const utils = loadSource('src/services/security-utils.service.ts');
  const TEN = ['10.0.0.0/8'];

  return [
    ['F1 trusted peer: x-real-ip and cf-connecting-ip are not believed', () => {
      const headers = { 'x-real-ip': '8.8.8.8', 'cf-connecting-ip': '8.8.4.4', 'x-forwarded-for': '203.0.113.9' };
      const got = utils.resolveClientIp('10.0.0.2', headers, TEN);
      assert(got === '203.0.113.9', `single-value header chose identity: ${got}`);
    }],
    ['F1 trusted peer: client prefix in XFF does not win over the appended hop', () => {
      const got = utils.resolveClientIp('10.0.0.2', { 'x-forwarded-for': '8.8.8.8, 203.0.113.9' }, TEN);
      assert(got === '203.0.113.9', `client-supplied prefix honoured: ${got}`);
    }],
    ['F2 scrubSensitiveQuery drops the fragment in both modes', () => {
      const redacted = utils.scrubSensitiveQuery('/ws?a=1#apiKey=FRAG-SECRET-1', 'redact');
      const removed = utils.scrubSensitiveQuery('/x?a=1#apiKey=FRAG-SECRET-2', 'remove');
      assert(!redacted.includes('FRAG-SECRET-1'), `fragment value survived redact: ${redacted}`);
      assert(!removed.includes('FRAG-SECRET-2'), `fragment value survived remove: ${removed}`);
      assert(redacted === '/ws?a=1' && removed === '/x?a=1', `unexpected output ${redacted} ${removed}`);
    }],
    ['F3 credential key names are matched without case, dash or underscore', () => {
      for (const name of ['x-api-key', 'API-KEY', 'admin_api_key', 'adminApiKey', 'access_token', 'secret', 'password']) {
        const out = utils.scrubSensitiveQuery(`/ws?${name}=VAL-${name.length}`, 'redact');
        assert(!out.includes(`VAL-${name.length}`), `${name} not redacted: ${out}`);
      }
      assert(utils.scrubSensitiveQuery('/ws?network=LTC', 'redact') === '/ws?network=LTC', 'non-credential param altered');
    }],
    ['F4 Teredo addresses are classified by their obfuscated client IPv4', () => {
      // client 127.0.0.1 -> groups 6-7 are ~0x7f00,~0x0001
      assert(utils.isBlockedBootstrapHost('2001:0:0:0:0:0:80ff:fffe'), 'Teredo loopback client not blocked');
      // client 10.0.0.1 -> ~0x0a00,~0x0001
      assert(utils.isBlockedBootstrapHost('2001:0:4136:e378:0:0:f5ff:fffe'), 'Teredo private client not blocked');
      // client 192.0.2.45 is not in the blocklist
      assert(!utils.isBlockedBootstrapHost('2001:0:4136:e378:8000:63bf:3fff:fdd2'), 'public Teredo client blocked');
    }],
    ['F5 attestation result cache stays within its bound', () => {
      const { AttestationService } = loadSource('src/services/attestation.service.ts');
      const svc = new AttestationService();
      const result = { success: false, ip: '0.0.0.0', isBlocked: false, source: 'unknown' };
      let last = '';
      for (let i = 0; i < 10500; i += 1) {
        last = `10.${(i >> 8) & 255}.${i & 255}.1`;
        svc.setCached(last, result);
      }
      assert(svc.cache.size <= 10000, `cache grew to ${svc.cache.size}`);
      assert(svc.getCached(last) !== null, 'most recent entry was evicted');
    }],
    ['F6 rate-limit key collapses an IPv6 /64 and keeps IPv4 and mapped IPv4 distinct', () => {
      assert(typeof utils.rateLimitKey === 'function', 'rateLimitKey missing');
      assert(utils.rateLimitKey('2001:db8:1:2:aaaa::1') === utils.rateLimitKey('2001:db8:1:2:ffff::9'), 'same /64 gives different keys');
      assert(utils.rateLimitKey('2001:db8:1:3::1') !== utils.rateLimitKey('2001:db8:1:2::1'), 'different /64 gives same key');
      assert(utils.rateLimitKey('203.0.113.9') === '203.0.113.9', 'IPv4 key changed');
      assert(utils.rateLimitKey('::ffff:203.0.113.9') === '203.0.113.9', 'mapped IPv4 not canonical');
    }],
    ['F9 a second ? in the query cannot hide a credential from the scrubber', () => {
      const redacted = utils.scrubSensitiveQuery('/x?y=1?apiKey=SMUG-1', 'redact');
      const removed = utils.scrubSensitiveQuery('/x?y=1?apiKey=SMUG-2', 'remove');
      assert(!redacted.includes('SMUG-1'), `smuggled value survived redact: ${redacted}`);
      assert(!removed.includes('SMUG-2'), `smuggled value survived remove: ${removed}`);
      assert(removed === '/x?y=1', `unexpected remove output ${removed}`);
    }],
    ['F10 IPv4-mapped CIDR with a prefix below 96 is rejected', () => {
      assert(!utils.isValidProxyCidr('::ffff:10.0.0.0/8'), 'short mapped prefix accepted');
      assert(utils.isValidProxyCidr('::ffff:10.0.0.0/104'), 'mapped /104 rejected');
      assert(utils.isValidProxyCidr('10.0.0.0/8'), 'IPv4 CIDR rejected');
      assert(!utils.isIpInCidr('5.5.5.5', '::ffff:10.0.0.0/8'), 'public IPv4 peer matched a short mapped prefix');
    }],
  ];
};

// ----------------------------------------------------------------- e2e cases

const e2eCases = async (stubPort) => {
  // Group A: faucet credential handling and log hygiene on a server with both keys.
  const a = await startRelayer(
    { RELAYER_API_KEY: RELAYER_KEY, ADMIN_API_KEY: ADMIN_KEY, FAUCET_ENABLED: 'true' },
    stubPort,
  );
  try {
    assert(a.started, 'group A server did not start');

    await runCase('F8 faucet: a stale x-admin-api-key does not block a valid ADMIN key in x-api-key', async () => {
      const res = await httpRequest(a.port, {
        target: '/address/faucet/abc',
        headers: { 'x-admin-api-key': 'STALE-ADMIN-VALUE', 'x-api-key': ADMIN_KEY },
      });
      assert(res.status === 200, `status ${res.status} body ${res.text}`);
    });

    await runCase('F8 faucet: RELAYER key in x-admin-api-key is rejected at the hook', async () => {
      const res = await httpRequest(a.port, {
        target: '/address/faucet/abc',
        headers: { 'x-admin-api-key': RELAYER_KEY },
      });
      assert(res.status === 401, `status ${res.status}`);
    });

    await runCase('F2 request log never carries a fragment-smuggled key', async () => {
      const res = await httpRequest(a.port, { target: '/address/balance/abc?x=1#apiKey=FRAGLEAK-9a1f' });
      assert(res.status !== 401, `status ${res.status}`);
      await sleep(200);
      assert(!a.getLogs().includes('FRAGLEAK-9a1f'), 'fragment value appears in logs');
    });

    await runCase('F3 request log redacts x-api-key style names in the query', async () => {
      await httpRequest(a.port, { target: '/address/balance/abc?admin_api_key=ADMINLEAK-77c2' });
      await sleep(200);
      assert(!a.getLogs().includes('ADMINLEAK-77c2'), 'admin_api_key value appears in logs');
    });

    await runCase('F9 request log redacts a key smuggled behind a second ?', async () => {
      await httpRequest(a.port, { target: '/address/balance/abc?y=1?apiKey=SMUGLEAK-4d8e' });
      await sleep(200);
      assert(!a.getLogs().includes('SMUGLEAK-4d8e'), 'smuggled apiKey value appears in logs');
    });

    await runCase('F9 request log redacts a key carried in the referer header', async () => {
      await httpRequest(a.port, {
        target: '/address/balance/abc',
        headers: { referer: 'https://app.example/page?apiKey=REFLEAK-3b7a' },
      });
      await sleep(200);
      assert(!a.getLogs().includes('REFLEAK-3b7a'), 'referer apiKey value appears in logs');
    });
  } finally {
    await a.stop();
  }

  // Group B: trusted proxy; header spoofing and IPv6 /64 quota.
  const b = await startRelayer(
    {
      TRUST_PROXY: '1',
      TRUST_PROXY_CIDRS: '127.0.0.0/8',
      ATTESTATION_RATE_LIMIT_PER_MIN: '1',
    },
    stubPort,
  );
  try {
    assert(b.started, 'group B server did not start');
    const check = (headers) => httpRequest(b.port, { method: 'POST', target: '/attestation/check', headers, body: {} });

    await runCase('F1 spoofed cf-connecting-ip cannot mint a fresh quota bucket', async () => {
      const first = await check({ 'cf-connecting-ip': '198.51.100.40' });
      const second = await check({ 'cf-connecting-ip': '198.51.100.41' });
      assert(first.status === 200, `first ${first.status}`);
      assert(second.status === 429, `second ${second.status} (header identity was believed)`);
    });

    await runCase('F6 IPv6 addresses inside one /64 share a quota bucket', async () => {
      const first = await check({ 'x-forwarded-for': '2001:db8:77:1::10' });
      const second = await check({ 'x-forwarded-for': '2001:db8:77:1:ffff::20' });
      assert(first.status === 200, `first ${first.status}`);
      assert(second.status === 429, `second ${second.status}`);
    });
  } finally {
    await b.stop();
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

  await expectRefusal('F7 ATTESTATION_PROVIDER_TIMEOUT_MS above the setTimeout limit refuses to start',
    { ATTESTATION_PROVIDER_TIMEOUT_MS: '3000000000' }, 'ATTESTATION_PROVIDER_TIMEOUT_MS');
  await expectRefusal('F5 non-numeric ATTESTATION_CACHE_TTL_MS refuses to start',
    { ATTESTATION_CACHE_TTL_MS: 'abc' }, 'ATTESTATION_CACHE_TTL_MS');
  await expectRefusal('F10 short IPv4-mapped TRUST_PROXY_CIDRS entry refuses to start',
    { TRUST_PROXY: '1', TRUST_PROXY_CIDRS: '::ffff:10.0.0.0/8' }, 'TRUST_PROXY_CIDRS');
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
