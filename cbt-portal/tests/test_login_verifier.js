'use strict';
const assert = require('node:assert/strict');
const { createLoginVerifier } = require('../src/shared/login-verifier');

async function main() {
  let calls = 0;
  let now = 100;
  const verifier = createLoginVerifier(async (password, hash) => {
    calls++;
    await new Promise((resolve) => setImmediate(resolve));
    return password === 'correct' && hash === 'hash';
  }, { clock: () => now, ttlMs: 20, maxEntries: 2 });

  const concurrent = await Promise.all(
    Array.from({ length: 1000 }, () => verifier.verify('correct', 'hash'))
  );
  assert.equal(concurrent.filter(Boolean).length, 1000);
  assert.equal(calls, 1, '1000 identical pending logins must coalesce to one bcrypt compare');
  assert.equal(await verifier.verify('correct', 'hash'), true);
  assert.equal(calls, 1, 'recent positive result should use TTL cache');

  assert.equal(await verifier.verify('wrong', 'hash'), false);
  assert.equal(await verifier.verify('wrong', 'hash'), false);
  assert.equal(calls, 3, 'wrong passwords must never be cached as successful');
  now += 30;
  assert.equal(await verifier.verify('correct', 'hash'), true);
  assert.equal(calls, 4, 'expired cache must be rechecked');
  assert.equal(await verifier.verify('correct', 'other-hash'), false);
  assert.equal(calls, 5, 'different password hashes must never share a result');
  console.log('PASS 1000 in-flight login requests deduplicated, positive TTL, wrong password and hash isolation');
}
main().catch((err) => { console.error(err); process.exitCode = 1; });
