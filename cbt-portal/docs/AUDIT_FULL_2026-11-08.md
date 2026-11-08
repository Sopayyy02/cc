# Full Repository Audit — CBT Portal

**Audit date:** 2026-11-08  
**Baseline:** `6cf678651ef40e7fa94128949a3412e994d274e9` (branch `main`)  
**Scope:** web UI, 3 Node services, MySQL schema and seed, Nginx,
Docker/Compose, Cloudflare preview, GitHub Actions, Grafana/k6, backup
and recovery, Terraform/ECS/RDS, and project documentation.

> **Status:** The remediation in this audit must pass its own GitHub
> Actions checks before being considered verified. Passing synthetic
> concurrency tests does not prove 1,000 real students can submit on a
> specific Windows host. This report distinguishes code-level findings,
> automated integration results, and the outstanding host-specific benchmark.

## Executive summary

| ID | Severity | Area | Finding | Disposition |
|---|---|---|---|---|
| P0-01 | Critical | Reset tooling | `reset-loadtest` deleted **all** answer rows, exam sessions and login sessions; PowerShell script embedded a hard-coded root password. | **Patched:** reset restricted to synthetic `LT[0-9]{4,}` accounts; Windows/Linux/Node entry points share one safe implementation. |
| P0-02 | High | Browser queue | 429 and permanent 4xx responses removed answers from `localStorage`; automatic finish could proceed before pending answers committed. | **Patched:** durable pending queue, retry 429/5xx, visible unrecoverable state, defer finish until ACK. |
| P0-03 | High | Auth consistency | Replica-local session cache could continue accepting a logged-out session for up to 60 seconds. | **Patched:** MySQL session store is authoritative for each request, login rotates session ID. |
| P0-04 | High | Exam consistency | Cached session status could claim `ongoing` after another replica had finished the exam. | **Patched:** authoritative MySQL session status and server-side timer readback. |
| P1-01 | High | Service availability | `/health` always claimed database was `up` without touching MySQL. | **Patched:** `SELECT 1` readiness probe, 503 during DB outage. |
| P1-02 | High | Backups | Restore script could drop the database before checking whether a backup was complete. | **Patched:** validate gzip and mysqldump completion marker first. |
| P1-03 | Medium | Authentication | Student record cache delayed password-reset revocation up to 30 seconds. | **Patched:** current hash read on each login, retain bounded bcrypt coalescing for concurrent identical hashes. |
| P1-04 | Medium | Build reproducibility | Docker image used `npm install` instead of deterministic lockfile install. | **Patched:** `npm ci --omit=dev`. |
| P1-05 | Medium | Docker exposure | Local gateway bound to every host interface unless user configured firewall rules. | **Patched:** localhost by default, explicit `APP_BIND_IP=0.0.0.0` for trusted LAN. |
| P1-06 | High | Capacity evidence | Existing CI tests one student's autosave and mocked 1,000 VUs, **not** a live 1,000-write burst. | **Added:** opt-in `cbt-1000-benchmark.yml` runs real 1,000 PUTs and 1,000 readbacks on a dedicated GitHub runner, uploads stats/logs. **Not automatically executed.** |
| P1-07 | External | Cloudflare OTP | Protected Quick Tunnel sessions may expire a few seconds after authentication on some `cloudflared` versions. | **Open upstream issue:** [cloudflare/cloudflared#1752](https://github.com/cloudflare/cloudflared/issues/1752). No local code change can guarantee a fix. |
| P2-01 | Medium | AWS IaC | ECS services are provisioned before database migration; initial deployments can be temporarily unhealthy or fail circuit breaker. | **Open:** deployment migration ordering should be redesigned and tested on an authorized AWS environment. |
| P2-02 | High | AWS security | AWS ECS `COOKIE_SECURE=false` and the migration seeds predictable demo credentials by default; not suitable as-is for real exams. | **Open:** production provisioning/auth flow, reverse-proxy HTTPS trust and real credential rotation require deployment-specific validation. |
| P2-03 | High | Backup/DRP | RPO 0 is only a goal for acknowledged local commits; single-host disaster recovery and 15-minute backups do not guarantee zero loss. | **Open:** offsite verified backups, RDS PITR, measured recovery drills and encrypted remote Terraform state. |
| P2-04 | Medium | Observability | Grafana receives k6 load metrics but has no first-class MySQL/Node exporter dashboard, SLO alerts or automatic database connection metrics. | **Open:** instrument services and add secured exporters without publishing internal metrics. |
| P2-05 | Medium | Dependency/CI hardening | No continuous SCA/SAST pipeline, SBOM or pinned SHA for third-party GitHub Actions. | **Open:** dependency and workflow supply-chain scan. |
| P2-06 | High | Business logic | Completion still needs multi-replica, last-second autosave/finish race tests under transaction isolation. | **Open:** real concurrent integration test plus a documented policy for last-second/offline submissions. |

## Live vs. synthetic test evidence

- Existing Actions run [#42502167196](https://github.com/Sopayyy02/cc/actions/runs/42502167196)
  **passed** baseline source syntax, a 1,000-VU mocked k6 contract test,
  and one live MySQL login → autosave → readback integration test.
- Audit regression now additionally checks browser retry behavior, the
  scoped reset preserving normal answers, and MySQL readiness during
  an outage. Inspect the new CI run's final status, not just individual steps.
- The optional **manual** [CBT 1,000-answer benchmark](https://github.com/Sopayyy02/cc/actions/workflows/cbt-1000-benchmark.yml)
  provisions ephemeral dummy accounts, runs the real HTTP 1,000-write burst
  and 1,000 readbacks through Docker, and uploads `node-burst-summary.json`,
  `docker-logs.txt`, and `docker-stats.txt`.
- Cloudflare Quick Tunnel is for **interactive preview only**, not for a
  1,000-request stress benchmark. Its documented in-flight cap is 200
  requests, so 429 responses beyond that cap measure the tunnel, not MySQL.
- On Windows, use `node loadtest/node-burst-1000.js` first, then
  `scripts/run-grafana-1000.ps1`. Include `docker stats`, host
  memory/CPU, k6 p95/p99, and failure counts with every capacity claim.

## P0 correction details

### Reset scope and integrity

The old SQL deleted all `answers`, `exam_sessions`, and `sessions`,
including non-test participants. New reset:

```powershell
cd cbt-portal
npm run reset:loadtest
```

deletes answers only for students whose NIM is exactly
`LT` followed by at least four digits, then removes only those students'
exam sessions within a single transaction. Student accounts, questions,
main student sessions, and all login sessions are preserved. Do not use it
against a database containing real users named with that reserved `LTdddd`
pattern: reserve the prefix exclusively for synthetic test accounts.

### Concurrent logout and scoring correctness

A cache local to each instance cannot guarantee invalidation after logout
or session completion on another instance. Each authenticated request now
consults the shared MySQL-backed session store; session metadata is fetched
from MySQL without 60-second stale status. Exam answers remain committed
with a conditional SQL write that checks student ownership, exam status
and expiry.

### Browser autosave guarantees and limits

The UI now keeps pending answers when Nginx returns HTTP 429 or when the
backend fails, retries them, and waits for ACKs before requesting finish.
A rejected 403/409 stays visible and in local storage rather than being
silently deleted. **Important:** an answer sent after the server's expiry
still cannot be counted merely because it was queued locally; recover this
through a supervised exam policy.

## Operational playbooks

### Local test, Windows 10/11

```powershell
git pull origin main
cd cbt-portal
# Configure .env with strong secrets, LOADTEST_STUDENTS=1000
docker compose -f docker-compose.yml -f docker-compose.stress.yml up -d --build
docker compose -f docker-compose.yml -f docker-compose.stress.yml run --rm db-init
node loadtest/node-burst-1000.js
```

Inspect the JSON report and compare `accepted` with `verified` (both
must equal attempted). A 1,000-VU k6 stress test is a separate instrument;
a low-memory Node burst passing does not certify 1,000 simultaneous
browser sessions or sustained activity.

### Cloudflare preview

`Actions → CBT Portal | Cloudflare Web Preview → Run workflow`; provide
a permitted email and a duration no greater than 350 minutes. The
URL is in the workflow Job Summary. Stop with **Cancel workflow**.
GitHub-hosted jobs have a hard 6-hour execution cap. Cloudflare
authentication may be affected by the open upstream bug above.
Use a named Cloudflare Tunnel and a managed Access policy when stable
authenticated previews are required.

## Audit acceptance criteria

Before production or a 1,000-user claim:
1. CI syntax, frontend, login-coalescing, reset-scope and MySQL readiness
   tests must all pass.
2. In a fresh, isolated database, achieve **1,000/1,000** saved-ACK and
   readback verifications for distinct students.
3. Independently record HTTP 429/401/500/502/503/504, p95/p99, CPU,
   memory, disk latency, active MySQL connections, and k6 memory usage.
4. Repeat the benchmark several times, including restart/failover, and
   validate no data loss or grading inconsistency.
5. Audit Access/CSRF, password lifecycle, AWS IaC migration order, remote
   state/secret management, supply-chain hygiene, and backup restoration
   before onboarding real student records.

**Do not equate CI smoke-test success with proven 1,000-user capacity.**
