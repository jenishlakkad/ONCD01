const crypto = require('crypto');
const db = require('../db/postgres');

const OTP_TTL_MINUTES = 10;

// PostgreSQL counterpart to server/lib/otp.js (SQLite). NOT wired into any
// route yet — exists so it can be exercised/tested on its own before any
// cutover decision is made.

function hashCode(code) {
  return crypto.createHash('sha256').update(code).digest('hex');
}

function generateCode() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

async function createOtp(email, purpose) {
  const code = generateCode();
  const expiresAt = new Date(Date.now() + OTP_TTL_MINUTES * 60 * 1000).toISOString();
  await db.query(
    `INSERT INTO otp_tokens (email, purpose, code_hash, expires_at) VALUES ($1, $2, $3, $4)`,
    [email.toLowerCase(), purpose, hashCode(code), expiresAt]
  );
  return code;
}

// Returns true/false. Consumes the token on success (single use).
//
// Wrapped in a transaction with SELECT ... FOR UPDATE: under better-sqlite3
// this SELECT-then-UPDATE was implicitly atomic because it all ran
// synchronously on Node's single thread — nothing could interleave between
// the two statements. Once these are real awaited network round trips to
// Postgres, two concurrent verify attempts with the same valid code could
// otherwise both pass the SELECT before either UPDATE commits, letting one
// OTP be used twice. FOR UPDATE takes a row lock for the transaction's
// duration, forcing a second concurrent call to wait until the first
// COMMITs — see the concurrency review in the accompanying report for a
// full walk-through of why this is actually safe under PostgreSQL's
// READ COMMITTED re-check (EvalPlanQual) semantics, including the
// multiple-outstanding-token edge case.
async function verifyOtp(email, purpose, code) {
  return db.transaction(async (client) => {
    const { rows } = await client.query(
      `SELECT * FROM otp_tokens
       WHERE email = $1 AND purpose = $2 AND consumed_at IS NULL
       ORDER BY id DESC LIMIT 1
       FOR UPDATE`,
      [email.toLowerCase(), purpose]
    );
    const row = rows[0];
    if (!row) return false;
    if (new Date(row.expires_at).getTime() < Date.now()) return false;
    if (row.code_hash !== hashCode(String(code))) return false;
    await client.query(`UPDATE otp_tokens SET consumed_at = NOW() WHERE id = $1`, [row.id]);
    return true;
  });
}

module.exports = { createOtp, verifyOtp };
