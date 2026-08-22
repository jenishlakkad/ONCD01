const crypto = require('crypto');
const db = require('../db/connection');

const OTP_TTL_MINUTES = 10;

function hashCode(code) {
  return crypto.createHash('sha256').update(code).digest('hex');
}

function generateCode() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

function createOtp(email, purpose) {
  const code = generateCode();
  const expiresAt = new Date(Date.now() + OTP_TTL_MINUTES * 60 * 1000).toISOString();
  db.prepare(
    `INSERT INTO otp_tokens (email, purpose, code_hash, expires_at) VALUES (?, ?, ?, ?)`
  ).run(email.toLowerCase(), purpose, hashCode(code), expiresAt);
  return code;
}

// Returns true/false. Consumes the token on success (single use).
function verifyOtp(email, purpose, code) {
  const row = db
    .prepare(
      `SELECT * FROM otp_tokens
       WHERE email = ? AND purpose = ? AND consumed_at IS NULL
       ORDER BY id DESC LIMIT 1`
    )
    .get(email.toLowerCase(), purpose);
  if (!row) return false;
  if (new Date(row.expires_at).getTime() < Date.now()) return false;
  if (row.code_hash !== hashCode(String(code))) return false;
  db.prepare(`UPDATE otp_tokens SET consumed_at = datetime('now') WHERE id = ?`).run(row.id);
  return true;
}

module.exports = { createOtp, verifyOtp };
