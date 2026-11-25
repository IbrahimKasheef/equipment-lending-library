<#
.SYNOPSIS
    Starts the portable PostgreSQL 16 instance used by this project.
.DESCRIPTION
    The project ships with (or expects) a portable PostgreSQL in
    %LOCALAPPDATA%\pg16 (pgsql\bin + data). No Windows service, no admin rights.
    Override -PgHome to point at another portable location.
.EXAMPLE
    tools\pg-start.ps1
#>
param(
    [string]$PgHome = "$env:LOCALAPPDATA\pg16",
    [int]$Port = 5433
)

$bin  = Join-Path $PgHome "pgsql\bin"
$data = Join-Path $PgHome "data"

if (-not (Test-Path (Join-Path $bin "pg_ctl.exe"))) {
    Write-Error "Portable PostgreSQL not found at '$PgHome'. See README.md (Quick start, Option A) for a standard PostgreSQL install."
    exit 1
}

& (Join-Path $bin "pg_ctl.exe") -D $data status *> $null
if ($LASTEXITCODE -eq 0) {
    Write-Host "PostgreSQL is already running  (data: $data, port: $Port)"
    exit 0
}

& (Join-Path $bin "pg_ctl.exe") -D $data -l (Join-Path $data "server.log") -o "-p $Port" start
if ($LASTEXITCODE -ne 0) {
    Write-Error "PostgreSQL failed to start - see $data\server.log"
    exit 1
}
Write-Host "PostgreSQL is running on port $Port  (data: $data)"
