# Windows 10/11 Docker Desktop helper; for Windows Server see docs/WINDOWS_SERVER_STAGING.md
param(
  [ValidateRange(1,9999)][int]$Users=1000,
  [ValidateRange(3,15)][int]$WarmupMinutes=7,
  [ValidateRange(0,240)][int]$BootstrapSpreadSeconds=90,
  [ValidateRange(1,16)][int]$AuthReplicas=2,
  [ValidateRange(1,16)][int]$SessionReplicas=3,
  [ValidateRange(1,16)][int]$ExamReplicas=1,
  [string]$BaseUrl='http://localhost:3000'
)
$ErrorActionPreference='Stop'
if (!(Test-Path 'docker-compose.yml') -or !(Test-Path 'loadtest/k6-burst-1000.js')) {
  throw 'Run from inside cbt-portal.'
}
if (!(Test-Path '.env')) { throw 'Copy and configure .env first.' }
$setting=Get-Content .env | Where-Object { $_ -match '^\s*LOADTEST_STUDENTS\s*=' } | Select-Object -Last 1
if (!$setting) { throw 'Set LOADTEST_STUDENTS=1000 or greater.' }
$count=[int](($setting -split '=',2)[1].Split('#')[0].Trim())
if ($count -lt $Users) { throw "Seed count $count is smaller than requested $Users." }
if (!(Get-Command docker -ErrorAction SilentlyContinue)) { throw 'Docker CLI missing.' }
if (!(Get-Command k6 -ErrorAction SilentlyContinue)) { throw 'Install Grafana k6 first.' }
$memory=& docker info --format '{{.MemTotal}}' 2>$null
if ($LASTEXITCODE -ne 0) { throw 'Docker engine unavailable.' }
if ($memory -match '^\d+$' -and [long]$memory -lt 6GB) {
  Write-Warning 'Docker engine has under 6 GiB RAM. k6 1000 VU may be resource-limited.'
}
$cfg=@('-f','docker-compose.yml','-f','docker-compose.stress.yml','-f','docker-compose.observability.yml')
& docker compose @cfg config --quiet
if ($LASTEXITCODE -ne 0) { throw 'Compose config invalid.' }
& docker compose @cfg up -d --build --scale "auth-service=$AuthReplicas" --scale "session-service=$SessionReplicas" --scale "exam-service=$ExamReplicas"
if ($LASTEXITCODE -ne 0) { throw 'Compose startup failed.' }
& docker compose @cfg run --rm db-init
if ($LASTEXITCODE -ne 0) { throw 'Dummy seeding failed.' }
New-Item -ItemType Directory -Force -Path 'loadtest/results' | Out-Null
$burstAt=(Get-Date).ToUniversalTime().AddMinutes($WarmupMinutes).ToString('o')
$env:K6_PROMETHEUS_RW_SERVER_URL='http://localhost:9090/api/v1/write'
$env:K6_PROMETHEUS_RW_TREND_STATS='p(95),p(99),avg,max'
Write-Host "Grafana http://localhost:3001 ; burst UTC $burstAt"
& k6 run -o experimental-prometheus-rw -e "USERS=$Users" -e "BASE_URL=$BaseUrl" -e "BOOTSTRAP_SPREAD_SEC=$BootstrapSpreadSeconds" -e "BURST_AT=$burstAt" --summary-export='loadtest/results/burst-summary.json' 'loadtest/k6-burst-1000.js'
if ($LASTEXITCODE -ne 0) { throw 'k6 thresholds failed; inspect report and Docker logs.' }
Write-Host 'k6 thresholds passed. Validate MySQL row counts separately.' -ForegroundColor Green
