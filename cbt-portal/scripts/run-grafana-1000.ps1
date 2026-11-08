# Run this from the cbt-portal directory, after applying the patch and setting .env.
# Requires Docker Desktop, Grafana k6, and >=1000 seeded dummy students.
param(
    [ValidateRange(1,9999)][int]$Users = 1000,
    [ValidateRange(2,15)][int]$WarmupMinutes = 5,
    [ValidateRange(1,16)][int]$AuthReplicas = 2,
    [ValidateRange(1,16)][int]$SessionReplicas = 3,
    [ValidateRange(1,16)][int]$ExamReplicas = 1,
    [string]$BaseUrl = 'http://localhost:3000'
)
$ErrorActionPreference = 'Stop'
if (-not (Test-Path 'docker-compose.yml') -or -not (Test-Path 'loadtest/k6-burst-1000.js')) {
    throw 'Please run this script from inside the patched cbt-portal directory.'
}
if (-not (Test-Path '.env')) { throw 'Create and configure .env first.' }
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { throw 'Docker CLI not found.' }
if (-not (Get-Command k6 -ErrorAction SilentlyContinue)) { throw 'Grafana k6 not found on PATH.' }
$cfg = @('-f', 'docker-compose.yml', '-f', 'docker-compose.stress.yml', '-f', 'docker-compose.observability.yml')
& docker compose @cfg config --quiet
if ($LASTEXITCODE -ne 0) { throw 'Docker Compose configuration is invalid.' }
Write-Host "Scaling to auth=$AuthReplicas, session=$SessionReplicas, exam=$ExamReplicas; adjust only after checking Docker Desktop CPU/RAM."
& docker compose @cfg up -d --build --scale "auth-service=$AuthReplicas" --scale "session-service=$SessionReplicas" --scale "exam-service=$ExamReplicas"
if ($LASTEXITCODE -ne 0) { throw 'Docker Compose startup failed.' }
& docker compose @cfg run --rm db-init
if ($LASTEXITCODE -ne 0) { throw 'Test-user seed failed. Check LOADTEST_STUDENTS and .env.' }

$env:BURST_AT = (Get-Date).ToUniversalTime().AddMinutes($WarmupMinutes).ToString('o')
$env:K6_PROMETHEUS_RW_SERVER_URL = 'http://localhost:9090/api/v1/write'
$env:K6_PROMETHEUS_RW_TREND_STATS = 'p(95),p(99),avg,max'
Write-Host "Scheduled synchronized burst: $env:BURST_AT" -ForegroundColor Cyan
Write-Host 'Grafana dashboard: http://localhost:3001 (import official k6 dashboard 19665)'
if (-not (Test-Path 'loadtest/results')) { New-Item -ItemType Directory -Path 'loadtest/results' | Out-Null }
& k6 run -o experimental-prometheus-rw -e "USERS=$Users" -e "BASE_URL=$BaseUrl" -e "BURST_AT=$env:BURST_AT" --tag 'testid=cbt-burst-1000' --summary-export='loadtest/results/burst-summary.json' 'loadtest/k6-burst-1000.js'
if ($LASTEXITCODE -ne 0) {
    Write-Warning 'A k6 threshold failed. Inspect the summary, HTTP codes, logs and DB readbacks.'
    exit $LASTEXITCODE
}
Write-Host 'k6 thresholds passed. Verify the DB row count as documented.' -ForegroundColor Green
