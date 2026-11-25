-- smoke test: happy paths (ON_ERROR_STOP=1)
\echo '== setup =='
INSERT INTO department (dept_id, dept_name, building, hod_name, contact_email) VALUES (1,'ISE','ISE Block','Dr. A','ise@rvce.edu.in');
INSERT INTO student (student_id, full_name, semester, email, dept_id) VALUES ('1RV22IS001','Test Student',5,'t1@rvce.edu.in',1);
INSERT INTO student (student_id, full_name, semester, email, dept_id) VALUES ('1RV22IS002','Other Student',5,'t2@rvce.edu.in',1);
INSERT INTO staff (staff_id, staff_name, role, email, dept_id) VALUES (1,'Lab Admin','LAB_ADMIN','lab@rvce.edu.in',1);
INSERT INTO category (category_id, category_name, max_loan_days, late_fee_per_day) VALUES (1,'Projector',3,50);
INSERT INTO equipment (model_id, model_name, manufacturer, category_id) VALUES (1,'Epson EB-X05','Epson',1);
INSERT INTO item (item_id, serial_no, item_condition, lifecycle_status, model_id, dept_id) VALUES (1,'PRJ-01','GOOD','AVAILABLE',1,1);
\echo '== cache after item insert =='
SELECT item_id, cached_status, next_free_ts IS NOT NULL AS has_next_free FROM availability_cache;
\echo '== request 1: auto-reserve =='
INSERT INTO lending_request (request_id, student_id, model_id, purpose, requested_start, requested_end) VALUES (1,'1RV22IS001',1,'need projector for software engineering demo', now()+interval '1 day', now()+interval '2 days');
SELECT approve_request(1,1);
\echo '== request 2: should queue (window overlaps reservation) =='
INSERT INTO lending_request (request_id, student_id, model_id, purpose, requested_start, requested_end) VALUES (2,'1RV22IS002',1,'also need the projector same day for seminar', now()+interval '1 day', now()+interval '2 days');
SELECT approve_request(2,1);
\echo '== walk-in checkout by student 2 =='
SELECT checkout_walkin('1RV22IS002', 1, 1) AS loan_id;
\echo '== cache after checkout =='
SELECT item_id, cached_status FROM availability_cache;
\echo '== ageing the loan, then overdue escalation =='
UPDATE loan SET checkout_at = now() - interval '5 days', due_date = now() - interval '2 days' WHERE loan_id = 1;
SELECT escalate_overdue() AS escalated;
SELECT loan_id, loan_status, fine_amount FROM loan;
\echo '== return with fine =='
SELECT (return_item(1, 'GOOD', 1)).loan_id, (SELECT fine_amount FROM loan WHERE loan_id=1) AS fine;
\echo '== queue tick: item free again -> first waiting entry gets an offer =='
SELECT item_id, ticket_no, request_id, full_name, offer_expires_at FROM queue_tick();
\echo '== utilization =='
SELECT item_id, busy_hours, utilization_pct FROM v_item_utilization;
