# Grafana + k6: 1,000 CBT answers in a synchronized burst

This procedure is for a **local/staging system you administer**, never a live exam.
There are two distinct tests:

- The existing `loadtest/k6-stress.js` ramps **10 → 100 → 500 → 1,000 VUs**,
  with pauses between autosaves. It is *not* 1,000 PUTs at the same instant.
- `loadtest/k6-burst-1000.js` logs in **1,000 separate dummy students**, starts
  sessions, synchronizes all submissions around one UTC timestamp, and verifies
  persistence with a subsequent `GET /api/sessions/:id` for every student.

## Root-cause candidates found during source audit

1. The normal Nginx limiter is only **50 API requests/s per source IP**; 1,000
   devices behind one NAT are counted as one client. After the 2,000-request
   burst is used, Nginx rejects traffic. With this patch it returns `429`
   (previous default: `503`), rather than looking like a crashed backend.
2. Per-replica answer and exam-start caches can acknowledge stale state. Autosave
   now checks the ongoing exam and time limit as part of its database write.
3. The stress override turned off InnoDB doublewrite and relaxed commit flushes;
   this is unsafe for exam answers and is removed. The real throughput may be
   slower, but answers must remain durable.
4. A true 1,000-write burst still needs measurement. The code alone cannot prove
   it will pass on a particular Windows/Docker Desktop machine.

## Windows 10/11 PowerShell — preparation

In the `cbt-portal` directory, copy `.env.example` to `.env` if needed and
replace every `GANTI_...` value with a strong secret. Set:

```dotenv
LOADTEST_STUDENTS=1000
GRAFANA_ADMIN_PASSWORD=use-a-long-unique-password
```

Start the opt-in stress profile with the optional monitoring stack:

```powershell
docker compose -f docker-compose.yml -f docker-compose.stress.yml -f docker-compose.observability.yml up -d --build --scale auth-service=2 --scale session-service=3 --scale exam-service=1
docker compose -f docker-compose.yml -f docker-compose.stress.yml -f docker-compose.observability.yml ps
```

The numbers above are an initial load-test profile, not a proven capacity recommendation.
The helper script accepts `-AuthReplicas`, `-SessionReplicas`, and `-ExamReplicas`
so you can select counts appropriate for Docker Desktop CPU/RAM.

Ensure 1,000 test students were provisioned in the `db-init` logs. If the job
wasn't recreated after editing `.env`, rerun the idempotent seed explicitly:

```powershell
docker compose -f docker-compose.yml -f docker-compose.stress.yml run --rm db-init
```

Local Grafana: http://localhost:3001 (login `admin` + your configured password).
Prometheus: http://localhost:9090. In Grafana import the official k6 Prometheus
Dashboard **19665**, selecting the provisioned Prometheus data source.
Alternatively, keep your existing Grafana and point k6 remote write to your
existing Prometheus or Grafana Cloud endpoint.

## Burst command (Grafana k6 installed on the Windows host)

For one-command startup after setup, run `powershell -ExecutionPolicy Bypass -File scripts/run-grafana-1000.ps1` from `cbt-portal`. Or run k6 directly:

```powershell
$env:BURST_AT=(Get-Date).ToUniversalTime().AddMinutes(5).ToString('o')
$env:K6_PROMETHEUS_RW_SERVER_URL='http://localhost:9090/api/v1/write'
$env:K6_PROMETHEUS_RW_TREND_STATS='p(95),p(99),avg,max'
k6 run -o experimental-prometheus-rw -e USERS=1000 -e BURST_AT=$env:BURST_AT --tag testid=cbt-burst-1000 --summary-export=loadtest/results/burst-summary.json loadtest/k6-burst-1000.js
```

If running Grafana Cloud instead, use its remote-write URL and set
`K6_PROMETHEUS_RW_USERNAME` / `K6_PROMETHEUS_RW_PASSWORD` via environment
variables, never in Git. Use a new `testid` for each test.

Optional offline contract check (does not replace a real load test):

```powershell
node tests/test_k6_contract.js
```

It runs the k6 script with 1,000 mocked VU identities and an injected 503.
It proves the test logic records missing saves, **not** that MySQL sustains 1,000 concurrent requests.

Pass criteria: `burst_warmup_ok == 100%`, `burst_submit_ok == 100%`,
`burst_verify_ok == 100%`, and `burst_on_time > 99%` within a configurable
2-second window. A 2-second window represents synchronized user submissions,
not mathematically identical-millisecond network arrivals.

## Verify DB persistence and diagnose errors

In a separate PowerShell terminal:

```powershell
docker compose logs --tail=300 gateway session-service auth-service mysql
docker stats --no-stream
docker compose exec mysql mysql -u cbt_user -p cbt_portal
```

Within the MySQL prompt (enter your DB password interactively):

```sql
SELECT COUNT(DISTINCT a.session_id) AS students_with_answers
FROM answers a
JOIN exam_sessions s ON s.id = a.session_id
JOIN students st ON st.id = s.student_id
WHERE st.nim LIKE 'LT%';
SHOW STATUS LIKE 'Threads_connected';
SHOW FULL PROCESSLIST;
```

Expected after a completed first test: `students_with_answers=1000`.
The SQL count alone is not sufficient for subsequent runs; the per-VU GET
readback compares the selected answer and catches stale/missing values.

Classify errors using HTTP status in Grafana and matching Nginx logs:

- **429**: gateway throttling (check compose profile and NAT aggregation).
- **401**: invalid sessions/cookies or missing LT student seeds.
- **403/409**: exam finished, timer expired, or write conflict.
- **500**: backend SQL/application error (check pool and stack trace).
- **502/503/504**: upstream unavailable, socket backlog, or timeouts.
- High p95/p99 with few failures: inspect CPU/RAM, MySQL disk fsync, pool queues,
  Docker Desktop allocated cores, and whether k6 competes for host resources.

**Do not loosen production limits or disable durable MySQL commits to inflate a
stress score.** An optional classroom profile for a trusted school LAN is
available with:

```powershell
docker compose -f docker-compose.yml -f docker-compose.classroom.yml up -d --build
```

For public Internet use, add identity-aware throttling/WAF before enabling the
trusted-LAN profile. After testing, restart only the intended deployment profile.
Never delete real exam data as part of load-test cleanup.
