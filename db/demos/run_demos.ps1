<#
.SYNOPSIS
    Runs the four Equipment Lending Library demos end to end.

.DESCRIPTION
    Executes the narrated SQL demos 01-03 with psql and the real-concurrency
    demo 04 with Node.js + pg.

    Demo 01 prints intentional ERROR lines: they prove that the database
    itself refuses double-booking.  Without ON_ERROR_STOP, psql continues and
    exits 0, so the run still counts as successful.

    The target database must already contain the project schema.  To reset it:

        psql -U postgres -p 5433 -d <db> -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"
        psql -U postgres -p 5433 -d <db> -f db/schema.sql
        psql -U postgres -p 5433 -d <db> -f db/seed.sql

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File db\demos\run_demos.ps1 -Db ll_demos
#>
param(
    [string] $PgBin = (Join-Path $env:LOCALAPPDATA 'pg16\pgsql\bin'),
    [string] $Db    = 'lending_library',
    [int]    $Port  = 5433,
    [string] $User  = 'postgres'
)

$ErrorActionPreference = 'Stop'

$demoDir = $PSScriptRoot
$psql    = Join-Path $PgBin 'psql.exe'

function Write-Banner {
    param([string] $Text)
    Write-Host ''
    Write-Host ('=' * 74) -ForegroundColor Cyan
    Write-Host ('  ' + $Text) -ForegroundColor Cyan
    Write-Host ('=' * 74) -ForegroundColor Cyan
}

if (-not (Test-Path -LiteralPath $psql)) {
    throw "psql.exe was not found under '$PgBin'. Pass -PgBin <PostgreSQL bin folder>."
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw 'node.exe was not found on PATH. Install Node.js LTS first.'
}

$completed = New-Object System.Collections.Generic.List[string]

Write-Banner "EQUIPMENT LENDING LIBRARY - DBMS DEMO RUN (db: $Db @ port $Port)"
Write-Host "psql : $psql"
Write-Host "node : $(& node --version)"
Write-Host ''
Write-Host 'note : demo 01 prints intentional ERROR lines - they prove that the'
Write-Host '       database itself refuses double-booking. psql continues and exits'
Write-Host '       0 for expected errors, so the overall run stays successful.'

$sqlDemos = @(
    @{ File = '01_exclusion_constraint.sql';    Label = 'DEMO 01 - exclusion constraints refuse double-booking' },
    @{ File = '02_fifo_queue.sql';              Label = 'DEMO 02 - fair FIFO hold queue (no-show skip + offer rotation)' },
    @{ File = '03_overdue_and_utilization.sql'; Label = 'DEMO 03 - overdue escalation, fines and utilization reporting' }
)

foreach ($demo in $sqlDemos) {
    Write-Banner $demo.Label
    & $psql -X -U $User -p $Port -d $Db -f (Join-Path $demoDir $demo.File)
    if ($LASTEXITCODE -ne 0) {
        throw "psql exited with code $LASTEXITCODE while running $($demo.File)."
    }
    $completed.Add($demo.File)
}

Write-Banner 'DEMO 04 - real concurrency: SERIALIZABLE checkout races (Node.js + pg)'

Push-Location $demoDir
try {
    if (-not (Test-Path -LiteralPath (Join-Path $demoDir 'node_modules\pg'))) {
        Write-Host 'pg is not installed yet - running: npm install --no-fund --no-audit'
        & npm install --no-fund --no-audit
        if ($LASTEXITCODE -ne 0) {
            throw "npm install failed with exit code $LASTEXITCODE."
        }
    }
    else {
        Write-Host 'pg module already present.'
    }

    # point the node demo at the same database as the SQL demos
    $savedEnv = @{}
    foreach ($name in 'PGHOST', 'PGPORT', 'PGUSER', 'PGDATABASE') {
        $savedEnv[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
    }
    try {
        $env:PGHOST     = 'localhost'
        $env:PGPORT     = "$Port"
        $env:PGUSER     = $User
        $env:PGDATABASE = $Db
        & node (Join-Path $demoDir '04_serializable_checkout.js')
        $nodeExit = $LASTEXITCODE
    }
    finally {
        foreach ($name in 'PGHOST', 'PGPORT', 'PGUSER', 'PGDATABASE') {
            [Environment]::SetEnvironmentVariable($name, $savedEnv[$name], 'Process')
        }
    }

    if ($nodeExit -ne 0) {
        throw "demo 04 reported a failed expectation (node exit code $nodeExit)."
    }
    $completed.Add('04_serializable_checkout.js')
}
finally {
    Pop-Location
}

Write-Banner 'DEMO RUN SUMMARY'
foreach ($file in $completed) {
    Write-Host "  [ok] $file" -ForegroundColor Green
}
Write-Host ''
Write-Host "database : $Db (port $Port)"
Write-Host 'For a pristine rerun, reset the schema and seed first:'
Write-Host '  schema.sql -> seed.sql   (see db/demos/README.md)'
Write-Host ''
Write-Host 'ALL DEMOS COMPLETED.' -ForegroundColor Green
