const express = require('express');
const db = require('../db/connection');
const { asyncRoute, ApiError } = require('../middleware/errorHandler');
const requireAdmin = require('../middleware/requireAdmin');
const requirePermission = require('../middleware/requirePermission');
const { sendMail } = require('../lib/mailer');
const { writeAudit } = require('../lib/audit');

const router = express.Router();

router.use(requireAdmin, requirePermission('contact', 'manage'));

const STATUSES = ['new', 'in_progress', 'replied', 'closed'];

function messageRow(id) {
  return db.prepare('SELECT * FROM contact_messages WHERE id = ?').get(id);
}
function repliesFor(id) {
  return db.prepare('SELECT id, admin_name AS adminName, body, created_at AS createdAt FROM contact_message_replies WHERE message_id = ? ORDER BY created_at').all(id);
}
function serialize(row, { replies } = {}) {
  return {
    id: row.id, customerId: row.customer_id,
    fullName: row.full_name, email: row.email, phone: row.phone,
    subject: row.subject, message: row.message,
    status: row.status, adminNotes: row.admin_notes,
    createdAt: row.created_at, updatedAt: row.updated_at,
    replies: replies || undefined,
  };
}

router.get('/', asyncRoute(async (req, res) => {
  const rows = db.prepare('SELECT * FROM contact_messages ORDER BY created_at DESC, id DESC').all();
  const replyCount = db.prepare('SELECT COUNT(*) AS n FROM contact_message_replies WHERE message_id = ?');
  res.json({ data: rows.map((r) => ({ ...serialize(r), replyCount: replyCount.get(r.id).n })) });
}));

router.get('/new-count', asyncRoute(async (req, res) => {
  const count = db.prepare("SELECT COUNT(*) AS n FROM contact_messages WHERE status = 'new'").get().n;
  res.json({ data: { count } });
}));

router.get('/:id', asyncRoute(async (req, res) => {
  const row = messageRow(req.params.id);
  if (!row) throw new ApiError(404, 'Message not found.');
  res.json({ data: serialize(row, { replies: repliesFor(row.id) }) });
}));

router.put('/:id', asyncRoute(async (req, res) => {
  const existing = messageRow(req.params.id);
  if (!existing) throw new ApiError(404, 'Message not found.');
  const { status, adminNotes } = req.body || {};
  if (status !== undefined && !STATUSES.includes(status)) throw new ApiError(400, 'Invalid status.');

  const sets = [];
  const params = [];
  if (status !== undefined) { sets.push('status = ?'); params.push(status); }
  if (adminNotes !== undefined) { sets.push('admin_notes = ?'); params.push(adminNotes || null); }
  if (sets.length) {
    db.prepare(`UPDATE contact_messages SET ${sets.join(', ')}, updated_at = datetime('now') WHERE id = ?`).run(...params, existing.id);
  }
  const row = messageRow(existing.id);
  writeAudit({ actor: req.adminUser.full_name, action: 'Updated contact message', target: row.subject, module: 'Contact' });
  res.json({ data: serialize(row, { replies: repliesFor(row.id) }) });
}));

router.post('/:id/reply', asyncRoute(async (req, res) => {
  const existing = messageRow(req.params.id);
  if (!existing) throw new ApiError(404, 'Message not found.');
  const body = String((req.body || {}).message || '').trim();
  if (!body) throw new ApiError(400, 'Reply message cannot be empty.');

  db.prepare('INSERT INTO contact_message_replies (message_id, admin_name, body) VALUES (?, ?, ?)').run(existing.id, req.adminUser.full_name, body);
  db.prepare("UPDATE contact_messages SET status = 'replied', updated_at = datetime('now') WHERE id = ?").run(existing.id);

  await sendMail({ to: existing.email, subject: `Re: ${existing.subject}`, text: body });

  writeAudit({ actor: req.adminUser.full_name, action: 'Replied to contact message', target: existing.subject, module: 'Contact' });
  const row = messageRow(existing.id);
  res.json({ data: serialize(row, { replies: repliesFor(row.id) }) });
}));

router.delete('/:id', asyncRoute(async (req, res) => {
  const existing = messageRow(req.params.id);
  if (!existing) throw new ApiError(404, 'Message not found.');
  db.prepare('DELETE FROM contact_messages WHERE id = ?').run(existing.id);
  writeAudit({ actor: req.adminUser.full_name, action: 'Deleted contact message', target: existing.subject, module: 'Contact' });
  res.json({ data: { deleted: true } });
}));

module.exports = router;
