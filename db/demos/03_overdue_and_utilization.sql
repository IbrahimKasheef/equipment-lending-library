-- ============================================================================
--  DEMO 03 - OVERDUE ESCALATION, FINES AND UTILIZATION REPORTING
-- ============================================================================
--  Course project : Equipment Lending Library with Fair Hold Queues
--  Run after      : db/schema.sql + db/seed.sql (and ideally demos 01/02)
--  Command        : psql -U postgres -p 5433 -d <db> -f db/demos/03_overdue_and_utilization.sql
--
--  Part 1 - overdue handling
--    v_overdue shows every unreturned item past its due date together with
--    the fine projected so far.  escalate_overdue() is the nightly job that
--    flips ACTIVE loans to OVERDUE and stamps fine_amount; after the grace
--    period configured in app_config ('lost_after_days') the unit is even
--    declared LOST.
--
--  Part 2 - utilization reporting
--    v_item_utilization measures busy time (loans + maintenance) over each
--    item's 90-day window, v_dept_utilization rolls it up per department and
--    v_idle_items lists everything under 5% busy - the procurement signal.
--
--  Demo 02 returned the overdue VR headset, so the loans still open and past
--  due here are CAM-02 (loan 10, fine 750) and LAP-02 (loan 9, active but
--  1 hour past due - escalate_overdue() turns it OVERDUE and fines it).
-- ============================================================================

\set ON_ERROR_STOP off

\echo ''
\echo '===================================================================='
\echo ' DEMO 03 - OVERDUE ESCALATION, FINES AND UTILIZATION'
\echo '===================================================================='

-- ---------------------------------------------------------------------------
-- PART 1 - overdue loans and automatic fines
-- ---------------------------------------------------------------------------
\echo ''
\echo '-- [1a] v_overdue: unreturned loans past their due date'
SELECT loan_id,
       serial_no,
       model_name,
       student_id,
       full_name,
       days_overdue,
       projected_fine,
       fine_amount,
       loan_status
  FROM v_overdue
 ORDER BY days_overdue DESC, loan_id;

\echo ''
\echo '-- [1b] run the nightly escalation job'
SELECT escalate_overdue() AS loans_newly_escalated;

\echo '-- every unreturned loan past due, with its stamped fine:'
SELECT l.loan_id,
       i.serial_no,
       l.student_id,
       l.loan_status,
       l.due_date,
       ROUND(EXTRACT(epoch FROM (now() - l.due_date)) / 86400.0, 2) AS days_late,
       l.fine_amount
  FROM loan l
  JOIN item i ON i.item_id = l.item_id
 WHERE l.returned_at IS NULL
   AND l.loan_status IN ('OVERDUE', 'LOST')
 ORDER BY l.fine_amount DESC, l.loan_id;

-- ---------------------------------------------------------------------------
-- PART 2 - utilization reporting
-- ---------------------------------------------------------------------------
\echo ''
\echo '-- [2a] top 5 items by utilization (90-day window)'
SELECT item_id, serial_no, model_name, dept_name,
       window_hours, busy_hours, utilization_pct
  FROM v_item_utilization
 ORDER BY utilization_pct DESC NULLS LAST, item_id
 LIMIT 5;

\echo '-- [2b] per-department roll-up:'
SELECT dept_name,
       item_count,
       avg_utilization_pct,
       total_busy_hours,
       total_window_hours
  FROM v_dept_utilization;

\echo '-- [2c] idle items (under 5% busy) - candidates to redeploy:'
SELECT item_id, serial_no, model_name, dept_name,
       utilization_pct, busy_hours, window_hours
  FROM v_idle_items
 ORDER BY utilization_pct, serial_no;

\echo ''
\echo 'DEMO 03 complete: overdue escalation and the three reporting views.'
