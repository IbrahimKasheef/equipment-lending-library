# Equipment Lending Library with Fair Hold Queues and Concurrency Management

An Equipment Lending Library for RVCE (most engineering departments, 28 labs) with a database-enforced core:

* `EXCLUDE USING gist` range constraints make double-booking **impossible**;
* `SERIALIZABLE` transactions make it impossible for two simultaneous checkouts of the
  last unit to both win;
* triggers maintain an availability cache and emit `pg_notify` events;
* the FIFO hold queue, no-show skip rules and booking functions are pure SQL.

## Project layout

| Folder | What it is | Port |
| --- | --- | --- |
| `live/` | **The live website** - email + password login (students, faculty, administrator), college-wide student self-registration, 10 departments and 28 labs, item management, department-scoped issuing, return requests, global search, a SQL console and account administration | **3000** |
| `db/` | PostgreSQL: core schema + seed + tests + database demos, and `db/live/` (live schema + seed) | - |
| `tools/` | start/stop PostgreSQL, database setup, acceptance tests | - |
| `scripts/` | generators for the ER diagram and Word deliverables | - |

---

## Quick start - LIVE website

```powershell
tools\pg-start.ps1                 # PostgreSQL 16 on port 5433
tools\setup-db.ps1 -Live -Reset    # build + seed the live database (lending_library_live)
cd live\backend
npm install                        # first time only
npm start                          # http://localhost:3000
```

Open **http://localhost:3000** → sign in or register.

Or use the one-command helpers: `tools\live-start.ps1` (starts PostgreSQL + the site)
and `tools\live-stop.ps1` (stops the site).

### Seeded accounts

**Department scoping:** students of any branch may request equipment from any department,
but a faculty member can only approve, issue, return, maintain and manage equipment that
belongs to their own department. The administrator is not tied to a department. All the
seeded faculty accounts belong to ISE; create a faculty account for another department
from **Admin → Accounts & roles** to see the restriction in action.

### College-wide departments and labs

The live system covers ten engineering departments - **CSE, ISE, ECE, EEE, Mechanical,
Civil, Chemical, Biotechnology, Aerospace, AI and ML** - with 28 laboratories whose names
and equipment follow the RVCE laboratory pages (`rvce.edu.in/department/<dept>/laboratories/`).
Examples: the CSE high-performance workstations and the NVIDIA A100 server, ECE signal
generators/oscilloscopes/spectrum analysers/FPGA boards, ISE Raspberry Pi and IoT kits,
EEE machines and high-voltage equipment, Mechanical lathes/metrology, Civil total
stations, Chemical process trainers, Biotechnology microscopes/PCR, Aerospace wind tunnel
and AI/ML robotics.

Every item belongs to a lab and every model belongs to a department. Faculty only see and
manage the labs of their own department; the administrator can manage every department.

### SQL console - faculty read-only, administrator unrestricted

Open **SQL Console** in the top navigation. The left panel lists every table and view
with its columns (click *Query this table* to load a starter query); the editor runs
**one statement at a time** (Ctrl+Enter) and the results render as a table underneath,
with command, row count and timing.

* **Faculty** run in a `READ ONLY` transaction with an 8-second timeout and a
  `SELECT / WITH / TABLE / VALUES` allow-list - the data cannot be modified.
* **Administrator** runs any single statement (SELECT, INSERT, UPDATE, DELETE, DDL)
  with full permissions; the statement is committed.

### Administrator

`admin@rvce.edu.in` is a superset of every role: it sees all faculty pages, the
unrestricted SQL console, and an **Admin → Accounts & roles** page where it can:

* list every student/faculty/admin account and search them;
* create faculty accounts (name, college email, department, staff role, initial password);
* reset any user's password (revoking their existing sessions);
* delete accounts (self-deletion and deleting the last administrator are blocked).

### Adding a faculty member (manual SQL - faculty are pre-approved on joining)

Students self-register; faculty accounts are created by the department. Run these two
statements as `postgres` (also printed at the bottom of `db/live/live_seed.sql`), or
use **Admin → Accounts & roles → Add faculty account** in the live site:

```sql
INSERT INTO staff (staff_name, role, email, dept_id)
VALUES ('Dr. Ananya Rao', 'LAB_ADMIN', 'ananyarao@rvce.edu.in', 2);   -- 2 = ISE

INSERT INTO app_user (email, password_hash, role, staff_id)
VALUES ('ananyarao@rvce.edu.in',
        crypt('Welcome@123', gen_salt('bf', 10)),    -- same bcrypt hashing as the app
        'FACULTY',
        (SELECT staff_id FROM staff WHERE email = 'ananyarao@rvce.edu.in'));
```

The new account can log in immediately and change its password from Settings.

### Return workflow

1. A student sees a current holding and clicks **Request return** (optional note).
2. The holding is flagged *return requested* everywhere (student + faculty views).
3. Faculty click **Returned** on that row - the loan closes, overdue days and the fine
   are computed by `return_item()` in SQL. Faculty can also return any active loan
   directly (walk-in return at the counter).

---

## Database design - the lab tasks, mapped

| Lab task | Where it lives |
| --- | --- |
| Overlapping bookings impossible (range exclusion constraints) | `db/schema.sql` - `reservation_no_overlap`, `loan_no_overlap`, `maintenance_no_overlap` |
| Cross-table conflicts (reservation vs maintenance vs loans) | `check_item_conflicts()` trigger - locks the item row, then validates |
| Serializable checkout (two simultaneous requests cannot both win) | `checkout()` / `checkout_walkin()` + retry on SQLSTATE `40001` |
| Fair FIFO hold queue with skip rules | `join_queue()`, `queue_tick()` - per-item tickets, offer expiry, no-show skip, temporary bar after 3 no-shows (`app_config`) |
| Triggers maintaining an availability cache | `refresh_availability_cache()` + triggers; emits `pg_notify('availability', …)` (the live site streams it over SSE) |
| Overdue escalation | `escalate_overdue()` - `ACTIVE → OVERDUE → LOST`, fines via `compute_fine()`; `v_overdue` |
| Utilization reporting per item / department | `v_item_utilization`, `v_dept_utilization`, `v_idle_items` |
| Lending requests with purpose + requester details | `lending_request` (name/USN/semester/department via `student`, model requested, purpose, window, remarks) |
| Accounts, roles, sessions (live) | `db/live/live_schema.sql` - `app_user` (bcrypt via pgcrypto), `app_session`, `lab`, `request_return()`, `retire_item()`, `v_lab_items`, `v_student_loans` |
| Append-only audit trail | `audit_row()` triggers → `audit_log` (mirrored to MongoDB in the production design of the Synopsis) |

## Running the demos & tests

```powershell
tools\setup-db.ps1 -Reset                       # pristine demo data
powershell -ExecutionPolicy Bypass -File db\demos\run_demos.ps1
```

1. **`01_exclusion_constraint.sql`** - the database refuses double-booking (`23P01`).
2. **`02_fifo_queue.sql`** - expired offer → no-show skip → next student offered the item.
3. **`03_overdue_and_utilization.sql`** - escalation, fines, utilization, idle list.
4. **`04_serializable_checkout.js`** - two real PostgreSQL sessions race; exactly one wins.

```powershell
powershell -ExecutionPolicy Bypass -File db\tests\run_tests.ps1       # 10 integrity checks
powershell -ExecutionPolicy Bypass -File tools\api-acceptance-live-test.ps1   # live API, 65 checks (auth, holdings, returns, equipment, console, admin)
```

## API in one glance

**Live** (Bearer token auth): `POST /api/auth/register|login`, `GET /api/auth/me`,
`POST /api/auth/password|logout`, `GET /api/labs`, `GET /api/catalog`,
`GET /api/me/loans`, `POST /api/me/loans/:id/request-return|cancel-return`,
`GET/POST /api/me/requests`, `GET /api/requests`, `POST /api/requests/:id/approve|reject`,
`GET /api/reservations`, `POST /api/reservations/:id/checkout`, `POST /api/checkout/walkin`,
`GET /api/loans`, `POST /api/loans/:id/return`, `GET /api/students`, `GET /api/students/:id/summary`,
`GET /api/queue`, `POST /api/queue/tick`, `GET/POST /api/maintenance`,
`POST /api/models`, `POST /api/items`, `POST /api/items/:id/retire|restore`,
`GET /api/labs/:id/items`, `GET /api/reports/*`, `POST /api/admin/escalate`,
`GET /api/console/schema`, `POST /api/console/query`, `GET /api/admin/users`,
`POST /api/admin/faculty`, `POST /api/admin/users/:id/reset-password`,
`DELETE /api/admin/users/:id`, `GET /api/events` (SSE live availability).


* **Configuration** comes from environment variables - copy
  `live/backend/.env.example` to `live/backend/.env` and adjust. `.env` is git-ignored;
  no credentials or connection strings are committed.
* **Seeded passwords** (`Student@123`, `Faculty@123`, `Admin@123`) exist only so the
  project can be evaluated immediately. Change them or remove the seeded accounts before
  exposing an instance publicly.
* **Security model**: bcrypt password hashes (pgcrypto), hashed session tokens,
  expiring sessions, per-IP rate limiting on login/registration, strict security
  headers/CSP, server-side role checks, and a read-only faculty SQL console.
* The frontend has no CDN or network dependencies; everything is served locally.

## Notes

* Ranges are `tstzrange` (timezone-aware); `btree_gist` supplies the GiST support.
* Passwords are bcrypt hashes (`crypt`/`gen_salt('bf')` from pgcrypto) - never stored
  in plain text; sessions are database rows with an expiry, sent as Bearer tokens.
* The production design (Synopsis §5) mirrors the availability stream to Redis and the
  audit trail to MongoDB; the working system keeps the same contracts using
  `pg_notify` and `audit_log` so it runs on a single PostgreSQL instance.
