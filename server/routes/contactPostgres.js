const express = require('express');
const db = require('../db/postgres');
const { asyncRoute, ApiError } = require('../middleware/errorHandler');
const { sendMailInBackground } = require('../lib/mailer');
const T = require('../lib/emailTemplates');
const { siteOrigin } = require('../lib/messaging');

// The public contact form. No login needed; a signed-in customer's message
// is linked to their account. Two branded emails go out in the background
// (the visitor never waits on the mail server):
//   * to the sales desk — with Reply-To set to the visitor, so "Reply" in
//     the inbox answers them directly;
//   * to the visitor — a short "we've got it" with the reference number.
// Rate-limited per visitor, and the confirmation goes to an address at most
// once an hour, so the form can't be turned into a mail cannon.

const router = express.Router();

const hits = new Map(); // ip -> [timestamps]
function tooMany(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < 24 * 60 * 60 * 1000);
  const recent = list.filter((t) => now - t < 10 * 60 * 1000);
  if (recent.length >= 5 || list.length >= 20) return true;
  list.push(now);
  hits.set(ip, list);
  if (hits.size > 10000) hits.clear();
  return false;
}
const acked = new Map(); // email -> time of the last confirmation
function shouldAck(email) {
  const k = email.toLowerCase();
  if (Date.now() - (acked.get(k) || 0) < 60 * 60 * 1000) return false;
  acked.set(k, Date.now());
  if (acked.size > 10000) acked.clear();
  return true;
}

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
  if (tooMany(req.ip || 'unknown')) throw new ApiError(429, "You've sent several messages in a short time. Please wait a few minutes, or message us on WhatsApp.");
  const { fullName, email, phone, subject, message } = result;

  const customerId = req.session && req.session.customerId ? req.session.customerId : null;
  const inserted = await db.get(
    `INSERT INTO contact_messages (customer_id, full_name, email, phone, subject, message, status)
     VALUES ($1, $2, $3, $4, $5, $6, 'new') RETURNING id`,
    [customerId, fullName, email, phone, subject, message]
  );

  // contact_messages.id is BIGINT -> pg returns it as a string.
  const id = Number(inserted.id);
  const origin = siteOrigin(req);
  const isCustomer = !!customerId;
  sendMailInBackground(async () => {
    const brand = await T.getBrand();
    if (!brand.deskEmail) return null;
    const m = await T.contactDeskEmail({ id, fullName, email, phone, subject, message, isCustomer, origin });
    return { to: brand.deskEmail, replyTo: { name: fullName.replace(/[\r\n"]/g, ''), address: email }, ...m };
  });
  if (shouldAck(email)) {
    sendMailInBackground(() => T.contactAckEmail({ id, fullName, origin, isCustomer }).then((m) => ({ to: email, ...m })));
  }

  res.status(201).json({ data: { id } });
}));

module.exports = router;
