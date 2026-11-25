'use strict';

/**
 * server.js - REST API for the LIVE Equipment Lending Library website
 * (college-wide, RVCE).
 *
 * Serves the JSON API under /api and the static frontend from ../frontend.
 *
 *   PGDATABASE=ll_live_dev PORT=3100 node server.js     (development)
 *   PGDATABASE=lending_library_live node server.js      (production)
 *
 * Auth model:
 *   - POST /api/auth/register and /api/auth/login hand out a bearer token.
 *   - Every other /api route (except /health, /departments, /events and the
 *     two auth entry points above) requires `Authorization: Bearer <token>`.
 *
 * Concurrency:
 *   - Reservation checkout and walk-in checkout run inside SERIALIZABLE
 *     transactions (db.withTx retries SQLSTATE 40001), so two simultaneous
 *     checkouts of the same unit can never both commit.
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const express = require('express');
const { Client: PgClient } = require('pg');
const { config, pool, q, withTx, mapError, num } = require('./db');
const {
  createSession,
  requireAuth,
  requireRole,
  verifyPassword,
  loadProfile,
} = require('./auth');

const PORT = parseInt(process.env.PORT || '3000', 10);

// The live website is college-wide. Staff manage only their own department's
// equipment; the administrator has no department restriction. Students of any
// branch may request equipment from any department.

const app = express();
const api = express.Router();

app.disable('x-powered-by');
app.use(express.json());

// ---------------------------------------------------------------------------
// Security headers + credential-endpoint rate limiting
// ---------------------------------------------------------------------------
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; " +
      "script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  );
  next();
});

/** Tiny in-memory limiter for /api/auth/login and /api/auth/register. */
const authAttempts = new Map();
function authRateLimit(maxAttempts, windowMs) {
  return (req, res, next) => {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    const rec = authAttempts.get(ip);
    if (!rec || now > rec.reset) {
      authAttempts.set(ip, { count: 1, reset: now + windowMs });
      return next();
    }
    rec.count += 1;
    if (rec.count > maxAttempts) {
      return res.status(429).json({
        status: 429,
        error: 'TOO_MANY_REQUESTS',
        message: 'Too many attempts. Please wait a few minutes and try again.',
      });
    }
    return next();
  };
}
app.use('/api/auth/login', authRateLimit(60, 10 * 60 * 1000));
app.use('/api/auth/register', authRateLimit(60, 10 * 60 * 1000));
setInterval(() => {
  const now = Date.now();
  for (const [ip, rec] of authAttempts) if (now > rec.reset) authAttempts.delete(ip);
}, 10 * 60 * 1000).unref();

// ---------------------------------------------------------------------------
// JSON request logger: one line per finished request
// ---------------------------------------------------------------------------
app.use((req, res, next) => {
  const startedAt = Date.now();
  res.on('finish', () => {
    console.log(
      JSON.stringify({
        ts: new Date().toISOString(),
        method: req.method,
        path: req.originalUrl,
        status: res.statusCode,
        ms: Date.now() - startedAt,
      }),
    );
  });
  next();
});

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** An error that already carries a complete HTTP response shape. */
class ApiError extends Error {
  constructor(status, error, message) {
    super(message);
    this.status = status;
    this.error = error;
  }
}

/** Throw a 400 unless every listed field is present and non-empty. */
function requireFields(body, fields) {
  for (const field of fields) {
    const value = body[field];
    if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) {
      throw new ApiError(400, 'INVALID', `Missing required field: ${field}`);
    }
  }
}

/** Epoch-ms value of a parseable date string, or a 400. */
function parseDate(value, field) {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw new ApiError(400, 'INVALID', `${field} must be a valid date/time`);
  return ms;
}

/** Optional positive integer query parameter (returns null when absent). */
function optionalPositiveInt(value, field) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new ApiError(400, 'INVALID', `${field} must be a positive integer`);
  return n;
}

/** True for the administrator (unrestricted across departments). */
function isAdmin(req) {
  return Boolean(req.user && req.user.role === 'ADMIN');
}

/** The department id of the signed-in staff member (null for students). */
function staffDeptId(req) {
  return req.user && req.user.staff_dept_id ? Number(req.user.staff_dept_id) : null;
}

/**
 * Department scoping: a faculty member may only manage/issue their own
 * department's equipment. The administrator is exempt.
 */
function assertOwnDept(req, deptId, action) {
  if (isAdmin(req)) return;
  const own = staffDeptId(req);
  if (own === null || Number(deptId) !== own) {
    throw new ApiError(
      403,
      'DEPT_FORBIDDEN',
      `You can only ${action || 'manage'} equipment belonging to your own department`,
    );
  }
}

/** Department that owns the model requested by a lending request. */
async function deptOfRequest(requestId) {
  const rows = await q(
    `SELECT e.dept_id, d.dept_name
       FROM lending_request r
       JOIN equipment e  ON e.model_id = r.model_id
       LEFT JOIN department d ON d.dept_id = e.dept_id
      WHERE r.request_id = $1::int`,
    [requestId],
  );
  return rows[0] || null;
}

/** Department that owns a serialized item. */
async function deptOfItem(itemId) {
  const rows = await q(
    `SELECT e.dept_id, d.dept_name
       FROM item i
       JOIN equipment e  ON e.model_id = i.model_id
       LEFT JOIN department d ON d.dept_id = e.dept_id
      WHERE i.item_id = $1::int`,
    [itemId],
  );
  return rows[0] || null;
}

/** Department that owns the item behind a reservation. */
async function deptOfReservation(reservationId) {
  const rows = await q(
    `SELECT e.dept_id, d.dept_name
       FROM reservation r
       JOIN item i       ON i.item_id  = r.item_id
       JOIN equipment e  ON e.model_id = i.model_id
       LEFT JOIN department d ON d.dept_id = e.dept_id
      WHERE r.reservation_id = $1::int`,
    [reservationId],
  );
  return rows[0] || null;
}

/** Department that owns the item behind a loan. */
async function deptOfLoan(loanId) {
  const rows = await q(
    `SELECT e.dept_id, d.dept_name
       FROM loan l
       JOIN item i       ON i.item_id  = l.item_id
       JOIN equipment e  ON e.model_id = i.model_id
       LEFT JOIN department d ON d.dept_id = e.dept_id
      WHERE l.loan_id = $1::int`,
    [loanId],
  );
  return rows[0] || null;
}

/** Parse an optional positive integer query/body value (null when absent). */
function optionalPositiveInt(value, field) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new ApiError(400, 'INVALID', `${field} must be a positive integer`);
  }
  return parsed;
}

// Route middleware groups.
const STUDENT_ONLY = [requireAuth, requireRole('STUDENT')];
const FACULTY_ONLY = [requireAuth, requireRole('FACULTY')];

// ===========================================================================
// Server-Sent Events - live availability updates
// ===========================================================================

/** Connected SSE responses ("the broadcast list"). */
const sseClients = new Set();

/** Write one SSE frame to every connected client. */
function broadcast(event, data) {
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    if (!res.writableEnded) res.write(frame);
  }
}

/** Keep-alive comment so proxies/browsers do not drop idle streams. */
setInterval(() => {
  for (const res of sseClients) {
    if (!res.writableEnded) res.write(': ping\n\n');
  }
}, 25000).unref();

/** One dedicated long-lived LISTEN client (never taken from the pool). */
let listener = null;
let listenerRetryTimer = null;

/** Look up the notified item and push its fresh v_availability row. */
async function onNotification(msg) {
  if (msg.channel !== 'availability') return;
  try {
    const rows = await q('SELECT * FROM v_availability WHERE item_id = $1::int', [msg.payload]);
    if (rows.length > 0) broadcast('availability', rows[0]);
  } catch (err) {
    console.error('[sse] availability lookup failed:', err.message);
  }
}

/** Retry the LISTEN connection 5 s from now (idempotent). */
function scheduleListenerRetry() {
  if (listenerRetryTimer) return;
  listenerRetryTimer = setTimeout(() => {
    listenerRetryTimer = null;
    connectListener().catch((err) => {
      console.error('[sse] listener reconnect failed:', err.message);
      scheduleListenerRetry();
    });
  }, 5000);
  listenerRetryTimer.unref();
}

/** Connect (or re-connect) the dedicated LISTEN client. */
async function connectListener() {
  if (listener) return;

  const client = new PgClient(config);

  client.on('notification', onNotification);
  client.on('error', (err) => {
    console.error('[sse] listener error:', err.message);
    if (listener === client) listener = null;
    client.end().catch(() => {});
    scheduleListenerRetry();
  });
  client.on('end', () => {
    if (listener === client) {
      listener = null;
      console.warn('[sse] listener disconnected - retrying in 5 s');
      scheduleListenerRetry();
    }
  });

  try {
    await client.connect();
    await client.query('LISTEN availability');
  } catch (err) {
    try {
      await client.end();
    } catch {
      /* ignore */
    }
    throw err;
  }

  listener = client;
  console.log('[sse] listening on channel "availability"');
}

// ===========================================================================
// Public routes
// ===========================================================================

// --- health -----------------------------------------------------------------
api.get('/health', async (req, res) => {
  try {
    const rows = await q('SELECT now() AS now');
    res.json({ ok: true, db: 'up', now: rows[0].now });
  } catch (err) {
    res.status(503).json({ ok: false, db: 'down', message: err.message });
  }
});

// --- departments (register page) -------------------------------------------
api.get('/departments', async (req, res, next) => {
  try {
    res.json(await q('SELECT dept_id, dept_name, branch_code FROM department ORDER BY dept_id'));
  } catch (err) {
    next(err);
  }
});

// --- registration -------------------------------------------------------------
api.post('/auth/register', async (req, res, next) => {
  try {
    const body = req.body || {};
    requireFields(body, ['full_name', 'usn', 'email', 'dept_id', 'password', 'confirm_password']);

    const fullName = String(body.full_name).trim();
    const usn = String(body.usn).trim().toUpperCase();
    const email = String(body.email).trim().toLowerCase();
    const password = String(body.password);
    const confirm = String(body.confirm_password);

    if (!/^[0-9][A-Z]{2}[0-9]{2}[A-Z]{2}[0-9]{3}$/.test(usn)) {
      throw new ApiError(400, 'INVALID_USN', 'USN must look like 1RV24IS001');
    }

    // College-wide RVCE email structure: full name (no dots) + .<branch><YY>
    // where branch and batch must match the selected department and the USN
    // (e.g. 1RV24IS057 -> karthikanupr.is24@rvce.edu.in, department ISE).
    const deptId = Number(body.dept_id);
    if (!Number.isInteger(deptId) || deptId <= 0) {
      throw new ApiError(400, 'INVALID_DEPARTMENT', 'Select your department');
    }
    const deptRows = await q(
      'SELECT dept_id, dept_name, branch_code FROM department WHERE dept_id = $1::int',
      [deptId],
    );
    if (deptRows.length === 0 || !deptRows[0].branch_code) {
      throw new ApiError(400, 'INVALID_DEPARTMENT', 'Unknown department');
    }
    const branch = String(deptRows[0].branch_code).toUpperCase();
    const usnBranch = usn.slice(5, 7);
    const batch = usn.slice(3, 5);
    if (usnBranch !== branch) {
      throw new ApiError(
        400,
        'USN_BRANCH_MISMATCH',
        `USN branch ${usnBranch} does not match ${deptRows[0].dept_name} (${branch})`,
      );
    }

    const emailMatch = /^[a-z0-9]+\.([a-z]{2})(\d{2})@rvce\.edu\.in$/.exec(email);
    if (!emailMatch) {
      throw new ApiError(
        400,
        'INVALID_EMAIL',
        'Use your college email: fullname.<branch><YY>@rvce.edu.in (no dots in the name, e.g. karthikanupr.is24)',
      );
    }
    if (emailMatch[1].toUpperCase() !== branch) {
      throw new ApiError(
        400,
        'EMAIL_BRANCH_MISMATCH',
        `Email branch .${emailMatch[1]} does not match ${branch}`,
      );
    }
    if (emailMatch[2] !== batch) {
      throw new ApiError(
        400,
        'EMAIL_USN_MISMATCH',
        `Email batch .${emailMatch[1]}${emailMatch[2]} does not match the USN batch ${batch}`,
      );
    }
    if (password.length < 8) {
      throw new ApiError(400, 'WEAK_PASSWORD', 'Password must be at least 8 characters');
    }
    if (password !== confirm) {
      throw new ApiError(400, 'PASSWORD_MISMATCH', 'confirm_password must match password');
    }

    // Duplicate checks (case-insensitive email; USN is the student PK).
    const emailTaken = await q(
      `SELECT 1 FROM student WHERE lower(email) = $1
       UNION ALL
       SELECT 1 FROM app_user WHERE lower(email) = $1
       LIMIT 1`,
      [email],
    );
    if (emailTaken.length > 0) {
      throw new ApiError(409, 'EMAIL_TAKEN', 'This email is already registered');
    }
    const usnTaken = await q('SELECT 1 FROM student WHERE student_id = $1::char(10)', [usn]);
    if (usnTaken.length > 0) {
      throw new ApiError(409, 'USN_TAKEN', 'This USN is already registered');
    }

    // One transaction: student row + login account + first session.
    const result = await withTx(async (client) => {
      await client.query(
        `INSERT INTO student (student_id, full_name, semester, email, dept_id)
         VALUES ($1::char(10), $2, NULL, $3, $4::int)`,
        [usn, fullName, email, deptId],
      );
      const inserted = await client.query(
        `INSERT INTO app_user (email, password_hash, role, student_id)
         VALUES ($1, crypt($2, gen_salt('bf', 10)), 'STUDENT', $3::char(10))
         RETURNING user_id`,
        [email, password, usn],
      );
      const token = await createSession(inserted.rows[0].user_id, client);
      const user = await loadProfile(inserted.rows[0].user_id, client);
      return { token, user };
    });

    res.status(201).json(result);
  } catch (err) {
    // A concurrent duplicate can still slip past the pre-checks; give the
    // same machine-readable codes as the explicit validations above.
    if (err && err.code === '23505') {
      const constraint = String(err.constraint || '');
      if (constraint.includes('email')) {
        return next(new ApiError(409, 'EMAIL_TAKEN', 'This email is already registered'));
      }
      if (constraint.includes('pkey')) {
        return next(new ApiError(409, 'USN_TAKEN', 'This USN is already registered'));
      }
    }
    next(err);
  }
});

// --- login ---------------------------------------------------------------------
api.post('/auth/login', async (req, res, next) => {
  try {
    const body = req.body || {};
    requireFields(body, ['email', 'password']);

    const account = await verifyPassword(String(body.email).trim(), String(body.password));
    if (!account) {
      throw new ApiError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
    }

    // housekeeping: drop expired sessions while we are here
    await q('DELETE FROM app_session WHERE expires_at < now()');

    await q('UPDATE app_user SET last_login = now() WHERE user_id = $1', [account.user_id]);
    const token = await createSession(account.user_id);
    const user = await loadProfile(account.user_id);
    res.json({ token, user });
  } catch (err) {
    next(err);
  }
});

// --- SSE stream (public) --------------------------------------------------------
api.get('/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n'); // client reconnects after 3 s

  sseClients.add(res);
  req.on('close', () => {
    sseClients.delete(res);
  });
});

// ===========================================================================
// Session routes (any authenticated role)
// ===========================================================================

// --- fresh profile ---------------------------------------------------------------
api.get('/auth/me', requireAuth, async (req, res, next) => {
  try {
    const user = await loadProfile(req.user.user_id);
    if (!user) {
      return res.status(401).json({ status: 401, error: 'UNAUTHORIZED', message: 'Login required' });
    }
    res.json({ user });
  } catch (err) {
    next(err);
  }
});

// --- logout (deletes only this session) ------------------------------------------
api.post('/auth/logout', requireAuth, async (req, res, next) => {
  try {
    await q('DELETE FROM app_session WHERE token_hash = $1', [req.tokenHash]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// --- password change (keeps the current session, drops the others) ---------------
api.post('/auth/password', requireAuth, async (req, res, next) => {
  try {
    const body = req.body || {};
    requireFields(body, ['current_password', 'new_password']);

    const current = String(body.current_password);
    const newPassword = String(body.new_password);
    if (newPassword.length < 8) {
      throw new ApiError(400, 'WEAK_PASSWORD', 'Password must be at least 8 characters');
    }
    if (newPassword === current) {
      throw new ApiError(400, 'INVALID', 'New password must be different from the current password');
    }

    await withTx(async (client) => {
      const verified = await client.query(
        `SELECT 1 FROM app_user
          WHERE user_id = $1 AND password_hash = crypt($2, password_hash)`,
        [req.user.user_id, current],
      );
      if (verified.rows.length === 0) {
        throw new ApiError(401, 'INVALID_CREDENTIALS', 'Current password is incorrect');
      }
      await client.query(
        `UPDATE app_user SET password_hash = crypt($2, gen_salt('bf', 10)) WHERE user_id = $1`,
        [req.user.user_id, newPassword],
      );
      await client.query('DELETE FROM app_session WHERE user_id = $1 AND token_hash <> $2', [
        req.user.user_id,
        req.tokenHash,
      ]);
    });

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ===========================================================================
// Labs + catalog (any authenticated role)
// ===========================================================================

// --- lab overview (every lab, even when it holds no items) ----------------------
api.get('/labs', requireAuth, async (req, res, next) => {
  try {
    const deptId = optionalPositiveInt(req.query.dept_id, 'dept_id');
    res.json(
      await q(
        `SELECT l.lab_id, l.lab_name, l.location,
                l.dept_id, d.dept_name, d.branch_code,
                count(v.item_id)::int                                            AS total_items,
                count(v.item_id) FILTER (WHERE v.availability = 'AVAILABLE')::int   AS available_items,
                count(v.item_id) FILTER (WHERE v.availability = 'ON_LOAN')::int     AS on_loan_items,
                count(v.item_id) FILTER (WHERE v.availability = 'MAINTENANCE')::int AS maintenance_items,
                count(v.item_id) FILTER (WHERE v.availability IN ('RETIRED','LOST'))::int AS retired_items
           FROM lab l
           JOIN department d ON d.dept_id = l.dept_id
           LEFT JOIN v_lab_items v ON v.lab_id = l.lab_id
          WHERE ($1::int IS NULL OR l.dept_id = $1::int)
          GROUP BY l.lab_id, l.lab_name, l.location, l.dept_id, d.dept_name, d.branch_code
          ORDER BY d.dept_name, l.lab_name`,
        [deptId],
      ),
    );
  } catch (err) {
    next(err);
  }
});

// --- catalog (only models that have lab-assigned items) --------------------------
api.get('/catalog', requireAuth, async (req, res, next) => {
  try {
    const labId = optionalPositiveInt(req.query.lab_id, 'lab_id');
    const deptId = optionalPositiveInt(req.query.dept_id, 'dept_id');
    res.json(
      await q(
        `SELECT e.model_id, e.model_name, e.manufacturer, e.description,
                e.dept_id, d.dept_name, d.branch_code,
                c.category_name, c.max_loan_days, c.late_fee_per_day,
                count(v.item_id)::int                                              AS total_items,
                count(v.item_id) FILTER (WHERE v.availability = 'AVAILABLE')::int AS available_items,
                count(v.item_id) FILTER (WHERE v.availability = 'ON_LOAN')::int   AS on_loan_items,
                min(v.next_free_ts) FILTER (WHERE v.availability NOT IN ('RETIRED','LOST'))
                                                                                   AS next_free_ts
           FROM equipment e
           JOIN category c   ON c.category_id = e.category_id
           JOIN department d ON d.dept_id     = e.dept_id
           LEFT JOIN v_lab_items v
                  ON v.model_id = e.model_id
                 AND ($1::int IS NULL OR v.lab_id = $1::int)
                 AND ($2::int IS NULL OR v.dept_id = $2::int)
          WHERE ($2::int IS NULL OR e.dept_id = $2::int)
          GROUP BY e.model_id, e.model_name, e.manufacturer, e.description,
                   e.dept_id, d.dept_name, d.branch_code,
                   c.category_name, c.max_loan_days, c.late_fee_per_day
         HAVING count(v.item_id) > 0
          ORDER BY d.dept_name, c.category_name, e.model_name`,
        [labId, deptId],
      ),
    );
  } catch (err) {
    next(err);
  }
});

// --- serialized units of one model ------------------------------------------------
api.get('/catalog/:modelId/items', requireAuth, async (req, res, next) => {
  try {
    const { modelId } = req.params;
    const model = await q('SELECT 1 FROM equipment WHERE model_id = $1::int', [modelId]);
    if (model.length === 0) {
      throw new ApiError(404, 'MODEL_NOT_FOUND', `No equipment model with id ${modelId}`);
    }
    res.json(
      await q(
        `SELECT item_id, serial_no, item_condition, availability, next_free_ts,
                lab_id, lab_name, dept_name, last_updated
           FROM v_lab_items
          WHERE model_id = $1::int
          ORDER BY item_id`,
        [modelId],
      ),
    );
  } catch (err) {
    next(err);
  }
});

// --- per-item booking calendar -----------------------------------------------------
api.get('/items/:itemId/calendar', requireAuth, async (req, res, next) => {
  try {
    const { itemId } = req.params;
    const days = req.query.days === undefined ? 14 : Number(req.query.days);
    if (!Number.isFinite(days) || days <= 0) {
      throw new ApiError(400, 'INVALID', 'days must be a positive number');
    }

    const items = await q('SELECT * FROM v_lab_items WHERE item_id = $1::int', [itemId]);
    if (items.length === 0) {
      throw new ApiError(404, 'ITEM_NOT_FOUND', `No item with id ${itemId}`);
    }

    const events = await q(
      `SELECT kind, ref_id, start_ts, end_ts, status
         FROM v_calendar
        WHERE item_id = $1::int
          AND end_ts   >= now() - interval '2 days'
          AND start_ts <= now() + make_interval(days => $2::int)
        ORDER BY start_ts`,
      [itemId, Math.floor(days)],
    );

    res.json({ item: items[0], events });
  } catch (err) {
    next(err);
  }
});

// --- categories (for the add-model form) -------------------------------------------
api.get('/categories', requireAuth, async (req, res, next) => {
  try {
    res.json(
      await q(
        `SELECT category_id, category_name, max_loan_days, late_fee_per_day
           FROM category
          ORDER BY category_id`,
      ),
    );
  } catch (err) {
    next(err);
  }
});

// ===========================================================================
// Student self-service
// ===========================================================================

// --- my loans (current by default, or full history) --------------------------------
api.get('/me/loans', STUDENT_ONLY, async (req, res, next) => {
  try {
    const scope = String(req.query.scope || 'current').toLowerCase();
    if (scope !== 'current' && scope !== 'history') {
      throw new ApiError(400, 'INVALID', "scope must be 'current' or 'history'");
    }
    const filter = scope === 'current' ? 'returned_at IS NULL' : 'returned_at IS NOT NULL';
    res.json(
      await q(
        `SELECT * FROM v_student_loans
          WHERE student_id = $1::char(10) AND ${filter}
          ORDER BY checkout_at DESC, loan_id DESC`,
        [req.user.student_id],
      ),
    );
  } catch (err) {
    next(err);
  }
});

// --- ask the lab counter to take a loan back ----------------------------------------
api.post('/me/loans/:id/request-return', STUDENT_ONLY, async (req, res, next) => {
  try {
    const body = req.body || {};
    const note =
      body.note === undefined || body.note === null || String(body.note).trim() === ''
        ? null
        : String(body.note).trim();

    const updated = await withTx(async (client) => {
      const called = await client.query('SELECT * FROM request_return($1::int, $2::char(10))', [
        req.params.id,
        req.user.student_id,
      ]);
      if (called.rows.length === 0) {
        throw new ApiError(404, 'LOAN_NOT_FOUND', `No loan with id ${req.params.id}`);
      }
      if (note !== null) {
        await client.query('UPDATE loan SET return_request_note = $1 WHERE loan_id = $2::int', [
          note,
          req.params.id,
        ]);
      }
      const rows = await client.query('SELECT * FROM v_student_loans WHERE loan_id = $1::int', [
        req.params.id,
      ]);
      return rows.rows[0];
    });

    res.json(updated);
  } catch (err) {
    next(err);
  }
});

// --- withdraw a return request ------------------------------------------------------
api.post('/me/loans/:id/cancel-return', STUDENT_ONLY, async (req, res, next) => {
  try {
    const updated = await withTx(async (client) => {
      const called = await client.query('SELECT * FROM cancel_return_request($1::int, $2::char(10))', [
        req.params.id,
        req.user.student_id,
      ]);
      if (called.rows.length === 0) {
        throw new ApiError(404, 'LOAN_NOT_FOUND', `No loan with id ${req.params.id}`);
      }
      const rows = await client.query('SELECT * FROM v_student_loans WHERE loan_id = $1::int', [
        req.params.id,
      ]);
      return rows.rows[0];
    });

    res.json(updated);
  } catch (err) {
    next(err);
  }
});

// --- my lending requests -------------------------------------------------------------
const MY_REQUEST_COLUMNS = `
  r.request_id, r.model_id, e.model_name, r.purpose, r.submitted_on,
  r.requested_start, r.requested_end, r.request_status, r.remarks`;

api.get('/me/requests', STUDENT_ONLY, async (req, res, next) => {
  try {
    res.json(
      await q(
        `SELECT ${MY_REQUEST_COLUMNS}
           FROM lending_request r
           JOIN equipment e ON e.model_id = r.model_id
          WHERE r.student_id = $1::char(10)
          ORDER BY r.submitted_on DESC, r.request_id DESC`,
        [req.user.student_id],
      ),
    );
  } catch (err) {
    next(err);
  }
});

api.post('/me/requests', STUDENT_ONLY, async (req, res, next) => {
  try {
    const body = req.body || {};
    requireFields(body, ['model_id', 'purpose', 'requested_start', 'requested_end']);

    const purpose = String(body.purpose).trim();
    if (purpose.length < 10) throw new ApiError(400, 'INVALID', 'purpose must be at least 10 characters');
    if (purpose.length > 1000) throw new ApiError(400, 'INVALID', 'purpose must be at most 1000 characters');

    const startMs = parseDate(body.requested_start, 'requested_start');
    const endMs = parseDate(body.requested_end, 'requested_end');
    if (endMs <= startMs) throw new ApiError(400, 'INVALID', 'requested_end must be after requested_start');

    const modelId = optionalPositiveInt(body.model_id, 'model_id');
    if (modelId === null) throw new ApiError(400, 'INVALID', 'Missing required field: model_id');
    const model = await q('SELECT 1 FROM equipment WHERE model_id = $1::int', [modelId]);
    if (model.length === 0) {
      throw new ApiError(404, 'MODEL_NOT_FOUND', `No equipment model with id ${modelId}`);
    }

    const created = await withTx(async (client) => {
      const inserted = await client.query(
        `INSERT INTO lending_request (student_id, model_id, purpose, requested_start, requested_end, remarks)
         VALUES ($1::char(10), $2::int, $3, $4::timestamptz, $5::timestamptz, $6)
         RETURNING request_id`,
        [
          req.user.student_id,
          modelId,
          purpose,
          body.requested_start,
          body.requested_end,
          body.remarks ?? null,
        ],
      );
      const rows = await client.query(
        `SELECT ${MY_REQUEST_COLUMNS}
           FROM lending_request r
           JOIN equipment e ON e.model_id = r.model_id
          WHERE r.request_id = $1::int`,
        [inserted.rows[0].request_id],
      );
      return rows.rows[0];
    });

    res.status(201).json(created);
  } catch (err) {
    next(err);
  }
});

// ===========================================================================
// Faculty operations
// ===========================================================================

// --- all lending requests (with student + model context) ----------------------------
api.get('/requests', FACULTY_ONLY, async (req, res, next) => {
  try {
    const status = req.query.status ? String(req.query.status) : null;
    const studentId = req.query.student_id ? String(req.query.student_id) : null;
    const scopeDept = isAdmin(req) ? null : staffDeptId(req);
    res.json(
      await q(
        `SELECT r.request_id, r.student_id, s.student_id AS usn,
                s.full_name, s.semester, d.dept_name,
                r.model_id, e.model_name, e.dept_id, ed.dept_name AS model_dept_name,
                r.purpose, r.submitted_on, r.requested_start, r.requested_end,
                r.request_status, r.remarks
           FROM lending_request r
           JOIN student s    ON s.student_id = r.student_id
           JOIN department d ON d.dept_id    = s.dept_id
           JOIN equipment e  ON e.model_id   = r.model_id
           LEFT JOIN department ed ON ed.dept_id = e.dept_id
          WHERE ($1::text IS NULL OR r.request_status = $1)
            AND ($2::text IS NULL OR r.student_id    = $2)
            AND ($3::int IS NULL OR e.dept_id = $3::int)
          ORDER BY r.submitted_on DESC, r.request_id DESC`,
        [status, studentId, scopeDept],
      ),
    );
  } catch (err) {
    next(err);
  }
});

// --- approve (auto-reserve, or join the FIFO queue) ----------------------------------
api.post('/requests/:id/approve', FACULTY_ONLY, async (req, res, next) => {
  try {
    const body = req.body || {};
    const requestInfo = await deptOfRequest(req.params.id);
    if (!requestInfo) {
      throw new ApiError(404, 'REQUEST_NOT_FOUND', `No request with id ${req.params.id}`);
    }
    assertOwnDept(req, requestInfo.dept_id, 'approve requests for');
    const itemId = optionalPositiveInt(body.item_id, 'item_id');
    const rows = await q('SELECT approve_request($1::int, $2::int, $3::int) AS result', [
      req.params.id,
      req.user.staff_id,
      itemId,
    ]);
    res.json(rows[0].result); // jsonb: { outcome: 'RESERVED' | 'QUEUED', ... }
  } catch (err) {
    next(err);
  }
});

// --- reject ---------------------------------------------------------------------------
api.post('/requests/:id/reject', FACULTY_ONLY, async (req, res, next) => {
  try {
    const body = req.body || {};
    const requestInfo = await deptOfRequest(req.params.id);
    if (!requestInfo) {
      throw new ApiError(404, 'REQUEST_NOT_FOUND', `No request with id ${req.params.id}`);
    }
    assertOwnDept(req, requestInfo.dept_id, 'reject requests for');
    await q('SELECT reject_request($1::int, $2::int, $3::text)', [
      req.params.id,
      req.user.staff_id,
      body.note ?? null,
    ]);
    res.json({ ok: true, request_id: Number(req.params.id) });
  } catch (err) {
    next(err);
  }
});

// --- reservations (HELD by default, ALL for the full history) -------------------------
api.get('/reservations', FACULTY_ONLY, async (req, res, next) => {
  try {
    const status = String(req.query.status || 'HELD').toUpperCase();
    const noFilter = status === 'ALL';
    const scopeDept = isAdmin(req) ? null : staffDeptId(req);
    res.json(
      await q(
        `SELECT r.reservation_id, r.request_id, r.item_id, i.serial_no, e.model_name,
                e.dept_id, dep.dept_name,
                s.student_id, s.full_name,
                lower(r.reserved_period) AS start_ts,
                upper(r.reserved_period) AS end_ts,
                r.status, r.hold_expires_at,
                l.lab_id, l.lab_name
           FROM reservation r
           JOIN item i             ON i.item_id     = r.item_id
           JOIN equipment e        ON e.model_id    = i.model_id
           LEFT JOIN department dep ON dep.dept_id  = e.dept_id
           JOIN lending_request lr ON lr.request_id = r.request_id
           JOIN student s          ON s.student_id  = lr.student_id
           LEFT JOIN lab l         ON l.lab_id      = i.lab_id
          WHERE ($1::text IS NULL OR r.status = $1)
            AND ($2::int IS NULL OR e.dept_id = $2::int)
          ORDER BY start_ts`,
        [noFilter ? null : status, scopeDept],
      ),
    );
  } catch (err) {
    next(err);
  }
});

// --- hand a held reservation over the counter ------------------------------------------
api.post('/reservations/:id/checkout', FACULTY_ONLY, async (req, res, next) => {
  try {
    const reservationInfo = await deptOfReservation(req.params.id);
    if (!reservationInfo) {
      throw new ApiError(404, 'RESERVATION_NOT_FOUND', `No reservation with id ${req.params.id}`);
    }
    assertOwnDept(req, reservationInfo.dept_id, 'check out');

    // SERIALIZABLE + automatic retry on 40001: the DB-level guarantee that
    // two concurrent checkouts of the same unit cannot both commit.
    const rows = await withTx(
      async (client) => {
        const result = await client.query('SELECT checkout($1::int, $2::int) AS loan_id', [
          req.params.id,
          req.user.staff_id,
        ]);
        return result.rows;
      },
      { isolation: 'SERIALIZABLE' },
    );

    res.json({ loan_id: rows[0].loan_id });
  } catch (err) {
    next(err);
  }
});

// --- walk-in checkout (no reservation) ----------------------------------------------------
api.post('/checkout/walkin', FACULTY_ONLY, async (req, res, next) => {
  try {
    const body = req.body || {};
    requireFields(body, ['student_id', 'item_id']);

    const itemInfo = await deptOfItem(body.item_id);
    if (!itemInfo) {
      throw new ApiError(404, 'ITEM_NOT_FOUND', `No item with id ${body.item_id}`);
    }
    assertOwnDept(req, itemInfo.dept_id, 'check out');

    const rows = await withTx(
      async (client) => {
        const result = await client.query(
          'SELECT checkout_walkin($1::char(10), $2::int, $3::int) AS loan_id',
          [String(body.student_id).trim(), body.item_id, req.user.staff_id],
        );
        return result.rows;
      },
      { isolation: 'SERIALIZABLE' },
    );

    res.json({ loan_id: rows[0].loan_id });
  } catch (err) {
    next(err);
  }
});

// --- loans (all students) with status / student / lab filters -----------------------------
const LOAN_FILTERS = {
  active: 'returned_at IS NULL',
  overdue: 'returned_at IS NULL AND now() > due_date',
  returned: 'returned_at IS NOT NULL',
  all: 'TRUE',
};

api.get('/loans', FACULTY_ONLY, async (req, res, next) => {
  try {
    const status = String(req.query.status || 'active').toLowerCase();
    const filter = LOAN_FILTERS[status];
    if (!filter) {
      throw new ApiError(400, 'INVALID', `status must be one of: ${Object.keys(LOAN_FILTERS).join(', ')}`);
    }
    const studentId = req.query.student_id ? String(req.query.student_id) : null;
    const labId = optionalPositiveInt(req.query.lab_id, 'lab_id');
    const scopeDept = isAdmin(req) ? null : staffDeptId(req);

    res.json(
      await q(
        `SELECT * FROM v_student_loans
          WHERE ${filter}
            AND ($1::text IS NULL OR student_id = $1)
            AND ($2::int  IS NULL OR lab_id     = $2::int)
            AND ($3::int  IS NULL OR dept_id    = $3::int)
          ORDER BY checkout_at DESC, loan_id DESC`,
        [studentId, labId, scopeDept],
      ),
    );
  } catch (err) {
    next(err);
  }
});

// --- accept a return over the counter ------------------------------------------------------
api.post('/loans/:id/return', FACULTY_ONLY, async (req, res, next) => {
  try {
    const body = req.body || {};
    if (body.condition === undefined || body.condition === null) {
      throw new ApiError(400, 'INVALID', 'condition is required');
    }
    const condition = String(body.condition).toUpperCase();
    if (!['NEW', 'GOOD', 'FAIR', 'DAMAGED'].includes(condition)) {
      throw new ApiError(400, 'INVALID', 'condition must be one of NEW, GOOD, FAIR, DAMAGED');
    }

    const loanInfo = await deptOfLoan(req.params.id);
    if (!loanInfo) {
      throw new ApiError(404, 'LOAN_NOT_FOUND', `No loan with id ${req.params.id}`);
    }
    assertOwnDept(req, loanInfo.dept_id, 'accept returns for');

    // NOTE: `SELECT * FROM return_item(...)` - the set-returning form calls the
    // function exactly once. `SELECT (return_item(...)).*` would evaluate the
    // volatile function once per output column, so the second evaluation would
    // observe the update made by the first and raise LOAN_ALREADY_RETURNED.
    const rows = await q('SELECT * FROM return_item($1::int, $2::varchar, $3::int)', [
      req.params.id,
      condition,
      req.user.staff_id,
    ]);
    res.json(rows[0]); // updated loan row, fine_amount already a JS number
  } catch (err) {
    next(err);
  }
});

// --- student directory (walk-in counter search) ---------------------------------------------
api.get('/students', FACULTY_ONLY, async (req, res, next) => {
  try {
    const search = req.query.q ? String(req.query.q).trim() : null;
    res.json(
      await q(
        `SELECT s.student_id, s.full_name, s.email, s.semester, d.dept_name,
                count(l.loan_id) FILTER (WHERE l.returned_at IS NULL)::int AS active_loans
           FROM student s
           JOIN department d ON d.dept_id = s.dept_id
           LEFT JOIN loan l  ON l.student_id = s.student_id
          WHERE $1::text IS NULL
             OR s.student_id ILIKE '%' || $1 || '%'
             OR s.full_name  ILIKE '%' || $1 || '%'
             OR s.email      ILIKE '%' || $1 || '%'
          GROUP BY s.student_id, s.full_name, s.email, s.semester, d.dept_name
          ORDER BY s.student_id`,
        [search === '' ? null : search],
      ),
    );
  } catch (err) {
    next(err);
  }
});

// --- one student's full loan picture ----------------------------------------------------------
api.get('/students/:id/summary', FACULTY_ONLY, async (req, res, next) => {
  try {
    const students = await q(
      `SELECT s.student_id, s.full_name, s.email, s.semester,
              s.dept_id, d.dept_name
         FROM student s
         JOIN department d ON d.dept_id = s.dept_id
        WHERE s.student_id = $1::char(10)`,
      [req.params.id],
    );
    if (students.length === 0) {
      throw new ApiError(404, 'STUDENT_NOT_FOUND', `No student with id ${req.params.id}`);
    }

    const loans = await q(
      `SELECT * FROM v_student_loans
        WHERE student_id = $1::char(10)
          AND ($2::int IS NULL OR dept_id = $2::int)
        ORDER BY checkout_at DESC, loan_id DESC`,
      [req.params.id, isAdmin(req) ? null : staffDeptId(req)],
    );

    res.json({
      student: students[0],
      current_loans: loans.filter((loan) => loan.returned_at === null),
      history_loans: loans.filter((loan) => loan.returned_at !== null),
    });
  } catch (err) {
    next(err);
  }
});

// --- FIFO hold queue ---------------------------------------------------------------------------
api.get('/queue', FACULTY_ONLY, async (req, res, next) => {
  try {
    const scopeDept = isAdmin(req) ? null : staffDeptId(req);
    res.json(
      await q(
        `SELECT qb.*
           FROM v_queue_board qb
           JOIN item i      ON i.item_id  = qb.item_id
           JOIN equipment e ON e.model_id = i.model_id
          WHERE ($1::int IS NULL OR e.dept_id = $1::int)
          ORDER BY qb.item_id, qb.ticket_no`,
        [scopeDept],
      ),
    );
  } catch (err) {
    next(err);
  }
});

api.post('/queue/tick', FACULTY_ONLY, async (req, res, next) => {
  try {
    const body = req.body || {};
    let holdHours = null;
    if (body.hold_hours !== undefined && body.hold_hours !== null && body.hold_hours !== '') {
      holdHours = Number(body.hold_hours);
      if (!Number.isFinite(holdHours) || holdHours <= 0) {
        throw new ApiError(400, 'INVALID', 'hold_hours must be a positive number');
      }
    }
    const offers = await q('SELECT * FROM queue_tick($1::numeric)', [holdHours]);
    res.json({ offers });
  } catch (err) {
    next(err);
  }
});

// --- maintenance blocks --------------------------------------------------------------------------
api.get('/maintenance', FACULTY_ONLY, async (req, res, next) => {
  try {
    const status = String(req.query.status || 'active').toLowerCase();
    if (status !== 'active' && status !== 'all') {
      throw new ApiError(400, 'INVALID', "status must be 'active' or 'all'");
    }
    const scopeDept = isAdmin(req) ? null : staffDeptId(req);
    res.json(
      await q(
        `SELECT mb.block_id, mb.item_id, i.serial_no, e.model_name, mb.reason,
                e.dept_id, dep.dept_name,
                lower(mb.blocked_range) AS start_ts,
                upper(mb.blocked_range) AS end_ts,
                mb.status,
                st.staff_name AS authorized_by,
                l.lab_id, l.lab_name
           FROM maintenance_block mb
           JOIN item i      ON i.item_id   = mb.item_id
           JOIN equipment e ON e.model_id  = i.model_id
           LEFT JOIN department dep ON dep.dept_id = e.dept_id
           JOIN staff st    ON st.staff_id = mb.authorized_by
           LEFT JOIN lab l  ON l.lab_id    = i.lab_id
          WHERE ($1::text = 'all' OR mb.status = 'ACTIVE')
            AND ($2::int IS NULL OR e.dept_id = $2::int)
          ORDER BY start_ts DESC`,
        [status, scopeDept],
      ),
    );
  } catch (err) {
    next(err);
  }
});

api.post('/maintenance', FACULTY_ONLY, async (req, res, next) => {
  try {
    const body = req.body || {};
    requireFields(body, ['item_id', 'start', 'end', 'reason']);

    const startMs = parseDate(body.start, 'start');
    const endMs = parseDate(body.end, 'end');
    if (endMs <= startMs) throw new ApiError(400, 'INVALID', 'end must be after start');

    const itemId = optionalPositiveInt(body.item_id, 'item_id');
    const itemInfo = await deptOfItem(itemId);
    if (!itemInfo) {
      throw new ApiError(404, 'ITEM_NOT_FOUND', `No item with id ${itemId}`);
    }
    assertOwnDept(req, itemInfo.dept_id, 'block maintenance for');

    const rows = await q(
      `INSERT INTO maintenance_block (item_id, authorized_by, blocked_range, reason)
       VALUES ($1::int, $2::int, tstzrange($3::timestamptz, $4::timestamptz, '[)'), $5::text)
       RETURNING block_id`,
      [itemId, req.user.staff_id, body.start, body.end, String(body.reason)],
    );
    res.status(201).json({ block_id: rows[0].block_id });
  } catch (err) {
    next(err);
  }
});

api.post('/maintenance/:id/close', FACULTY_ONLY, async (req, res, next) => {
  try {
    const blockInfo = await q(
      `SELECT e.dept_id
         FROM maintenance_block mb
         JOIN item i      ON i.item_id  = mb.item_id
         JOIN equipment e ON e.model_id = i.model_id
        WHERE mb.block_id = $1::int AND mb.status = 'ACTIVE'`,
      [req.params.id],
    );
    if (blockInfo.length === 0) {
      throw new ApiError(404, 'BLOCK_NOT_FOUND', `No ACTIVE maintenance block with id ${req.params.id}`);
    }
    assertOwnDept(req, blockInfo[0].dept_id, 'close maintenance for');

    const rows = await q(
      `UPDATE maintenance_block
          SET status = 'DONE'
        WHERE block_id = $1::int AND status = 'ACTIVE'
        RETURNING block_id`,
      [req.params.id],
    );
    if (rows.length === 0) {
      throw new ApiError(404, 'BLOCK_NOT_FOUND', `No ACTIVE maintenance block with id ${req.params.id}`);
    }
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// --- equipment catalog management -------------------------------------------------------------
api.post('/models', FACULTY_ONLY, async (req, res, next) => {
  try {
    const body = req.body || {};
    requireFields(body, ['model_name', 'manufacturer', 'category_id']);

    const categories = await q('SELECT category_id, category_name FROM category WHERE category_id = $1::int', [
      body.category_id,
    ]);
    if (categories.length === 0) {
      throw new ApiError(404, 'CATEGORY_NOT_FOUND', `No category with id ${body.category_id}`);
    }

    let deptId;
    if (isAdmin(req)) {
      deptId = optionalPositiveInt(body.dept_id, 'dept_id');
      if (!deptId) throw new ApiError(400, 'INVALID_DEPARTMENT', 'dept_id is required for the administrator');
    } else {
      deptId = staffDeptId(req);
    }
    const dept = await q('SELECT dept_id, dept_name FROM department WHERE dept_id = $1::int', [deptId]);
    if (dept.length === 0) {
      throw new ApiError(404, 'DEPARTMENT_NOT_FOUND', `No department with id ${deptId}`);
    }

    const rows = await q(
      `INSERT INTO equipment (model_name, manufacturer, description, category_id, dept_id)
       VALUES ($1, $2, $3, $4::int, $5::int)
       RETURNING model_id, model_name, manufacturer, description, category_id, dept_id`,
      [
        String(body.model_name).trim(),
        String(body.manufacturer).trim(),
        body.description === undefined || body.description === null ? null : String(body.description),
        body.category_id,
        deptId,
      ],
    );
    res.status(201).json({
      ...rows[0],
      category_name: categories[0].category_name,
      dept_name: dept[0].dept_name,
    });
  } catch (err) {
    next(err);
  }
});

api.post('/items', FACULTY_ONLY, async (req, res, next) => {
  try {
    const body = req.body || {};
    requireFields(body, ['serial_no', 'model_id', 'lab_id']);

    const condition = body.item_condition ? String(body.item_condition).toUpperCase() : 'GOOD';
    if (!['NEW', 'GOOD', 'FAIR', 'DAMAGED'].includes(condition)) {
      throw new ApiError(400, 'INVALID', 'item_condition must be one of NEW, GOOD, FAIR, DAMAGED');
    }
    const purchaseDate = body.purchase_date ? String(body.purchase_date) : null;

    const models = await q('SELECT model_id, dept_id FROM equipment WHERE model_id = $1::int', [body.model_id]);
    if (models.length === 0) {
      throw new ApiError(404, 'MODEL_NOT_FOUND', `No equipment model with id ${body.model_id}`);
    }
    const labs = await q('SELECT lab_id, lab_name, dept_id FROM lab WHERE lab_id = $1::int', [body.lab_id]);
    if (labs.length === 0) {
      throw new ApiError(404, 'LAB_NOT_FOUND', `No lab with id ${body.lab_id}`);
    }
    if (models[0].dept_id !== labs[0].dept_id) {
      throw new ApiError(
        400,
        'MODEL_LAB_DEPT_MISMATCH',
        'The model and the lab belong to different departments',
      );
    }
    assertOwnDept(req, labs[0].dept_id, 'add equipment to');

    const rows = await q(
      `INSERT INTO item (serial_no, purchase_date, item_condition, model_id, dept_id, lab_id)
       VALUES ($1, COALESCE($2::date, current_date), $3, $4::int, $5::int, $6::int)
       RETURNING item_id, serial_no, purchase_date, item_condition, lifecycle_status,
                 model_id, dept_id, lab_id`,
      [
        String(body.serial_no).trim(),
        purchaseDate,
        condition,
        body.model_id,
        labs[0].dept_id,
        body.lab_id,
      ],
    );
    res.status(201).json({ ...rows[0], lab_name: labs[0].lab_name });
  } catch (err) {
    next(err);
  }
});

api.post('/items/:id/retire', FACULTY_ONLY, async (req, res, next) => {
  try {
    const itemInfo = await deptOfItem(req.params.id);
    if (!itemInfo) {
      throw new ApiError(404, 'ITEM_NOT_FOUND', `No item with id ${req.params.id}`);
    }
    assertOwnDept(req, itemInfo.dept_id, 'retire');
    await q('SELECT retire_item($1::int, $2::int)', [req.params.id, req.user.staff_id]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

api.post('/items/:id/restore', FACULTY_ONLY, async (req, res, next) => {
  try {
    const itemInfo = await deptOfItem(req.params.id);
    if (!itemInfo) {
      throw new ApiError(404, 'ITEM_NOT_FOUND', `No item with id ${req.params.id}`);
    }
    assertOwnDept(req, itemInfo.dept_id, 'restore');
    await q('SELECT unretire_item($1::int)', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// --- full item list of one lab (all statuses) ---------------------------------------------------
api.get('/labs/:labId/items', FACULTY_ONLY, async (req, res, next) => {
  try {
    const labs = await q('SELECT lab_id, dept_id FROM lab WHERE lab_id = $1::int', [req.params.labId]);
    if (labs.length === 0) {
      throw new ApiError(404, 'LAB_NOT_FOUND', `No lab with id ${req.params.labId}`);
    }
    assertOwnDept(req, labs[0].dept_id, 'view the equipment of');
    res.json(
      await q('SELECT * FROM v_lab_items WHERE lab_id = $1::int ORDER BY item_id', [req.params.labId]),
    );
  } catch (err) {
    next(err);
  }
});

// ===========================================================================
// Reports (same shapes as the demo API)
// ===========================================================================

api.get('/reports/summary', FACULTY_ONLY, async (req, res, next) => {
  try {
    const [items, loans, requests, queue, utilization] = await Promise.all([
      q(`SELECT count(*)::int AS items_total,
                count(*) FILTER (WHERE availability = 'AVAILABLE')::int   AS available,
                count(*) FILTER (WHERE availability = 'ON_LOAN')::int     AS on_loan,
                count(*) FILTER (WHERE availability = 'MAINTENANCE')::int AS maintenance,
                count(*) FILTER (WHERE availability IN ('RETIRED','LOST'))::int AS retired
           FROM v_availability`),
      q(`SELECT count(*)::int AS active_loans,
                count(*) FILTER (WHERE now() > due_date)::int AS overdue_loans
           FROM loan
          WHERE returned_at IS NULL`),
      q(`SELECT count(*)::int AS pending_requests
           FROM lending_request
          WHERE request_status = 'PENDING'`),
      q(`SELECT count(*)::int AS queue_waiting
           FROM queue_entry
          WHERE queue_status = 'WAITING'`),
      q(`SELECT ROUND(avg(utilization_pct), 1) AS avg_utilization FROM v_item_utilization`),
    ]);

    res.json({
      ...items[0],
      ...loans[0],
      ...requests[0],
      ...queue[0],
      avg_utilization: num(utilization[0].avg_utilization),
    });
  } catch (err) {
    next(err);
  }
});

api.get('/reports/utilization', FACULTY_ONLY, async (req, res, next) => {
  try {
    res.json(
      await q('SELECT * FROM v_item_utilization ORDER BY utilization_pct DESC NULLS LAST, serial_no'),
    );
  } catch (err) {
    next(err);
  }
});

api.get('/reports/dept-utilization', FACULTY_ONLY, async (req, res, next) => {
  try {
    res.json(
      await q(
        `SELECT dept_name, item_count::int AS item_count,
                avg_utilization_pct, total_busy_hours, total_window_hours
           FROM v_dept_utilization`,
      ),
    );
  } catch (err) {
    next(err);
  }
});

api.get('/reports/overdue', FACULTY_ONLY, async (req, res, next) => {
  try {
    res.json(await q('SELECT * FROM v_overdue ORDER BY days_overdue DESC NULLS LAST, loan_id'));
  } catch (err) {
    next(err);
  }
});

api.get('/reports/idle', FACULTY_ONLY, async (req, res, next) => {
  try {
    res.json(await q('SELECT * FROM v_idle_items'));
  } catch (err) {
    next(err);
  }
});

// ===========================================================================
// Admin + audit
// ===========================================================================

api.post('/admin/escalate', FACULTY_ONLY, async (req, res, next) => {
  try {
    const rows = await q('SELECT escalate_overdue() AS escalated');
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

api.get('/audit', FACULTY_ONLY, async (req, res, next) => {
  try {
    let limit = 50;
    if (req.query.limit !== undefined) {
      limit = parseInt(req.query.limit, 10);
      if (!Number.isFinite(limit) || limit <= 0) {
        throw new ApiError(400, 'INVALID', 'limit must be a positive integer');
      }
      limit = Math.min(limit, 500); // hard cap
    }
    res.json(
      await q(
        `SELECT audit_id::int AS audit_id, occurred_at, actor, action, entity, entity_id, details
           FROM audit_log
          ORDER BY occurred_at DESC, audit_id DESC
          LIMIT $1::int`,
        [limit],
      ),
    );
  } catch (err) {
    next(err);
  }
});

// ===========================================================================
// SQL console - faculty read-only, admin unrestricted (one statement at a time)
// ===========================================================================
const SQL_MAX_LENGTH = 20000;
const READ_ONLY_STATEMENT = /^(select|with|table|values)\b/i;
const TRANSACTION_CONTROL = /^(begin|start|commit|rollback|savepoint|release|end)\b/i;

/** All tables/views of the live schema with their columns (console sidebar). */
api.get('/console/schema', requireAuth, requireRole('FACULTY'), async (req, res, next) => {
  try {
    const relations = await q(
      `SELECT c.relname AS name,
              CASE c.relkind WHEN 'r' THEN 'table' WHEN 'v' THEN 'view'
                             WHEN 'm' THEN 'materialized view' ELSE 'other' END AS kind
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r','v','m')
        ORDER BY c.relkind, c.relname`,
    );
    const columns = await q(
      `SELECT table_name, column_name, data_type, is_nullable
         FROM information_schema.columns
        WHERE table_schema = 'public'
        ORDER BY table_name, ordinal_position`,
    );
    const byName = new Map(relations.map((r) => [r.name, { ...r, columns: [] }]));
    for (const col of columns) {
      const rel = byName.get(col.table_name);
      if (rel) {
        rel.columns.push({
          name: col.column_name,
          type: col.data_type,
          nullable: col.is_nullable === 'YES',
        });
      }
    }
    res.json({ relations: Array.from(byName.values()) });
  } catch (err) {
    next(err);
  }
});

/** Run one SQL statement and return the rows so the UI can draw a table. */
api.post('/console/query', requireAuth, requireRole('FACULTY'), async (req, res) => {
  const body = req.body || {};
  const sqlText = String(body.sql || '').trim();
  if (!sqlText) {
    return res.status(400).json({ status: 400, error: 'INVALID', message: 'sql is required' });
  }
  if (sqlText.length > SQL_MAX_LENGTH) {
    return res.status(400).json({
      status: 400,
      error: 'INVALID',
      message: `SQL is limited to ${SQL_MAX_LENGTH} characters`,
    });
  }

  const isAdmin = req.user.role === 'ADMIN';
  let maxRows = parseInt(body.max_rows, 10);
  if (!Number.isFinite(maxRows) || maxRows <= 0) maxRows = 300;
  maxRows = Math.min(maxRows, 1000);

  const cleaned = sqlText.replace(/;+\s*$/, '');
  if (TRANSACTION_CONTROL.test(cleaned)) {
    return res.status(400).json({
      status: 400,
      error: 'TRANSACTION_CONTROL',
      message: 'The console manages its own transaction; BEGIN/COMMIT are not allowed here.',
    });
  }
  if (!isAdmin && !READ_ONLY_STATEMENT.test(cleaned)) {
    return res.status(403).json({
      status: 403,
      error: 'READ_ONLY',
      message: 'The faculty console is read-only: SELECT / WITH / TABLE / VALUES only.',
    });
  }

  const started = Date.now();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL statement_timeout = '8000'");
    if (!isAdmin) await client.query('SET TRANSACTION READ ONLY');

    // `values: []` forces the extended protocol => exactly ONE statement can run.
    let text = cleaned;
    if (!isAdmin && /^(select|with)\b/i.test(cleaned)) {
      text = `SELECT * FROM (${cleaned}) AS __console_q LIMIT ${maxRows}`;
    }
    const result = await client.query({ text, values: [] });
    await client.query(isAdmin ? 'COMMIT' : 'ROLLBACK');

    res.json({
      command: result.command || 'SELECT',
      row_count: typeof result.rowCount === 'number' ? result.rowCount : result.rows.length,
      columns: (result.fields || []).map((f) => f.name),
      rows: (result.rows || []).slice(0, maxRows),
      truncated: (result.rows || []).length > maxRows,
      duration_ms: Date.now() - started,
      read_only: !isAdmin,
    });
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* the connection may already be broken */
    }
    res.status(400).json({
      status: 400,
      error: 'SQL_ERROR',
      message: err.message,
      detail: err.detail || null,
      hint: err.hint || null,
      position: err.position || null,
    });
  } finally {
    client.release();
  }
});

// ===========================================================================
// Administration - account directory, faculty onboarding, password resets
// ===========================================================================
const ADMIN_ONLY = [requireAuth, requireRole('ADMIN')];

api.get('/admin/users', ADMIN_ONLY, async (req, res, next) => {
  try {
    res.json(
      await q(
        `SELECT u.user_id, u.email, u.role, u.created_at, u.last_login,
                COALESCE(st.full_name, sf.staff_name) AS name,
                u.student_id, u.staff_id, sf.role AS staff_role,
                sf.dept_id AS staff_dept_id, fd.dept_name AS staff_dept_name
           FROM app_user u
           LEFT JOIN student st ON st.student_id = u.student_id
           LEFT JOIN staff   sf ON sf.staff_id   = u.staff_id
           LEFT JOIN department fd ON fd.dept_id = sf.dept_id
          ORDER BY u.role, u.email`,
      ),
    );
  } catch (err) {
    next(err);
  }
});

/** Create a faculty login (staff row + account) - the admin version of the
 *  manual SQL faculty onboarding described in the README. */
api.post('/admin/faculty', ADMIN_ONLY, async (req, res, next) => {
  try {
    const body = req.body || {};
    requireFields(body, ['staff_name', 'email', 'staff_role', 'dept_id', 'password']);
    const staffName = String(body.staff_name).trim();
    const email = String(body.email).trim().toLowerCase();
    const staffRole = String(body.staff_role).toUpperCase();
    const deptId = Number(body.dept_id);
    const password = String(body.password);

    if (!/^[a-z0-9._%+-]+@rvce\.edu\.in$/.test(email)) {
      throw new ApiError(400, 'INVALID_EMAIL', 'Faculty email must be a name@rvce.edu.in address');
    }
    if (!['LAB_ADMIN', 'TECHNICIAN', 'DEPT_ADMIN'].includes(staffRole)) {
      throw new ApiError(400, 'INVALID', 'staff_role must be LAB_ADMIN, TECHNICIAN or DEPT_ADMIN');
    }
    const dept = await q('SELECT dept_id, dept_name FROM department WHERE dept_id = $1::int', [deptId]);
    if (dept.length === 0) {
      throw new ApiError(404, 'DEPARTMENT_NOT_FOUND', `No department with id ${deptId}`);
    }
    if (password.length < 8) {
      throw new ApiError(400, 'WEAK_PASSWORD', 'Password must be at least 8 characters');
    }

    const dup = await q(
      `SELECT 1 FROM staff WHERE lower(email) = $1
       UNION ALL
       SELECT 1 FROM app_user WHERE lower(email) = $1
       LIMIT 1`,
      [email],
    );
    if (dup.length > 0) throw new ApiError(409, 'EMAIL_TAKEN', 'This email is already in use');

    const userId = await withTx(async (client) => {
      const staff = await client.query(
        `INSERT INTO staff (staff_name, role, email, dept_id)
         VALUES ($1, $2, $3, $4::int) RETURNING staff_id`,
        [staffName, staffRole, email, deptId],
      );
      const user = await client.query(
        `INSERT INTO app_user (email, password_hash, role, staff_id)
         VALUES ($1, crypt($2, gen_salt('bf', 10)), 'FACULTY', $3)
         RETURNING user_id`,
        [email, password, staff.rows[0].staff_id],
      );
      return user.rows[0].user_id;
    });

    res.status(201).json({
      user_id: userId,
      email,
      role: 'FACULTY',
      name: staffName,
      staff_role: staffRole,
      dept_id: deptId,
      dept_name: dept[0].dept_name,
    });
  } catch (err) {
    next(err);
  }
});

api.post('/admin/users/:id/reset-password', ADMIN_ONLY, async (req, res, next) => {
  try {
    const body = req.body || {};
    requireFields(body, ['new_password']);
    const newPassword = String(body.new_password);
    if (newPassword.length < 8) {
      throw new ApiError(400, 'WEAK_PASSWORD', 'Password must be at least 8 characters');
    }
    const updated = await q(
      `UPDATE app_user SET password_hash = crypt($2, gen_salt('bf', 10))
        WHERE user_id = $1::int RETURNING user_id`,
      [req.params.id, newPassword],
    );
    if (updated.length === 0) {
      throw new ApiError(404, 'USER_NOT_FOUND', `No account with id ${req.params.id}`);
    }
    await q('DELETE FROM app_session WHERE user_id = $1::int', [req.params.id]);
    res.json({ ok: true, user_id: updated[0].user_id, sessions_revoked: true });
  } catch (err) {
    next(err);
  }
});

api.delete('/admin/users/:id', ADMIN_ONLY, async (req, res, next) => {
  try {
    const targetId = Number(req.params.id);
    if (!Number.isInteger(targetId) || targetId <= 0) {
      throw new ApiError(400, 'INVALID', 'invalid user id');
    }
    if (targetId === req.user.user_id) {
      throw new ApiError(400, 'CANNOT_DELETE_SELF', 'You cannot delete your own account');
    }
    const target = await q('SELECT user_id, role, email FROM app_user WHERE user_id = $1::int', [targetId]);
    if (target.length === 0) {
      throw new ApiError(404, 'USER_NOT_FOUND', `No account with id ${targetId}`);
    }
    if (target[0].role === 'ADMIN') {
      const admins = await q("SELECT count(*)::int AS n FROM app_user WHERE role = 'ADMIN'");
      if (admins[0].n <= 1) {
        throw new ApiError(400, 'LAST_ADMIN', 'At least one administrator account must remain');
      }
    }
    await q('DELETE FROM app_user WHERE user_id = $1::int', [targetId]);
    res.json({ ok: true, deleted_user_id: targetId, email: target[0].email });
  } catch (err) {
    next(err);
  }
});

// ===========================================================================
// Mounting + error handling
// ===========================================================================

// unknown API route
api.use((req, res) => {
  res.status(404).json({
    status: 404,
    error: 'NOT_FOUND',
    message: `No route for ${req.method} ${req.originalUrl}`,
  });
});

// static frontend (GET / serves ../frontend/index.html when present)
app.use('/', express.static(path.join(__dirname, '..', 'frontend')));
app.use('/api', api);

// central error handler - mapError translates PostgreSQL failures
app.use((err, req, res, _next) => {
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ status: 400, error: 'BAD_INPUT', message: 'Request body is not valid JSON' });
  }
  const mapped =
    err instanceof ApiError
      ? { status: err.status, error: err.error, message: err.message }
      : mapError(err);
  if (mapped.status >= 500) console.error('[error]', err);
  res.status(mapped.status).json(mapped);
});

// ===========================================================================
// Start
// ===========================================================================
const server = app.listen(PORT, () => {
  console.log(`Equipment Lending Library LIVE API listening on http://localhost:${PORT} (db: ${config.database})`);
  connectListener().catch((err) => {
    console.error('[sse] initial LISTEN failed:', err.message);
    scheduleListenerRetry();
  });
});

// Graceful shutdown (POSIX signals; Windows Stop-Process is a hard kill).
function shutdown(signal) {
  console.log(`${signal} received - shutting down`);
  for (const res of sseClients) {
    try {
      res.end();
    } catch {
      /* ignore */
    }
  }
  sseClients.clear();
  if (listener) {
    listener.end().catch(() => {});
    listener = null;
  }
  server.close(() => {
    pool.end().finally(() => process.exit(0));
  });
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
