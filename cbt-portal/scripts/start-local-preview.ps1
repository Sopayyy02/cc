# Run from inside cbt-portal on Windows, requires Docker Desktop and cloudflared.
# The website is accessible only to the specified email using Cloudflare OTP.
param(
    [Parameter(Mandatory=$true)][string]$AllowedEmail
)
$ErrorActionPreference = 'Stop'
if ($AllowedEmail -notmatch '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$') {
    throw 'AllowedEmail must contain one valid email address.'
}
if (-not (Test-Path 'docker-compose.yml')) {
    throw 'Run the command from the cbt-portal directory.'
}
if (-not (Test-Path '.env')) {
    throw 'Create .env from .env.example and replace all placeholder values first.'
}
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    throw 'Docker Desktop/CLI not found.'
}
if (-not (Get-Command cloudflared -ErrorAction SilentlyContinue)) {
    throw 'cloudflared not found. Install it from https://developers.cloudflare.com/tunnel/downloads/.'
}
Write-Host 'Starting local CBT stack...' -ForegroundColor Cyan
& docker compose up -d --build
if ($LASTEXITCODE -ne 0) { throw 'docker compose up failed.' }
for ($i = 0; $i -lt 90; $i++) {
    try {
        $response = Invoke-WebRequest -Uri 'http://127.0.0.1:3000/healthz' -UseBasicParsing -TimeoutSec 3
        if ($response.StatusCode -eq 200) { break }
    } catch { }
    Start-Sleep -Seconds 2
}
Write-Host 'Local UI: http://localhost:3000' -ForegroundColor Green
Write-Host 'Cloudflare will print a temporary HTTPS URL. Use the allowed email to receive a PIN.' -ForegroundColor Cyan
Write-Host 'To stop the public URL press Ctrl+C. Your local Docker containers will stay running.'
& cloudflared tunnel --no-autoupdate --url http://127.0.0.1:3000 --allowed-mail $AllowedEmail
