const db = require('../db/postgres');
const { sendMail } = require('./mailer');

// Shared pieces of the customer <-> sales desk messaging flow:
//
//   Inquiry (cart / "Inquire" popup -> WhatsApp, Email, LINE, Skype)
//     -> stored with the reference printed in the outgoing message + the note
//     -> Admin "Inquiries" inbox (and the customer's admin Details dialog)
//     -> desk replies in-app (emailed to the customer) or changes the status
//     -> customer sees it in Dashboard > Inquiry History and can answer there,
//        which puts the inquiry back into the desk's "Awaiting reply" queue.
//
//   Contact form -> Admin "Contact Messages" -> reply (emailed)
//     -> customer sees the thread in Dashboard > Messages and can answer.
//
// The thread tables/columns are added by MESSAGING_MIGRATION_SQL (schema
// changes on the shared Supabase database are run by the owner in the SQL
// editor). Until then everything keeps working without threads: statuses,
// inquiries and contact messages behave exactly as before.

const MESSAGING_MIGRATION_SQL = `-- ONCD messaging: inquiry references, notes and conversation threads.
-- Safe to run more than once.
ALTER TABLE inquiries ADD COLUMN IF NOT EXISTS ref TEXT;
ALTER TABLE inquiries ADD COLUMN IF NOT EXISTS note TEXT;
ALTER TABLE inquiries ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;
CREATE UNIQUE INDEX IF NOT EXISTS inquiries_ref_key ON inquiries (ref);
CREATE INDEX IF NOT EXISTS inquiries_customer_created_idx ON inquiries (customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS inquiry_items_inquiry_idx ON inquiry_items (inquiry_id);

CREATE TABLE IF NOT EXISTS inquiry_messages (
  id BIGSERIAL PRIMARY KEY,
  inquiry_id BIGINT NOT NULL REFERENCES inquiries(id) ON DELETE CASCADE,
  sender TEXT NOT NULL CHECK (sender IN ('customer', 'admin')),
  author_name TEXT,
  body TEXT NOT NULL,
  emailed BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS inquiry_messages_inquiry_idx ON inquiry_messages (inquiry_id, created_at);

ALTER TABLE contact_message_replies ADD COLUMN IF NOT EXISTS sender TEXT NOT NULL DEFAULT 'admin';
CREATE INDEX IF NOT EXISTS contact_messages_customer_idx ON contact_messages (customer_id);
`;

const NEWSLETTER_SUBJECT = 'Newsletter subscription';
const MAX_BODY = 4000;
const REF_RE = /^ONCD-[A-Z0-9]{6}$/;

// A positive answer never changes (columns aren't dropped), so it's cached
// for good; a negative one is re-checked every 30s so running the SQL takes
// effect without a restart.
let schemaCache = { at: 0, value: null };
async function getMessagingSchema({ fresh } = {}) {
  const c = schemaCache;
  if (!fresh && c.value && (c.value.ready || Date.now() - c.at < 30 * 1000)) return c.value;
  // Resolved through the search path (to_regclass), i.e. exactly the tables
  // the queries themselves will hit.
  const rows = await db.all(
    `SELECT c.tbl AS table_name, a.attname AS column_name
     FROM (VALUES ('inquiries'), ('inquiry_messages'), ('contact_message_replies')) AS c(tbl)
     JOIN pg_attribute a ON a.attrelid = to_regclass(c.tbl) AND a.attnum > 0 AND NOT a.attisdropped
     WHERE a.attname IN ('ref', 'note', 'updated_at', 'id', 'sender')`
  );
  const has = (t, col) => rows.some((r) => r.table_name === t && r.column_name === col);
  const inquiryRefs = has('inquiries', 'ref') && has('inquiries', 'note') && has('inquiries', 'updated_at');
  const inquiryThreads = inquiryRefs && has('inquiry_messages', 'id');
  const contactReplies = has('contact_message_replies', 'sender');
  const value = { inquiryRefs, inquiryThreads, contactReplies, ready: inquiryThreads && contactReplies };
  schemaCache = { at: Date.now(), value };
  return value;
}

function cleanBody(value) {
  return String(value || '').replace(/\r\n/g, '\n').trim().slice(0, MAX_BODY);
}

// Absolute links for emails. app.js doesn't set 'trust proxy', so the
// forwarded protocol is read directly (falls back to the request's own).
function siteOrigin(req) {
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() || req.protocol || 'http';
  return `${proto}://${req.get('host')}`;
}

async function deskAddress() {
  const s = (await db.get('SELECT inquiry_email, support_email FROM site_settings WHERE id = 1')) || {};
  return s.inquiry_email || s.support_email || null;
}

// Fire-and-forget email to the sales desk; a failed notification never
// fails the customer's action (the message is already stored and visible
// in the admin inbox).
function notifyDesk({ subject, text }) {
  deskAddress()
    .then((to) => (to ? sendMail({ to, subject, text }) : null))
    .catch(() => {});
}

function inquiryLabel(inq) {
  return inq.ref || `#${inq.id}`;
}

// Per-customer rate limit on messages they post (thread replies), so a
// stuck client or a bad actor can't flood the desk's inbox and email.
const postHits = new Map();
function customerRateLimited(customerId, limit = 30) {
  const now = Date.now();
  const recent = (postHits.get(customerId) || []).filter((t) => now - t < 60 * 60 * 1000);
  recent.push(now);
  postHits.set(customerId, recent);
  if (postHits.size > 5000) postHits.clear();
  return recent.length > limit;
}

const INQUIRY_STATUSES = ['pending', 'replied', 'closed'];
const INQUIRY_STATUS_LABELS = { pending: 'Pending', replied: 'Replied', closed: 'Closed' };

// The desk changing an inquiry's status — shared by the Inquiries inbox and
// the User Approval > Details dialog so both log and stamp it identically.
// `customerId` (optional) scopes the lookup to one customer's inquiries.
// Returns null when the inquiry doesn't exist (or isn't that customer's).
async function updateInquiryStatus({ id, status, actor, customerId }) {
  const { writeAudit } = require('./auditPostgres');
  if (!/^\d+$/.test(String(id))) return null;
  const schema = await getMessagingSchema();
  const inquiry = await db.get(
    `SELECT i.id, i.status, ${schema.inquiryRefs ? 'i.ref' : 'NULL AS ref'}, COALESCE(c.full_name, i.guest_name, 'Guest') AS who
     FROM inquiries i LEFT JOIN customers c ON c.id = i.customer_id
     WHERE i.id = $1 ${customerId ? 'AND i.customer_id = $2' : ''}`,
    customerId ? [id, customerId] : [id]
  );
  if (!inquiry) return null;
  if (inquiry.status !== status) {
    await db.query(
      schema.inquiryRefs ? 'UPDATE inquiries SET status = $1, updated_at = NOW() WHERE id = $2' : 'UPDATE inquiries SET status = $1 WHERE id = $2',
      [status, inquiry.id]
    );
    await writeAudit({ actor, action: `Marked inquiry ${inquiryLabel(inquiry)} ${INQUIRY_STATUS_LABELS[status]}`, target: inquiry.who, module: 'Inquiries' });
  }
  return { id: Number(inquiry.id), status };
}

module.exports = {
  INQUIRY_STATUSES,
  updateInquiryStatus,
  MESSAGING_MIGRATION_SQL,
  NEWSLETTER_SUBJECT,
  MAX_BODY,
  REF_RE,
  getMessagingSchema,
  cleanBody,
  siteOrigin,
  notifyDesk,
  inquiryLabel,
  customerRateLimited,
};
