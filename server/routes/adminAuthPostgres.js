const express = require('express');
const db = require('../db/postgres');
const { hashPassword, verifyPassword } = require('../lib/password');
const { createOtp, verifyOtp } = require('../lib/otpPostgres');
const { sendMail } = require('../lib/mailer');
const { asyncRoute, ApiError } = require('../middleware/errorHandler');
const requireAdmin = require('../middleware/requireAdminPostgres');

// PostgreSQL counterpart to server/routes/adminAuth.js (SQLite). Parallel/
// isolated test route file only — NOT mounted in app.js, NOT reachable by
// any real request. Exists so it can be exercised on its own before any
// cutover decision is made.

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

router.post('/forgot', asyncRoute(async (req, res) => {
  const email = String((req.body || {}).email || '').trim().toLowerCase();
  const admin = email ? await db.get('SELECT id FROM admin_users WHERE email = $1', [email]) : null;
  // Always respond 200 regardless of whether the account exists (no user enumeration).
  if (admin) {
    const code = await createOtp(email, 'admin_reset');
    await sendMail({ to: email, subject: 'Reset your ONCD admin password', text: `Your password reset code is ${code}. It expires in 10 minutes.` });
  }
  res.json({ data: { sent: true } });
}));

router.post('/forgot/verify', asyncRoute(async (req, res) => {
  const { email, code } = req.body || {};
  if (!email || !code) throw new ApiError(400, 'Email and code are required.');
  const row = await db.get(
    `SELECT * FROM otp_tokens WHERE email = $1 AND purpose = 'admin_reset' AND consumed_at IS NULL ORDER BY id DESC LIMIT 1`,
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
  if (newPassword.length < 8) throw new ApiError(400, 'Password must be at least 8 characters.');
  const ok = await verifyOtp(String(email).trim().toLowerCase(), 'admin_reset', code);
  if (!ok) throw new ApiError(400, 'Invalid or expired code.');
  const result = await db.query('UPDATE admin_users SET password_hash = $1 WHERE email = $2', [hashPassword(newPassword), String(email).trim().toLowerCase()]);
  if (result.rowCount === 0) throw new ApiError(404, 'No admin account found for this email.');
  res.json({ data: { reset: true } });
}));

module.exports = router;
