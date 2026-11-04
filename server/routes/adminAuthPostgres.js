const express = require('express');
const db = require('../db/postgres');
const { hashPassword, verifyPassword } = require('../lib/password');
const { createOtp, checkOtp, cooldownLeft, noteIssued, OtpRateError, OTP_TTL_MINUTES, RESEND_COOLDOWN_S } = require('../lib/otpPostgres');
const { sendMailInBackground } = require('../lib/mailer');
const T = require('../lib/emailTemplates');
const { siteOrigin } = require('../lib/messaging');
const { asyncRoute, ApiError } = require('../middleware/errorHandler');
const requireAdmin = require('../middleware/requireAdminPostgres');

// Admin sign-in, password change and password reset (emailed code).

const router = express.Router();

router.post('/login', asyncRoute(async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) throw new ApiError(400, 'Email and password are required.');
  const admin = await db.get('SELECT * FROM admin_users WHERE email = $1', [String(email).trim().toLowerCase()]);
  if (!admin || !verifyPassword(password, admin.password_hash)) {
    throw new ApiError(401, 'Incorrect email or password.');
  }
  if (admin.status === 'suspended') throw new ApiError(403, 'This admin account has been suspended.');
  req.session.adminId = Number(admin.id);
  const role = await db.get('SELECT name FROM roles WHERE id = $1', [admin.role_id]);
  res.json({ data: { id: Number(admin.id), fullName: admin.full_name, email: admin.email, role: role ? role.name : null } });
}));

router.post('/logout', (req, res) => {
  req.session.adminId = null;
  res.json({ data: { loggedOut: true } });
});

router.get('/me', requireAdmin, (req, res) => {
  res.json({
    data: {
      id: req.adminUser.id,
      fullName: req.adminUser.full_name,
      email: req.adminUser.email,
      role: req.adminRole ? req.adminRole.name : null,
      permissions: req.adminPermissions,
    },
  });
});

router.post('/change-password', requireAdmin, asyncRoute(async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || !newPassword) throw new ApiError(400, 'Current and new password are required.');
  if (newPassword.length < 8) throw new ApiError(400, 'New password must be at least 8 characters.');
  const admin = await db.get('SELECT * FROM admin_users WHERE id = $1', [req.adminUser.id]);
  if (!verifyPassword(currentPassword, admin.password_hash)) throw new ApiError(401, 'Current password is incorrect.');
  await db.query('UPDATE admin_users SET password_hash = $1 WHERE id = $2', [hashPassword(newPassword), admin.id]);
  res.json({ data: { changed: true } });
}));

// Codes are emailed in the background (the response doesn't wait for the
// mail server) with a resend cooldown — see server/lib/otpPostgres.js.
router.post('/forgot', asyncRoute(async (req, res) => {
  const email = String((req.body || {}).email || '').trim().toLowerCase();
  if (!email) throw new ApiError(400, 'Email is required.');
  const admin = await db.get('SELECT id, full_name FROM admin_users WHERE email = $1', [email]);
  // Same response (and cooldown) whether or not the account exists.
  if (admin) {
    let code;
    try {
      code = await createOtp(email, 'admin_reset');
    } catch (err) {
      if (err instanceof OtpRateError) throw new ApiError(429, err.message, { retryAfter: err.retryAfter });
      throw err;
    }
    const origin = siteOrigin(req);
    sendMailInBackground(() => T.otpEmail({ purpose: 'admin_reset', code, name: admin.full_name, origin, minutes: OTP_TTL_MINUTES }).then((m) => ({ to: email, ...m })));
  } else {
    const wait = cooldownLeft(email, 'admin_reset');
    if (wait > 0) throw new ApiError(429, `Please wait ${wait} seconds before requesting another code.`, { retryAfter: wait });
    noteIssued(email, 'admin_reset');
  }
  res.json({ data: { sent: true, resendIn: RESEND_COOLDOWN_S } });
}));

router.post('/forgot/verify', asyncRoute(async (req, res) => {
  const { email, code } = req.body || {};
  if (!email || !code) throw new ApiError(400, 'Email and code are required.');
  // Checked without being used up (the /reset step uses it); wrong
  // guesses still count towards the attempt limit.
  const result = await checkOtp(String(email).trim().toLowerCase(), 'admin_reset', code, { consume: false });
  if (!result.ok) throw new ApiError(400, result.message, { reason: result.reason });
  res.json({ data: { valid: true } });
}));

router.post('/reset', asyncRoute(async (req, res) => {
  const { email, code, newPassword } = req.body || {};
  if (!email || !code || !newPassword) throw new ApiError(400, 'Email, code and new password are required.');
  if (newPassword.length < 8) throw new ApiError(400, 'Password must be at least 8 characters.');
  const addr = String(email).trim().toLowerCase();
  const check = await checkOtp(addr, 'admin_reset', code);
  if (!check.ok) throw new ApiError(400, check.message, { reason: check.reason });
  const row = await db.get('UPDATE admin_users SET password_hash = $1 WHERE email = $2 RETURNING full_name', [hashPassword(newPassword), addr]);
  if (!row) throw new ApiError(404, 'No admin account found for this email.');
  const origin = siteOrigin(req);
  sendMailInBackground(() => T.passwordChangedEmail({ name: row.full_name, origin, admin: true }).then((m) => ({ to: addr, ...m })));
  res.json({ data: { reset: true } });
}));

module.exports = router;
