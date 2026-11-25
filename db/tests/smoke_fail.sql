-- smoke test: paths that MUST fail (run without ON_ERROR_STOP, state = after smoke_ok)
\echo '== overlapping reservation must fail (exclusion constraint) =='
INSERT INTO reservation (request_id, item_id, reserved_period)
VALUES (1, 1, tstzrange(now()+interval '36 hours', now()+interval '3 days'));

\echo '== maintenance overlapping the held reservation must fail =='
INSERT INTO maintenance_block (item_id, authorized_by, blocked_range, reason)
VALUES (1, 1, tstzrange(now()+interval '30 hours', now()+interval '40 hours'), 'lens repair');

\echo '== a fresh item: first walk-in succeeds =='
INSERT INTO item (item_id, serial_no, item_condition, lifecycle_status, model_id, dept_id)
VALUES (2, 'PRJ-02', 'GOOD', 'AVAILABLE', 1, 1);
SELECT checkout_walkin('1RV22IS001', 2, 1) AS ok_loan_id;

\echo '== second walk-in on the same item must fail (ITEM_NOT_AVAILABLE) =='
SELECT checkout_walkin('1RV22IS002', 2, 1);

\echo '== three no-shows, then joining the queue must fail (STUDENT_TEMP_BARRED) =='
INSERT INTO lending_request (request_id, student_id, model_id, purpose, requested_start, requested_end) VALUES
 (91,'1RV22IS001',1,'dummy request one for the no-show bar test', now(), now()+interval '1 day'),
 (92,'1RV22IS001',1,'dummy request two for the no-show bar test', now(), now()+interval '1 day'),
 (93,'1RV22IS001',1,'dummy request three for no-show bar test', now(), now()+interval '1 day');
INSERT INTO queue_entry (item_id, ticket_no, request_id, queue_status, offer_expires_at, no_show_count) VALUES
 (1, 91, 91, 'OFFERED', now()-interval '1 hour', 0),
 (1, 92, 92, 'OFFERED', now()-interval '2 hours', 0),
 (1, 93, 93, 'OFFERED', now()-interval '3 hours', 0);
SELECT count(*) AS skipped_after_tick FROM queue_tick();
INSERT INTO lending_request (request_id, student_id, model_id, purpose, requested_start, requested_end)
VALUES (94,'1RV22IS001',1,'fourth request that should hit the ban rule', now(), now()+interval '1 day');
SELECT join_queue(1, 94);
