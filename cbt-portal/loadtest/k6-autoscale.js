// Uji beban untuk memicu auto scaling.  Jalankan:
//   k6 run -e BASE_URL=https://<api-id>.execute-api.ap-southeast-1.amazonaws.com loadtest/k6-autoscale.js
// Lalu pantau jumlah task:  aws ecs describe-services --cluster cbt-cluster --services session exam auth
import http from 'k6/http';
import { check, sleep } from 'k6';

const BASE = __ENV.BASE_URL || 'http://localhost:3000';

export const options = {
  stages: [
    { duration: '1m', target: 20 },
    { duration: '5m', target: 150 },   // naik -> scale out
    { duration: '3m', target: 150 },
    { duration: '5m', target: 0 },     // turun -> scale in
  ],
  thresholds: { http_req_failed: ['rate<0.02'], http_req_duration: ['p(95)<800'] },
};

export default function () {
  const nim = `202400${1 + Math.floor(Math.random() * 5)}`;
  const login = http.post(`${BASE}/api/login`, JSON.stringify({ nim, password: 'password123' }), { headers: { 'Content-Type': 'application/json' } });
  check(login, { 'login 200': (r) => r.status === 200 });
  const start = http.post(`${BASE}/api/sessions/start`, JSON.stringify({ exam_id: 1 }), { headers: { 'Content-Type': 'application/json' } });
  const sid = start.json('session_id');
  for (let q = 1; q <= 10; q++) {
    const r = http.put(`${BASE}/api/sessions/${sid}/answers`, JSON.stringify({ question_id: q, pilihan: 'ABCD'[q % 4] }), { headers: { 'Content-Type': 'application/json' } });
    check(r, { 'autosave ok': (x) => x.status === 200 || x.status === 403 });
    sleep(0.3);
  }
}
