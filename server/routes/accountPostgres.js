const express = require('express');
const db = require('../db/postgres');
const { asyncRoute, ApiError } = require('../middleware/errorHandler');
const requireCustomer = require('../middleware/requireCustomerPostgres');
const { loadAccountSnapshot } = require('../lib/accountSnapshot');
const {
  getMessagingSchema, cleanBody, siteOrigin, notifyDesk, inquiryLabel, customerRateLimited, NEWSLETTER_SUBJECT,
} = require('../lib/messaging');

// The customer account dashboard (Dashboard.dc.html) loads everything it
// shows from this one endpoint — see lib/accountSnapshot.js for why it's a
// single query. Writes still go through the existing routes (PUT
// /api/auth/profile, /api/saved-items, /api/cart, ...).

const router = express.Router();

// Same outcomes as middleware/requireCustomerPostgres.js, but checked on the
// snapshot itself so the session check doesn't cost its own round trip.
const BLOCKED_MESSAGES = {
  pending: "Your account is pending admin approval. You'll be notified by email once access is granted.",
  rejected: 'This account has been rejected.',
  suspended: 'This account has been suspended.',
};

router.get('/dashboard', asyncRoute(async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const id = req.session && req.session.customerId;
  if (!id) return res.status(401).json({ error: 'Not logged in.' });

  const snapshot = await loadAccountSnapshot(id);
  if (!snapshot) {
    req.session.customerId = null;
    return res.status(401).json({ error: 'Not logged in.' });
  }
  if (snapshot.me.status !== 'approved') {
    req.session.customerId = null;
    return res.status(403).json({
      error: BLOCKED_MESSAGES[snapshot.me.status] || 'This account is not eligible to log in.',
      status: snapshot.me.status,
    });
  }
  res.json({ data: { ...snapshot, serverTime: new Date().toISOString() } });
}));

// ---- Conversations ----------------------------------------------------
// The customer's side of each thread. Posting puts the conversation back
// into the desk's queue ("Awaiting reply" / "New") and emails the desk a
// link straight to it.

const idParam = (v) => (/^\d+$/.test(String(v)) ? String(v) : null);

function requireBody(req) {
  const body = cleanBody((req.body || {}).message);
  if (!body) throw new ApiError(400, 'Write a message before sending.');
  return body;
}

router.post('/inquiries/:id/messages', requireCustomer, asyncRoute(async (req, res) => {
  const schema = await getMessagingSchema();
  if (!schema.inquiryThreads) throw new ApiError(409, 'Messaging is not available yet.');
  const id = idParam(req.params.id);
  const inquiry = id && await db.get('SELECT id, ref, status FROM inquiries WHERE id = $1 AND customer_id = $2', [id, req.customer.id]);
  if (!inquiry) throw new ApiError(404, 'Inquiry not found.');
  const body = requireBody(req);
  if (customerRateLimited(req.customer.id)) throw new ApiError(429, 'You have sent a lot of messages in the last hour. Please try again a little later.');

  const message = await db.transaction(async (client) => {
    const r = await client.query(
      `INSERT INTO inquiry_messages (inquiry_id, sender, author_name, body) VALUES ($1, 'customer', $2, $3)
       RETURNING id, sender, author_name AS author, body, created_at AS "createdAt"`,
      [inquiry.id, req.customer.full_name, body]
    );
    // A customer message always means "over to you" for the desk, including
    // on an inquiry that was replied to or closed.
    await client.query("UPDATE inquiries SET status = 'pending', updated_at = NOW() WHERE id = $1", [inquiry.id]);
    return r.rows[0];
  });

  const company = req.customer.company_name ? ` (${req.customer.company_name})` : '';
  notifyDesk({
    subject: `New message on inquiry ${inquiryLabel(inquiry)} from ${req.customer.full_name}`,
    text: `${req.customer.full_name}${company} wrote:\n\n${body}\n\nOpen the conversation: ${siteOrigin(req)}/AdminInquiries.dc.html?id=${inquiry.id}`,
  });
  res.status(201).json({ data: { ...message, id: Number(message.id), status: 'pending' } });
}));

// "Mark as resolved" from the customer's side. Sending a new message
// reopens it.
router.post('/inquiries/:id/close', requireCustomer, asyncRoute(async (req, res) => {
  const schema = await getMessagingSchema();
  const id = idParam(req.params.id);
  const inquiry = id && await db.get('SELECT id FROM inquiries WHERE id = $1 AND customer_id = $2', [id, req.customer.id]);
  if (!inquiry) throw new ApiError(404, 'Inquiry not found.');
  await db.query(
    schema.inquiryRefs ? "UPDATE inquiries SET status = 'closed', updated_at = NOW() WHERE id = $1" : "UPDATE inquiries SET status = 'closed' WHERE id = $1",
    [inquiry.id]
  );
  res.json({ data: { id: Number(inquiry.id), status: 'closed' } });
}));

router.post('/messages/:id/replies', requireCustomer, asyncRoute(async (req, res) => {
  const schema = await getMessagingSchema();
  if (!schema.contactReplies) throw new ApiError(409, 'Messaging is not available yet.');
  const id = idParam(req.params.id);
  const msg = id && await db.get(
    `SELECT id, subject FROM contact_messages
     WHERE id = $1 AND subject <> $3 AND (customer_id = $2 OR (customer_id IS NULL AND lower(email) = lower($4)))`,
    [id, req.customer.id, NEWSLETTER_SUBJECT, req.customer.email]
  );
  if (!msg) throw new ApiError(404, 'Message not found.');
  const body = requireBody(req);
  if (customerRateLimited(req.customer.id)) throw new ApiError(429, 'You have sent a lot of messages in the last hour. Please try again a little later.');

  const reply = await db.transaction(async (client) => {
    const r = await client.query(
      `INSERT INTO contact_message_replies (message_id, admin_name, body, sender) VALUES ($1, $2, $3, 'customer')
       RETURNING id, sender, admin_name AS author, body, created_at AS "createdAt"`,
      [msg.id, req.customer.full_name, body]
    );
    // Back to "New" so it shows in the desk's unread badge again; the
    // conversation is also claimed for the account if it was sent as a guest.
    await client.query("UPDATE contact_messages SET status = 'new', customer_id = COALESCE(customer_id, $2), updated_at = NOW() WHERE id = $1", [msg.id, req.customer.id]);
    return r.rows[0];
  });

  notifyDesk({
    subject: `Re: ${msg.subject} (reply from ${req.customer.full_name})`,
    text: `${req.customer.full_name} replied:\n\n${body}\n\nOpen the conversation: ${siteOrigin(req)}/AdminContact.dc.html?id=${msg.id}`,
  });
  res.status(201).json({ data: { ...reply, id: Number(reply.id), status: 'new' } });
}));

module.exports = router;
