'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const match = html.match(/<script>([\s\S]*?)<\/script>/);
assert.ok(match, 'Inline CBT browser logic must exist');

const elements = new Map();
const callbacks = [];
const calls = [];
const memory = new Map();
let replies = [];
const element = (selector) => {
  if (!elements.has(selector)) {
    elements.set(selector, {
      className: '',
      textContent: '',
      innerHTML: '',
      addEventListener() {},
      classList: { add() {}, remove() {}, toggle() {} },
    });
  }
  return elements.get(selector);
};
const ctx = vm.createContext({
  document: { querySelector: element },
  localStorage: {
    getItem: (key) => memory.get(key) ?? null,
    setItem: (key, value) => memory.set(key, value),
  },
  setTimeout: (fn) => { callbacks.push(fn); },
  setInterval: () => 1,
  clearInterval() {},
  confirm: () => true,
  fetch: async (url, options) => {
    calls.push({ url, method: options?.method || 'GET' });
    const next = replies.shift();
    assert.ok(next, 'Unexpected API request: ' + url);
    return { ok: next.status >= 200 && next.status < 300, status: next.status,
      json: async () => next.body };
  },
  console,
});
vm.runInContext(match[1].replace(/\bboot\(\);\s*$/, ''), ctx, { filename: 'index.html' });
const evalIn = (code) => vm.runInContext(code, ctx);

async function run() {
  evalIn("S.sid = 42; S.queue = { 1: 'A' }; persist();");
  replies = [{ status: 429, body: { error: 'throttled' } }];
  await evalIn('flush()');
  assert.equal(evalIn("S.queue[1]"), 'A', '429 must preserve queued answer');
  assert.match(memory.get('pending_42'), /"1":"A"/, '429 answer remains durable in localStorage');

  replies = [{ status: 200, body: { status: 'saved' } }];
  await evalIn('flush()');
  assert.equal(evalIn('Object.keys(S.queue).length'), 0, '200 ACK removes queued answer');
  assert.equal(memory.get('pending_42'), '{}');

  evalIn("S.queue = { 2: 'B' }; persist();");
  replies = [{ status: 503, body: { error: 'unavailable' } }];
  await evalIn('flush()');
  assert.equal(evalIn("S.queue[2]"), 'B', '503 must preserve queued answer');

  replies = [{ status: 403, body: { error: 'exam_finished' } }];
  await evalIn('flush()');
  assert.equal(evalIn("S.queue[2]"), 'B', 'Permanent rejection must not silently erase answer');

  evalIn("S.queue = { 3: 'C' }; S.finishOnSave = false; persist();");
  replies = [{ status: 200, body: { status: 'saved' } },
             { status: 200, body: { status: 'finished', benar: 1, total: 10 } }];
  const before = calls.length;
  await evalIn('finishExam(true)');
  // finishExam schedules flush but does not await it: let its promise settle.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, before + 1, 'Auto finish must send pending PUT first');
  assert.equal(calls.at(-1).method, 'PUT');
  assert.equal(evalIn('Object.keys(S.queue).length'), 0);
  assert.equal(evalIn('S.finishOnSave'), false, 'Queued completion handed to timer');
  // Execute only scheduled completion callback (the old 429/503 retries are inert now).
  for (let i = 0; i < callbacks.length; i++) {
    const cb = callbacks[i];
    if (calls.length === before + 1 && replies.length === 1) {
      await cb();
      await Promise.resolve();
    }
  }
  assert.ok(calls.some((r, i) => i > before && r.method === 'POST' && r.url.endsWith('/finish')),
    'Finish must occur after successful answer ACK');
  console.log('PASS frontend: 429/503/403 retain unsaved queue, 200 removes it, finish waits for autosave.');
}
run().catch((e) => { console.error(e); process.exitCode = 1; });
