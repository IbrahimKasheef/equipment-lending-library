'use strict';

/**
 * db.js - thin PostgreSQL access layer for the LIVE Equipment Lending Library
 * website API (college-wide, RVCE).
 *
 * Exposes:
 *   config        connection settings (env-overridable)
 *   pool          the shared pg Pool
 *   q(...)        run a parameterised query, return the rows
 *   withTx(...)   run a function inside a transaction (SERIALIZABLE + retry)
 *   mapError(...) translate PostgreSQL errors into HTTP-friendly objects
 *   num(v)        null-safe numeric coercion helper
 *
 * Defaults target the production database `lending_library_live` on port 5433;
 * every value can be overridden from the environment (PGDATABASE, PGPORT, ...).
 */

const { Pool, types } = require('pg');

// ---------------------------------------------------------------------------
// Connection configuration (all env-overridable)
// ---------------------------------------------------------------------------
const config = {
  host: process.env.PGHOST || 'localhost',
  port: parseInt(process.env.PGPORT || '5433', 10),
  user: process.env.PGUSER || 'postgres',
  database: process.env.PGDATABASE || 'lending_library_live',
  password: process.env.PGPASSWORD || '',
};

// node-postgres returns NUMERIC (OID 1700) as strings to avoid precision
// loss. Every numeric column in this schema (fines, fees, percentages) fits
// comfortably in a JS number, so parse them once, globally, into numbers.
types.setTypeParser(1700, (value) => (value === null ? null : Number(value)));

const pool = new Pool(config);

// Never let an idle-client error take the whole process down.
pool.on('error', (err) => {
  console.error('[db] idle client error:', err.message);
});

// ---------------------------------------------------------------------------
// Query helpers
// ---------------------------------------------------------------------------

/** Run a parameterised query on the pool and return its rows. */
async function q(text, params) {
  const { rows } = await pool.query(text, params);
  return rows;
}

/** Null-safe coercion of a PostgreSQL NUMERIC-ish value to a JS number. */
function num(value) {
  return value === null || value === undefined ? null : Number(value);
}

/** Small promise-based sleep used by the serializable retry loop. */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run `fn(client)` inside a transaction on a dedicated client.
 *
 * @param {(client: import('pg').PoolClient) => Promise<any>} fn
 * @param {{isolation?: string}} [opts] e.g. { isolation: 'SERIALIZABLE' }
 *
 * When isolation is SERIALIZABLE a SQLSTATE 40001 (serialization failure)
 * aborts the transaction and the whole function is retried up to 3 times,
 * 100 ms apart - this is what makes concurrent checkouts safe.
 */
async function withTx(fn, { isolation } = {}) {
  const maxAttempts = isolation === 'SERIALIZABLE' ? 3 : 1;
  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const client = await pool.connect();
    try {
      await client.query(isolation ? `BEGIN ISOLATION LEVEL ${isolation}` : 'BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        /* the connection may already be broken - nothing more we can do */
      }
      lastError = err;
      const isRetryable = isolation === 'SERIALIZABLE' && err && err.code === '40001';
      if (isRetryable && attempt < maxAttempts) {
        console.warn(
          `[db] serialization failure (attempt ${attempt}/${maxAttempts}) - retrying in 100 ms`,
        );
        await sleep(100);
        continue;
      }
      throw err;
    } finally {
      client.release();
    }
  }

  throw lastError; // unreachable, keeps linters happy
}

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

/**
 * Translate a PostgreSQL error into { status, error, message } for the API.
 *
 * Business functions RAISE EXCEPTION with messages shaped like
 * "CODE_TEXT (details)" or "CODE_TEXT: details"; the leading UPPER_SNAKE
 * token becomes the machine-readable `error` code.
 */
function mapError(err) {
  const sqlstate = err && err.code;
  const raw = (err && err.message) || 'Unknown database error';

  switch (sqlstate) {
    case '23P01': // exclusion constraint violation
      return { status: 409, error: 'CONFLICT', message: raw };
    case '40001': // serialization failure
      return { status: 409, error: 'SERIALIZATION_FAILURE', message: raw };
    case '23505': // unique violation
      return { status: 409, error: 'DUPLICATE', message: raw };
    case '23514': // check constraint violation
    case '23502': // not-null violation
      return { status: 400, error: 'INVALID', message: raw };
    case '22P02': // invalid text representation
      return { status: 400, error: 'BAD_INPUT', message: raw };
    // Pragmatic extras beyond the contract: a broken foreign key reference is
    // a 404 and an unparsable date is a 400 rather than an opaque 500.
    case '23503':
      return { status: 404, error: 'REFERENCE_NOT_FOUND', message: raw };
    case '22007': // invalid datetime format
    case '22008': // datetime field overflow
      return { status: 400, error: 'BAD_INPUT', message: raw };
    default:
      break;
  }

  // RAISE EXCEPTION from the business functions (SQLSTATE P0001 or default).
  const match = /^([A-Z][A-Z0-9_]*)\b/.exec(raw);
  if (match) {
    const code = match[1];
    let status = 400;
    // The auth routes raise/verify INVALID_CREDENTIALS themselves; this keeps
    // the mapping consistent if the code ever bubbles up from the database.
    if (code === 'INVALID_CREDENTIALS') status = 401;
    else if (code.includes('NOT_FOUND')) status = 404;
    // ITEM_NOT_AVAILABLE describes a state conflict (the unit exists but is
    // busy), which is better reported as 409 than as malformed input.
    else if (code === 'ITEM_NOT_AVAILABLE') status = 409;

    const details = raw
      .slice(match[0].length)
      .replace(/^\s*[:(]\s*/, '')
      .replace(/\s*\)\s*$/, '')
      .trim();
    return { status, error: code, message: details || raw };
  }

  return { status: 500, error: 'INTERNAL', message: raw };
}

module.exports = { config, pool, q, withTx, mapError, num };
