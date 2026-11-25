<#
.SYNOPSIS
    Starts the LIVE Equipment Lending Library website (PostgreSQL + backend).
.DESCRIPTION
    - starts the portable PostgreSQL 16 if it is not running
    - builds / seeds the live database if it is missing (tools\setup-db.ps1 -Live)
    - starts the Node live backend on the requested port (default 3000) in the
      background and writes its PID to live\backend\server.pid
    Open http://localhost:<port> afterwards.  Stop it with tools\live-stop.ps1.
.EXAMPLE
    tools\live-start.ps1
    tools\live-start.ps1 -Port 8080
#>
param(
    [string]$PgHome = "$env:LOCALAPPDATA\pg16",
    [int]$Port = 3000
)

$root = Split-Path $PSScriptRoot -Parent
$node = (Get-Command node -ErrorAction SilentlyContinue)
if (-not $node) { Write-Error 'Node.js was not found on PATH.'; exit 1 }

# --- 1. PostgreSQL ------------------------------------------------------------
& (Join-Path $PSScriptRoot "pg-start.ps1") -PgHome $PgHome
if ($LASTEXITCODE -ne 0) { exit 1 }

# --- 2. live database (build + seed if missing) ------------------------------
$pgBin = Join-Path $PgHome "pgsql\bin"
$psql  = Join-Path $pgBin "psql.exe"
$hasDb = & $psql -U postgres -p 5433 -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname = 'lending_library_live'"
if ($hasDb -ne "1") {
    Write-Host "Live database missing - building it..."
    & (Join-Path $PSScriptRoot "setup-db.ps1") -Live -Reset
    if ($LASTEXITCODE -ne 0) { exit 1 }
} else {
    $hasSchema = & $psql -U postgres -p 5433 -d lending_library_live -tAc "SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='app_user'"
    if ($hasSchema -ne "1") {
        Write-Host "Live schema missing - building it..."
        & (Join-Path $PSScriptRoot "setup-db.ps1") -Live -Reset
        if ($LASTEXITCODE -ne 0) { exit 1 }
    }
}

# --- 3. already running? ------------------------------------------------------
$pidFile = Join-Path $root "live\backend\server.pid"
if (Test-Path $pidFile) {
    $oldPid = Get-Content $pidFile -ErrorAction SilentlyContinue
    if ($oldPid) {
        $proc = Get-Process -Id $oldPid -ErrorAction SilentlyContinue
        if ($proc) {
            Write-Host "The live website is already running on http://localhost:$Port (PID $oldPid)."
            Write-Host "Stop it with tools\live-stop.ps1 first if you want to restart."
            exit 0
        }
    }
}

# --- 4. start the backend -----------------------------------------------------
$env:PGDATABASE = 'lending_library_live'
$env:PGPORT     = '5433'
$env:PGUSER     = 'postgres'
$env:PGHOST     = 'localhost'
$env:PORT       = "$Port"

$backend = Join-Path $root "live\backend"
$p = Start-Process -FilePath $node.Source -ArgumentList 'server.js' `
    -WorkingDirectory $backend -PassThru `
    -RedirectStandardOutput (Join-Path $backend 'server.log') `
    -RedirectStandardError  (Join-Path $backend 'server.err.log')

$p.Id | Out-File $pidFile -Encoding ascii
Start-Sleep -Seconds 3

# --- 5. health check ----------------------------------------------------------
try {
    $health = Invoke-RestMethod -Uri "http://localhost:$Port/api/health" -TimeoutSec 10
    if ($health.ok -eq $true) {
        Write-Host ''
        Write-Host ("  Live website is UP  ->  http://localhost:{0}" -f $Port) -ForegroundColor Green
        Write-Host ("  Backend PID {0}  (stop with tools\live-stop.ps1)" -f $p.Id)
        Write-Host ''
        Write-Host '  Demo logins:'
        Write-Host '    Student  karthikanupr.is24@rvce.edu.in  / Student@123'
        Write-Host '    Faculty  padmashreet@rvce.edu.in        / Faculty@123'
        Write-Host '    Faculty  rashmir@rvce.edu.in            / Faculty@123'
        Write-Host '    Faculty  rekhabs@rvce.edu.in            / Faculty@123'
        Write-Host '    Admin    admin@rvce.edu.in              / Admin@123'
        exit 0
    }
} catch {
    # fall through to the error below
}

Write-Error "The backend did not answer on port $Port - see live\backend\server.err.log"
exit 1
