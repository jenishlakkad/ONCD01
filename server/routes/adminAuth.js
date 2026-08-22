const express = require('express');
const db = require('../db/connection');
const { hashPassword, verifyPassword } = require('../lib/password');
const { createOtp, verifyOtp } = require('../lib/otp');
const { sendMail } = require('../lib/mailer');
const { asyncRoute, ApiError } = require('../middleware/errorHandler');
const requireAdmin = require('../middleware/requireAdmin');

const router = express.Router();

router.post('/login', asyncRoute(async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) throw new ApiError(400, 'Email and password are required.');
  const admin = db.prepare('SELECT * FROM admin_users WHERE email = ?').get(String(email).trim().toLowerCase());
  if (!admin || !verifyPassword(password, admin.password_hash)) {
    throw new ApiError(401, 'Incorrect email or password.');
  }
  if (admin.status === 'suspended') throw new ApiError(403, 'This admin account has been suspended.');
  req.session.adminId = admin.id;
  const role = db.prepare('SELECT name FROM roles WHERE id = ?').get(admin.role_id);
  res.json({ data: { id: admin.id, fullName: admin.full_name, email: admin.email, role: role ? role.name : null } });
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
  const admin = db.prepare('SELECT * FROM admin_users WHERE id = ?').get(req.adminUser.id);
  if (!verifyPassword(currentPassword, admin.password_hash)) throw new ApiError(401, 'Current password is incorrect.');
  db.prepare('UPDATE admin_users SET password_hash = ? WHERE id = ?').run(hashPassword(newPassword), admin.id);
  res.json({ data: { changed: true } });
}));

router.post('/forgot', asyncRoute(async (req, res) => {
  const email = String((req.body || {}).email || '').trim().toLowerCase();
  const admin = email ? db.prepare('SELECT id FROM admin_users WHERE email = ?').get(email) : null;
  // Always respond 200 regardless of whether the account exists (no user enumeration).
  if (admin) {
    const code = createOtp(email, 'admin_reset');
    await sendMail({ to: email, subject: 'Reset your Aurum & Co. admin password', text: `Your password reset code is ${code}. It expires in 10 minutes.` });
  }
  res.json({ data: { sent: true } });
}));

router.post('/forgot/verify', asyncRoute(async (req, res) => {
  const { email, code } = req.body || {};
  if (!email || !code) throw new ApiError(400, 'Email and code are required.');
  const row = db.prepare(
    `SELECT * FROM otp_tokens WHERE email = ? AND purpose = 'admin_reset' AND consumed_at IS NULL ORDER BY id DESC LIMIT 1`
  ).get(String(email).trim().toLowerCase());
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
  const ok = verifyOtp(String(email).trim().toLowerCase(), 'admin_reset', code);
  if (!ok) throw new ApiError(400, 'Invalid or expired code.');
  const info = db.prepare('UPDATE admin_users SET password_hash = ? WHERE email = ?')
    .run(hashPassword(newPassword), String(email).trim().toLowerCase());
  if (info.changes === 0) throw new ApiError(404, 'No admin account found for this email.');
  res.json({ data: { reset: true } });
}));

module.exports = router;
