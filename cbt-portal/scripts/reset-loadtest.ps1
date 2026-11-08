# Safe reset: only synthetic LT0001+ accounts. Real answers and login sessions are preserved.
$ErrorActionPreference = 'Stop'
$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
& node (Join-Path $scriptRoot 'reset-loadtest.js')
if ($LASTEXITCODE -ne 0) { throw "Reset failed (exit $LASTEXITCODE)." }
