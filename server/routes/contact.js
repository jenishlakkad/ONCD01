const express = require('express');
const db = require('../db/connection');
const { asyncRoute, ApiError } = require('../middleware/errorHandler');
const { sendMail } = require('../lib/mailer');

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
  const info = db.prepare(
    `INSERT INTO contact_messages (customer_id, full_name, email, phone, subject, message, status)
     VALUES (?, ?, ?, ?, ?, ?, 'new')`
  ).run(customerId, fullName, email, phone, subject, message);

  const settings = db.prepare('SELECT * FROM site_settings WHERE id = 1').get() || {};
  const notifyTo = settings.inquiry_email || settings.support_email;
  if (notifyTo) {
    sendMail({
      to: notifyTo,
      subject: `New contact message: ${subject}`,
      text: `From: ${fullName} <${email}>\nPhone: ${phone}\n\n${message}`,
    }).catch(() => {});
  }

  res.status(201).json({ data: { id: info.lastInsertRowid } });
}));

module.exports = router;
