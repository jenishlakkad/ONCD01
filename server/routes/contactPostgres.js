const express = require('express');
const db = require('../db/postgres');
const { asyncRoute, ApiError } = require('../middleware/errorHandler');
const { sendMail } = require('../lib/mailer');

// PostgreSQL counterpart to server/routes/contact.js (SQLite). Parallel/
// isolated file only — NOT mounted in app.js.
//
// Current behavior confirmed by re-reading the source: this is a fully
// public route (no auth middleware at all) that optionally associates the
// message with `req.session.customerId` if a session happens to be present,
// but never requires one. Notification email is fire-and-forget
// (`.catch(() => {})`, not awaited) — a failed notify email never affects
// the HTTP response, preserved exactly, not upgraded to `await`.

const router = express.Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validate(b) {
  const fullName = String(b.fullName || '').trim();
  const email = String(b.email || '').trim();
  const phone = String(b.phone || '').trim();
  const subject = String(b.subject || '').trim();
  const message = String(b.message || '').trim();

  if (!fullName) return { error: 'Full name is required.' };
  if (!email) return { error: 'Email is required.' };
  if (!EMAIL_RE.test(email)) return { error: 'Please enter a valid email address.' };
  if (!phone) return { error: 'Phone is required.' };
  if (phone.replace(/\D/g, '').length < 6) return { error: 'Please enter a valid phone number.' };
  if (!subject) return { error: 'Subject is required.' };
  if (!message) return { error: 'Message is required.' };
  if (message.length < 10) return { error: 'Please add a few more details to your message (at least 10 characters).' };

  return { fullName, email, phone, subject, message };
}

router.post('/', asyncRoute(async (req, res) => {
  const result = validate(req.body || {});
  if (result.error) throw new ApiError(400, result.error);
  const { fullName, email, phone, subject, message } = result;

  const customerId = req.session && req.session.customerId ? req.session.customerId : null;
  const inserted = await db.get(
    `INSERT INTO contact_messages (customer_id, full_name, email, phone, subject, message, status)
     VALUES ($1, $2, $3, $4, $5, $6, 'new') RETURNING id`,
    [customerId, fullName, email, phone, subject, message]
  );

  const settings = (await db.get('SELECT * FROM site_settings WHERE id = 1')) || {};
  const notifyTo = settings.inquiry_email || settings.support_email;
  if (notifyTo) {
    sendMail({
      to: notifyTo,
      subject: `New contact message: ${subject}`,
      text: `From: ${fullName} <${email}>\nPhone: ${phone}\n\n${message}`,
    }).catch(() => {});
  }

  // contact_messages.id is BIGINT -> pg returns it as a string; Number(...)
  // keeps the response shape identical to the SQLite version's lastInsertRowid.
  res.status(201).json({ data: { id: Number(inserted.id) } });
}));

module.exports = router;
