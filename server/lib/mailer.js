const nodemailer = require('nodemailer');
const env = require('../config/env');

const hasSmtp = !!(env.smtp.host && env.smtp.user && env.smtp.pass);

const transporter = hasSmtp
  ? nodemailer.createTransport({
      host: env.smtp.host,
      port: env.smtp.port,
      secure: env.smtp.secure,
      auth: { user: env.smtp.user, pass: env.smtp.pass },
    })
  : null;

// Sends real email when SMTP is configured; otherwise logs to the server
// console so registration/reset flows stay fully testable without credentials.
async function sendMail({ to, subject, text }) {
  if (!transporter) {
    console.log(`[mailer:dev-mode] To: ${to} | Subject: ${subject}\n${text}`);
    return { devMode: true };
  }
  try {
    await transporter.sendMail({ from: env.smtp.from, to, subject, text });
    return { devMode: false };
  } catch (err) {
    console.error('[mailer] send failed, falling back to console:', err.message);
    console.log(`[mailer:dev-mode-fallback] To: ${to} | Subject: ${subject}\n${text}`);
    return { devMode: true, error: err.message };
  }
}

module.exports = { sendMail, hasSmtp };
