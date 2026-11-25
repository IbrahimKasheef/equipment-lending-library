# Equipment Lending Library - demo pack

Narrated demonstrations of the database-level features of the project
*Equipment Lending Library with Fair Hold Queues and Concurrency Management*.

| File | What it demonstrates |
|------|----------------------|
| `01_exclusion_constraint.sql` | GiST `EXCLUDE` constraint `reservation_no_overlap`: an overlapping `HELD` reservation for the VR headset (item 16) is rejected with SQLSTATE `23P01`; a maintenance block overlapping the hold is rejected by the trigger (`CONFLICT_WITH_RESERVATION`); a **non**-overlapping booking for the same unit is accepted. |
| `02_fifo_queue.sql` | Fair FIFO hold queue: the expired offer (ticket 1) is skipped with `no_show_count = 1`, the offer rolls on to ticket 2, and a fresh request from `1RV23CS021` joins the back of the queue (`outcome QUEUED`, next ticket). The seeded headset is first returned from its overdue loan so the offer engine has a free unit to work with. |
| `03_overdue_and_utilization.sql` | `v_overdue` + `escalate_overdue()`: ACTIVE loans past due become `OVERDUE` with a stamped fine. Then the reporting views: top-5 `v_item_utilization`, `v_dept_utilization` roll-up and `v_idle_items`. |
| `04_serializable_checkout.js` | Real concurrency with two separate pg connections at `BEGIN ISOLATION LEVEL SERIALIZABLE`: (A) two students race for one laptop unit via `checkout_walkin()` - exactly one loan, the loser fails `ITEM_NOT_AVAILABLE`; (B) two staff scan the same reservation via `checkout()` - exactly one loan, the loser fails `RESERVATION_NOT_HELD`. Serialization failures (`40001`) are retried like the API does. |
| `run_demos.ps1` | One-shot runner for all of the above. |

The SQL demos are re-runnable: every row they create is tagged and removed
again (demo 02 also guards the loan return). The Node demo cleans up its
temporary item/loan/reservation/request at the end. `audit_log` rows are
intentionally left behind.

## Prerequisites

* PostgreSQL 16 on port 5433 (`psql.exe` under
  `%LOCALAPPDATA%\pg16\pgsql\bin`), user `postgres`, trust auth.
* Node.js 22 + npm.
* A database loaded with `db/schema.sql` + `db/seed.sql`.

## Run everything

```powershell
powershell -ExecutionPolicy Bypass -File db\demos\run_demos.ps1 -Db ll_demos
```

The runner passes `-PgBin`, `-Db`, `-Port`, `-User` through; it installs the
`pg` module automatically on first use.

## Run one demo

```powershell
& "$env:LOCALAPPDATA\pg16\pgsql\bin\psql.exe" -U postgres -p 5433 -d ll_demos -f db\demos\01_exclusion_constraint.sql
```

```powershell
cd db\demos
npm install            # once
$env:PGDATABASE = 'll_demos'; $env:PGPORT = '5433'
npm start              # = node 04_serializable_checkout.js
```

## Reset to a pristine state

```powershell
& "$env:LOCALAPPDATA\pg16\pgsql\bin\psql.exe" -U postgres -p 5433 -d ll_demos -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"
& "$env:LOCALAPPDATA\pg16\pgsql\bin\psql.exe" -U postgres -p 5433 -d ll_demos -f db\schema.sql
& "$env:LOCALAPPDATA\pg16\pgsql\bin\psql.exe" -U postgres -p 5433 -d ll_demos -f db\seed.sql
```

## Expected output (highlights)

* **01** - two `ERROR` lines (`conflicting key value violates exclusion
  constraint "reservation_no_overlap"` and `CONFLICT_WITH_RESERVATION`), then a
  successful non-overlapping insert that is deleted again.
* **02** - BEFORE board (ticket 1 `OFFERED` expired, tickets 2/3 `WAITING`),
  the loan return with its freshly computed fine (`compute_fine` rounds any
  part-day up, so a headset 9 days overdue right after seeding shows
  `10 x 200.00 = 2000.00`), `queue_tick()` output offering
  ticket 2, AFTER board with ticket 1 `SKIPPED` / `no_show_count 1`, and an
  `approve_request` answer of `{"outcome": "QUEUED", "ticket_no": ...}`.
* **03** - overdue list, escalation count, freshly stamped fines, the top-5
  utilization table, the department roll-up and the idle list.
* **04** - two race sections, each with one `COMMIT -> loan_id` and one
  `ROLLBACK -> SQLSTATE ...` (with the retry trace when a `40001` occurs),
  followed by `RESULT: ALL EXPECTATIONS MET`.

## Notes for the viva

* Demo 01 deliberately creates one legal far-future `HELD` reservation on the
  seeded VR headset (item 16) in its setup step: the seed queues the VR
  requests but holds none, so without it there would be nothing to attack.
* Demo 02 receives the seeded overdue headset first because `queue_tick()`
  only offers units whose `availability_cache` says `AVAILABLE`.
* The fine in demo 02 (`10 days x 200.00` right after seeding, because
  `compute_fine()` rounds any partial day up) and the escalation in demo 03
  are computed by `compute_fine()` / `escalate_overdue()`, not by the scripts.
