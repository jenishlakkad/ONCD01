const nodemailer = require('nodemailer');
const env = require('../config/env');

const hasSmtp = !!(env.smtp.host && env.smtp.user && env.smtp.pass);

// One pooled connection that stays open between messages: the TLS + login
// handshake with Gmail (~1s) is paid once, not on every code or reply.
const transporter = hasSmtp
  ? nodemailer.createTransport({
      pool: true,
      maxConnections: 2,
      maxMessages: 200,
      host: env.smtp.host,
      port: env.smtp.port,
      secure: env.smtp.secure,
      auth: { user: env.smtp.user, pass: env.smtp.pass },
    })
  : null;

// The sending ADDRESS comes from SMTP_FROM (it must match the SMTP account);
// the display NAME is the site name from Admin > Settings, so mail never
// goes out under a stale name left in .env.
function fromAddress() {
  const m = /<([^>]+)>/.exec(env.smtp.from);
  return (m ? m[1] : env.smtp.from || env.smtp.user || '').trim();
}
let brandName = 'ONCD';
function setSenderName(name) {
  if (name && String(name).trim()) brandName = String(name).trim().slice(0, 60);
}
function from() {
  const addr = fromAddress();
  return addr ? { name: brandName, address: addr } : env.smtp.from;
}

// Sends real email when SMTP is configured; otherwise logs to the server
// console so registration/reset flows stay fully testable without credentials.
// Accepts { to, subject, text, html, replyTo }.
async function sendMail({ to, subject, text, html, replyTo }) {
  if (!transporter) {
    console.log(`[mailer:dev-mode] To: ${to} | Subject: ${subject}\n${text}`);
    return { devMode: true };
  }
  try {
    await transporter.sendMail({ from: from(), to, subject, text, html, replyTo: replyTo || undefined });
    return { devMode: false };
  } catch (err) {
    console.error('[mailer] send failed, falling back to console:', err.message);
    console.log(`[mailer:dev-mode-fallback] To: ${to} | Subject: ${subject}\n${text}`);
    return { devMode: true, error: err.message };
  }
}

// For mail the request shouldn't wait on (verification codes, desk alerts,
// confirmations): the response goes back at once and the message follows
// a moment later. Goes through module.exports so a test harness that swaps
// sendMail also captures these.
// `message` may also be a function returning (a promise of) the message,
// so building the email from a template happens off the request too.
function sendMailInBackground(message) {
  setImmediate(() => {
    Promise.resolve()
      .then(() => (typeof message === 'function' ? message() : message))
      .then((m) => (m && m.to ? module.exports.sendMail(m) : null))
      .catch((err) => console.error('[mailer] background send failed:', err && err.message));
  });
}

// Opens the pooled connection at startup so even the first code of the day
// goes out without the handshake delay.
function warmUp() {
  if (!transporter) return;
  transporter.verify().then(
    () => console.log('[mailer] SMTP connection ready'),
    (err) => console.error('[mailer] SMTP not reachable yet:', err.message),
  );
}

module.exports = { sendMail, sendMailInBackground, warmUp, setSenderName, hasSmtp };
