<#
.SYNOPSIS
    End-to-end acceptance test for the LIVE website API (login, registration,
    holdings, return requests, faculty actions, equipment management).

.DESCRIPTION
    Drives the live backend (live/backend) through a complete journey and
    asserts every step, including the two roles of the project story:

      * a student registers, logs in, sees holdings and requests a return;
      * faculty mark that return as received (fine computed in SQL), approve a
        request (RESERVED / QUEUED), and manage lab equipment (add model,
        add item, retire, restore).

    The script appends demo data (a throw-away student, one model + item).
    Reset afterwards for a pristine demo:  tools\setup-db.ps1 -Live -Reset

.EXAMPLE
    # in one terminal
    tools\pg-start.ps1
    tools\setup-db.ps1 -Live -Reset
    cd live\backend ; npm install ; npm start        # port 3000

    # in another
    powershell -ExecutionPolicy Bypass -File tools\api-acceptance-live-test.ps1
#>
param(
    [string] $BaseUrl = 'http://localhost:3000'
)

$ErrorActionPreference = 'Continue'
$script:passed = 0
$script:failed = 0

function Check {
    param([string] $Name, [bool] $Ok, [string] $Detail = '')
    if ($Ok) {
        $script:passed++
        Write-Host ('  [PASS] {0}{1}' -f $Name, $(if ($Detail) { "  ($Detail)" } else { '' })) -ForegroundColor Green
    } else {
        $script:failed++
        Write-Host ('  [FAIL] {0}{1}' -f $Name, $(if ($Detail) { "  ($Detail)" } else { '' })) -ForegroundColor Red
    }
}

function Api {
    param(
        [string] $Method = 'GET',
        [string] $Path,
        $Body = $null,
        [string] $Token = ''
    )
    $uri = $BaseUrl + $Path
    $headers = @{}
    if ($Token) { $headers['Authorization'] = "Bearer $Token" }
    try {
        $params = @{ Method = $Method; Uri = $uri; Headers = $headers }
        if ($null -ne $Body) {
            $params['ContentType'] = 'application/json; charset=utf-8'
            $params['Body'] = ($Body | ConvertTo-Json -Depth 6)
        }
        $r = Invoke-RestMethod @params
        return [pscustomobject]@{ ok = $true; status = 200; data = $r }
    } catch {
        $status = 0
        $data = $null
        $resp = $_.Exception.Response
        if ($resp) { $status = [int]$resp.StatusCode }
        $text = $_.ErrorDetails.Message
        if (-not $text -and $resp) {
            try {
                $reader = New-Object System.IO.StreamReader($resp.GetResponseStream())
                $text = $reader.ReadToEnd()
            } catch { }
        }
        if ($text) { try { $data = $text | ConvertFrom-Json } catch { } }
        return [pscustomobject]@{ ok = $false; status = $status; data = $data }
    }
}

function New-RandomCode { param([int]$Min = 100, [int]$Max = 999) (Get-Random -Minimum $Min -Maximum $Max) }

Write-Host ''
Write-Host ('=' * 74) -ForegroundColor Cyan
Write-Host '  EQUIPMENT LENDING LIBRARY - LIVE WEBSITE ACCEPTANCE TEST' -ForegroundColor Cyan
Write-Host ("  target: {0}" -f $BaseUrl) -ForegroundColor Cyan
Write-Host ('=' * 74) -ForegroundColor Cyan

# ---------------------------------------------------------------------------
# 0. the app + health
# ---------------------------------------------------------------------------
$h = Api -Path '/api/health'
if (-not $h.ok) {
    Write-Host '  [FAIL] live backend not reachable - start it first:  cd live\backend; npm start' -ForegroundColor Red
    exit 1
}
Check 'GET /api/health' ($h.data.ok -eq $true)

try {
    $page = Invoke-WebRequest -Uri "$BaseUrl/" -UseBasicParsing
    Check 'GET / serves the live frontend' ($page.Content -match 'Equipment Lending Library')
    $logo = Invoke-WebRequest -Uri "$BaseUrl/rvce-logo.png" -UseBasicParsing
    Check 'GET /rvce-logo.png (top-bar logo)' ($logo.StatusCode -eq 200)
} catch {
    Check 'GET / serves the live frontend' $false $_.Exception.Message
}

# ---------------------------------------------------------------------------
# 1. registration rules
# ---------------------------------------------------------------------------
$code = New-RandomCode 100 899
$usn = "1RV24CS$code"
$email = "acceptancestudent$code.cs24@rvce.edu.in"

$bad = Api -Method POST -Path '/api/auth/register' -Body @{
    full_name = 'Acceptance Gmail'; usn = "1RV24CS$(New-RandomCode 100 899)";
    email = "acceptance$code@gmail.com"; dept_id = 1;
    password = 'Password@123'; confirm_password = 'Password@123'
}
Check 'register with non-college email -> 400' ($bad.status -eq 400)

$reg = Api -Method POST -Path '/api/auth/register' -Body @{
    full_name = 'Acceptance Test Student'; usn = $usn; email = $email; dept_id = 1;
    password = 'Student@123'; confirm_password = 'Student@123'
}
Check 'POST /api/auth/register -> 201 + token' ($reg.ok -and $reg.data.token -and $reg.data.user.role -eq 'STUDENT') ("usn {0}" -f $usn)
$studentToken = $reg.data.token

$dupUsn = Api -Method POST -Path '/api/auth/register' -Body @{
    full_name = 'Copy Cat'; usn = $usn; email = "copycat$code.cs24@rvce.edu.in"; dept_id = 1;
    password = 'Student@123'; confirm_password = 'Student@123'
}
Check 'duplicate USN -> 409 USN_TAKEN' ($dupUsn.status -eq 409 -and $dupUsn.data.error -eq 'USN_TAKEN')

$dupMail = Api -Method POST -Path '/api/auth/register' -Body @{
    full_name = 'Copy Cat 2'; usn = "1RV24CS$(New-RandomCode 100 899)"; email = $email; dept_id = 1;
    password = 'Student@123'; confirm_password = 'Student@123'
}
Check 'duplicate email -> 409 EMAIL_TAKEN' ($dupMail.status -eq 409 -and $dupMail.data.error -eq 'EMAIL_TAKEN')

$dotted = Api -Method POST -Path '/api/auth/register' -Body @{
    full_name = 'Dotted Name'; usn = "1RV24CS$(New-RandomCode 100 899)"; email = "dotted.name$code.cs24@rvce.edu.in"; dept_id = 1;
    password = 'Student@123'; confirm_password = 'Student@123'
}
Check 'dotted name in email -> 400 INVALID_EMAIL' ($dotted.status -eq 400 -and $dotted.data.error -eq 'INVALID_EMAIL')

$mismatch = Api -Method POST -Path '/api/auth/register' -Body @{
    full_name = 'Batch Mismatch'; usn = "1RV23CS$(New-RandomCode 100 899)"; email = "batchmismatch$code.cs24@rvce.edu.in"; dept_id = 1;
    password = 'Student@123'; confirm_password = 'Student@123'
}
Check 'email batch != USN batch -> 400 EMAIL_USN_MISMATCH' ($mismatch.status -eq 400 -and $mismatch.data.error -eq 'EMAIL_USN_MISMATCH')

$branchMismatch = Api -Method POST -Path '/api/auth/register' -Body @{
    full_name = 'Branch Mismatch'; usn = "1RV24IS$(New-RandomCode 100 899)"; email = "branchmismatch$code.is24@rvce.edu.in"; dept_id = 1;
    password = 'Student@123'; confirm_password = 'Student@123'
}
Check 'USN branch != selected department -> 400 USN_BRANCH_MISMATCH' ($branchMismatch.status -eq 400 -and $branchMismatch.data.error -eq 'USN_BRANCH_MISMATCH')

# ---------------------------------------------------------------------------
# 2. login / me / change password round-trip (seeded student)
# ---------------------------------------------------------------------------
$wrong = Api -Method POST -Path '/api/auth/login' -Body @{ email = 'karthikanupr.is24@rvce.edu.in'; password = 'nope' }
Check 'wrong password -> 401' ($wrong.status -eq 401 -and $wrong.data.error -eq 'INVALID_CREDENTIALS')

$login = Api -Method POST -Path '/api/auth/login' -Body @{ email = 'karthikanupr.is24@rvce.edu.in'; password = 'Student@123' }
Check 'student login (seeded account)' ($login.ok -and $login.data.token) ("user {0}" -f $login.data.user.name)
$kToken = $login.data.token

$me = Api -Path '/api/auth/me' -Token $kToken
Check 'GET /api/auth/me (student)' ($me.ok -and $me.data.user.student_id -eq '1RV24IS057')

$pw1 = Api -Method POST -Path '/api/auth/password' -Token $kToken -Body @{ current_password = 'Student@123'; new_password = 'Student@321' }
Check 'change password (valid current)' ($pw1.ok)
$relogin = Api -Method POST -Path '/api/auth/login' -Body @{ email = 'karthikanupr.is24@rvce.edu.in'; password = 'Student@321' }
Check 'login with the NEW password' ($relogin.ok -and $relogin.data.token)
$kToken = $relogin.data.token
$old = Api -Method POST -Path '/api/auth/login' -Body @{ email = 'karthikanupr.is24@rvce.edu.in'; password = 'Student@123' }
Check 'login with the OLD password -> 401' ($old.status -eq 401)
$pw2 = Api -Method POST -Path '/api/auth/password' -Token $kToken -Body @{ current_password = 'Student@321'; new_password = 'Student@123' }
Check 'restore the seeded password' ($pw2.ok)
$relogin2 = Api -Method POST -Path '/api/auth/login' -Body @{ email = 'karthikanupr.is24@rvce.edu.in'; password = 'Student@123' }
$kToken = $relogin2.data.token
Check 'login restored' ($relogin2.ok -and $relogin2.data.token)

# ---------------------------------------------------------------------------
# 3. student holdings and the return workflow
# ---------------------------------------------------------------------------
$current = @((Api -Path '/api/me/loans?scope=current' -Token $kToken).data)
$history = @((Api -Path '/api/me/loans?scope=history' -Token $kToken).data)
Check 'GET /api/me/loans?scope=current' ($current.Count -ge 1) ("{0} current holdings" -f $current.Count)
Check 'GET /api/me/loans?scope=history' ($history.Count -ge 1) ("{0} history rows" -f $history.Count)

$labList = @((Api -Path '/api/labs' -Token $kToken).data)
Check 'GET /api/labs -> 28 labs across 10 departments' ($labList.Count -eq 28 -and (@($labList.dept_name | Sort-Object -Unique)).Count -eq 10)

$catalog = @((Api -Path '/api/catalog' -Token $kToken).data)
Check 'GET /api/catalog (college-wide)' ($catalog.Count -ge 50)

# ---------------------------------------------------------------------------
# 4. faculty login + return marking (ISE faculty manages the ISE loan)
# ---------------------------------------------------------------------------
$flogin = Api -Method POST -Path '/api/auth/login' -Body @{ email = 'rashmir@rvce.edu.in'; password = 'Faculty@123' }
Check 'faculty login (seeded account)' ($flogin.ok -and $flogin.data.user.role -eq 'FACULTY')
$fToken = $flogin.data.token

$padLogin = Api -Method POST -Path '/api/auth/login' -Body @{ email = 'padmashreet@rvce.edu.in'; password = 'Faculty@123' }
Check 'Padmashree faculty login (ISE)' ($padLogin.ok -and $padLogin.data.user.staff_dept_name -eq 'Information Science and Engineering')

$rekhaLogin = Api -Method POST -Path '/api/auth/login' -Body @{ email = 'rekhabs@rvce.edu.in'; password = 'Faculty@123' }
Check 'Rekha faculty login (ISE)' ($rekhaLogin.ok -and $rekhaLogin.data.user.staff_dept_name -eq 'Information Science and Engineering')

$active = @((Api -Path '/api/loans?status=active' -Token $fToken).data)
$requested = @($active | Where-Object { $_.return_requested_at })
if ($requested.Count -gt 0) {
    $loanId = $requested[0].loan_id
    $ret = Api -Method POST -Path "/api/loans/$loanId/return" -Token $fToken -Body @{ condition = 'GOOD' }
    Check ("faculty marks the return-requested loan #{0} as RETURNED" -f $loanId) ($ret.ok -and $ret.data.returned_at) ("fine {0}" -f $ret.data.fine_amount)
} else {
    Check 'a return-requested loan exists for the faculty demo' $false 'reset the live DB (tools\setup-db.ps1 -Live -Reset)'
}

$summary = Api -Path '/api/students/1RV24IS057/summary' -Token $fToken
Check 'GET /api/students/:id/summary (holdings + history)' ($summary.ok -and $null -ne $summary.data.current_loans -and $null -ne $summary.data.history_loans)

# ---------------------------------------------------------------------------
# 5. request -> approve (RESERVED / QUEUED) + department scoping
# ---------------------------------------------------------------------------
$start = (Get-Date).AddDays(40).ToString('o')
$end = (Get-Date).AddDays(41).ToString('o')

# CSE request (model 1 = ThinkStation P920): ISE faculty must be blocked
$reqCse = Api -Method POST -Path '/api/me/requests' -Token $kToken -Body @{
    model_id = 1; purpose = 'Acceptance test: CSE workstation for the DBMS benchmark'; requested_start = $start; requested_end = $end
}
Check 'student creates a CSE request' ($reqCse.ok -and $reqCse.data.request_id) ("request #{0}" -f $reqCse.data.request_id)
$reqCseId = $reqCse.data.request_id

$cross = Api -Method POST -Path "/api/requests/$reqCseId/approve" -Token $fToken -Body @{}
Check 'ISE faculty cannot approve a CSE request -> 403' ($cross.status -eq 403 -and $cross.data.error -eq 'DEPT_FORBIDDEN')

# ISE request (model 11 = Raspberry Pi 4)
$reqIse = Api -Method POST -Path '/api/me/requests' -Token $kToken -Body @{
    model_id = 11; purpose = 'Acceptance test: Raspberry Pi for the IoT mini project'; requested_start = $start; requested_end = $end
}
Check 'student creates an ISE request' ($reqIse.ok -and $reqIse.data.request_id) ("request #{0}" -f $reqIse.data.request_id)

$ownIse = Api -Method POST -Path "/api/requests/$($reqIse.data.request_id)/approve" -Token $fToken -Body @{}
Check 'ISE faculty approves the ISE request' ($ownIse.ok -and $ownIse.data.outcome -in @('RESERVED', 'QUEUED')) ("outcome {0}" -f $ownIse.data.outcome)

# ---------------------------------------------------------------------------
# 6. equipment management (add model, add item, retire, restore)
# ---------------------------------------------------------------------------
$model = Api -Method POST -Path '/api/models' -Token $fToken -Body @{
    model_name = "Acceptance Sensor $code"; manufacturer = 'Texas Instruments'; description = 'created by the acceptance test'; category_id = 5
}
Check 'POST /api/models -> 201' ($model.ok -and $model.data.model_id) ("model #{0}" -f $model.data.model_id)

$serial = "ISE-ACC-$code"
$item = Api -Method POST -Path '/api/items' -Token $fToken -Body @{
    serial_no = $serial; model_id = $model.data.model_id; lab_id = 4; item_condition = 'NEW'
}
Check 'POST /api/items -> 201 (added to ISE UG Lab 1A)' ($item.ok -and $item.data.item_id) ("item #{0} ({1})" -f $item.data.item_id, $serial)
$itemId = $item.data.item_id

$labItems = @((Api -Path '/api/labs/4/items' -Token $fToken).data)
Check 'GET /api/labs/4/items contains the new unit' (@($labItems | Where-Object { $_.item_id -eq $itemId }).Count -eq 1)

$retire = Api -Method POST -Path "/api/items/$itemId/retire" -Token $fToken -Body @{}
Check 'POST /api/items/:id/retire' ($retire.ok)
$restore = Api -Method POST -Path "/api/items/$itemId/restore" -Token $fToken -Body @{}
Check 'POST /api/items/:id/restore' ($restore.ok)

# ---------------------------------------------------------------------------
# 7. queue, maintenance, reports, audit, logout
# ---------------------------------------------------------------------------
$tick = Api -Method POST -Path '/api/queue/tick' -Token $fToken -Body @{}
Check 'POST /api/queue/tick' ($tick.ok -and $null -ne $tick.data.offers)

$maint = Api -Method POST -Path '/api/maintenance' -Token $fToken -Body @{
    item_id = $itemId; start = (Get-Date).ToString('o'); end = (Get-Date).AddHours(1).ToString('o'); reason = 'Acceptance test check-up'
}
Check 'POST /api/maintenance -> 201' ($maint.ok -and $maint.data.block_id)
if ($maint.ok) {
    $close = Api -Method POST -Path "/api/maintenance/$($maint.data.block_id)/close" -Token $fToken -Body @{}
    Check 'POST /api/maintenance/:id/close' ($close.ok)
}

foreach ($ep in @('summary', 'utilization', 'dept-utilization', 'overdue', 'idle')) {
    $rep = Api -Path "/api/reports/$ep" -Token $fToken
    Check "GET /api/reports/$ep" ($rep.ok)
}
$esc = Api -Method POST -Path '/api/admin/escalate' -Token $fToken -Body @{}
Check 'POST /api/admin/escalate' ($esc.ok)
$audit = @((Api -Path '/api/audit?limit=5' -Token $fToken).data)
Check 'GET /api/audit' ($audit.Count -ge 1)

# ---------------------------------------------------------------------------
# 8. SQL console (faculty read-only) + administrator console & accounts
# ---------------------------------------------------------------------------
$fSel = Api -Method POST -Path '/api/console/query' -Token $fToken -Body @{ sql = 'SELECT count(*) AS items FROM item' }
Check 'faculty console SELECT works' ($fSel.ok -and @($fSel.data.rows).Count -eq 1)

$fDel = Api -Method POST -Path '/api/console/query' -Token $fToken -Body @{ sql = 'DELETE FROM item WHERE item_id = 99999' }
Check 'faculty console is read-only (DELETE rejected)' ($fDel.status -eq 403 -and $fDel.data.error -eq 'READ_ONLY')

$fMulti = Api -Method POST -Path '/api/console/query' -Token $fToken -Body @{ sql = 'SELECT 1; SELECT 2' }
Check 'console allows only one statement' ($fMulti.status -eq 400 -and $fMulti.data.error -eq 'SQL_ERROR')

$fAdmin = Api -Path '/api/admin/users' -Token $fToken
Check 'faculty cannot access the admin directory -> 403' ($fAdmin.status -eq 403)

$adminLogin = Api -Method POST -Path '/api/auth/login' -Body @{ email = 'admin@rvce.edu.in'; password = 'Admin@123' }
Check 'administrator login' ($adminLogin.ok -and $adminLogin.data.user.role -eq 'ADMIN')
$aToken = $adminLogin.data.token

$schema = Api -Path '/api/console/schema' -Token $aToken
Check 'GET /api/console/schema (all tables)' ($schema.ok -and @($schema.data.relations).Count -ge 20 -and (@($schema.data.relations.name) -contains 'app_user'))

$aSel = Api -Method POST -Path '/api/console/query' -Token $aToken -Body @{ sql = 'SELECT email, role FROM app_user ORDER BY email' }
Check 'admin console SELECT app_user' ($aSel.ok -and @($aSel.data.rows).Count -ge 6)

$users = @((Api -Path '/api/admin/users' -Token $aToken).data)
Check 'GET /api/admin/users' ($users.Count -ge 6)

$facEmail = "acceptancefaculty$code@rvce.edu.in"
$mkFac = Api -Method POST -Path '/api/admin/faculty' -Token $aToken -Body @{
    staff_name = 'Acceptance Faculty'; email = $facEmail; staff_role = 'TECHNICIAN'; dept_id = 1; password = 'Welcome@123'
}
Check 'POST /api/admin/faculty -> 201' ($mkFac.ok -and $mkFac.data.user_id) ("user #{0}" -f $mkFac.data.user_id)

$facLogin = Api -Method POST -Path '/api/auth/login' -Body @{ email = $facEmail; password = 'Welcome@123' }
Check 'new faculty account can sign in' ($facLogin.ok -and $facLogin.data.user.role -eq 'FACULTY')
Check 'new faculty account belongs to CSE' ($facLogin.data.user.staff_dept_name -eq 'Computer Science and Engineering')

$facIseLab = Api -Path '/api/labs/4/items' -Token $facLogin.data.token
Check 'CSE faculty cannot view ISE lab items -> 403' ($facIseLab.status -eq 403)
$facOwnLab = Api -Path '/api/labs/1/items' -Token $facLogin.data.token
Check 'CSE faculty can view its own CSE lab items' ($facOwnLab.ok)
$facRequests = @((Api -Path '/api/requests' -Token $facLogin.data.token).data)
Check 'CSE faculty request list is department-scoped' ($facRequests.Count -ge 1 -and @($facRequests | Where-Object { $_.dept_id -ne 1 }).Count -eq 0)

$delFac = Api -Method DELETE -Path ("/api/admin/users/" + $mkFac.data.user_id) -Token $aToken
Check 'DELETE /api/admin/users/:id (cleanup)' ($delFac.ok)

$lastAdmin = Api -Method DELETE -Path ("/api/admin/users/" + $adminLogin.data.user.user_id) -Token $aToken
Check 'admin cannot delete own account' ($lastAdmin.status -eq 400 -and $lastAdmin.data.error -eq 'CANNOT_DELETE_SELF')

$nologin = Api -Path '/api/me/loans'
Check 'unauthenticated API call -> 401' ($nologin.status -eq 401)

$logout = Api -Method POST -Path '/api/auth/logout' -Token $fToken -Body @{}
Check 'POST /api/auth/logout' ($logout.ok)
$after = Api -Path '/api/auth/me' -Token $fToken
Check 'token rejected after logout -> 401' ($after.status -eq 401)

# ---------------------------------------------------------------------------
# summary
# ---------------------------------------------------------------------------
Write-Host ''
Write-Host ('=' * 74) -ForegroundColor Cyan
$total = $script:passed + $script:failed
if ($script:failed -gt 0) {
    Write-Host ("  RESULT: FAIL - {0}/{1} checks passed" -f $script:passed, $total) -ForegroundColor Red
    Write-Host '  (reset the live data with tools\setup-db.ps1 -Live -Reset)' -ForegroundColor Yellow
    exit 1
}
Write-Host ("  RESULT: PASS - {0}/{1} checks passed" -f $script:passed, $total) -ForegroundColor Green
Write-Host '  The live database now contains acceptance-test rows (a test student,' -ForegroundColor Yellow
Write-Host '  one model + item); run tools\setup-db.ps1 -Live -Reset for a pristine demo.' -ForegroundColor Yellow
exit 0
