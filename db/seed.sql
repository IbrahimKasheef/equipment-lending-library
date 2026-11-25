-- ============================================================================
--  EQUIPMENT LENDING LIBRARY - demo seed data
--  Run after schema.sql:  psql -U postgres -d lending_library -f db/seed.sql
--  All timestamps are relative to now(), so demos always look "fresh".
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- departments / students / staff
-- ---------------------------------------------------------------------------
INSERT INTO department (dept_id, dept_name, building, hod_name, contact_email) VALUES
 (1, 'Information Science and Engineering', 'ISE Block',  'Dr. Rashmi R',       'ise.office@rvce.edu.in'),
 (2, 'Computer Science and Engineering',    'CS Block',   'Dr. Srinivasa K G',  'cse.office@rvce.edu.in'),
 (3, 'Electronics and Communication',       'ECE Block',  'Dr. Nagamani K',     'ece.office@rvce.edu.in');

INSERT INTO student (student_id, full_name, semester, email, dept_id) VALUES
 ('1RV22IS001', 'Aditi Sharma',            5, 'aditisharma.is22@rvce.edu.in',      1),
 ('1RV22IS012', 'Rahul Verma',             5, 'rahulverma.is22@rvce.edu.in',       1),
 ('1RV22IS034', 'Sneha Rao',               5, 'sneharao.is22@rvce.edu.in',         1),
 ('1RV23IS008', 'Vikram Singh',            3, 'vikramsingh.is23@rvce.edu.in',      1),
 ('1RV23CS021', 'Priya Nair',              3, 'priyanair.cs23@rvce.edu.in',        2),
 ('1RV22EC009', 'Arjun Menon',             5, 'arjunmenon.ec22@rvce.edu.in',       3),
 ('1RV24IS057', 'Karthik Anup Revankar',   3, 'karthikanupr.is24@rvce.edu.in',     1),
 ('1RV24IS049', 'Ibrahim Kasheef',         3, 'ibrahimkasheef.is24@rvce.edu.in',   1);

INSERT INTO student_phone (student_id, phone_no) VALUES
 ('1RV22IS001', '+91 98450 11001'),
 ('1RV22IS001', '+91 80 6717 8001'),
 ('1RV22IS012', '+91 98450 11012'),
 ('1RV22IS034', '+91 98450 11034'),
 ('1RV24IS057', '+91 98450 11057'),
 ('1RV24IS049', '+91 98450 11049');

INSERT INTO staff (staff_id, staff_name, role, email, dept_id) VALUES
 (1, 'Meena Kumari',  'LAB_ADMIN',  'meena.kumari@rvce.edu.in',  1),
 (2, 'Ravi Shankar',  'TECHNICIAN', 'ravi.shankar@rvce.edu.in',  1),
 (3, 'Dr. Rashmi R',  'DEPT_ADMIN', 'rashmi.r@rvce.edu.in',      1),
 (4, 'Suresh Babu',   'TECHNICIAN', 'suresh.babu@rvce.edu.in',   3);

-- ---------------------------------------------------------------------------
-- categories / equipment models / serialized items
-- ---------------------------------------------------------------------------
INSERT INTO category (category_id, category_name, max_loan_days, late_fee_per_day) VALUES
 (1, 'Projector',        3, 50.00),
 (2, 'DSLR Camera',      2, 150.00),
 (3, 'Oscilloscope',     5, 40.00),
 (4, 'Development Kit',  7, 10.00),
 (5, 'Laptop',           3, 100.00),
 (6, 'VR Headset',       2, 200.00);

INSERT INTO equipment (model_id, model_name, manufacturer, description, category_id) VALUES
 (1, 'Epson EB-X05',        'Epson',  'XGA 3300-lumen portable projector',        1),
 (2, 'BenQ MW560',          'BenQ',   'WXGA 4000-lumen wireless projector',       1),
 (3, 'Canon EOS 200D',      'Canon',  '24MP DSLR with 18-55mm kit lens',          2),
 (4, 'Rigol DS1054Z',       'Rigol',  '4-channel 50 MHz digital oscilloscope',    3),
 (5, 'Arduino UNO Starter', 'Arduino','UNO R3 board with sensor and motor kit',   4),
 (6, 'Dell Latitude 5420',  'Dell',   'i5 / 16 GB / 512 GB development laptop',   5),
 (7, 'Meta Quest 2',        'Meta',   '128 GB standalone VR headset',             6);

INSERT INTO item (item_id, serial_no, purchase_date, item_condition, lifecycle_status, model_id, dept_id) VALUES
 (1,  'ISE-PRJ-01', current_date - 900, 'GOOD', 'AVAILABLE', 1, 1),
 (2,  'ISE-PRJ-02', current_date - 900, 'GOOD', 'AVAILABLE', 1, 1),
 (3,  'ISE-PRJ-03', current_date - 800, 'FAIR', 'AVAILABLE', 1, 1),
 (4,  'ISE-PRJ-04', current_date - 600, 'GOOD', 'AVAILABLE', 2, 1),
 (5,  'ECE-PRJ-05', current_date - 700, 'GOOD', 'AVAILABLE', 2, 3),
 (6,  'ISE-CAM-01', current_date - 400, 'NEW',  'AVAILABLE', 3, 1),
 (7,  'ISE-CAM-02', current_date - 400, 'GOOD', 'AVAILABLE', 3, 1),
 (8,  'ECE-OSC-01', current_date - 1100,'GOOD', 'AVAILABLE', 4, 3),
 (9,  'ECE-OSC-02', current_date - 1100,'GOOD', 'AVAILABLE', 4, 3),
 (10, 'ISE-KIT-01', current_date - 300, 'GOOD', 'AVAILABLE', 5, 1),
 (11, 'ISE-KIT-02', current_date - 300, 'GOOD', 'AVAILABLE', 5, 1),
 (12, 'ISE-KIT-03', current_date - 300, 'GOOD', 'AVAILABLE', 5, 1),
 (13, 'ISE-KIT-04', current_date - 300, 'GOOD', 'AVAILABLE', 5, 1),
 (14, 'ISE-LAP-01', current_date - 500, 'GOOD', 'AVAILABLE', 6, 1),
 (15, 'ISE-LAP-02', current_date - 500, 'FAIR', 'AVAILABLE', 6, 1),
 (16, 'ISE-VR-01',  current_date - 200, 'NEW',  'AVAILABLE', 7, 1);

-- ---------------------------------------------------------------------------
-- lending requests (pending pipeline + queue requests)
-- ---------------------------------------------------------------------------
INSERT INTO lending_request (request_id, student_id, model_id, purpose, requested_start, requested_end, request_status, remarks) VALUES
 (1, '1RV23CS021', 1, 'Need a projector for the DBMS project demo day in the seminar hall',        now()+interval '1 day',  now()+interval '2 days',  'APPROVED', 'Reserved automatically by approve_request'),
 (2, '1RV22IS001', 3, 'Photography for the college magazine shoot at the main auditorium',         now()+interval '1 day',  now()+interval '3 days',  'PENDING',  NULL),
 (3, '1RV22EC009', 4, 'Oscilloscope needed for the IoT lab sensor characterisation experiments',   now()+interval '1 day',  now()+interval '3 days',  'APPROVED', 'Reserved automatically by approve_request'),
 (4, '1RV24IS057', 6, 'Laptop needed for the 3-day hackathon at the innovation centre',            now()+interval '30 days', now()+interval '32 days', 'PENDING', NULL),
 (5, '1RV22IS001', 7, 'VR session for the open-day robotics demonstration',                        now(),                   now()+interval '1 day',   'APPROVED', 'Queued automatically - all headsets busy'),
 (6, '1RV23IS008', 7, 'VR content development for the semester mini-project review',               now(),                   now()+interval '2 days',  'APPROVED', NULL),
 (7, '1RV24IS049', 7, 'VR lab familiarisation session for the first-year induction',               now(),                   now()+interval '1 day',   'APPROVED', NULL);

-- ---------------------------------------------------------------------------
-- loans: history (returned) -> utilization data, one late return with fine
-- ---------------------------------------------------------------------------
INSERT INTO loan (loan_id, student_id, item_id, issued_by_staff_id, checkout_at, due_date, returned_at, return_condition, loan_status, fine_amount) VALUES
 (1,  '1RV22IS001', 1, 1, now()-interval '20 days', now()-interval '17 days', now()-interval '18 days', 'GOOD',   'RETURNED', 0),
 (2,  '1RV22IS012', 1, 2, now()-interval '14 days', now()-interval '11 days', now()-interval '12 days', 'GOOD',   'RETURNED', 0),
 (3,  '1RV22IS034', 6, 1, now()-interval '10 days', now()-interval '8 days',  now()-interval '8 days',  'GOOD',   'RETURNED', 0),
 (4,  '1RV22EC009', 8, 4, now()-interval '25 days', now()-interval '20 days', now()-interval '16 days', 'FAIR',   'RETURNED', 160.00),
 (5,  '1RV23IS008', 10, 2, now()-interval '9 days',  now()-interval '2 days',  now()-interval '3 days',  'GOOD',   'RETURNED', 0),
 (6,  '1RV23CS021', 14, 1, now()-interval '30 days', now()-interval '27 days', now()-interval '25 days', 'GOOD',   'RETURNED', 0),
 (12, '1RV24IS057', 12, 2, now()-interval '20 days', now()-interval '13 days', now()-interval '15 days', 'GOOD',   'RETURNED', 0);

-- loans: currently active
INSERT INTO loan (loan_id, student_id, item_id, issued_by_staff_id, checkout_at, due_date, loan_status) VALUES
 (7,  '1RV22IS001', 2,  1, now()-interval '1 day',  now()+interval '2 days',  'ACTIVE'),   -- PRJ-02 on loan
 (8,  '1RV24IS049', 11, 2, now()-interval '2 days', now()+interval '5 days',  'ACTIVE'),   -- KIT-02 on loan
 (9,  '1RV24IS057', 15, 1, now()-interval '3 days', now() - interval '1 hour', 'ACTIVE'); -- LAP-02 due now

-- loans: overdue (unreturned) -> powers the overdue report and escalation demo
INSERT INTO loan (loan_id, student_id, item_id, issued_by_staff_id, checkout_at, due_date, loan_status, fine_amount) VALUES
 (10, '1RV22IS012', 7, 1, now()-interval '8 days',  now()-interval '5 days', 'OVERDUE', 750.00),  -- CAM-02, 5 days late x 150
 (11, '1RV22IS034', 16,1, now()-interval '12 days', now()-interval '9 days', 'OVERDUE', 1800.00); -- VR-01, 9 days late x 200

-- ---------------------------------------------------------------------------
-- reservations: HELD future bookings
-- ---------------------------------------------------------------------------
INSERT INTO reservation (reservation_id, request_id, item_id, reserved_period, status, hold_expires_at) VALUES
 (1, 1, 3, tstzrange(now()+interval '1 day', now()+interval '2 days'), 'HELD', now()+interval '1 day'),
 (2, 3, 9, tstzrange(now()+interval '1 day', now()+interval '3 days'), 'HELD', now()+interval '1 day');

-- ---------------------------------------------------------------------------
-- maintenance blocks: one ACTIVE now, calibration in the past
-- ---------------------------------------------------------------------------
INSERT INTO maintenance_block (block_id, item_id, authorized_by, blocked_range, reason, status) VALUES
 (1, 5, 4, tstzrange(now()-interval '1 day', now()+interval '1 day'),  'Lamp replacement and fan cleaning', 'ACTIVE'),
 (2, 8, 4, tstzrange(now()-interval '30 days', now()-interval '28 days'), 'Annual calibration certificate',   'DONE'),
 (3, 14,1, tstzrange(now()-interval '24 days', now()-interval '22 days'), 'SSD upgrade and OS reinstall',     'DONE');

-- ---------------------------------------------------------------------------
-- FIFO hold queue on the VR headset (ISE-VR-01, currently overdue)
--   ticket 1: offer EXPIRED  (queue_tick will skip it as a no-show)
--   ticket 2, 3: WAITING
-- ---------------------------------------------------------------------------
INSERT INTO queue_entry (item_id, ticket_no, request_id, enqueued_at, queue_status, offer_expires_at, no_show_count) VALUES
 (16, 1, 5, now()-interval '3 hours', 'OFFERED', now()-interval '30 minutes', 0),
 (16, 2, 6, now()-interval '2 hours', 'WAITING', NULL, 0),
 (16, 3, 7, now()-interval '1 hour',  'WAITING', NULL, 0);

-- ---------------------------------------------------------------------------
-- keep identity sequences ahead of the explicitly inserted ids
-- ---------------------------------------------------------------------------
DO $$
BEGIN
    PERFORM setval(pg_get_serial_sequence('department', 'dept_id'),         (SELECT max(dept_id) FROM department));
    PERFORM setval(pg_get_serial_sequence('staff', 'staff_id'),             (SELECT max(staff_id) FROM staff));
    PERFORM setval(pg_get_serial_sequence('category', 'category_id'),       (SELECT max(category_id) FROM category));
    PERFORM setval(pg_get_serial_sequence('equipment', 'model_id'),         (SELECT max(model_id) FROM equipment));
    PERFORM setval(pg_get_serial_sequence('item', 'item_id'),               (SELECT max(item_id) FROM item));
    PERFORM setval(pg_get_serial_sequence('lending_request', 'request_id'), (SELECT max(request_id) FROM lending_request));
    PERFORM setval(pg_get_serial_sequence('reservation', 'reservation_id'), (SELECT max(reservation_id) FROM reservation));
    PERFORM setval(pg_get_serial_sequence('loan', 'loan_id'),               (SELECT max(loan_id) FROM loan));
    PERFORM setval(pg_get_serial_sequence('maintenance_block', 'block_id'), (SELECT max(block_id) FROM maintenance_block));
END $$;

COMMIT;
