<#
.SYNOPSIS
    Automated integrity test runner for the Equipment Lending Library schema.

.DESCRIPTION
    Creates the test database (default: ll_tests) when it does not exist, then:

      1. resets it:      DROP SCHEMA public CASCADE; CREATE SCHEMA public;
      2. loads           db/schema.sql                      (ON_ERROR_STOP=1)
      3. runs            db/tests/smoke_ok.sql              (ON_ERROR_STOP=1, must exit 0)
         and asserts its output reports the RESERVED and QUEUED outcomes
      4. runs            db/tests/smoke_fail.sql            (errors EXPECTED)
         captures the output and asserts it contains the four required refusals:
             conflicting key value violates exclusion constraint
             CONFLICT_WITH_RESERVATION
             ITEM_NOT_AVAILABLE
             STUDENT_TEMP_BARRED
      5. leaves the test DB clean by reloading schema.sql + seed.sql

    Prints PASS/FAIL for every check and exits 1 if anything failed.  The test
    database is disposable - the user's demo database (lending_library) is
    never touched.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File db\tests\run_tests.ps1

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File db\tests\run_tests.ps1 -Db ll_tests -Port 5433
#>
param(
    [string] $PgBin = (Join-Path $env:LOCALAPPDATA 'pg16\pgsql\bin'),
    [string] $Db    = 'll_tests',
    [int]    $Port  = 5433,
    [string] $User  = 'postgres'
)

$ErrorActionPreference = 'Stop'

$psql     = Join-Path $PgBin 'psql.exe'
$createdb = Join-Path $PgBin 'createdb.exe'
$dbRoot   = Split-Path -Parent $PSScriptRoot          # <repo>\db
$schema   = Join-Path $dbRoot 'schema.sql'
$seed     = Join-Path $dbRoot 'seed.sql'
$smokeOk  = Join-Path $PSScriptRoot 'smoke_ok.sql'
$smokeBad = Join-Path $PSScriptRoot 'smoke_fail.sql'

foreach ($file in @($psql, $schema, $seed, $smokeOk, $smokeBad)) {
    if (-not (Test-Path -LiteralPath $file)) {
        throw "required file missing: $file"
    }
}

$checks = New-Object System.Collections.Generic.List[object]

function Write-Banner {
    param([string] $Text)
    Write-Host ''
    Write-Host ('=' * 74) -ForegroundColor Cyan
    Write-Host ('  ' + $Text) -ForegroundColor Cyan
    Write-Host ('=' * 74) -ForegroundColor Cyan
}

function Test-Check {
    param([string] $Name, [bool] $Passed, [string] $Detail = '')
    $checks.Add([pscustomobject]@{ Name = $Name; Passed = $Passed })
    if ($Passed) {
        Write-Host ('  [PASS] {0}{1}' -f $Name, $(if ($Detail) { "  ($Detail)" } else { '' })) -ForegroundColor Green
    }
    else {
        Write-Host ('  [FAIL] {0}{1}' -f $Name, $(if ($Detail) { "  ($Detail)" } else { '' })) -ForegroundColor Red
    }
}

function Invoke-Captured {
    # Runs a native command and captures stdout + stderr (native stderr is
    # expected from psql in the must-fail step, so the caller's
    # ErrorActionPreference must not treat it as a terminating error).
    param([string] $FilePath, [string[]] $Arguments)
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $output = & $FilePath @Arguments 2>&1 | Out-String
        $code = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $previous
    }
    return [pscustomobject]@{ Output = $output; ExitCode = $code }
}

function Invoke-Psql {
    param([string[]] $PsqlArgs)
    return Invoke-Captured -FilePath $psql -Arguments (@('-X', '-U', $User, '-p', "$Port") + $PsqlArgs)
}

Write-Banner "EQUIPMENT LENDING LIBRARY - INTEGRITY TEST RUN (db: $Db @ port $Port)"

# ---------------------------------------------------------------------------
# 1. ensure the disposable test database exists
# ---------------------------------------------------------------------------
Write-Host "[1/6] ensure test database '$Db' exists"
$existsRun = Invoke-Captured -FilePath $psql -Arguments @('-X', '-U', $User, '-p', "$Port", '-d', 'postgres', '-tAc', "SELECT 1 FROM pg_database WHERE datname = '$Db'")
$existsRaw = $existsRun.Output.Trim()
if ("$existsRaw" -notmatch '1') {
    Write-Host "      creating database '$Db' ..."
    $createRun = Invoke-Captured -FilePath $createdb -Arguments @('-U', $User, '-p', "$Port", $Db)
    if ($createRun.ExitCode -ne 0) {
        throw "createdb failed (exit $($createRun.ExitCode)): $($createRun.Output)"
    }
}
else {
    Write-Host '      already present.'
}

# ---------------------------------------------------------------------------
# 2. reset the schema
# ---------------------------------------------------------------------------
Write-Host '[2/6] reset schema (DROP SCHEMA public CASCADE; CREATE SCHEMA public;)'
$reset = Invoke-Psql -PsqlArgs @('-d', $Db, '-v', 'ON_ERROR_STOP=1', '-c', 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;')
Test-Check 'test schema reset' ($reset.ExitCode -eq 0) "psql exit $($reset.ExitCode)"
if ($reset.ExitCode -ne 0) { Write-Host $reset.Output }

$blocked = ($reset.ExitCode -ne 0)

# ---------------------------------------------------------------------------
# 3. load the schema
# ---------------------------------------------------------------------------
if (-not $blocked) {
    Write-Host '[3/6] load db/schema.sql (ON_ERROR_STOP=1)'
    $schemaRun = Invoke-Psql -PsqlArgs @('-d', $Db, '-v', 'ON_ERROR_STOP=1', '-f', $schema)
    Test-Check 'schema.sql loads cleanly' ($schemaRun.ExitCode -eq 0) "psql exit $($schemaRun.ExitCode)"
    if ($schemaRun.ExitCode -ne 0) {
        Write-Host $schemaRun.Output
        $blocked = $true
    }
}

# ---------------------------------------------------------------------------
# 4. happy paths: smoke_ok.sql must exit 0 and report RESERVED / QUEUED
# ---------------------------------------------------------------------------
if (-not $blocked) {
    Write-Host '[4/6] smoke_ok.sql - happy paths (ON_ERROR_STOP=1)'
    $okRun = Invoke-Psql -PsqlArgs @('-d', $Db, '-v', 'ON_ERROR_STOP=1', '-f', $smokeOk)
    $okText = ($okRun.Output -replace '\s+', ' ')   # undo console line wrapping
    Test-Check 'smoke_ok.sql exits 0 with ON_ERROR_STOP=1' ($okRun.ExitCode -eq 0) "psql exit $($okRun.ExitCode)"
    if ($okRun.ExitCode -ne 0) { Write-Host $okRun.Output }
    Test-Check 'smoke_ok output reports RESERVED outcome' ([bool]($okText -match 'RESERVED'))
    Test-Check 'smoke_ok output reports QUEUED outcome'   ([bool]($okText -match 'QUEUED'))

    # -----------------------------------------------------------------------
    # 5. must-fail paths: smoke_fail.sql (errors are EXPECTED, no ON_ERROR_STOP)
    # -----------------------------------------------------------------------
    Write-Host '[5/6] smoke_fail.sql - must-fail paths (errors expected)'
    $badRun = Invoke-Psql -PsqlArgs @('-d', $Db, '-f', $smokeBad)
    $badText = ($badRun.Output -replace '\s+', ' ')  # undo console line wrapping
    Write-Host "      smoke_fail.sql exit code: $($badRun.ExitCode) (errors are expected here)"

    $expectedErrors = @(
        'conflicting key value violates exclusion constraint',
        'CONFLICT_WITH_RESERVATION',
        'ITEM_NOT_AVAILABLE',
        'STUDENT_TEMP_BARRED'
    )
    foreach ($needle in $expectedErrors) {
        Test-Check ("smoke_fail output contains '{0}'" -f $needle) `
                   ([bool]($badText -match [regex]::Escape($needle)))
    }
}

# ---------------------------------------------------------------------------
# 6. leave the test database clean: schema.sql + seed.sql
# ---------------------------------------------------------------------------
Write-Host '[6/6] leave the test DB clean: reload db/schema.sql + db/seed.sql'
$cleanSchema = Invoke-Psql -PsqlArgs @('-d', $Db, '-v', 'ON_ERROR_STOP=1', '-f', $schema)
$cleanSeed   = Invoke-Psql -PsqlArgs @('-d', $Db, '-v', 'ON_ERROR_STOP=1', '-f', $seed)
Test-Check 'test DB reloaded with schema.sql + seed.sql' `
           ([bool]($cleanSchema.ExitCode -eq 0 -and $cleanSeed.ExitCode -eq 0)) `
           "schema exit $($cleanSchema.ExitCode), seed exit $($cleanSeed.ExitCode)"
if ($cleanSchema.ExitCode -ne 0) { Write-Host $cleanSchema.Output }
if ($cleanSeed.ExitCode -ne 0)   { Write-Host $cleanSeed.Output }

# ---------------------------------------------------------------------------
# summary
# ---------------------------------------------------------------------------
$failed = @($checks | Where-Object { -not $_.Passed })

Write-Banner 'TEST SUMMARY'
Write-Host ('  checks : {0} total, {1} passed, {2} failed' -f $checks.Count, ($checks.Count - $failed.Count), $failed.Count)

if ($failed.Count -gt 0) {
    foreach ($entry in $failed) {
        Write-Host ("  [FAIL] {0}" -f $entry.Name) -ForegroundColor Red
    }
    Write-Host '  RESULT: FAIL' -ForegroundColor Red
    exit 1
}

Write-Host '  RESULT: PASS - all integrity checks green' -ForegroundColor Green
exit 0
