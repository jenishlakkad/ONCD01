const express = require('express');
const db = require('../db/postgres');
const { hashPassword, verifyPassword } = require('../lib/password');
const { createOtp, checkOtp, cooldownLeft, noteIssued, OtpRateError, OTP_TTL_MINUTES, RESEND_COOLDOWN_S } = require('../lib/otpPostgres');
const { sendMailInBackground } = require('../lib/mailer');
const T = require('../lib/emailTemplates');
const { siteOrigin } = require('../lib/messaging');
const { asyncRoute, ApiError } = require('../middleware/errorHandler');
const requireCustomer = require('../middleware/requireCustomerPostgres');
const { customerCode } = require('../lib/customerCode');

// Customer accounts: registration (with email verification), login, profile
// and password reset/change.
//
// Verification codes are FAST: the code is created, the response goes back
// immediately and the (branded) email is sent in the background over a
// pooled SMTP connection. Every response that sends a code includes
// `resendIn` (seconds) so the page can show its resend countdown; a request
// during the cooldown answers 429 with `retryAfter`.

const router = express.Router();
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function publicCustomer(c) {
  const { password_hash, ...rest } = c;
  // customers.id is BIGINT — pg returns it as a string.
  return { ...rest, id: Number(rest.id), customer_code: customerCode(rest.id) };
}

function cleanEmail(v) {
  return String(v || '').trim().toLowerCase();
}

// Creates a code and emails it in the background. Throws a 429 ApiError
// (with retryAfter) while the address is cooling down.
async function sendCode(req, { email, dbPurpose, template, name }) {
  let code;
  try {
    code = await createOtp(email, dbPurpose);
  } catch (err) {
    if (err instanceof OtpRateError) throw new ApiError(429, err.message, { retryAfter: err.retryAfter });
    throw err;
  }
  const origin = siteOrigin(req);
  sendMailInBackground(() => T.otpEmail({ purpose: template, code, name, origin, minutes: OTP_TTL_MINUTES }).then((m) => ({ to: email, ...m })));
}

// Same timing/cooldown behaviour for an address with no account, so these
// endpoints can't be used to discover which emails are registered.
function noAccountSend(email, dbPurpose) {
  const wait = cooldownLeft(email, dbPurpose);
  if (wait > 0) throw new ApiError(429, `Please wait ${wait} seconds before requesting another code.`, { retryAfter: wait });
  noteIssued(email, dbPurpose);
}

function codeError(result) {
  return new ApiError(400, result.message, { reason: result.reason });
}

function checkPassword(pw) {
  if (!pw || String(pw).length < 8) throw new ApiError(400, 'Password must be at least 8 characters.');
}

router.post('/register', asyncRoute(async (req, res) => {
  const b = req.body || {};
  const required = ['fullName', 'mobile', 'email', 'country', 'state', 'city', 'password'];
  for (const f of required) {
    if (!b[f] || !String(b[f]).trim()) throw new ApiError(400, `${f} is required.`);
  }
  const email = cleanEmail(b.email);
  if (!EMAIL_RE.test(email)) throw new ApiError(400, 'Please enter a valid email address.');
  checkPassword(b.password);

  // One round trip for a new address; the existing account is only looked
  // up when the email is already taken.
  const inserted = await db.get(
    `INSERT INTO customers (full_name, email, password_hash, mobile, country, state, city, company_name, business_type, website, message, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'pending')
     ON CONFLICT ((lower(email))) DO NOTHING RETURNING id`,
    [
      b.fullName.trim(), email, hashPassword(b.password), b.mobile.trim(), b.country.trim(), b.state.trim(), b.city.trim(),
      b.companyName ? String(b.companyName).trim() : null,
      b.businessType ? String(b.businessType).trim() : null,
      b.website ? String(b.website).trim() : null,
      b.message ? String(b.message).trim() : null,
    ]
  );

  if (!inserted) {
    const existing = await db.get('SELECT id, full_name, email_verified_at FROM customers WHERE lower(email) = $1', [email]);
    // Started registering earlier but never entered the code: send a fresh
    // one and let the page jump straight to the code step. (The earlier
    // details and password are kept — they're not overwritten by whoever
    // fills in the form again.)
    if (!existing.email_verified_at) {
      let resendIn = RESEND_COOLDOWN_S;
      try {
        await sendCode(req, { email, dbPurpose: 'register', template: 'register', name: existing.full_name });
      } catch (err) {
        if (err.status !== 429) throw err;
        resendIn = err.extra.retryAfter;
      }
      throw new ApiError(409, "You've already started registering with this email. We've sent a new code — enter it to finish (your earlier details and password are kept).", { code: 'UNVERIFIED', email, resendIn });
    }
    throw new ApiError(409, 'An account with this email already exists. Log in, or use "Forgot password" if you need a new one.', { code: 'EXISTS' });
  }

  await sendCode(req, { email, dbPurpose: 'register', template: 'register', name: b.fullName });
  res.json({ data: { email, resendIn: RESEND_COOLDOWN_S } });
}));

router.post('/register/resend', asyncRoute(async (req, res) => {
  const email = cleanEmail((req.body || {}).email);
  if (!email) throw new ApiError(400, 'Email is required.');
  // Only an account that is waiting for verification gets a code.
  const customer = await db.get('SELECT full_name, email_verified_at FROM customers WHERE email = $1', [email]);
  if (customer && !customer.email_verified_at) {
    await sendCode(req, { email, dbPurpose: 'register', template: 'register', name: customer.full_name });
  } else {
    noAccountSend(email, 'register');
  }
  res.json({ data: { email, resendIn: RESEND_COOLDOWN_S } });
}));

router.post('/register/verify', asyncRoute(async (req, res) => {
  const { email: rawEmail, code } = req.body || {};
  if (!rawEmail || !code) throw new ApiError(400, 'Email and code are required.');
  const email = cleanEmail(rawEmail);
  const result = await checkOtp(email, 'register', code);
  if (!result.ok) throw codeError(result);
  // Marks the email verified and tells us whether it already was — one statement.
  const customer = await db.get(
    `UPDATE customers c SET email_verified_at = COALESCE(c.email_verified_at, NOW())
     FROM (SELECT id, email_verified_at AS was FROM customers WHERE email = $1) old
     WHERE c.id = old.id
     RETURNING c.*, old.was AS was_verified_at`, [email]);
  const firstTime = customer && !customer.was_verified_at;

  if (firstTime) {
    const origin = siteOrigin(req);
    // Confirmation to the customer, and a heads-up for whoever approves accounts.
    sendMailInBackground(() => T.registrationReceivedEmail({ name: customer.full_name, origin, customerCode: customerCode(customer.id) }).then((m) => ({ to: email, ...m })));
    sendMailInBackground(async () => {
      const brand = await T.getBrand();
      if (!brand.deskEmail) return null;
      const m = await T.newApplicationDeskEmail({ customer, origin });
      return { to: brand.deskEmail, replyTo: email, ...m };
    });
  }
  res.json({ data: { verified: true, status: customer ? customer.status : 'pending' } });
}));

router.post('/login', asyncRoute(async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) throw new ApiError(400, 'Email and password are required.');
  const customer = await db.get('SELECT * FROM customers WHERE email = $1', [cleanEmail(email)]);
  if (!customer || !verifyPassword(password, customer.password_hash)) {
    throw new ApiError(401, 'Incorrect email or password.');
  }
  // Only after the password is right: an unverified email is finished here
  // (the page shows the code step) instead of leaving the customer stuck.
  if (!customer.email_verified_at && customer.status === 'pending') {
    let resendIn = RESEND_COOLDOWN_S;
    try {
      await sendCode(req, { email: customer.email, dbPurpose: 'register', template: 'register', name: customer.full_name });
    } catch (err) {
      if (err.status !== 429) throw err;
      resendIn = err.extra.retryAfter;
    }
    throw new ApiError(403, "Please verify your email first — we've sent a 6-digit code to your inbox.", { code: 'UNVERIFIED', email: customer.email, resendIn });
  }
  // Only 'pending' and 'rejected' are blocked here; suspension is enforced
  // by requireCustomer on the next request (unchanged behaviour).
  if (customer.status === 'pending') {
    throw new ApiError(403, "Your account is pending admin approval. You'll be notified by email once access is granted.", { code: 'PENDING' });
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
  await sendCode(req, { email: req.customer.email, dbPurpose: 'reset', template: 'change', name: req.customer.full_name });
  res.json({ data: { sent: true, resendIn: RESEND_COOLDOWN_S } });
}));

router.post('/change-password/verify', requireCustomer, asyncRoute(async (req, res) => {
  const { code, newPassword } = req.body || {};
  if (!code || !newPassword) throw new ApiError(400, 'Code and new password are required.');
  checkPassword(newPassword);
  const result = await checkOtp(req.customer.email, 'reset', code);
  if (!result.ok) throw codeError(result);
  await db.query(`UPDATE customers SET password_hash = $1, updated_at = NOW() WHERE id = $2`, [hashPassword(newPassword), req.customer.id]);
  const origin = siteOrigin(req);
  const { email, full_name: name } = req.customer;
  sendMailInBackground(() => T.passwordChangedEmail({ name, origin }).then((m) => ({ to: email, ...m })));
  res.json({ data: { changed: true } });
}));

router.post('/forgot', asyncRoute(async (req, res) => {
  const email = cleanEmail((req.body || {}).email);
  if (!email || !EMAIL_RE.test(email)) throw new ApiError(400, 'Please enter a valid email address.');
  const customer = await db.get('SELECT full_name FROM customers WHERE email = $1', [email]);
  // Same response whether or not the account exists (no user enumeration).
  if (customer) await sendCode(req, { email, dbPurpose: 'reset', template: 'reset', name: customer.full_name });
  else noAccountSend(email, 'reset');
  res.json({ data: { sent: true, resendIn: RESEND_COOLDOWN_S } });
}));

// Checks the code without using it up, so the next step (/reset) can.
// Wrong guesses still count towards the attempt limit.
router.post('/forgot/verify', asyncRoute(async (req, res) => {
  const { email, code } = req.body || {};
  if (!email || !code) throw new ApiError(400, 'Email and code are required.');
  const result = await checkOtp(cleanEmail(email), 'reset', code, { consume: false });
  if (!result.ok) throw codeError(result);
  res.json({ data: { valid: true } });
}));

router.post('/reset', asyncRoute(async (req, res) => {
  const { email: rawEmail, code, newPassword } = req.body || {};
  if (!rawEmail || !code || !newPassword) throw new ApiError(400, 'Email, code and new password are required.');
  checkPassword(newPassword);
  const email = cleanEmail(rawEmail);
  const result = await checkOtp(email, 'reset', code);
  if (!result.ok) throw codeError(result);
  const row = await db.get('UPDATE customers SET password_hash = $1, updated_at = NOW() WHERE email = $2 RETURNING full_name', [hashPassword(newPassword), email]);
  if (!row) throw new ApiError(404, 'No account found for this email.');
  const origin = siteOrigin(req);
  sendMailInBackground(() => T.passwordChangedEmail({ name: row.full_name, origin }).then((m) => ({ to: email, ...m })));
  res.json({ data: { reset: true } });
}));

module.exports = router;
