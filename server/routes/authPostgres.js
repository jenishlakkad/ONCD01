const express = require('express');
const db = require('../db/postgres');
const { hashPassword, verifyPassword } = require('../lib/password');
const { createOtp, verifyOtp } = require('../lib/otpPostgres');
const { sendMail } = require('../lib/mailer');
const { asyncRoute, ApiError } = require('../middleware/errorHandler');
const requireCustomer = require('../middleware/requireCustomerPostgres');

// PostgreSQL counterpart to server/routes/auth.js (SQLite). Parallel/isolated
// test route file only — NOT mounted in app.js, NOT reachable by any real
// request. Exists so it can be exercised on its own before any cutover
// decision is made.

const router = express.Router();

function publicCustomer(c) {
  const { password_hash, ...rest } = c;
  // customers.id is BIGINT — pg returns it as a string, not a number.
  // Converting back to Number here keeps the response shape identical to
  // the SQLite version.
  return { ...rest, id: Number(rest.id) };
}

router.post('/register', asyncRoute(async (req, res) => {
  const b = req.body || {};
  const required = ['fullName', 'mobile', 'email', 'country', 'state', 'city', 'password'];
  for (const f of required) {
    if (!b[f] || !String(b[f]).trim()) throw new ApiError(400, `${f} is required.`);
  }
  const email = String(b.email).trim().toLowerCase();
  const existing = await db.get('SELECT id FROM customers WHERE email = $1', [email]);
  if (existing) throw new ApiError(409, 'An account with this email already exists.');

  await db.query(
    `INSERT INTO customers (full_name, email, password_hash, mobile, country, state, city, company_name, business_type, website, message, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'pending')`,
    [
      b.fullName.trim(), email, hashPassword(b.password), b.mobile.trim(), b.country.trim(), b.state.trim(), b.city.trim(),
      b.companyName ? String(b.companyName).trim() : null,
      b.businessType ? String(b.businessType).trim() : null,
      b.website ? String(b.website).trim() : null,
      b.message ? String(b.message).trim() : null,
    ]
  );

  const code = await createOtp(email, 'register');
  await sendMail({ to: email, subject: 'Verify your ONCD account', text: `Your verification code is ${code}. It expires in 10 minutes.` });
  res.json({ data: { email } });
}));

router.post('/register/resend', asyncRoute(async (req, res) => {
  const email = String((req.body || {}).email || '').trim().toLowerCase();
  if (!email) throw new ApiError(400, 'Email is required.');
  const code = await createOtp(email, 'register');
  await sendMail({ to: email, subject: 'Your new ONCD verification code', text: `Your verification code is ${code}. It expires in 10 minutes.` });
  res.json({ data: { email } });
}));

router.post('/register/verify', asyncRoute(async (req, res) => {
  const { email, code } = req.body || {};
  if (!email || !code) throw new ApiError(400, 'Email and code are required.');
  const ok = await verifyOtp(String(email).trim().toLowerCase(), 'register', code);
  if (!ok) throw new ApiError(400, 'Invalid or expired code.');
  await db.query(`UPDATE customers SET email_verified_at = NOW() WHERE email = $1`, [String(email).trim().toLowerCase()]);
  res.json({ data: { verified: true } });
}));

router.post('/login', asyncRoute(async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) throw new ApiError(400, 'Email and password are required.');
  const customer = await db.get('SELECT * FROM customers WHERE email = $1', [String(email).trim().toLowerCase()]);
  if (!customer || !verifyPassword(password, customer.password_hash)) {
    throw new ApiError(401, 'Incorrect email or password.');
  }
  // Matches the CURRENT SQLite /login exactly: only 'pending' and 'rejected'
  // are blocked here. There is intentionally no 'suspended' check in this
  // route today — a suspended customer can still complete login and receive
  // a session; suspension is enforced separately, on the very next request
  // to any route guarded by requireCustomer (which nulls the session and
  // returns 403 for a non-approved status). Not "fixed" here — preserved.
  if (customer.status === 'pending') {
    throw new ApiError(403, "Your account is pending admin approval. You'll be notified by email once access is granted.");
  }
  if (customer.status === 'rejected') {
    throw new ApiError(403, 'This account is not eligible to log in.');
  }
  req.session.customerId = Number(customer.id);
  res.json({ data: publicCustomer(customer) });
}));

router.post('/logout', (req, res) => {
  req.session.customerId = null;
  res.json({ data: { loggedOut: true } });
});

router.get('/me', requireCustomer, (req, res) => {
  res.json({ data: req.customer });
});

router.put('/profile', requireCustomer, asyncRoute(async (req, res) => {
  const b = req.body || {};
  const required = ['fullName', 'mobile', 'country', 'state', 'city'];
  for (const f of required) {
    if (!b[f] || !String(b[f]).trim()) throw new ApiError(400, `${f} is required.`);
  }
  await db.query(
    `UPDATE customers SET full_name = $1, mobile = $2, country = $3, state = $4, city = $5,
       company_name = $6, business_type = $7, website = $8, message = $9, updated_at = NOW()
     WHERE id = $10`,
    [
      b.fullName.trim(), b.mobile.trim(), b.country.trim(), b.state.trim(), b.city.trim(),
      b.companyName ? String(b.companyName).trim() : null,
      b.businessType ? String(b.businessType).trim() : null,
      b.website ? String(b.website).trim() : null,
      b.message ? String(b.message).trim() : null,
      req.customer.id,
    ]
  );
  const updated = await db.get('SELECT * FROM customers WHERE id = $1', [req.customer.id]);
  res.json({ data: publicCustomer(updated) });
}));

router.post('/change-password/request', requireCustomer, asyncRoute(async (req, res) => {
  const code = await createOtp(req.customer.email, 'reset');
  await sendMail({ to: req.customer.email, subject: 'Your ONCD password change code', text: `Your verification code is ${code}. It expires in 10 minutes.` });
  res.json({ data: { sent: true } });
}));

router.post('/change-password/verify', requireCustomer, asyncRoute(async (req, res) => {
  const { code, newPassword } = req.body || {};
  if (!code || !newPassword) throw new ApiError(400, 'Code and new password are required.');
  const ok = await verifyOtp(req.customer.email, 'reset', code);
  if (!ok) throw new ApiError(400, 'Invalid or expired code.');
  await db.query(`UPDATE customers SET password_hash = $1, updated_at = NOW() WHERE id = $2`, [hashPassword(newPassword), req.customer.id]);
  res.json({ data: { changed: true } });
}));

router.post('/forgot', asyncRoute(async (req, res) => {
  const email = String((req.body || {}).email || '').trim().toLowerCase();
  const customer = email ? await db.get('SELECT id FROM customers WHERE email = $1', [email]) : null;
  // Always respond 200 regardless of whether the account exists (no user enumeration).
  if (customer) {
    const code = await createOtp(email, 'reset');
    await sendMail({ to: email, subject: 'Reset your ONCD password', text: `Your password reset code is ${code}. It expires in 10 minutes.` });
  }
  res.json({ data: { sent: true } });
}));

router.post('/forgot/verify', asyncRoute(async (req, res) => {
  const { email, code } = req.body || {};
  if (!email || !code) throw new ApiError(400, 'Email and code are required.');
  // Peek without consuming: re-verify at /reset so the code can still be used there.
  const row = await db.get(
    `SELECT * FROM otp_tokens WHERE email = $1 AND purpose = 'reset' AND consumed_at IS NULL ORDER BY id DESC LIMIT 1`,
    [String(email).trim().toLowerCase()]
  );
  const crypto = require('crypto');
  const hash = crypto.createHash('sha256').update(String(code)).digest('hex');
  if (!row || row.code_hash !== hash || new Date(row.expires_at).getTime() < Date.now()) {
    throw new ApiError(400, 'Invalid or expired code.');
  }
  res.json({ data: { valid: true } });
}));

router.post('/reset', asyncRoute(async (req, res) => {
  const { email, code, newPassword } = req.body || {};
  if (!email || !code || !newPassword) throw new ApiError(400, 'Email, code and new password are required.');
  const ok = await verifyOtp(String(email).trim().toLowerCase(), 'reset', code);
  if (!ok) throw new ApiError(400, 'Invalid or expired code.');
  const result = await db.query('UPDATE customers SET password_hash = $1, updated_at = NOW() WHERE email = $2', [hashPassword(newPassword), String(email).trim().toLowerCase()]);
  if (result.rowCount === 0) throw new ApiError(404, 'No account found for this email.');
  res.json({ data: { reset: true } });
}));

module.exports = router;
