#!/usr/bin/env node
/**
 * ============================================================================
 *  DEMO 04 - REAL CONCURRENCY: SERIALIZABLE checkout races (Node.js + pg)
 * ============================================================================
 *  Course project: Equipment Lending Library with Fair Hold Queues
 *
 *  Two scenarios, each played out on two SEPARATE PostgreSQL connections
 *  (two independent sessions - exactly like two browser tabs working on the
 *  same database):
 *
 *    Scenario A - two students race for the last available unit
 *                 checkout_walkin() on a temporary laptop item DEMO-RACE-01
 *                 (model 6, Dell Latitude 5420)
 *
 *    Scenario B - two staff scan the same HELD reservation
 *                 checkout() on a reservation created for the seeded
 *                 projector ISE-PRJ-03 (item 3)
 *
 *  Both sessions open with BEGIN ISOLATION LEVEL SERIALIZABLE.  The loser
 *  either hits a serialization failure (SQLSTATE 40001) or, after the retry
 *  loop rolls the transaction back and replays it, the business-rule error
 *  (ITEM_NOT_AVAILABLE / RESERVATION_NOT_HELD).  Exactly one loan may be
 *  created per race - anything else is a FAIL.
 *
 *  The retry loop below mirrors the API's behaviour: 40001 / 40P01 are
 *  transient, so the transaction is rolled back and retried; the replay then
 *  sees the committed state of the winner and fails deterministically with
 *  the business error.
 *
 *  Connection settings come from the environment (PGHOST / PGPORT / PGUSER /
 *  PGDATABASE) with the project defaults.  The script exits with a non-zero
 *  code if any expectation fails.
 * ============================================================================
 */

'use strict';

const { Client } = require('pg');

// ---------------------------------------------------------------------------
// configuration
// ---------------------------------------------------------------------------
const DB_CONFIG = {
  host: process.env.PGHOST || 'localhost',
  port: Number(process.env.PGPORT || 5433),
  user: process.env.PGUSER || 'postgres',
  database: process.env.PGDATABASE || 'lending_library',
};

const MAX_ATTEMPTS = 3; // serialization failures are retried up to this many times
const BARRIER_TIMEOUT_MS = 5000; // safety valve so a broken racer cannot hang the run

const RUN_START = Date.now(); // used for the wall-clock report

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Start barrier: every racer waits here after opening its transaction, and
 * the moment both have arrived they issue their SELECT in the same event-loop
 * turn - the two statements reach PostgreSQL within microseconds of each
 * other, which is what makes the race a real race.
 */
function createBarrier(size) {
  let arrived = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const safety = setTimeout(release, BARRIER_TIMEOUT_MS);
  if (typeof safety.unref === 'function') safety.unref();
  return function arriveAndWait() {
    arrived += 1;
    if (arrived >= size) release();
    return gate;
  };
}

const firstLine = (text) => String(text || '').split(/\r?\n/)[0];

function section(title) {
  console.log(`\n${'='.repeat(74)}`);
  console.log(`  ${title}`);
  console.log('='.repeat(74));
}

let failedChecks = 0;
let fatalError = false;
const scenarioResults = [];

function check(ok, description, detail) {
  const tag = ok ? 'PASS' : 'FAIL';
  console.log(`   [${tag}] ${description}${detail ? `  (${detail})` : ''}`);
  if (!ok) failedChecks += 1;
  return ok;
}

/**
 * Runs one checkout statement inside a SERIALIZABLE transaction and retries
 * transient serialization failures (SQLSTATE 40001 / 40P01).
 *
 * Resolves to a result object (never throws for expected database errors):
 *   { label, student, ok, loanId, code, message, attempts, elapsedMs }
 */
async function raceTransaction({ label, student = null, sql, params, barrier = null }) {
  const client = new Client(DB_CONFIG);
  await client.connect();
  const startedAt = Date.now();
  const attempts = [];

  try {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      let inTransaction = false;
      try {
        await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
        inTransaction = true;
        if (attempt === 1 && barrier) {
          // coordination barrier: both racers sit on an open transaction and
          // fire their SELECT together
          await barrier();
        }
        const outcome = await client.query(sql, params);
        await client.query('COMMIT');
        inTransaction = false;
        attempts.push({ attempt, code: null, message: 'committed', retry: false });
        return {
          label,
          student,
          ok: true,
          loanId: outcome.rows[0].loan_id,
          code: null,
          message: null,
          attempts,
          elapsedMs: Date.now() - startedAt,
        };
      } catch (err) {
        if (inTransaction) {
          try {
            await client.query('ROLLBACK');
          } catch (rollbackErr) {
            // connection already gone - nothing left to roll back
          }
        }
        const retryable = err.code === '40001' || err.code === '40P01';
        const willRetry = retryable && attempt < MAX_ATTEMPTS;
        attempts.push({
          attempt,
          code: err.code || null,
          message: firstLine(err.message),
          retry: willRetry,
        });
        if (willRetry) {
          await sleep(10 * attempt);
          continue;
        }
        return {
          label,
          student,
          ok: false,
          loanId: null,
          code: err.code || null,
          message: err.message,
          attempts,
          elapsedMs: Date.now() - startedAt,
        };
      }
    }
    // unreachable - loop always returns
    return { label, student, ok: false, loanId: null, code: null, message: 'no attempt made', attempts, elapsedMs: Date.now() - startedAt };
  } finally {
    await client.end().catch(() => {});
  }
}

function printRaceResult(result) {
  const who = result.student ? `${result.label} (student ${result.student})` : result.label;
  const verdict = result.ok
    ? `COMMIT -> loan_id = ${result.loanId}`
    : `ROLLBACK -> SQLSTATE ${result.code}`;
  console.log(`   ${who}: ${verdict}   [${result.elapsedMs} ms, ${result.attempts.length} attempt(s)]`);
  for (const a of result.attempts) {
    const code = a.code ? `SQLSTATE ${a.code}` : 'no error';
    const retry = a.retry ? ' -> retrying' : '';
    console.log(`       attempt ${a.attempt}: ${code}${a.message ? ` - ${a.message}` : ''}${retry}`);
  }
}

// ---------------------------------------------------------------------------
// database fixtures / cleanup (all DEMO-04 rows are tagged so re-runs work)
// ---------------------------------------------------------------------------
async function cleanupDemoItem(client) {
  // loans reference the item, so they must go first; audit_log rows are kept
  await client.query(
    `DELETE FROM loan
      WHERE item_id IN (SELECT item_id FROM item WHERE serial_no = 'DEMO-RACE-01')`);
  await client.query(`DELETE FROM item WHERE serial_no = 'DEMO-RACE-01'`);
}

async function cleanupDemoRequests(client) {
  const tagged = `SELECT request_id FROM lending_request WHERE purpose LIKE 'DEMO-04%'`;
  await client.query(
    `DELETE FROM loan WHERE reservation_id IN (
        SELECT reservation_id FROM reservation WHERE request_id IN (${tagged}))`);
  await client.query(`DELETE FROM queue_entry WHERE request_id IN (${tagged})`);
  await client.query(`DELETE FROM reservation WHERE request_id IN (${tagged})`);
  await client.query(`DELETE FROM lending_request WHERE purpose LIKE 'DEMO-04%'`);
}

// ---------------------------------------------------------------------------
// Scenario A - two students race for the last available unit (walk-in)
// ---------------------------------------------------------------------------
async function scenarioA(admin) {
  section('SCENARIO A - two students race for the last available unit (walk-in)');
  const scenarioStart = Date.now();
  let pass = false;

  await cleanupDemoItem(admin); // pre-clean leftovers of a crashed earlier run

  try {
    // -- committed setup: a fresh laptop unit, serial DEMO-RACE-01 ----------
    const created = await admin.query(
      `INSERT INTO item (serial_no, item_condition, lifecycle_status, model_id, dept_id)
       VALUES ('DEMO-RACE-01', 'GOOD', 'AVAILABLE', 6, 1)
       RETURNING item_id`);
    const itemId = created.rows[0].item_id;
    console.log(`   setup: created item ${itemId} (serial DEMO-RACE-01, model 6 laptop, dept 1)`);

    const cache = await admin.query(
      'SELECT cached_status FROM availability_cache WHERE item_id = $1', [itemId]);
    console.log(`   setup: availability_cache -> ${cache.rows[0].cached_status}`);
    console.log(`   race : CLIENT-A (1RV23CS021) vs CLIENT-B (1RV22IS012), both run`);
    console.log(`          BEGIN ISOLATION LEVEL SERIALIZABLE + checkout_walkin(${itemId})`);

    // -- the race: two independent connections released by the same barrier
    const barrier = createBarrier(2);
    const [a, b] = await Promise.all([
      raceTransaction({
        label: 'CLIENT-A',
        student: '1RV23CS021',
        sql: 'SELECT checkout_walkin($1, $2, $3) AS loan_id',
        params: ['1RV23CS021', itemId, 1],
        barrier,
      }),
      raceTransaction({
        label: 'CLIENT-B',
        student: '1RV22IS012',
        sql: 'SELECT checkout_walkin($1, $2, $3) AS loan_id',
        params: ['1RV22IS012', itemId, 2],
        barrier,
      }),
    ]);
    printRaceResult(a);
    printRaceResult(b);

    // -- ground truth straight from the database ----------------------------
    const loans = await admin.query(
      `SELECT loan_id, student_id, loan_status
         FROM loan
        WHERE item_id = $1 AND returned_at IS NULL
        ORDER BY loan_id`, [itemId]);
    console.log(`   database check: active loans on item ${itemId} = ${loans.rowCount}` +
      loans.rows.map((r) => ` [loan ${r.loan_id} -> ${r.student_id}]`).join(''));

    const winners = [a, b].filter((r) => r.ok);
    const losers = [a, b].filter((r) => !r.ok);
    const loser = losers[0];

    const c1 = check(winners.length === 1,
      'exactly one racer obtained the last unit',
      winners.length ? `${winners[0].label} -> loan ${winners[0].loanId}` : 'no winner');
    const c2 = check(
      losers.length === 1 &&
        (loser.code === '40001' || /ITEM_NOT_AVAILABLE/.test(loser.message || '')),
      'the other racer was refused (business rule)',
      loser ? `SQLSTATE ${loser.code}: ${firstLine(loser.message)}` : 'no loser');
    const c3 = check(loans.rowCount === 1,
      'database truth: exactly one active loan for the demo item',
      `${loans.rowCount} active loan(s)`);
    pass = c1 && c2 && c3;
  } finally {
    await cleanupDemoItem(admin); // leave no trace behind
    console.log('   cleanup: demo item and its loan(s) removed (audit_log kept)');
  }

  scenarioResults.push({ name: 'Scenario A - walk-in race', pass, ms: Date.now() - scenarioStart });
  return pass;
}

// ---------------------------------------------------------------------------
// Scenario B - two staff scan the same reservation (checkout)
// ---------------------------------------------------------------------------
async function scenarioB(admin) {
  section('SCENARIO B - two staff scan the same HELD reservation (checkout)');
  const scenarioStart = Date.now();
  let pass = false;

  await cleanupDemoRequests(admin); // pre-clean leftovers of a crashed earlier run

  let requestId = null;
  let reservationId = null;

  try {
    // -- committed setup: request + HELD reservation on item 3 --------------
    const request = await admin.query(
      `INSERT INTO lending_request (student_id, model_id, purpose, requested_start, requested_end)
       VALUES ('1RV22IS034', 1,
               'DEMO-04-B: reservation scanned by two staff at once',
               now() + interval '3 days',
               now() + interval '4 days')
       RETURNING request_id`);
    requestId = request.rows[0].request_id;

    const approved = await admin.query(
      'SELECT approve_request($1, $2, $3) AS outcome', [requestId, 1, 3]);
    const outcome = approved.rows[0].outcome;
    console.log(`   setup: approve_request(request ${requestId}, staff 1, item 3) -> ${JSON.stringify(outcome)}`);

    if (!outcome || outcome.outcome !== 'RESERVED' || !outcome.reservation_id) {
      check(false, 'setup produced a HELD reservation on item 3',
        `unexpected outcome ${JSON.stringify(outcome)}`);
    } else {
      reservationId = outcome.reservation_id;
      console.log(`   setup: reservation ${reservationId} is HELD on item 3 (ISE-PRJ-03)`);
      console.log('   race : CLIENT-A (staff 1) vs CLIENT-B (staff 2), both run');
      console.log(`          BEGIN ISOLATION LEVEL SERIALIZABLE + checkout(${reservationId}, staff)`);

      // -- the race: both staff scan the same reservation at the barrier
      const barrier = createBarrier(2);
      const [a, b] = await Promise.all([
        raceTransaction({
          label: 'CLIENT-A',
          sql: 'SELECT checkout($1, $2) AS loan_id',
          params: [reservationId, 1],
          barrier,
        }),
        raceTransaction({
          label: 'CLIENT-B',
          sql: 'SELECT checkout($1, $2) AS loan_id',
          params: [reservationId, 2],
          barrier,
        }),
      ]);
      printRaceResult(a);
      printRaceResult(b);

      // -- ground truth straight from the database --------------------------
      const loans = await admin.query(
        'SELECT loan_id, issued_by_staff_id FROM loan WHERE reservation_id = $1',
        [reservationId]);
      const reservation = await admin.query(
        'SELECT status FROM reservation WHERE reservation_id = $1', [reservationId]);
      console.log(`   database check: loans for reservation ${reservationId} = ${loans.rowCount},` +
        ` reservation is now ${reservation.rows[0].status}`);

      const winners = [a, b].filter((r) => r.ok);
      const losers = [a, b].filter((r) => !r.ok);
      const loser = losers[0];

      const c1 = check(winners.length === 1,
        'exactly one scan produced a loan',
        winners.length ? `${winners[0].label} -> loan ${winners[0].loanId}` : 'no winner');
      const c2 = check(
        losers.length === 1 &&
          (loser.code === '40001' ||
            /RESERVATION_NOT_HELD|RESERVATION_EXPIRED/.test(loser.message || '')),
        'the other scan was refused (business rule)',
        loser ? `SQLSTATE ${loser.code}: ${firstLine(loser.message)}` : 'no loser');
      const c3 = check(loans.rowCount === 1,
        'database truth: exactly one loan references the reservation',
        `${loans.rowCount} loan(s)`);
      const c4 = check(reservation.rows[0].status === 'FULFILLED',
        'the reservation was consumed (status FULFILLED)',
        `status = ${reservation.rows[0].status}`);
      pass = c1 && c2 && c3 && c4;
    }
  } finally {
    // FK-safe teardown: loan -> queue_entry -> reservation -> lending_request
    if (reservationId !== null) {
      await admin.query('DELETE FROM loan WHERE reservation_id = $1', [reservationId]);
      await admin.query('DELETE FROM reservation WHERE reservation_id = $1', [reservationId]);
    }
    if (requestId !== null) {
      await admin.query('DELETE FROM queue_entry WHERE request_id = $1', [requestId]);
      await admin.query('DELETE FROM lending_request WHERE request_id = $1', [requestId]);
    }
    console.log('   cleanup: demo loan / reservation / request removed (audit_log kept)');
  }

  scenarioResults.push({ name: 'Scenario B - reservation race', pass, ms: Date.now() - scenarioStart });
  return pass;
}

// ---------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------
function printSummary() {
  section('SUMMARY');
  for (const result of scenarioResults) {
    console.log(`   [${result.pass ? 'PASS' : 'FAIL'}] ${result.name}  (${result.ms} ms)`);
  }
  console.log(`   expectations failed : ${failedChecks}`);
  console.log(`   total wall time     : ${Date.now() - RUN_START} ms`);
  const ok = failedChecks === 0 && !fatalError;
  console.log(`   RESULT: ${ok ? 'ALL EXPECTATIONS MET' : 'FAILURES PRESENT'}`);
  process.exitCode = ok ? 0 : 1;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
async function main() {
  section('DEMO 04 - SERIALIZABLE CHECKOUT RACES (Node.js + pg)');
  console.log(`   database : ${DB_CONFIG.database} @ ${DB_CONFIG.host}:${DB_CONFIG.port} (user ${DB_CONFIG.user})`);
  console.log('   note     : audit_log rows created by this demo are intentionally left in place.');

  const admin = new Client(DB_CONFIG);
  await admin.connect();
  try {
    await cleanupDemoItem(admin); // belt-and-braces pre-clean of both scenarios
    await cleanupDemoRequests(admin);

    await scenarioA(admin);
    await scenarioB(admin);
  } finally {
    await admin.end().catch(() => {});
  }

  printSummary();
}

main().then(
  () => {},
  (err) => {
    fatalError = true;
    console.error(`\n   FATAL: ${err && err.stack ? err.stack : err}`);
    printSummary();
  }
);
