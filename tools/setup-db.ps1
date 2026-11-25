<#
.SYNOPSIS
    Creates and seeds (or resets) the database for this project.
.DESCRIPTION
    - Creates the database if it does not exist.
    - Loads db\schema.sql and db\seed.sql when the schema is missing.
    - With -Reset, reloads schema + seed from scratch (drops all data).
    - With -Live, targets the live website database (lending_library_live)
      and loads db\live\live_schema.sql + db\live\live_seed.sql (accounts,
      labs, return-request demo state) instead.
    Assumes the project's PostgreSQL server is running; starts it if needed
    (portable install only).
.EXAMPLE
    tools\setup-db.ps1            # first-time setup (demo database)
    tools\setup-db.ps1 -Reset     # wipe and reload the demo data
    tools\setup-db.ps1 -Live -Reset   # wipe and reload the live website data
#>
param(
    [string]$PgHome = "$env:LOCALAPPDATA\pg16",
    [int]$Port     = 5433,
    [string]$User  = "postgres",
    [string]$Db    = "lending_library",
    [switch]$Reset,
    [switch]$Live
)

if ($Live -and $Db -eq "lending_library") { $Db = "lending_library_live" }
$schemaRel = if ($Live) { "db\live\live_schema.sql" } else { "db\schema.sql" }
$seedRel   = if ($Live) { "db\live\live_seed.sql"   } else { "db\seed.sql" }

$bin      = Join-Path $PgHome "pgsql\bin"
$psql     = Join-Path $bin "psql.exe"
$createdb = Join-Path $bin "createdb.exe"
$root     = Split-Path $PSScriptRoot -Parent

if (-not (Test-Path $psql)) {
    Write-Error "psql.exe not found under '$bin'. See README.md (Quick start, Option A) for a standard PostgreSQL install."
    exit 1
}

# --- make sure the (portable) server is running -------------------------------
& (Join-Path $bin "pg_ctl.exe") -D (Join-Path $PgHome "data") status *> $null
if ($LASTEXITCODE -ne 0) {
    Write-Host "PostgreSQL is not running - starting it first..."
    & (Join-Path $PSScriptRoot "pg-start.ps1") -PgHome $PgHome -Port $Port
    if ($LASTEXITCODE -ne 0) { exit 1 }
}

# --- create the database if missing --------------------------------------------
$exists = & $psql -U $User -p $Port -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname = '$Db'"
if ($exists -ne "1") {
    & $createdb -U $User -p $Port $Db
    if ($LASTEXITCODE -ne 0) { Write-Error "Could not create database '$Db'."; exit 1 }
    Write-Host "Created database '$Db'."
}

# --- is the schema loaded? ------------------------------------------------------
$hasSchema = & $psql -U $User -p $Port -d $Db -tAc "SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'item'"

if ($Reset) {
    Write-Host "Resetting '$Db' (schema + seed)..."
    & $psql -U $User -p $Port -d $Db -q -c "SET client_min_messages = warning; DROP SCHEMA public CASCADE; CREATE SCHEMA public;"
    & $psql -U $User -p $Port -d $Db -q -v ON_ERROR_STOP=1 -f (Join-Path $root $schemaRel) ; if ($LASTEXITCODE -ne 0) { Write-Error "$schemaRel failed"; exit 1 }
    & $psql -U $User -p $Port -d $Db -q -v ON_ERROR_STOP=1 -f (Join-Path $root $seedRel)   ; if ($LASTEXITCODE -ne 0) { Write-Error "$seedRel failed";   exit 1 }
}
elseif ($hasSchema -ne "1") {
    Write-Host "Loading schema + seed into '$Db'..."
    & $psql -U $User -p $Port -d $Db -q -v ON_ERROR_STOP=1 -f (Join-Path $root $schemaRel) ; if ($LASTEXITCODE -ne 0) { Write-Error "$schemaRel failed"; exit 1 }
    & $psql -U $User -p $Port -d $Db -q -v ON_ERROR_STOP=1 -f (Join-Path $root $seedRel)   ; if ($LASTEXITCODE -ne 0) { Write-Error "$seedRel failed";   exit 1 }
}
else {
    Write-Host "'$Db' is already set up (use -Reset to wipe and reload the data)."
}

# --- summary ---------------------------------------------------------------------
& $psql -U $User -p $Port -d $Db -tAc @"
SELECT 'items: '||count(*)||'   students: '||(SELECT count(*) FROM student)||'   active loans: '||(SELECT count(*) FROM loan WHERE returned_at IS NULL) FROM item;
"@
if ($Live) {
    & $psql -U $User -p $Port -d $Db -tAc "SELECT 'labs: '||(SELECT count(*) FROM lab)||'   user accounts: '||(SELECT count(*) FROM app_user);"
}
Write-Host "Database '$Db' is ready on port $Port."
