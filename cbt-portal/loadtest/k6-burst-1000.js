// 1 VU per student, 1 synchronized autosave PUT per VU, DB readback verification.
// Do not run against production or services you do not administer.
import http from 'k6/http';
import { sleep } from 'k6';
import { Rate } from 'k6/metrics';
import exec from 'k6/execution';

const BASE = __ENV.BASE_URL || 'http://localhost:3000';
const USERS = Number(__ENV.USERS || 1000);
const EXAM_ID = Number(__ENV.EXAM_ID || 1);
const BOOTSTRAP_SPREAD_SEC = Number(__ENV.BOOTSTRAP_SPREAD_SEC || 90);
const USER_OFFSET = Number(__ENV.USER_OFFSET || 0);
const BURST_AT = Date.parse(__ENV.BURST_AT || '');
const TOLERANCE_MS = Number(__ENV.TOLERANCE_MS || 2000);
if (!Number.isInteger(USERS) || USERS < 1 || USERS > 9999) throw new Error('USERS must be 1..9999');
if (!Number.isInteger(USER_OFFSET) || USER_OFFSET < 0 || USER_OFFSET + USERS > 9999) throw new Error('Invalid USER_OFFSET/USERS partition');
if (!Number.isFinite(BOOTSTRAP_SPREAD_SEC) || BOOTSTRAP_SPREAD_SEC < 0 || BOOTSTRAP_SPREAD_SEC > 240) throw new Error('BOOTSTRAP_SPREAD_SEC must be 0..240');
if (!Number.isFinite(BURST_AT) || BURST_AT <= Date.now()) {
  throw new Error('BURST_AT must be a future ISO-8601 timestamp (allow 3-5 minutes for warmup)');
}

const warmupOk = new Rate('burst_warmup_ok');
const onTime = new Rate('burst_on_time');
const submitOk = new Rate('burst_submit_ok');
const verifyOk = new Rate('burst_verify_ok');
export const options = {
  scenarios: {
    answer_burst: { executor: 'per-vu-iterations', vus: USERS, iterations: 1,
      maxDuration: '20m', gracefulStop: '30s' },
  },
  thresholds: {
    burst_warmup_ok: ['rate==1'],
    burst_on_time: ['rate>0.99'],
    burst_submit_ok: ['rate==1'],
    burst_verify_ok: ['rate==1'],
  },
};

const headers = { 'Content-Type': 'application/json' };
const parseJson = (r) => {
  try { return JSON.parse(r.body || 'null'); } catch (_) { return null; }
};
const call = (method, path, payload, name, phase) =>
  http.request(method, BASE + path, payload === null ? null : JSON.stringify(payload), {
    headers, timeout: '30s', tags: { name, phase },
  });

export default function () {
  const nim = 'LT' + String(USER_OFFSET + exec.vu.idInTest).padStart(4, '0');
  // Spread login/start/questions over ~90 sec so the synchronized test
  // measures 1,000 autosave writes, not 1,000 bcrypt logins at once.
  const warmupDelay = (exec.vu.idInTest - 1) * BOOTSTRAP_SPREAD_SEC / USERS;
  if (warmupDelay > 0) sleep(warmupDelay);
  const login = call('POST', '/api/login',
    { nim, password: __ENV.LOADTEST_PASSWORD || 'password123' }, 'login', 'warmup');
  if (login.status !== 200) {
    warmupOk.add(false); onTime.add(false); submitOk.add(false); verifyOk.add(false);
    return;
  }
  const start = call('POST', '/api/sessions/start', { exam_id: EXAM_ID }, 'session_start', 'warmup');
  const sid = parseJson(start)?.session_id;
  const questions = call('GET', '/api/exams/' + EXAM_ID + '/questions', null, 'questions', 'warmup');
  const qs = parseJson(questions);
  if (start.status !== 200 || !sid || questions.status !== 200 || !Array.isArray(qs) || !qs.length) {
    warmupOk.add(false); onTime.add(false); submitOk.add(false); verifyOk.add(false);
    return;
  }
  warmupOk.add(true);

  const qid = qs[0].id;
  const pilihan = 'ABCD'[(exec.vu.idInTest - 1) % 4];
  const remaining = BURST_AT - Date.now();
  if (remaining > 0) sleep(remaining / 1000);
  const sentAt = Date.now();
  onTime.add(Math.abs(sentAt - BURST_AT) <= TOLERANCE_MS);

  const write = call('PUT', '/api/sessions/' + sid + '/answers',
    { question_id: qid, pilihan }, 'burst_autosave', 'burst');
  const saved = write.status === 200 && parseJson(write)?.status === 'saved';
  submitOk.add(saved);

  // The GET handler fetches persisted MySQL rows, so this tests real readback
  // even when the load balancer sends it to another session-service replica.
  const read = call('GET', '/api/sessions/' + sid, null, 'verify_answer', 'verify');
  const result = parseJson(read);
  verifyOk.add(saved && read.status === 200 && result?.answers?.[qid] === pilihan);
}
