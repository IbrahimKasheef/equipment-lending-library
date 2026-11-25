-- ============================================================================
--  DEMO 02 - FAIR FIFO HOLD QUEUE: no-show skip and offer rotation
-- ============================================================================
--  Course project : Equipment Lending Library with Fair Hold Queues
--  Run after      : db/schema.sql + db/seed.sql (and ideally demo 01)
--  Command        : psql -U postgres -p 5433 -d <db> -f db/demos/02_fifo_queue.sql
--
--  The seeded queue on the VR headset ISE-VR-01 (item 16):
--    ticket 1 - request 5 - OFFERED, but the offer window already expired
--    ticket 2 - request 6 - WAITING
--    ticket 3 - request 7 - WAITING
--
--  queue_tick() is the offer engine:
--    1) every OFFERED entry whose hold window elapsed becomes SKIPPED and its
--       no_show_count goes up by one (this is what stops one student from
--       blocking the queue forever);
--    2) the first WAITING ticket of each currently free item with no open
--       offer receives the next OFFERED window (pure FIFO by ticket_no).
--
--  The offer engine only fires for items whose cache says AVAILABLE.  The
--  seeded headset is still out on overdue loan 11, so this demo first takes
--  it back at the counter (return_item - the real lab workflow), which also
--  shows the automatic fine for a late return.
--
--  Finally a competing hold is approved for the same VR window and a fresh
--  request from student '1RV23CS021' is approved behind it: with the unit
--  taken, the newcomer receives outcome QUEUED and the next FIFO ticket.
--
--  All DEMO-02 rows use DEFAULT ids and are removed at the end; the loan
--  return is guarded, so the whole script is re-runnable.
-- ============================================================================

\set ON_ERROR_STOP off
\set VERBOSITY verbose

\echo ''
\echo '===================================================================='
\echo ' DEMO 02 - FIFO HOLD QUEUE: expired offers are skipped, not waited on'
\echo '===================================================================='

-- ---------------------------------------------------------------------------
-- Step 0 - idempotence: clear leftovers of an interrupted earlier run
-- ---------------------------------------------------------------------------
\echo ''
\echo '-- [0] remove any leftover DEMO-02 rows so the script can run again'
DELETE FROM queue_entry
 WHERE request_id IN (SELECT request_id FROM lending_request WHERE purpose LIKE 'DEMO-02%');
DELETE FROM reservation
 WHERE request_id IN (SELECT request_id FROM lending_request WHERE purpose LIKE 'DEMO-02%');
DELETE FROM lending_request WHERE purpose LIKE 'DEMO-02%';

-- ---------------------------------------------------------------------------
-- Step 1 - BEFORE: the queue board for item 16
-- ---------------------------------------------------------------------------
\echo ''
\echo '-- [1] BEFORE: queue board for ISE-VR-01 (item 16)'
SELECT ticket_no, request_id, student_id, full_name, queue_status,
       offer_expires_at, no_show_count
  FROM v_queue_board
 WHERE item_id = 16
 ORDER BY ticket_no;

\echo '-- ticket 1 holds an offer whose window has already elapsed:'
SELECT ticket_no, queue_status,
       (offer_expires_at < now()) AS offer_expired
  FROM v_queue_board
 WHERE item_id = 16
   AND queue_status = 'OFFERED';

\echo '-- the headset is still out on loan 11, so the offer engine has nothing'
\echo '-- to offer yet (the cached status is ON_LOAN):'
SELECT item_id, cached_status, next_free_ts
  FROM availability_cache
 WHERE item_id = 16;

-- ---------------------------------------------------------------------------
-- Step 2 - the overdue unit comes back to the counter
-- ---------------------------------------------------------------------------
\echo ''
\echo '-- [2] return the overdue VR headset (loan 11); the guard keeps re-runs safe'
WITH returned AS (
    SELECT (return_item(11, 'GOOD', 1)) AS loan_row
     WHERE EXISTS (SELECT 1 FROM loan WHERE loan_id = 11 AND returned_at IS NULL)
)
SELECT (loan_row).loan_id     AS returned_loan_id,
       (loan_row).loan_status AS new_loan_status,
       (loan_row).fine_amount AS fine_charged,
       (loan_row).returned_at AS returned_at
  FROM returned;

\echo '-- the trigger-maintained cache now reports the unit as free again:'
SELECT item_id, cached_status, next_free_ts
  FROM availability_cache
 WHERE item_id = 16;

-- ---------------------------------------------------------------------------
-- Step 3 - run the offer engine
-- ---------------------------------------------------------------------------
\echo ''
\echo '-- [3] run queue_tick(); it returns only the NEW offers it just made'
SELECT item_id, ticket_no, request_id, full_name, offer_expires_at AS new_offer_expires_at
  FROM queue_tick()
 ORDER BY ticket_no;

\echo '-- AFTER: ticket 1 is SKIPPED (no_show_count = 1) and the offer has moved'
\echo '-- on, in FIFO order, to ticket 2 (request 6):'
SELECT ticket_no, request_id, student_id, full_name, queue_status,
       offer_expires_at, no_show_count
  FROM v_queue_board
 WHERE item_id = 16
 ORDER BY ticket_no;

\echo '-- the no-show recorded against ticket 1:'
SELECT ticket_no, queue_status, no_show_count
  FROM v_queue_board
 WHERE item_id = 16
   AND ticket_no = 1;

-- ---------------------------------------------------------------------------
-- Step 4 - joining the queue: a fresh request for student 1RV23CS021
-- ---------------------------------------------------------------------------
\echo ''
\echo '-- [4] joining the FIFO queue: student 1RV23CS021 also wants the headset'
\echo '--     first another student takes the hold for the same window...'

INSERT INTO lending_request (student_id, model_id, purpose, requested_start, requested_end)
VALUES ('1RV24IS057',
        7,
        'DEMO-02 holder: VR booking for the window the newcomer also wants',
        now(),
        now() + interval '2 days');

SELECT request_id AS holder_request
  FROM lending_request
 WHERE purpose LIKE 'DEMO-02 holder%'
 ORDER BY request_id DESC
 LIMIT 1
\gset

\echo '-- approve the competing hold on item 16 (expect RESERVED):'
SELECT approve_request(:holder_request, 1, 16) AS competing_hold;

\echo '-- ... then the newcomer request is approved and must join the queue'
INSERT INTO lending_request (student_id, model_id, purpose, requested_start, requested_end)
VALUES ('1RV23CS021',
        7,
        'DEMO-02 queue joiner: second VR request for the same window',
        now(),
        now() + interval '2 days');

SELECT request_id AS joiner_request
  FROM lending_request
 WHERE purpose LIKE 'DEMO-02 queue joiner%'
 ORDER BY request_id DESC
 LIMIT 1
\gset

\echo '-- approve the newcomer against item 16 (expect outcome QUEUED, new ticket):'
SELECT approve_request(:joiner_request, 1, 16) AS joiner_outcome;

\echo '-- final board for item 16: the newcomer is last in line (WAITING):'
SELECT ticket_no, request_id, student_id, full_name, queue_status,
       offer_expires_at, no_show_count
  FROM v_queue_board
 WHERE item_id = 16
 ORDER BY ticket_no;

-- ---------------------------------------------------------------------------
-- Step 5 - teardown
-- ---------------------------------------------------------------------------
\echo ''
\echo '-- [5] teardown: remove all DEMO-02 rows (audit_log rows are kept)'
DELETE FROM queue_entry
 WHERE request_id IN (SELECT request_id FROM lending_request WHERE purpose LIKE 'DEMO-02%');
DELETE FROM reservation
 WHERE request_id IN (SELECT request_id FROM lending_request WHERE purpose LIKE 'DEMO-02%');
DELETE FROM lending_request WHERE purpose LIKE 'DEMO-02%';

\echo ''
\echo 'DEMO 02 complete: the expired offer was skipped (no-show), the next'
\echo 'waiting student was offered the headset, and the newcomer queued'
\echo 'behind them - all of it enforced by the database functions.'
