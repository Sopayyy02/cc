// Stress test Portal Ujian CBT (Pertemuan 3): 10 -> 100 -> 500 -> 1000 virtual users.
// Tiap level: naik bertahap (RAMP_SEC) lalu DITAHAN (HOLD_SEC, default 120 dtk = 1-3 menit sesuai petunjuk).
//
// Perilaku tiap VU meniru siswa yang mengerjakan ujian:
//   login sekali -> mulai/lanjutkan sesi -> ambil soal -> (jeda) -> autosave jawaban berulang,
//   sesekali GET sesi (heartbeat/resume seperti frontend tiap 5 dtk).
//
// Persiapan (sekali):  LOADTEST_STUDENTS=1000 di .env, lalu
//   docker compose -f docker-compose.yml -f docker-compose.stress.yml up -d --build
// Jalankan:
//   k6 run --out json=loadtest/results/raw.json.gz --summary-export=loadtest/results/summary.json loadtest/k6-stress.js
// Grafik:
//   python3 loadtest/plot_results.py loadtest/results/raw.json.gz
// Ulangi uji:  ./scripts/reset-loadtest.sh   (hapus sesi/jawaban uji agar timer 30 menit mulai ulang)
import http from 'k6/http';
import { check, sleep } from 'k6';
import exec from 'k6/execution';

const BASE = __ENV.BASE_URL || 'http://localhost:3000';
const LEVELS = [10, 100, 500, 1000];
const RAMP = +(__ENV.RAMP_SEC || 30);
const HOLD = +(__ENV.HOLD_SEC || 120);
const THINK_MIN = +(__ENV.THINK_MIN || 1);   // detik jeda antar autosave
const THINK_MAX = +(__ENV.THINK_MAX || 3);
const USERS = +(__ENV.USERS || 1000);        // jumlah siswa uji (LT0001..)
const USER_MODE = __ENV.USER_MODE || 'loadtest'; // 'dummy' = pakai 5 siswa bawaan (2024001-2024005)
const EXAM_ID = +(__ENV.EXAM_ID || 1);

const stages = [];
LEVELS.forEach((v) => { stages.push({ duration: `${RAMP}s`, target: v }, { duration: `${HOLD}s`, target: v }); });
stages.push({ duration: `${RAMP}s`, target: 0 });

// Ambang per level (hanya level "hold"). Tidak membatalkan tes; dipakai untuk melihat di level mana mulai gagal.
const thresholds = {};
LEVELS.forEach((v) => {
  thresholds[`http_req_failed{stage:${v}_hold}`] = ['rate<0.01'];
  thresholds[`http_req_duration{stage:${v}_hold}`] = ['p(95)<1000'];
});

export const options = {
  scenarios: { exam: { executor: 'ramping-vus', startVUs: 0, stages, gracefulRampDown: '10s' } },
  thresholds,
  discardResponseBodies: false,
};

// Label tahap berdasarkan waktu berjalan, mis. "500_hold", "100_ramp", "down".
function stageTag() {
  const t = exec.instance.currentTestRunDuration / 1000;
  const len = RAMP + HOLD;
  const i = Math.floor(t / len);
  if (i >= LEVELS.length) return 'down';
  return `${LEVELS[i]}_${t - i * len < RAMP ? 'ramp' : 'hold'}`;
}

const nimOf = () => (USER_MODE === 'dummy'
  ? `202400${((__VU - 1) % 5) + 1}`
  : `LT${String(((__VU - 1) % USERS) + 1).padStart(4, '0')}`);

const JSON_H = { 'Content-Type': 'application/json' };
const call = (method, path, body, name) => http.request(method, BASE + path, body ? JSON.stringify(body) : null, {
  headers: JSON_H, timeout: '10s', tags: { stage: stageTag(), name },
});

// State per VU (tiap VU punya runtime sendiri; cookie jar juga per VU)
let sid = null;
let qids = [];
let n = 0;

function bootstrap() {
  const login = call('POST', '/api/login', { nim: nimOf(), password: 'password123' }, 'login');
  if (!check(login, { 'login 200': (r) => r.status === 200 })) return false;
  const start = call('POST', '/api/sessions/start', { exam_id: EXAM_ID }, 'start');
  if (!check(start, { 'start 200': (r) => r.status === 200 })) return false;
  sid = start.json('session_id');
  const qs = call('GET', `/api/exams/${EXAM_ID}/questions`, null, 'questions');
  if (!check(qs, { 'soal 200': (r) => r.status === 200 })) return false;
  qids = qs.json().map((q) => q.id);
  return qids.length > 0;
}

export default function () {
  if (sid === null && !bootstrap()) { sid = null; sleep(1); return; }

  const qid = qids[Math.floor(Math.random() * qids.length)];
  const r = call('PUT', `/api/sessions/${sid}/answers`, { question_id: qid, pilihan: 'ABCD'[Math.floor(Math.random() * 4)] }, 'autosave');
  check(r, { 'autosave 200': (x) => x.status === 200 });
  if (r.status === 401 || r.status === 404) sid = null; // sesi/login hilang -> ulangi dari awal

  if (++n % 5 === 0 && sid !== null) {
    check(call('GET', `/api/sessions/${sid}`, null, 'resume'), { 'resume 200': (x) => x.status === 200 });
  }
  sleep(THINK_MIN + Math.random() * (THINK_MAX - THINK_MIN));
}
