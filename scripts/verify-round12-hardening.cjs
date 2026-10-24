#!/usr/bin/env node
// Regression probes for the round-12 findings. The client IP rule is pinned to the vector file
// that tl-collator vendors byte for byte (test/fixtures/client-ip-vectors.json): both repos must
// resolve every vector the same way.
//
// Unit section: loads src/ through the TypeScript transpiler (no build needed).
//
// Usage: node scripts/verify-round12-hardening.cjs

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const h = require('./lib/probe-harness.cjs');
const { results, assert, runCase, loadSource } = h;

// sha256 of the vector file; the same digest is pinned in tl-collator's test/round12-hardening.test.mjs.
const VECTOR_SHA256 = '38120ac55cdd3d7938fd09e680d1567a5a78fd95d433dc7ec511a528cda90020';
const VECTOR_PATH = path.join(__dirname, 'fixtures', 'client-ip-vectors.json');

const main = async () => {
  const bytes = fs.readFileSync(VECTOR_PATH);
  await runCase('F5 the vector file is the shared copy (sha256 pinned in both repos)', () => {
    const digest = crypto.createHash('sha256').update(bytes).digest('hex');
    assert(digest === VECTOR_SHA256, `vector file sha256 is ${digest}, want ${VECTOR_SHA256}`);
  });

  const utils = loadSource('src/services/security-utils.service.ts');
  const { cases } = JSON.parse(bytes.toString('utf8'));
  for (const c of cases) {
    await runCase(`F5 ${c.name}`, () => {
      const headers = c.xff === null ? {} : { 'x-forwarded-for': c.xff };
      const got = utils.resolveClientIp(c.peer, headers, c.trusted);
      assert(got === c.expect, `resolveClientIp(${JSON.stringify(c.peer)}, ${JSON.stringify(c.xff)}) = ${JSON.stringify(got)}, want ${JSON.stringify(c.expect)}`);
    });
  }

  console.log(`\n${results.passed} passed, ${results.failed.length} failed`);
  process.exit(results.failed.length === 0 ? 0 : 1);
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
