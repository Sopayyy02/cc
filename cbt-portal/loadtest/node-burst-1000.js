// Pure Node.js diagnostic: 1,000 distinct test accounts, 1,000 concurrent HTTP
// autosave PUTs, followed by 1,000 MySQL-backed readback GETs.
// No 1,000-VU k6 memory overhead. Local/staging systems you administer ONLY.
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');

const BASE = new URL(process.env.BASE_URL || 'http://127.0.0.1:3000');
const USERS = Number(process.env.USERS || 1000);
const WARMUP_CONCURRENCY = Number(process.env.WARMUP_CONCURRENCY || 32);
const EXAM_ID = Number(process.env.EXAM_ID || 1);
const TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 45000);
const PASSWORD = process.env.LOADTEST_PASSWORD || 'password123';
if (BASE.protocol !== 'http:' ||
    !(['localhost', '127.0.0.1', '::1'].includes(BASE.hostname) || process.env.ALLOW_REMOTE_TEST === '1')) {
  throw new Error('Only local HTTP targets are allowed by default; set ALLOW_REMOTE_TEST=1 for your own staging LAN.');
}
if (!Number.isInteger(USERS) || USERS < 1 || USERS > 9999) throw new Error('USERS must be 1..9999');
if (!Number.isInteger(WARMUP_CONCURRENCY) || WARMUP_CONCURRENCY < 1 || WARMUP_CONCURRENCY > 100) {
  throw new Error('WARMUP_CONCURRENCY must be 1..100');
}
const agent = new http.Agent({ keepAlive: true, maxSockets: Math.max(USERS, 32), maxTotalSockets: Math.max(USERS, 32) });
let pending = 0, peakPending = 0;

function request(method, uri, payload, cookie) {
  const start = performance.now();
  const data = payload === null ? null : JSON.stringify(payload);
  const headers = { 'Content-Type': 'application/json' };
  if (data !== null) headers['Content-Length'] = Buffer.byteLength(data);
  if (cookie) headers.Cookie = cookie;
  pending++; peakPending = Math.max(pending, peakPending);
  return new Promise((resolve) => {
    let finished = false;
    const finish = (value) => {
      if (finished) return;
      finished = true; pending--;
      resolve({ ...value, latencyMs: +(performance.now() - start).toFixed(2) });
    };
    const req = http.request(new URL(uri, BASE), { method, headers, agent, timeout: TIMEOUT_MS }, (res) => {
      const chunks = [];
      let bytes = 0;
      res.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > 1024 * 1024) { req.destroy(new Error('Response body > 1MiB')); return; }
        chunks.push(chunk);
      });
      res.on('error', (err) => finish({ status: 0, error: err.message }));
      res.on('end', () => {
        let body;
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { body = null; }
        finish({ status: res.statusCode, body, setCookies: res.headers['set-cookie'] || [] });
      });
    });
    req.on('timeout', () => req.destroy(new Error('Client request timeout')));
    req.on('error', (err) => finish({ status: 0, error: err.message }));
    if (data !== null) req.write(data);
    req.end();
  });
}
async function eachLimited(size, workers, fn) {
  const output = Array(size);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(size, workers) }, async () => {
    while (cursor < size) {
      const index = cursor++;
      try { output[index] = await fn(index); }
      catch (err) { output[index] = { error: err.message }; }
    }
  }));
  return output;
}
function summarize(rows) {
  const byStatus = {};
  for (const item of rows) {
    const key = String(item.status || 'transport_error');
    byStatus[key] = (byStatus[key] || 0) + 1;
  }
  const durations = rows.map((r) => r.latencyMs).filter(Number.isFinite).sort((a, b) => a - b);
  const pct = (p) => durations.length ? durations[Math.min(durations.length - 1, Math.ceil(p * durations.length) - 1)] : null;
  return { byStatus, p50Ms: pct(.5), p95Ms: pct(.95), p99Ms: pct(.99), maxMs: durations.at(-1) || null };
}
async function main() {
  console.log('Node autosave diagnostic: warming up', USERS, 'distinct dummy students; concurrency', WARMUP_CONCURRENCY);
  const warmupStarted = performance.now();
  const students = await eachLimited(USERS, WARMUP_CONCURRENCY, async (index) => {
    const nim = 'LT' + String(index + 1).padStart(4, '0');
    const login = await request('POST', '/api/login', { nim, password: PASSWORD }, null);
    if (login.status !== 200) return { nim, failure: 'login', status: login.status, error: login.error };
    const cookie = login.setCookies.find((item) => item.startsWith('cbt.sid='))?.split(';', 1)[0];
    if (!cookie) return { nim, failure: 'cookie', status: login.status };
    const started = await request('POST', '/api/sessions/start', { exam_id: EXAM_ID }, cookie);
    if (started.status !== 200 || !started.body?.session_id) {
      return { nim, failure: 'session_start', status: started.status, error: started.error };
    }
    const questions = await request('GET', '/api/exams/' + EXAM_ID + '/questions', null, cookie);
    if (questions.status !== 200 || !Array.isArray(questions.body) || !questions.body.length) {
      return { nim, failure: 'questions', status: questions.status, error: questions.error };
    }
    return { nim, cookie, sid: started.body.session_id, qid: questions.body[0].id, choice: 'ABCD'[index % 4] };
  });
  const rejected = students.filter((s) => !s || s.failure || !s.sid);
  if (rejected.length) {
    console.error('PRECONDITION FAILED:', rejected.length, 'of', USERS, 'student bootstraps. First failures:', rejected.slice(0, 15));
    process.exitCode = 2;
    agent.destroy();
    return;
  }
  console.log('All', USERS, 'students ready in', Math.round((performance.now() - warmupStarted) / 1000), 'seconds. Launching synchronous burst.');
  const putStarted = performance.now();
  const submissions = await Promise.all(students.map((s) => request('PUT',
    '/api/sessions/' + s.sid + '/answers',
    { question_id: s.qid, pilihan: s.choice }, s.cookie)));
  const putDurationSec = (performance.now() - putStarted) / 1000;
  const accepted = submissions.filter((r) => r.status === 200 && r.body?.status === 'saved').length;
  console.log('PUT stats:', summarize(submissions), 'ACKs:', accepted + '/' + USERS,
    'client pending peak:', peakPending, 'wall sec:', +putDurationSec.toFixed(2));
  const readbacks = await eachLimited(USERS, WARMUP_CONCURRENCY, (i) =>
    request('GET', '/api/sessions/' + students[i].sid, null, students[i].cookie));
  const verified = readbacks.filter((r, i) => r.status === 200 &&
    r.body?.answers?.[students[i].qid] === students[i].choice).length;
  const report = { users: USERS, attempted: submissions.length, accepted, verified,
    elapsedSeconds: +putDurationSec.toFixed(3), peakClientPending: peakPending,
    puts: summarize(submissions), readbacks: summarize(readbacks),
    failedSamples: submissions.map((r, i) => ({ nim: students[i].nim,
      status: r.status, error: r.error || r.body?.error })).filter((r) => r.status !== 200).slice(0, 50),
    generatedAt: new Date().toISOString() };
  const dir = path.join(__dirname, 'results');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'node-burst-summary.json');
  fs.writeFileSync(file, JSON.stringify(report, null, 2));
  console.log('MySQL-backed readbacks verified:', verified, '/', USERS);
  console.log('Diagnostic report:', file);
  if (accepted !== USERS || verified !== USERS) process.exitCode = 1;
  agent.destroy();
}
main().catch((err) => { console.error(err); process.exitCode = 1; agent.destroy(); });
