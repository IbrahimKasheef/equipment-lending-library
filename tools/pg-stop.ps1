<#
.SYNOPSIS
    Stops the portable PostgreSQL 16 instance used by this project.
.EXAMPLE
    tools\pg-stop.ps1
#>
param(
    [string]$PgHome = "$env:LOCALAPPDATA\pg16"
)

$bin  = Join-Path $PgHome "pgsql\bin"
$data = Join-Path $PgHome "data"

if (-not (Test-Path (Join-Path $bin "pg_ctl.exe"))) {
    Write-Error "Portable PostgreSQL not found at '$PgHome'."
    exit 1
}

& (Join-Path $bin "pg_ctl.exe") -D $data stop -m fast
if ($LASTEXITCODE -ne 0) {
    Write-Warning "pg_ctl stop returned a non-zero exit code (server may already be stopped)."
    exit 0
}
Write-Host "PostgreSQL stopped."
