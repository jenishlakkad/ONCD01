const nodemailer = require('nodemailer');
const env = require('../config/env');

// Two ways to send, picked automatically:
//
//  1. Brevo's HTTPS email API, when BREVO_API_KEY is set. Use this on the
//     live site: Render's free plan blocks every outgoing SMTP port (25, 465,
//     587) since Sept 2025, so Gmail SMTP silently times out there. An HTTPS
//     API goes out on port 443, which is never blocked.
//  2. SMTP (Gmail etc.), when SMTP_HOST/USER/PASS are set: fine locally or
//     on any host that allows SMTP. Also the fallback if Brevo fails.
//
// With neither, mail is printed to the server console (dev mode).

const BREVO_URL = 'https://api.brevo.com/v3/smtp/email';
const hasBrevo = !!env.brevoApiKey;
const hasSmtp = !!(env.smtp.host && env.smtp.user && env.smtp.pass);

// One pooled connection that stays open between messages: the TLS + login
// handshake with Gmail (~1s) is paid once, not on every code or reply.
// Short timeouts so a blocked port fails in seconds, not minutes.
const transporter = hasSmtp
  ? nodemailer.createTransport({
      pool: true,
      maxConnections: 2,
      maxMessages: 200,
      host: env.smtp.host,
      port: env.smtp.port,
      secure: env.smtp.secure,
      auth: { user: env.smtp.user, pass: env.smtp.pass },
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 20000,
    })
  : null;

// The sending ADDRESS comes from MAIL_FROM / SMTP_FROM (with Brevo it must be
// a sender verified in the Brevo account; with SMTP it must match the SMTP
// login). The display NAME is the site name from Admin > Settings, so mail
// never goes out under a stale name left in .env.
function fromAddress() {
  const m = /<([^>]+)>/.exec(env.mailFrom);
  return (m ? m[1] : env.mailFrom || env.smtp.user || '').trim();
}
let brandName = 'ONCD';
function setSenderName(name) {
  if (name && String(name).trim()) brandName = String(name).trim().slice(0, 60);
}
function from() {
  const addr = fromAddress();
  return addr ? { name: brandName, address: addr } : env.mailFrom;
}

// "a@x.com", "Name <a@x.com>", { name, address } or a list of those -> [{ email, name? }]
function toRecipients(v) {
  const list = Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : [v];
  return list
    .map((r) => {
      if (!r) return null;
      if (typeof r === 'object') return r.address ? { email: r.address, ...(r.name ? { name: r.name } : {}) } : null;
      const s = String(r).trim();
      const m = /^(.*)<([^>]+)>$/.exec(s);
      if (m) return { email: m[2].trim(), ...(m[1].trim() ? { name: m[1].trim().replace(/^"|"$/g, '') } : {}) };
      return s ? { email: s } : null;
    })
    .filter(Boolean);
}

async function sendViaBrevo({ to, subject, text, html, replyTo }) {
  const sender = { name: brandName, email: fromAddress() };
  if (!sender.email) throw new Error('MAIL_FROM (or SMTP_FROM) is not set');
  const body = { sender, to: toRecipients(to), subject };
  if (html) body.htmlContent = html;
  if (text) body.textContent = text;
  const reply = replyTo ? toRecipients(replyTo)[0] : null;
  if (reply) body.replyTo = reply;
  const res = await fetch(BREVO_URL, {
    method: 'POST',
    headers: { 'api-key': env.brevoApiKey, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Brevo ${res.status}: ${detail.slice(0, 300)}`);
  }
}

// Sends real email when a provider is configured; otherwise logs to the
// server console so registration/reset flows stay testable without one.
// Accepts { to, subject, text, html, replyTo }.
async function sendMail(message) {
  const { to, subject, text, html, replyTo } = message;
  const errors = [];
  if (hasBrevo) {
    try {
      await sendViaBrevo(message);
      return { devMode: false, via: 'brevo' };
    } catch (err) {
      errors.push(err.message);
      console.error('[mailer] Brevo send failed:', err.message);
    }
  }
  if (transporter) {
    try {
      await transporter.sendMail({ from: from(), to, subject, text, html, replyTo: replyTo || undefined });
      return { devMode: false, via: 'smtp' };
    } catch (err) {
      errors.push(err.message);
      console.error('[mailer] SMTP send failed:', err.message);
    }
  }
  if (!hasBrevo && !transporter) {
    console.log(`[mailer:dev-mode] To: ${to} | Subject: ${subject}\n${text}`);
    return { devMode: true };
  }
  console.error(`[mailer] NOT DELIVERED to ${typeof to === 'string' ? to : JSON.stringify(to)} | ${subject}`);
  return { devMode: true, error: errors.join(' / ') };
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

// Startup check, so a misconfiguration shows up in the server log right
// away instead of when a customer is waiting for a code.
function warmUp() {
  if (hasBrevo) {
    fetch('https://api.brevo.com/v3/account', {
      headers: { 'api-key': env.brevoApiKey, accept: 'application/json' },
      signal: AbortSignal.timeout(15000),
    })
      .then((r) => (r.ok
        ? console.log(`[mailer] Brevo email API ready (sending as ${fromAddress() || 'MAIL_FROM NOT SET'})`)
        : console.error(`[mailer] Brevo API key rejected (HTTP ${r.status}) — check BREVO_API_KEY`)))
      .catch((err) => console.error('[mailer] Brevo not reachable:', err.message));
    return; // SMTP stays as a silent fallback; on Render it can't connect anyway.
  }
  if (!transporter) {
    console.log('[mailer] no email provider configured — codes are printed to this console');
    return;
  }
  transporter.verify().then(
    () => console.log('[mailer] SMTP connection ready'),
    (err) => console.error(
      '[mailer] SMTP not reachable:', err.message,
      process.env.RENDER ? '— Render blocks SMTP ports on the free plan; set BREVO_API_KEY to send over HTTPS.' : '',
    ),
  );
}

module.exports = { sendMail, sendMailInBackground, warmUp, setSenderName, hasSmtp, hasBrevo };
