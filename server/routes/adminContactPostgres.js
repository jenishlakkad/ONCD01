const express = require('express');
const db = require('../db/postgres');
const { asyncRoute, ApiError } = require('../middleware/errorHandler');
const requireAdmin = require('../middleware/requireAdminPostgres');
const requirePermission = require('../middleware/requirePermission');
const { sendMail } = require('../lib/mailer');
const { writeAudit } = require('../lib/auditPostgres');
const { getMessagingSchema, NEWSLETTER_SUBJECT, siteOrigin } = require('../lib/messaging');

// PostgreSQL counterpart to server/routes/adminContact.js (SQLite). Parallel/
// isolated file only — NOT mounted in app.js.
//
// Current behavior confirmed by re-reading the source, worth stating
// explicitly:
// - POST /:id/reply performs the reply INSERT and the parent-status UPDATE
//   as two SEPARATE statements, NOT wrapped in a shared transaction in the
//   SQLite source (two independent db.prepare(...).run(...) calls). Preserved
//   exactly here as two separate client-less db.query() calls — no
//   db.transaction() invented for this, per instructions.
// - PUT /:id is a genuine no-op quirk when neither `status` nor `adminNotes`
//   is provided: the UPDATE is skipped entirely (sets.length === 0), but
//   writeAudit STILL fires and the route still returns 200 with the
//   unchanged row. Preserved exactly.
// - POST /:id/reply unconditionally forces status to 'replied', even if the
//   message was already 'closed' — preserved exactly, not guarded.
// - sendMail(...) in the reply route IS awaited (unlike contact.js's
//   fire-and-forget notify email) — if it throws, the reply row and status
//   update have already committed (no rollback, since not transactional);
//   the request then surfaces as a 500. Preserved exactly, not wrapped in a
//   try/catch to "fix" this.
// - DELETE /:id relies on contact_message_replies.message_id's
//   ON DELETE CASCADE FK (confirmed identical in both the SQLite schema and
//   the PostgreSQL schema, read-only) to remove replies — no explicit
//   application-level reply cleanup in either version.
// - No pagination/filtering anywhere: GET / always returns every row.

const router = express.Router();

router.use(requireAdmin, requirePermission('contact', 'manage'));

const STATUSES = ['new', 'in_progress', 'replied', 'closed'];

async function messageRow(id) {
  return db.get('SELECT * FROM contact_messages WHERE id = $1', [id]);
}

// NOTE: `AS "adminName"`, `AS "createdAt"` must be double-quoted — Postgres
// folds unquoted identifiers to lowercase. ORDER BY created_at is a
// TIMESTAMPTZ column (not text), so no COLLATE is needed here.
async function repliesFor(id) {
  const schema = await getMessagingSchema();
  const rows = await db.all(
    `SELECT id, admin_name AS "adminName", body, created_at AS "createdAt", ${schema.contactReplies ? 'sender' : "'admin' AS sender"}
     FROM contact_message_replies WHERE message_id = $1 ORDER BY created_at, id`,
    [id]
  );
  return rows.map((r) => ({ ...r, id: Number(r.id) }));
}

// The registered account behind a message: linked when it was sent while
// signed in, otherwise matched on the account email.
async function customerFor(row) {
  const c = row.customer_id
    ? await db.get('SELECT id, full_name, company_name, status FROM customers WHERE id = $1', [row.customer_id])
    : await db.get('SELECT id, full_name, company_name, status FROM customers WHERE lower(email) = lower($1)', [row.email]);
  return c ? { id: Number(c.id), name: c.full_name, company: c.company_name || '', status: c.status } : null;
}

function serialize(row, { replies } = {}) {
  return {
    // contact_messages.id is BIGINT -> Number(...). customer_id is a
    // nullable BIGINT FK -> Number(...) only when not null, so a guest
    // message's customerId stays null rather than becoming 0.
    id: Number(row.id), customerId: row.customer_id === null ? null : Number(row.customer_id),
    fullName: row.full_name, email: row.email, phone: row.phone,
    subject: row.subject, message: row.message,
    status: row.status, adminNotes: row.admin_notes,
    createdAt: row.created_at, updatedAt: row.updated_at,
    kind: row.subject === NEWSLETTER_SUBJECT ? 'newsletter' : 'message',
    replies: replies || undefined,
  };
}

router.get('/', asyncRoute(async (req, res) => {
  const schema = await getMessagingSchema();
  const lastSender = schema.contactReplies
    ? `(SELECT r.sender FROM contact_message_replies r WHERE r.message_id = cm.id ORDER BY r.created_at DESC, r.id DESC LIMIT 1)`
    : `CASE WHEN EXISTS (SELECT 1 FROM contact_message_replies r WHERE r.message_id = cm.id) THEN 'admin' END`;
  const rows = await db.all(
    `SELECT cm.*,
            (SELECT COUNT(*) FROM contact_message_replies r WHERE r.message_id = cm.id) AS reply_count,
            ${lastSender} AS last_sender,
            c.id AS acct_id, c.full_name AS acct_name, c.company_name AS acct_company
     FROM contact_messages cm
     LEFT JOIN customers c ON c.id = COALESCE(cm.customer_id, (SELECT x.id FROM customers x WHERE lower(x.email) = lower(cm.email) LIMIT 1))
     ORDER BY COALESCE(cm.updated_at, cm.created_at) DESC, cm.id DESC`
  );
  res.json({
    data: rows.map((r) => ({
      ...serialize(r), replyCount: Number(r.reply_count), lastSender: r.last_sender || null,
      customer: r.acct_id ? { id: Number(r.acct_id), name: r.acct_name, company: r.acct_company || '' } : null,
    })),
  });
}));

// Sidebar badges on every admin page: unread contact messages (newsletter
// signups aren't conversations, so they don't count) and inquiries waiting
// for the desk.
router.get('/new-count', asyncRoute(async (req, res) => {
  const row = await db.get(
    `SELECT (SELECT COUNT(*) FROM contact_messages WHERE status = 'new' AND subject <> $1) AS n,
            (SELECT COUNT(*) FROM inquiries WHERE status = 'pending') AS inquiries`,
    [NEWSLETTER_SUBJECT]
  );
  res.json({ data: { count: Number(row.n), inquiries: Number(row.inquiries) } });
}));

router.get('/:id', asyncRoute(async (req, res) => {
  const row = await messageRow(req.params.id);
  if (!row) throw new ApiError(404, 'Message not found.');
  res.json({ data: { ...serialize(row, { replies: await repliesFor(row.id) }), customer: await customerFor(row) } });
}));

router.put('/:id', asyncRoute(async (req, res) => {
  const existing = await messageRow(req.params.id);
  if (!existing) throw new ApiError(404, 'Message not found.');
  const { status, adminNotes } = req.body || {};
  if (status !== undefined && !STATUSES.includes(status)) throw new ApiError(400, 'Invalid status.');

  const sets = [];
  const params = [];
  let i = 1;
  if (status !== undefined) { sets.push(`status = $${i++}`); params.push(status); }
  if (adminNotes !== undefined) { sets.push(`admin_notes = $${i++}`); params.push(adminNotes || null); }
  if (sets.length) {
    params.push(existing.id);
    await db.query(`UPDATE contact_messages SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${i}`, params);
  }
  const row = await messageRow(existing.id);
  // Fires unconditionally, even when sets.length === 0 (no-op update) —
  // preserved exactly, not gated on an actual change having occurred.
  await writeAudit({ actor: req.adminUser.full_name, action: 'Updated contact message', target: row.subject, module: 'Contact' });
  res.json({ data: { ...serialize(row, { replies: await repliesFor(row.id) }), customer: await customerFor(row) } });
}));

router.post('/:id/reply', asyncRoute(async (req, res) => {
  const existing = await messageRow(req.params.id);
  if (!existing) throw new ApiError(404, 'Message not found.');
  const body = String((req.body || {}).message || '').trim();
  if (!body) throw new ApiError(400, 'Reply message cannot be empty.');

  // Two separate statements, not a shared transaction — matches the SQLite
  // source exactly (see file-header note). The insert's own id is discarded
  // here too, exactly like the original (never used — the response re-fetches
  // repliesFor() afterward instead).
  await db.query('INSERT INTO contact_message_replies (message_id, admin_name, body) VALUES ($1, $2, $3)', [existing.id, req.adminUser.full_name, body]);
  await db.query("UPDATE contact_messages SET status = 'replied', updated_at = NOW() WHERE id = $1", [existing.id]);

  // Registered customers can read and answer the whole thread in their
  // account, so the email links there.
  const account = await customerFor(existing);
  const link = account
    ? `\n\nView and reply to this conversation in your account:\n${siteOrigin(req)}/Dashboard.dc.html?tab=messages&message=${existing.id}`
    : '';
  await sendMail({ to: existing.email, subject: `Re: ${existing.subject}`, text: `${body}${link}` });

  await writeAudit({ actor: req.adminUser.full_name, action: 'Replied to contact message', target: existing.subject, module: 'Contact' });
  const row = await messageRow(existing.id);
  res.json({ data: { ...serialize(row, { replies: await repliesFor(row.id) }), customer: account } });
}));

router.delete('/:id', asyncRoute(async (req, res) => {
  const existing = await messageRow(req.params.id);
  if (!existing) throw new ApiError(404, 'Message not found.');
  await db.query('DELETE FROM contact_messages WHERE id = $1', [existing.id]);
  await writeAudit({ actor: req.adminUser.full_name, action: 'Deleted contact message', target: existing.subject, module: 'Contact' });
  res.json({ data: { deleted: true } });
}));

module.exports = router;
