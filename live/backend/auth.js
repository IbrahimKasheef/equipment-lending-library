'use strict';

/**
 * auth.js - database-backed session authentication for the live website.
 *
 * Design notes (viva):
 *   - Passwords are stored as bcrypt hashes produced by pgcrypto
 *     (crypt(pw, gen_salt('bf', 10))). Verification happens inside
 *     PostgreSQL - the API never compares hashes in JS.
 *   - Sessions are opaque 48-hex-character bearer tokens. Only the SHA-256
 *     hash of a token is persisted (app_session.token_hash), so a database
 *     leak does not disclose usable session tokens.
 *   - requireAuth resolves the token to a full profile (student OR staff
 *     join) and attaches it to req.user for the downstream handlers.
 */

const crypto = require('crypto');
const { pool } = require('./db');

// ---------------------------------------------------------------------------
// Tokens and sessions
// ---------------------------------------------------------------------------

/** SHA-256 hex digest of a raw session token (what the database stores). */
function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * Create a new 7-day session for a user.
 *
 * @param {number} userId
 * @param {import('pg').PoolClient} [client] run inside the caller's transaction when given
 * @returns {Promise<string>} the RAW token - it is returned once and never stored
 */
async function createSession(userId, client) {
  const token = crypto.randomBytes(24).toString('hex'); // 48 hex characters
  const runner = client || pool;
  await runner.query(
    `INSERT INTO app_session (token_hash, user_id, expires_at)
     VALUES ($1, $2, now() + interval '7 days')`,
    [hashToken(token), userId],
  );
  return token;
}

// ---------------------------------------------------------------------------
// Profile loading
// ---------------------------------------------------------------------------

/** Shared SELECT/FROM used wherever a full user profile is needed. */
const PROFILE_SELECT = `
  SELECT u.user_id, u.email, u.role,
         u.student_id, u.staff_id,
         st.full_name AS student_name, st.semester,
         sd.dept_name  AS student_dept_name,
         sf.staff_name, sf.role AS staff_role,
         sf.dept_id AS staff_dept_id,
         fd.dept_name AS staff_dept_name`;

const PROFILE_FROM = `
    FROM app_user u
    LEFT JOIN student    st ON st.student_id = u.student_id
    LEFT JOIN department sd ON sd.dept_id    = st.dept_id
    LEFT JOIN staff      sf ON sf.staff_id   = u.staff_id
    LEFT JOIN department fd ON fd.dept_id    = sf.dept_id`;

/**
 * Public JSON shape of a logged-in user.
 * { user_id, email, role, name, student_id?, usn?, semester?, dept_name?,
 *   staff_id?, staff_role?, lab_hint? }
 */
function userShape(row) {
  const user = {
    user_id: row.user_id,
    email: row.email,
    role: row.role,
    name: row.role === 'STUDENT' ? row.student_name : row.staff_name,
    lab_hint: null,
  };
  if (row.role === 'STUDENT') {
    const usn = row.student_id === null ? null : String(row.student_id).trim();
    user.student_id = usn;
    user.usn = usn;
    user.semester = row.semester; // may be null until a faculty member fills it in
    user.dept_name = row.student_dept_name;
  } else {
    user.staff_id = row.staff_id;
    user.staff_role = row.staff_role;
    user.staff_dept_id = row.staff_dept_id;
    user.staff_dept_name = row.staff_dept_name;
  }
  return user;
}

/**
 * Load the public profile of a user by id.
 * @param {number} userId
 * @param {import('pg').PoolClient} [client] read inside the caller's transaction when given
 * @returns {Promise<object|null>}
 */
async function loadProfile(userId, client) {
  const runner = client || pool;
  const { rows } = await runner.query(`${PROFILE_SELECT} ${PROFILE_FROM} WHERE u.user_id = $1`, [
    userId,
  ]);
  return rows.length > 0 ? userShape(rows[0]) : null;
}

// ---------------------------------------------------------------------------
// Express middleware
// ---------------------------------------------------------------------------

/** Standard 401 response. */
function unauthorized(res) {
  return res.status(401).json({ status: 401, error: 'UNAUTHORIZED', message: 'Login required' });
}

/**
 * Express middleware: require `Authorization: Bearer <token>` resolving to a
 * live app_session row. On success attaches:
 *
 *   req.user = { user_id, email, role, student_id, staff_id, name }
 *   req.tokenHash = sha256(token)   (used by logout / password change)
 */
async function requireAuth(req, res, next) {
  try {
    const header = String(req.headers.authorization || '').trim();
    const match = /^Bearer\s+(\S+)$/i.exec(header);
    if (!match) return unauthorized(res);

    const tokenHash = hashToken(match[1]);
    const { rows } = await pool.query(
      `${PROFILE_SELECT}
         FROM app_session s
         JOIN app_user u      ON u.user_id = s.user_id
         LEFT JOIN student    st ON st.student_id = u.student_id
         LEFT JOIN department sd ON sd.dept_id    = st.dept_id
         LEFT JOIN staff      sf ON sf.staff_id   = u.staff_id
         LEFT JOIN department fd ON fd.dept_id    = sf.dept_id
        WHERE s.token_hash = $1
          AND s.expires_at > now()`,
      [tokenHash],
    );
    if (rows.length === 0) return unauthorized(res);

    // Touch the session so "last seen" reflects actual API activity.
    await pool.query('UPDATE app_session SET last_seen = now() WHERE token_hash = $1', [tokenHash]);

    const shape = userShape(rows[0]);
    req.tokenHash = tokenHash;
    req.user = {
      user_id: shape.user_id,
      email: shape.email,
      role: shape.role,
      student_id: shape.student_id ?? null,
      staff_id: shape.staff_id ?? null,
      staff_dept_id: shape.staff_dept_id ?? null,
      staff_dept_name: shape.staff_dept_name ?? null,
      name: shape.name,
    };
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Express middleware factory: require a specific role after requireAuth.
 * Faculty-only and student-only route groups use this.
 */
function requireRole(role) {
  return (req, res, next) => {
    if (!req.user) return unauthorized(res);
    // The administrator role is a superset of every other role.
    if (req.user.role === 'ADMIN') return next();
    if (req.user.role !== role) {
      return res.status(403).json({
        status: 403,
        error: 'FORBIDDEN',
        message: `This action requires the ${role} role`,
      });
    }
    next();
  };
}

// ---------------------------------------------------------------------------
// Password verification
// ---------------------------------------------------------------------------

/**
 * Check an email/password pair inside PostgreSQL with pgcrypto.
 * @returns {Promise<object|null>} the app_user row on success, null otherwise
 */
async function verifyPassword(email, password) {
  const { rows } = await pool.query(
    `SELECT * FROM app_user
      WHERE lower(email) = lower($1)
        AND password_hash = crypt($2, password_hash)`,
    [String(email), String(password)],
  );
  return rows[0] || null;
}

module.exports = {
  hashToken,
  createSession,
  requireAuth,
  requireRole,
  verifyPassword,
  loadProfile,
  userShape,
};
