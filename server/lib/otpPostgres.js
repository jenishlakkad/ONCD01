const crypto = require('crypto');
const db = require('../db/postgres');

// One-time verification codes (registration, password reset/change, admin
// reset), stored hashed in otp_tokens.
//
// Guard rails (kept in memory — this app runs as one process, and the
// limits only need to hold for minutes):
//   * resend cooldown: one new code per address+purpose every 30 seconds,
//     and at most 6 per hour — so the form can't be used to flood an inbox;
//   * attempts: 5 wrong guesses lock that code (a 6-digit code can't be
//     brute-forced); the customer just requests a fresh one.
// Only the newest code for an address+purpose is ever valid.

const OTP_TTL_MINUTES = 10;
const RESEND_COOLDOWN_S = 30;
const MAX_PER_HOUR = 6;
const MAX_ATTEMPTS = 5;

class OtpRateError extends Error {
  constructor(retryAfter, message) {
    super(message || `Please wait ${retryAfter} seconds before requesting another code.`);
    this.retryAfter = retryAfter;
  }
}

const issued = new Map();   // `${purpose}:${email}` -> [timestamps]
const attempts = new Map(); // token id -> wrong guesses

function hashCode(code) {
  return crypto.createHash('sha256').update(String(code)).digest('hex');
}

function generateCode() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

function keyOf(email, purpose) {
  return `${purpose}:${String(email).toLowerCase()}`;
}

// Seconds until another code may be sent (0 = now). Doesn't record anything.
function cooldownLeft(email, purpose) {
  const now = Date.now();
  const list = (issued.get(keyOf(email, purpose)) || []).filter((t) => now - t < 60 * 60 * 1000);
  if (list.length >= MAX_PER_HOUR) return Math.ceil((list[0] + 60 * 60 * 1000 - now) / 1000);
  const last = list[list.length - 1];
  return last ? Math.max(0, Math.ceil((last + RESEND_COOLDOWN_S * 1000 - now) / 1000)) : 0;
}

// Records a send for the cooldown without creating a code — used when an
// address has no account, so "forgot password" behaves identically (and
// can't be used to probe which emails are registered).
function noteIssued(email, purpose) {
  const k = keyOf(email, purpose);
  const now = Date.now();
  const list = (issued.get(k) || []).filter((t) => now - t < 60 * 60 * 1000);
  list.push(now);
  issued.set(k, list);
  if (issued.size > 20000) issued.clear();
}

// Creates a code (throws OtpRateError while cooling down). Earlier codes
// for the same address+purpose stop working. One round trip: the old codes
// are retired and the new one stored in a single statement.
async function createOtp(email, purpose) {
  const wait = cooldownLeft(email, purpose);
  if (wait > 0) throw new OtpRateError(wait);
  noteIssued(email, purpose);
  const code = generateCode();
  const expiresAt = new Date(Date.now() + OTP_TTL_MINUTES * 60 * 1000).toISOString();
  await db.query(
    `WITH retired AS (
       UPDATE otp_tokens SET consumed_at = NOW() WHERE email = $1 AND purpose = $2 AND consumed_at IS NULL
     )
     INSERT INTO otp_tokens (email, purpose, code_hash, expires_at) VALUES ($1, $2, $3, $4)`,
    [email.toLowerCase(), purpose, hashCode(code), expiresAt]
  );
  return code;
}

// Checks a code. Returns { ok: true } or { ok: false, reason, message }
// where reason is 'missing' | 'expired' | 'locked' | 'invalid'.
// consume:true uses the code up on success (single use).
//
// The right code costs ONE round trip: a single UPDATE that matches only
// the newest unused, unexpired code with that hash. It is also what makes
// it single-use under concurrency — a second request with the same code
// waits on the row lock, then re-checks "consumed_at IS NULL" and matches
// nothing. Only a failed attempt does a second query, to say why.
async function checkOtp(email, purpose, code, { consume = true } = {}) {
  const clean = String(code || '').replace(/\D/g, '');
  const addr = String(email).toLowerCase();
  const latest = `SELECT id FROM otp_tokens WHERE email = $1 AND purpose = $2 AND consumed_at IS NULL ORDER BY id DESC LIMIT 1`;
  if (clean.length === 6) {
    const hit = consume
      ? await db.get(
        `UPDATE otp_tokens SET consumed_at = NOW()
         WHERE id = (${latest}) AND code_hash = $3 AND expires_at > NOW() AND consumed_at IS NULL
         RETURNING id`, [addr, purpose, hashCode(clean)])
      : await db.get(
        `SELECT id FROM otp_tokens WHERE id = (${latest}) AND code_hash = $3 AND expires_at > NOW()`,
        [addr, purpose, hashCode(clean)]);
    if (hit) {
      if (consume) attempts.delete(String(hit.id));
      return { ok: true };
    }
  }
  const row = await db.get(`SELECT id, expires_at FROM otp_tokens WHERE id = (${latest})`, [addr, purpose]);
  if (!row) return { ok: false, reason: 'missing', message: 'This code is no longer valid. Request a new one.' };
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    return { ok: false, reason: 'expired', message: 'This code has expired. Request a new one — it only takes a moment.' };
  }
  const tries = (attempts.get(String(row.id)) || 0) + 1;
  attempts.set(String(row.id), tries);
  if (attempts.size > 20000) attempts.clear();
  if (tries >= MAX_ATTEMPTS) {
    await db.query(`UPDATE otp_tokens SET consumed_at = NOW() WHERE id = $1 AND consumed_at IS NULL`, [row.id]);
    return { ok: false, reason: 'locked', message: 'Too many incorrect attempts, so this code was cancelled. Request a new one.' };
  }
  const left = MAX_ATTEMPTS - tries;
  return { ok: false, reason: 'invalid', message: `That code isn't right — ${left} ${left === 1 ? 'try' : 'tries'} left.` };
}

// Boolean form kept for callers that only need yes/no.
async function verifyOtp(email, purpose, code) {
  return (await checkOtp(email, purpose, code)).ok;
}

// For test scripts that issue several codes in a row.
function resetLimits() { issued.clear(); attempts.clear(); }

module.exports = {
  resetLimits, createOtp, verifyOtp, checkOtp, cooldownLeft, noteIssued, OtpRateError,
  OTP_TTL_MINUTES, RESEND_COOLDOWN_S,
};
