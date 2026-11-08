/* Deterministic contract test for the k6 scenario; does not benchmark MySQL/Docker.
 * Executes the actual k6 script in 1,000 isolated synthetic VU runtimes.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const scriptPath = path.join(__dirname, '..', 'loadtest', 'k6-burst-1000.js');
let source = fs.readFileSync(scriptPath, 'utf8');
source = source
  .replace(/^import http from 'k6\/http';$/m, '')
  .replace(/^import \{ sleep \} from 'k6';$/m, '')
  .replace(/^import \{ Rate \} from 'k6\/metrics';$/m, '')
  .replace(/^import exec from 'k6\/execution';$/m, '')
  .replace('export const options =', 'const options =')
  .replace('export default function () {', 'function run() {');
const compiled = new vm.Script(`${source}\nrun();`, { filename: 'k6-burst-1000.js' });
const targetTime = Date.parse('2099-02-01T00:00:00Z');
const data = new Map();
const metrics = new Map();
const allNims = new Set();
let putCount = 0;
let getCount = 0;
const firstRejectedVU = 337;

function executeVu(vu, reject = false) {
  let now = targetTime - 1000;
  let student = null;
  let sid = null;
  const DateMock = class extends Date { static now() { return now; } };
  const http = {
    request(method, url, body) {
      const endpoint = url.replace(/^http:\/\/localhost:3000/, '');
      const json = body ? JSON.parse(body) : null;
      const reply = (status, result) => ({ status, body: JSON.stringify(result) });
      if (method === 'POST' && endpoint === '/api/login') {
        student = json.nim;
        allNims.add(student);
        return reply(200, { id: vu });
      }
      if (method === 'POST' && endpoint === '/api/sessions/start') {
        assert.equal(json.exam_id, 1);
        sid = String(vu);
        return reply(200, { session_id: Number(sid) });
      }
      if (method === 'GET' && endpoint === '/api/exams/1/questions') {
        return reply(200, [{ id: 1 }]);
      }
      if (method === 'PUT' && endpoint === `/api/sessions/${sid}/answers`) {
        assert.equal(typeof student, 'string');
        assert.equal(json.question_id, 1);
        assert.match(json.pilihan, /^[A-D]$/);
        putCount++;
        if (reject) return reply(503, { error: 'synthetic upstream failure' });
        data.set(sid, { 1: json.pilihan });
        return reply(200, { status: 'saved' });
      }
      if (method === 'GET' && endpoint === `/api/sessions/${sid}`) {
        getCount++;
        return reply(200, { answers: data.get(sid) || {} });
      }
      throw Error(`Unexpected request ${method} ${endpoint}`);
    },
  };
  const sandbox = {
    __ENV: { USERS: '1000', BURST_AT: '2099-02-01T00:00:00Z', BOOTSTRAP_SPREAD_SEC: '0' },
    http,
    sleep: (seconds) => { now += Math.ceil(seconds * 1000); },
    Rate: class {
      constructor(name) { this.name = name; }
      add(value) {
        const records = metrics.get(this.name) || [];
        records.push(Boolean(value));
        metrics.set(this.name, records);
      }
    },
    exec: { vu: { idInTest: vu } },
    Date: DateMock,
    Number, String, Math, JSON, Array,
    console,
  };
  compiled.runInNewContext(sandbox);
}

// Regression: end-of-test summary may evaluate this module AFTER BURST_AT.
// The timestamp must not cause an import-time exception in that context.
const postBurstDate = class extends Date { static now() { return targetTime + 30000; } };
const summaryModule = new vm.Script(source + '\noptions.scenarios.answer_burst.vus;', {
  filename: 'k6-burst-1000.js (summary context)',
});
assert.doesNotThrow(() => summaryModule.runInNewContext({
  __ENV: { USERS: '1000', BURST_AT: '2099-02-01T00:00:00Z', BOOTSTRAP_SPREAD_SEC: '0' },
  Date: postBurstDate, Rate: class { add() {} }, Number, String, Math, JSON, Array,
  http: {}, sleep: () => {}, exec: { vu: { idInTest: 1 } }, console,
}), 'End-of-test summary must be constructible after BURST_AT has elapsed');

for (let i = 1; i <= 1000; i++) executeVu(i, i === firstRejectedVU);
assert.equal(allNims.size, 1000, 'Each VU must use a unique student');
assert.equal(putCount, 1000, 'One answer submission per VU');
assert.equal(getCount, 1000, 'Each VU independently attempts DB readback');
assert.equal(data.size, 999, 'Intentionally rejected save must not be treated as persisted');
for (const name of ['burst_warmup_ok', 'burst_on_time', 'burst_submit_ok', 'burst_verify_ok']) {
  assert.equal(metrics.get(name).length, 1000, `Every VU must record ${name}`);
}
assert.equal(metrics.get('burst_warmup_ok').filter(Boolean).length, 1000);
assert.equal(metrics.get('burst_on_time').filter(Boolean).length, 1000);
assert.equal(metrics.get('burst_submit_ok').filter(Boolean).length, 999);
assert.equal(metrics.get('burst_verify_ok').filter(Boolean).length, 999);
console.log('PASS k6 contract: 1,000 distinct synthetic VUs, 1,000 PUTs, 1,000 readback attempts; injected failure correctly reported.');
console.log('NOTE: These mocks are NOT a live concurrent load test of the Docker/MySQL stack.');
