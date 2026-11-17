const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

function bool(v, fallback) {
  if (v === undefined || v === '') return fallback;
  return v === 'true' || v === '1';
}

module.exports = {
  port: Number(process.env.PORT) || 8843,
  sessionSecret: process.env.SESSION_SECRET || 'dev-only-insecure-secret-change-me',
  nodeEnv: process.env.NODE_ENV || 'development',
  rootDir: path.join(__dirname, '..', '..'),
  uploadsDir: path.join(__dirname, '..', '..', 'uploads'),
  // Brevo HTTPS email API (needed on Render's free plan, which blocks SMTP).
  brevoApiKey: (process.env.BREVO_API_KEY || '').trim(),
  // Sender address for all mail. Falls back to SMTP_FROM.
  mailFrom: process.env.MAIL_FROM || process.env.SMTP_FROM || 'ONCD <no-reply@oncd.com>',
  smtp: {
    host: process.env.SMTP_HOST || '',
    port: Number(process.env.SMTP_PORT) || 587,
    secure: bool(process.env.SMTP_SECURE, false),
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.SMTP_FROM || 'ONCD <no-reply@oncd.com>',
  },
};
