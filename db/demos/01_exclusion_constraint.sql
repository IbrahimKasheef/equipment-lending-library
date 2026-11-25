-- ============================================================================
--  DEMO 01 - EXCLUSION CONSTRAINTS: PostgreSQL refuses double-booking
-- ============================================================================
--  Course project : Equipment Lending Library with Fair Hold Queues
--  Run after      : db/schema.sql + db/seed.sql
--  Command        : psql -U postgres -p 5433 -d <db> -f db/demos/01_exclusion_constraint.sql
--
--  What this demo proves:
--    * the GiST EXCLUDE constraint reservation_no_overlap makes two
--      overlapping HELD reservations for one item impossible - the check
--      lives in the database, not in application code;
--    * a BEFORE trigger refuses a maintenance block that overlaps a HELD
--      reservation (CONFLICT_WITH_RESERVATION);
--    * the contrast: a NON-overlapping hold for the very same unit is
--      still accepted.
--
--  The seeded VR headset ISE-VR-01 (item 16) is used throughout.  It is the
--  busiest unit in the seed (overdue loan + three queue tickets).  The seed
--  only queues its VR requests, so the setup step creates one legal HELD
--  reservation on item 16 and the two "must fail" steps then attack it.
--
--  Expected ERROR lines are intentional - this script runs WITHOUT
--  ON_ERROR_STOP, so psql prints the refusal and carries on.
--  Every row created here is tagged 'DEMO-01' and removed again at the end,
--  which keeps the demo re-runnable.
-- ============================================================================

\set ON_ERROR_STOP off
\set VERBOSITY verbose
-- (verbose verbosity makes psql annotate errors with their SQLSTATE)

\echo ''
\echo '===================================================================='
\echo ' DEMO 01 - EXCLUSION CONSTRAINTS: the database says no to double-booking'
\echo '===================================================================='

-- ---------------------------------------------------------------------------
-- Step 0 - idempotence: clear leftovers of an interrupted earlier run
-- ---------------------------------------------------------------------------
\echo ''
\echo '-- [0] remove any leftover DEMO-01 rows so the script can run again'
DELETE FROM reservation
 WHERE request_id IN (SELECT request_id FROM lending_request
                       WHERE purpose LIKE 'DEMO-01%');
DELETE FROM lending_request WHERE purpose LIKE 'DEMO-01%';

-- ---------------------------------------------------------------------------
-- Step 1 - context + setup: give the VR headset one HELD reservation
--          The window starts 20 days from now, comfortably after the unit is
--          due back, so the hold itself is perfectly legal.
-- ---------------------------------------------------------------------------
\echo ''
\echo '-- [1a] item 16 today: overdue loan + FIFO queue (from v_calendar)'
SELECT kind, ref_id, status, start_ts, end_ts
  FROM v_calendar
 WHERE item_id = 16
 ORDER BY start_ts;

\echo '-- [1b] setup: two fresh VR requests (model 7 - item 16 is the only unit)'
INSERT INTO lending_request (student_id, model_id, purpose, requested_start, requested_end)
VALUES ('1RV24IS057',
        7,
        'DEMO-01 holder: far-future VR headset hold for the demo window',
        now() + interval '20 days',
        now() + interval '22 days');

INSERT INTO lending_request (student_id, model_id, purpose, requested_start, requested_end)
VALUES ('1RV22IS012',
        7,
        'DEMO-01 challenger: VR request overlapping the existing hold',
        now() + interval '21 days',
        now() + interval '23 days');

SELECT request_id AS holder_request
  FROM lending_request
 WHERE purpose LIKE 'DEMO-01 holder%'
 ORDER BY request_id DESC
 LIMIT 1
\gset

SELECT request_id AS challenger_request
  FROM lending_request
 WHERE purpose LIKE 'DEMO-01 challenger%'
 ORDER BY request_id DESC
 LIMIT 1
\gset

\echo '-- approve the holder request against item 16 (expect outcome RESERVED)'
SELECT approve_request(:holder_request, 1, 16) AS approve_outcome;

\echo '-- the HELD reservation that now protects the VR headset:'
SELECT r.reservation_id,
       r.item_id,
       i.serial_no,
       r.status,
       lower(r.reserved_period) AS hold_from,
       upper(r.reserved_period) AS hold_until
  FROM reservation r
  JOIN item i ON i.item_id = r.item_id
 WHERE r.item_id = 16
   AND r.status = 'HELD'
 ORDER BY r.reservation_id;

-- ---------------------------------------------------------------------------
-- Step 2 - PART 1: overlapping HELD reservation -> EXCLUDE USING gist fires
-- ---------------------------------------------------------------------------
\echo ''
\echo '-- [2] PART 1: insert a HELD reservation that overlaps the hold'
\echo '--     [20d,22d) and [21d,23d) overlap -> must fail with SQLSTATE 23P01'
INSERT INTO reservation (request_id, item_id, reserved_period, status)
VALUES (:challenger_request,
        16,
        tstzrange(now() + interval '21 days', now() + interval '23 days'),
        'HELD');

\echo '-- ^ no row was inserted: constraint reservation_no_overlap'
\echo '--   (EXCLUDE USING gist on item_id = and reserved_period &&) rejected it.'
\echo '--   The check ran inside PostgreSQL; no application code was involved.'

-- ---------------------------------------------------------------------------
-- Step 3 - PART 2: maintenance block overlapping the HELD reservation
-- ---------------------------------------------------------------------------
\echo ''
\echo '-- [3] PART 2: maintenance block overlapping the same hold'
\echo '--     the BEFORE trigger raises CONFLICT_WITH_RESERVATION'
INSERT INTO maintenance_block (item_id, authorized_by, blocked_range, reason)
VALUES (16,
        4,
        tstzrange(now() + interval '20 days 6 hours',
                  now() + interval '20 days 18 hours'),
        'DEMO-01: attempt to calibrate the VR headset while it is held');

\echo '-- ^ the maintenance window [20d06h,20d18h) sits inside the hold'
\echo '--   [20d,22d), so the trigger refused the block. Maintenance can only'
\echo '--   be booked into gaps that are actually free.'

-- ---------------------------------------------------------------------------
-- Step 4 - PART 3: the contrast - a non-overlapping hold is accepted
-- ---------------------------------------------------------------------------
\echo ''
\echo '-- [4] PART 3: a NON-overlapping reservation for the same item succeeds'
INSERT INTO reservation (request_id, item_id, reserved_period, status)
VALUES (:challenger_request,
        16,
        tstzrange(now() + interval '30 days', now() + interval '32 days'),
        'HELD')
RETURNING reservation_id AS accepted_reservation_id
\gset

\echo '-- both holds coexist because their ranges are disjoint:'
SELECT r.reservation_id,
       r.request_id,
       r.status,
       lower(r.reserved_period) AS hold_from,
       upper(r.reserved_period) AS hold_until
  FROM reservation r
 WHERE r.item_id = 16
   AND r.status = 'HELD'
 ORDER BY lower(r.reserved_period);

\echo '-- remove the Part-3 reservation again (keep the demo re-runnable)'
DELETE FROM reservation
 WHERE reservation_id = :accepted_reservation_id;

-- ---------------------------------------------------------------------------
-- Step 5 - teardown
-- ---------------------------------------------------------------------------
\echo ''
\echo '-- [5] teardown: remove all DEMO-01 rows (audit_log rows are kept)'
DELETE FROM reservation
 WHERE request_id IN (SELECT request_id FROM lending_request
                       WHERE purpose LIKE 'DEMO-01%');
DELETE FROM lending_request WHERE purpose LIKE 'DEMO-01%';

\echo ''
\echo 'DEMO 01 complete: two illegal writes were rejected by the database itself.'
