'use strict';
const crypto = require('node:crypto');

/**
 * Deduplicate identical in-flight password verification without caching plaintext
 * passwords. A small, expiring success cache also reduces synchronized logins
 * from synthetic load-test accounts sharing the same salted password hash.
 *
 * Important: this is performance coalescing, not a substitute for login rate limits.
 */
function createLoginVerifier(compare, options = {}) {
  if (typeof compare !== 'function') throw new TypeError('compare must be a function');
  const ttlMs = options.ttlMs ?? 15000;
  const maxEntries = options.maxEntries ?? 512;
  const clock = options.clock ?? (() => Date.now());
  if (!(ttlMs > 0) || !(maxEntries > 0)) throw new RangeError('Invalid verifier cache bounds');

  const pending = new Map();
  const successes = new Map();

  async function verify(password, passwordHash) {
    const text = String(password ?? '');
    const hash = String(passwordHash ?? '');
    const key = crypto.createHash('sha256')
      .update(text).update('\x00').update(hash).digest('hex');
    const cached = successes.get(key);
    if (cached !== undefined) {
      if (cached > clock()) return true;
      successes.delete(key);
    }
    const existing = pending.get(key);
    if (existing) return existing;
    const task = Promise.resolve().then(() => compare(text, hash))
      .then((valid) => {
        if (valid === true) {
          // Bound the cache even if an attacker creates many distinct correct accounts.
          if (successes.size >= maxEntries) successes.delete(successes.keys().next().value);
          successes.set(key, clock() + ttlMs);
          return true;
        }
        return false;
      })
      .finally(() => pending.delete(key));
    pending.set(key, task);
    return task;
  }

  return { verify };
}
module.exports = { createLoginVerifier };
