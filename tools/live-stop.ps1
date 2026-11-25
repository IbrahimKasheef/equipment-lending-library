<#
.SYNOPSIS
    Stops the LIVE Equipment Lending Library website backend.
.DESCRIPTION
    Reads the PID written by tools\live-start.ps1 and stops that process.
    PostgreSQL keeps running (use tools\pg-stop.ps1 to stop it too).
#>
$root = Split-Path $PSScriptRoot -Parent
$pidFile = Join-Path $root "live\backend\server.pid"

if (-not (Test-Path $pidFile)) {
    Write-Host 'No live-server PID file found - the website is probably not running.'
    exit 0
}

$serverPid = Get-Content $pidFile -ErrorAction SilentlyContinue
if ($serverPid) {
    $proc = Get-Process -Id $serverPid -ErrorAction SilentlyContinue
    if ($proc) {
        Stop-Process -Id $serverPid -Force
        Write-Host "Live website stopped (PID $serverPid)."
    } else {
        Write-Host 'The recorded server process is not running any more.'
    }
}
Remove-Item $pidFile -ErrorAction SilentlyContinue
