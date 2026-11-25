-- ============================================================================
--  EQUIPMENT LENDING LIBRARY - LIVE WEBSITE SEED (college-wide)
--
--  Departments: CSE, ISE, ECE, EEE, Mechanical, Civil, Chemical,
--               Biotechnology, Aerospace, AI and ML
--  Labs and equipment names follow the RVCE laboratory pages
--  (rvce.edu.in/department/<dept>/laboratories/).
--
--  Live profiles: Padmashree T, Rashmi R and Rekha B S (all ISE faculty),
--                 Karthik Anup Revankar (ISE student), Ibrahim Kasheef
--                 (ISE student), plus the administrator account.
--
--  Usage (after live_schema.sql):
--    psql -U postgres -p 5433 -d lending_library_live -v ON_ERROR_STOP=1 -f db/live/live_seed.sql
-- ============================================================================

SET client_min_messages = warning;

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. departments (branch code = USN branch and email suffix)
-- ---------------------------------------------------------------------------
INSERT INTO department (dept_id, dept_name, branch_code, building, hod_name, contact_email) VALUES
 (1,  'Computer Science and Engineering',        'CS', 'CS Block',   'Dr. Srinivasa K G', 'cse.office@rvce.edu.in'),
 (2,  'Information Science and Engineering',     'IS', 'ISE Block',  'Dr. Rashmi R',      'ise.office@rvce.edu.in'),
 (3,  'Electronics and Communication Engineering','EC','ECE Block',  'Dr. Nagamani K',    'ece.office@rvce.edu.in'),
 (4,  'Electrical and Electronics Engineering',  'EE', 'EEE Block',  'Dr. Pandry Narendra Rao', 'eee.office@rvce.edu.in'),
 (5,  'Mechanical Engineering',                  'ME', 'ME Block',   'Dr. K S Narayanaswamy', 'me.office@rvce.edu.in'),
 (6,  'Civil Engineering',                       'CV', 'Civil Block','Dr. Ramesh B',      'civil.office@rvce.edu.in'),
 (7,  'Chemical Engineering',                    'CH', 'Chemical Block', 'Dr. Prasanna B D', 'chemical.office@rvce.edu.in'),
 (8,  'Biotechnology',                           'BT', 'BT Block',   'Dr. Divya G',       'bt.office@rvce.edu.in'),
 (9,  'Aerospace Engineering',                   'AE', 'AE Block',   'Dr. Sridhar B',     'ae.office@rvce.edu.in'),
 (10, 'Artificial Intelligence and Machine Learning', 'AI', 'AI Block', 'Dr. Shanta Rangaswamy', 'aiml.office@rvce.edu.in');

-- ---------------------------------------------------------------------------
-- 2. lending categories
-- ---------------------------------------------------------------------------
INSERT INTO category (category_id, category_name, max_loan_days, late_fee_per_day) VALUES
 (1,  'Projector and Display',        3, 50.00),
 (2,  'Computing and Workstation',    3, 100.00),
 (3,  'Networking',                   3, 80.00),
 (4,  'Test and Measurement',         5, 40.00),
 (5,  'Microcontroller and Embedded', 7, 10.00),
 (6,  'Communication Systems',        5, 60.00),
 (7,  'RF and Microwave',             3, 150.00),
 (8,  'VLSI and FPGA',                5, 200.00),
 (9,  'Electrical Machines',          5, 100.00),
 (10, 'Mechanical Engineering',       7, 50.00),
 (11, 'Civil Engineering',            7, 50.00),
 (12, 'Chemical and Biotechnology',   7, 80.00),
 (13, 'Aerospace',                    5, 200.00),
 (14, 'IoT and Robotics',             7, 30.00);

-- ---------------------------------------------------------------------------
-- 3. laboratories (names from the department laboratory pages)
-- ---------------------------------------------------------------------------
INSERT INTO lab (lab_id, lab_name, dept_id, location) VALUES
 (1,  'CSE Laboratory 1',                        1, 'CS Block, Lab 1'),
 (2,  'CSE Laboratory 2',                        1, 'CS Block, Lab 2'),
 (3,  'CSE Laboratory 11',                       1, 'CS Block, Lab 11'),
 (4,  'UG Laboratory 1A',                        2, 'ISE Block, Lab 1A'),
 (5,  'UG Laboratory 2A',                        2, 'ISE Block, Lab 2A'),
 (6,  'IoT Lab Facilities',                      2, 'ISE Block, IoT Lab'),
 (7,  'R and D Laboratory',                      2, 'ISE Block, R and D Lab'),
 (8,  'Circuits Lab 1',                          3, 'ECE Block, Lab 1'),
 (9,  'Communication System Lab',                3, 'ECE Block, Lab 2'),
 (10, 'Microcontroller and System Design Lab',   3, 'ECE Block, Lab 3'),
 (11, 'RF Lab',                                  3, 'ECE Block, Lab 4'),
 (12, 'VLSI and Embedded Lab',                   3, 'ECE Block, Lab 5'),
 (13, 'Electrical Machines Lab',                 4, 'EEE Block, Lab 1'),
 (14, 'Digital Signal Processing and Microcontroller Lab', 4, 'EEE Block, Lab 2'),
 (15, 'Relay and High Voltage Lab',              4, 'EEE Block, Lab 3'),
 (16, 'Machine Shop',                            5, 'ME Block, Workshop'),
 (17, 'Heat Engines Lab',                        5, 'ME Block, Lab 1'),
 (18, 'Metrology Lab',                           5, 'ME Block, Lab 2'),
 (19, 'Concrete Laboratory',                     6, 'Civil Block, Lab 1'),
 (20, 'Surveying Laboratory',                    6, 'Civil Block, Lab 2'),
 (21, 'Chemical Engineering Laboratory',         7, 'Chemical Block, Lab 1'),
 (22, 'Process Control Laboratory',              7, 'Chemical Block, Lab 2'),
 (23, 'Biotechnology Laboratory',                8, 'BT Block, Lab 1'),
 (24, 'Molecular Biology Laboratory',            8, 'BT Block, Lab 2'),
 (25, 'Aerodynamics Laboratory',                 9, 'AE Block, Lab 1'),
 (26, 'Aircraft Propulsion Laboratory',          9, 'AE Block, Lab 2'),
 (27, 'AI and ML Laboratory',                    10, 'AI Block, Lab 1'),
 (28, 'Robotics and Vision Laboratory',          10, 'AI Block, Lab 2');

-- ---------------------------------------------------------------------------
-- 4. faculty and administrator
-- ---------------------------------------------------------------------------
INSERT INTO staff (staff_id, staff_name, role, email, dept_id) VALUES
 (1, 'Padmashree T',        'LAB_ADMIN',  'padmashreet@rvce.edu.in', 2),
 (2, 'Rashmi R',            'DEPT_ADMIN', 'rashmir@rvce.edu.in',     2),
 (3, 'Rekha B S',           'LAB_ADMIN',  'rekhabs@rvce.edu.in',     2),
 (4, 'System Administrator','DEPT_ADMIN', 'admin@rvce.edu.in',       2);

-- ---------------------------------------------------------------------------
-- 5. students (ISE, 2024 batch)
-- ---------------------------------------------------------------------------
INSERT INTO student (student_id, full_name, semester, email, dept_id) VALUES
 ('1RV24IS057', 'Karthik Anup Revankar', 5, 'karthikanupr.is24@rvce.edu.in', 2),
 ('1RV24IS049', 'Ibrahim Kasheef',       5, 'ibrahimkasheef.is24@rvce.edu.in', 2);

INSERT INTO student_phone (student_id, phone_no) VALUES
 ('1RV24IS057', '+91 98450 11057'),
 ('1RV24IS049', '+91 98450 11049');

-- ---------------------------------------------------------------------------
-- 6. accounts (bcrypt via pgcrypto)
-- ---------------------------------------------------------------------------
INSERT INTO app_user (email, password_hash, role, student_id) VALUES
 ('karthikanupr.is24@rvce.edu.in', crypt('Student@123', gen_salt('bf', 10)), 'STUDENT', '1RV24IS057'),
 ('ibrahimkasheef.is24@rvce.edu.in', crypt('Student@123', gen_salt('bf', 10)), 'STUDENT', '1RV24IS049');

INSERT INTO app_user (email, password_hash, role, staff_id) VALUES
 ('padmashreet@rvce.edu.in', crypt('Faculty@123', gen_salt('bf', 10)), 'FACULTY', 1),
 ('rashmir@rvce.edu.in',     crypt('Faculty@123', gen_salt('bf', 10)), 'FACULTY', 2),
 ('rekhabs@rvce.edu.in',     crypt('Faculty@123', gen_salt('bf', 10)), 'FACULTY', 3),
 ('admin@rvce.edu.in',       crypt('Admin@123',   gen_salt('bf', 10)), 'ADMIN',   4);

-- ---------------------------------------------------------------------------
-- 7. catalogue models (real equipment from the department laboratory pages)
-- ---------------------------------------------------------------------------
INSERT INTO equipment (model_id, model_name, manufacturer, description, category_id, dept_id) VALUES
 (1,  'Lenovo ThinkStation P920 Workstation', 'Lenovo',   '2 x Intel Xeon Gold 5118, 128 GB RAM, 4 TB SSD', 2, 1),
 (2,  'NVIDIA A100 GPU Server',               'NVIDIA',   'Dual A100 40 GB GPUs, 128 GB RAM', 2, 1),
 (3,  'Lenovo ThinkCentre Neo 50t Desktop',   'Lenovo',   'Core i5-12500, 8 GB RAM, 512 GB SSD', 2, 1),
 (4,  '65 inch Interactive Display',          'Samsung',  '65 inch interactive display for seminars', 1, 1),
 (5,  'Acer Veriton M200 H310 Desktop',       'Acer',     'Core i5-8400, 8 GB RAM, 1 TB HDD', 2, 1),
 (6,  'Digital Logic Trainer Board',          'RVCE',     'Digital logic trainer with 16-pin IC base', 5, 1),
 (7,  'Acer Desktop Core i5',                 'Acer',     'Core i5, 8 GB RAM, 1 TB HDD, 18.5 inch monitor', 2, 2),
 (8,  'IoT Development Kit',                  'Arduino',  'IoT sensors, actuators and accessories', 14, 2),
 (9,  'Dell Desktop Core i7',                 'Dell',     'Core i7, 16 GB RAM, 1 TB SSD, 20 inch monitor', 2, 2),
 (10, 'Ceiling Projector',                    'Epson',    'Ceiling-mounted lab projector', 1, 2),
 (11, 'Raspberry Pi 4 Model B',               'Raspberry Pi Foundation', '4 GB single board computer', 14, 2),
 (12, 'Arduino Mega 2560 R3',                 'Arduino',  'ATmega2560 development board', 14, 2),
 (13, 'ARM 7 LPC2148 Microcontroller Kit',    'NXP',      'LPC2148 development board with accessories', 5, 2),
 (14, 'HP Workstation Core i9',               'HP',       'Core i9, 64 GB RAM, 2 TB storage', 2, 2),
 (15, 'Signal Generator',                     'Keysight', 'Laboratory signal generator', 4, 3),
 (16, 'Digital Multimeter',                   'Fluke',    'Bench digital multimeter', 4, 3),
 (17, 'Oscilloscope',                         'Tektronix','Dual channel laboratory oscilloscope', 4, 3),
 (18, 'Software Defined Radio Kit',           'Ettus',    'USRP software defined radio kit', 6, 3),
 (19, 'DSP Starter Kit TMS320C6713',          'Texas Instruments', 'DSP starter kit with USB programmer', 6, 3),
 (20, 'ARM Cortex Microcontroller Kit',       'STMicroelectronics', 'ARM Cortex development kit', 5, 3),
 (21, 'Microprocessor Trainer Kit',           'ALS',      '8085/8051 microprocessor trainer kit', 5, 3),
 (22, 'Spectrum Analyzer',                    'Rohde and Schwarz', 'RF spectrum analyzer', 7, 3),
 (23, 'AM FM Signal Generator',               'Keysight', 'AM/FM modulated signal generator', 7, 3),
 (24, 'Xilinx Spartan 3E FPGA Board',         'Xilinx',   'Spartan 3E FPGA development board', 8, 3),
 (25, 'Xilinx Virtex-5 ML507 FPGA Kit',       'Xilinx',   'Virtex-5 ML507 evaluation kit', 8, 3),
 (26, 'DC Compound Machine 3.5 kW',           'BHEL',     'DC compound machine, 230 V, 1500 rpm', 9, 4),
 (27, 'Three Phase Transformer 3 kVA',        'Kirloskar','230/230 V three phase transformer', 9, 4),
 (28, 'Digital Storage Oscilloscope DSO1002A','Agilent',  '60 MHz digital storage oscilloscope', 4, 4),
 (29, 'DSP Starter Kit TMS320C6713',          'Texas Instruments', 'DSP starter kit for the EEE DSP lab', 6, 4),
 (30, 'High Voltage Test Transformer 30 kV',  'BHEL',     '30 kV, 40 mA epoxy coated test transformer', 9, 4),
 (31, 'Impulse Generator 150 kV',             'BHEL',     '5 stage, 225 joules impulse generator', 9, 4),
 (32, 'Centre Lathe Machine',                 'Kirloskar','Conventional centre lathe', 10, 5),
 (33, 'Milling Machine',                      'BFW',      'Universal milling machine', 10, 5),
 (34, 'Four Stroke Diesel Engine Test Rig',   'Kirloskar','Diesel engine test rig with dynamometer', 10, 5),
 (35, 'Bomb Calorimeter',                     'Labindia', 'Calorific value measurement apparatus', 10, 5),
 (36, 'Vernier Caliper Set',                  'Mitutoyo', '0-150 mm vernier caliper set', 10, 5),
 (37, 'Surface Roughness Tester',             'Mitutoyo', 'Portable surface roughness tester', 10, 5),
 (38, 'Concrete Mixer',                       'Apollo',   'Laboratory concrete mixer', 11, 6),
 (39, 'Compression Testing Machine',          'Aimil',    'Concrete compression testing machine', 11, 6),
 (40, 'Total Station',                        'Leica',    'Electronic total station with tripod', 11, 6),
 (41, 'Auto Level',                           'Leica',    'Automatic optical level', 11, 6),
 (42, 'Distillation Column Trainer',          'P.A. Hilton', 'Laboratory distillation column trainer', 12, 7),
 (43, 'pH Meter',                             'Hanna',    'Benchtop pH meter', 12, 7),
 (44, 'PID Controller Trainer',               'Feedback Instruments', 'Process control PID trainer', 12, 7),
 (45, 'Flow Measurement Trainer',             'P.A. Hilton', 'Flow measurement laboratory trainer', 12, 7),
 (46, 'Binocular Microscope',                 'Olympus',  'Laboratory binocular microscope', 12, 8),
 (47, 'Laminar Air Flow Cabinet',             'Esco',     'Horizontal laminar air flow cabinet', 12, 8),
 (48, 'PCR Thermal Cycler',                   'Bio-Rad',  'Thermal cycler for molecular biology', 12, 8),
 (49, 'Gel Electrophoresis Unit',             'Bio-Rad',  'Vertical gel electrophoresis unit', 12, 8),
 (50, 'Low Speed Wind Tunnel',                'Aerolab',  'Low speed aerodynamics wind tunnel', 13, 9),
 (51, 'Pitot Static Tube',                    'Aerolab',  'Pitot static tube with manometer', 13, 9),
 (52, 'Jet Engine Model',                     'Rolls-Royce', 'Cutaway jet engine model', 13, 9),
 (53, 'Thrust Stand',                         'Aerolab',  'Engine thrust measurement stand', 13, 9),
 (54, 'NVIDIA RTX Workstation',               'NVIDIA',   'RTX GPU workstation for AI workloads', 2, 10),
 (55, 'Jetson Orin Developer Kit',            'NVIDIA',   'Edge AI developer kit', 2, 10),
 (56, 'TurtleBot 4 Robot',                    'Clearpath Robotics', 'Mobile robotics platform', 14, 10),
 (57, 'Intel RealSense Camera',               'Intel',    'Depth camera for vision experiments', 14, 10);

-- ---------------------------------------------------------------------------
-- 8. serialized units per model
-- ---------------------------------------------------------------------------
INSERT INTO item (serial_no, purchase_date, item_condition, lifecycle_status, model_id, dept_id, lab_id)
SELECT v.prefix || '-' || lpad(g::text, 2, '0'),
       current_date - 300,
       'GOOD',
       'AVAILABLE',
       v.model_id,
       e.dept_id,
       v.lab_id
  FROM (VALUES
    (1, 1,  'CSE-LAB1-P920',        2),
    (2, 1,  'CSE-LAB1-A100',        1),
    (3, 2,  'CSE-LAB2-NEO',         3),
    (4, 2,  'CSE-LAB2-DISPLAY',     1),
    (5, 3,  'CSE-LAB11-VERITON',    3),
    (6, 3,  'CSE-LAB11-LOGIC',      3),
    (7, 4,  'ISE-UG1A-ACER',        3),
    (8, 4,  'ISE-UG1A-IOTKIT',      4),
    (9, 5,  'ISE-UG2A-DELL',        2),
    (10, 5, 'ISE-UG2A-PROJECTOR',   1),
    (11, 6, 'ISE-IOT-RPI4',         6),
    (12, 6, 'ISE-IOT-ARDUINO',      6),
    (13, 6, 'ISE-IOT-LPC2148',      4),
    (14, 7, 'ISE-RD-HPWS',          2),
    (15, 8, 'ECE-CIRCUITS-SIGGEN',  3),
    (16, 8, 'ECE-CIRCUITS-DMM',     4),
    (17, 8, 'ECE-CIRCUITS-OSC',     3),
    (18, 9, 'ECE-COMM-SDR',         2),
    (19, 9, 'ECE-COMM-DSPKIT',      2),
    (20, 10,'ECE-UCSD-ARM',         4),
    (21, 10,'ECE-UCSD-MP',          3),
    (22, 11,'ECE-RF-SPECTRUM',      2),
    (23, 11,'ECE-RF-AMFM',          1),
    (24, 12,'ECE-VLSI-SPARTAN',     3),
    (25, 12,'ECE-VLSI-VIRTEX',      1),
    (26, 13,'EEE-MACHINES-DCM',     2),
    (27, 13,'EEE-MACHINES-TRANSFORMER', 2),
    (28, 14,'EEE-DSP-DSO',          2),
    (29, 14,'EEE-DSP-KIT',          2),
    (30, 15,'EEE-HV-TRANSFORMER',   1),
    (31, 15,'EEE-HV-IMPULSE',       1),
    (32, 16,'ME-SHOP-LATHE',        2),
    (33, 16,'ME-SHOP-MILLING',      1),
    (34, 17,'ME-HEAT-DIESEL',       1),
    (35, 17,'ME-HEAT-CALORIMETER',  1),
    (36, 18,'ME-METRO-CALIPER',     4),
    (37, 18,'ME-METRO-ROUGHNESS',   1),
    (38, 19,'CV-CONCRETE-MIXER',    1),
    (39, 19,'CV-CONCRETE-CTM',      1),
    (40, 20,'CV-SURVEY-TOTALSTATION', 2),
    (41, 20,'CV-SURVEY-AUTOLEVEL',  3),
    (42, 21,'CH-PROCESS-DISTILLATION', 1),
    (43, 21,'CH-PROCESS-PHMETER',   2),
    (44, 22,'CH-CONTROL-PID',       2),
    (45, 22,'CH-CONTROL-FLOW',      1),
    (46, 23,'BT-LAB-MICROSCOPE',    3),
    (47, 23,'BT-LAB-LAMINAR',       2),
    (48, 24,'BT-MOL-PCR',           1),
    (49, 24,'BT-MOL-GEL',           2),
    (50, 25,'AE-AERO-WINDTUNNEL',   1),
    (51, 25,'AE-AERO-PITOT',        2),
    (52, 26,'AE-PROP-JETMODEL',     1),
    (53, 26,'AE-PROP-THRUST',       1),
    (54, 27,'AIML-LAB-RTXWS',       2),
    (55, 27,'AIML-LAB-JETSON',      3),
    (56, 28,'AIML-VISION-TURTLEBOT', 2),
    (57, 28,'AIML-VISION-REALSENSE', 3)
  ) AS v(model_id, lab_id, prefix, qty)
  CROSS JOIN LATERAL generate_series(1, v.qty) AS g
  JOIN equipment e ON e.model_id = v.model_id;

UPDATE item SET item_condition = 'FAIR'
 WHERE serial_no IN ('ISE-UG2A-PROJECTOR-01', 'ME-SHOP-LATHE-02', 'ECE-CIRCUITS-OSC-03');

-- ---------------------------------------------------------------------------
-- 9. live activity: loans, requests, FIFO queue, reservations, maintenance
--    (only the two seeded students)
-- ---------------------------------------------------------------------------
INSERT INTO loan (loan_id, student_id, item_id, issued_by_staff_id,
                  checkout_at, due_date, returned_at, return_condition,
                  loan_status, fine_amount, return_requested_at, return_request_note) VALUES
 (1, '1RV24IS057', (SELECT item_id FROM item WHERE serial_no = 'CSE-LAB1-A100-01'),
     1, now() - interval '1 day', now() + interval '2 days', NULL, NULL, 'ACTIVE', 0, NULL, NULL),
 (2, '1RV24IS049', (SELECT item_id FROM item WHERE serial_no = 'ECE-RF-SPECTRUM-01'),
     3, now() - interval '8 days', now() - interval '3 days', NULL, NULL, 'OVERDUE', 450.00, NULL, NULL),
 (3, '1RV24IS057', (SELECT item_id FROM item WHERE serial_no = 'ISE-UG2A-DELL-01'),
     2, now() - interval '2 days', now() + interval '1 day', NULL, NULL, 'ACTIVE', 0,
     now() - interval '1 hour', 'Project work finished early, returning at the ISE counter'),
 (4, '1RV24IS049', (SELECT item_id FROM item WHERE serial_no = 'ISE-IOT-RPI4-01'),
     2, now() - interval '12 days', now() - interval '5 days', now() - interval '5 days',
     'GOOD', 'RETURNED', 0, NULL, NULL),
 (5, '1RV24IS057', (SELECT item_id FROM item WHERE serial_no = 'CSE-LAB2-NEO-01'),
     1, now() - interval '17 days', now() - interval '14 days', now() - interval '10 days',
     'GOOD', 'RETURNED', 0, NULL, NULL);

INSERT INTO lending_request (request_id, student_id, model_id, purpose,
                             requested_start, requested_end, request_status, remarks) VALUES
 (1, '1RV24IS057', 1,  'High performance workstation for the DBMS project benchmarking',
     now() + interval '5 days', now() + interval '6 days', 'PENDING', NULL),
 (2, '1RV24IS049', 22, 'Spectrum analyzer for the RF and microwave lab experiment',
     now() + interval '2 days', now() + interval '3 days', 'PENDING', NULL),
 (3, '1RV24IS057', 11, 'Raspberry Pi 4 for the IoT lab mini project',
     now() + interval '1 day', now() + interval '2 days', 'PENDING', NULL),
 (4, '1RV24IS049', 2,  'A100 GPU server for the deep learning coursework',
     now(), now() + interval '1 day', 'APPROVED', 'Queued while the GPU server is on loan'),
 (5, '1RV24IS057', 10, 'Ceiling projector for the department seminar',
     now() + interval '3 days', now() + interval '4 days', 'APPROVED', NULL);

INSERT INTO queue_entry (item_id, ticket_no, request_id, enqueued_at,
                         queue_status, offer_expires_at, no_show_count) VALUES
 ((SELECT item_id FROM item WHERE serial_no = 'CSE-LAB1-A100-01'), 1, 4,
  now() - interval '2 hours', 'WAITING', NULL, 0);

INSERT INTO reservation (reservation_id, request_id, item_id, reserved_period,
                         status, hold_expires_at) VALUES
 (1, 5, (SELECT item_id FROM item WHERE serial_no = 'ISE-UG2A-PROJECTOR-01'),
  tstzrange(now() + interval '3 days', now() + interval '4 days'), 'HELD', now() + interval '3 days');

INSERT INTO maintenance_block (block_id, item_id, authorized_by, blocked_range, reason, status) VALUES
 (1, (SELECT item_id FROM item WHERE serial_no = 'ECE-RF-SPECTRUM-02'),
  3, tstzrange(now() - interval '1 day', now() + interval '1 day'),
  'Calibration and firmware update', 'ACTIVE'),
 (2, (SELECT item_id FROM item WHERE serial_no = 'ISE-IOT-RPI4-02'),
  2, tstzrange(now() - interval '20 days', now() - interval '18 days'),
  'Preventive maintenance', 'DONE');

-- ---------------------------------------------------------------------------
-- 10. keep identity sequences ahead of the explicit ids
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
    PERFORM setval(pg_get_serial_sequence('lab', 'lab_id'),                 (SELECT max(lab_id) FROM lab));
END $$;

COMMIT;

-- ============================================================================
-- MANUAL FACULTY ONBOARDING (faculty join pre-approved; add them by SQL)
-- ============================================================================
-- Run these two statements as postgres whenever a faculty member joins the
-- college (replace the values; `<dept_id>` is the department they belong to).
-- The account can log in immediately and change its password from Settings.
-- Alternatively use Admin > Accounts & roles > Add faculty account.
--
--   INSERT INTO staff (staff_name, role, email, dept_id)
--   VALUES ('Dr. Ananya Rao', 'LAB_ADMIN', 'ananyarao@rvce.edu.in', 2);
--
--   INSERT INTO app_user (email, password_hash, role, staff_id)
--   VALUES ('ananyarao@rvce.edu.in',
--           crypt('Welcome@123', gen_salt('bf', 10)),
--           'FACULTY',
--           (SELECT staff_id FROM staff WHERE email = 'ananyarao@rvce.edu.in'));
-- ============================================================================
