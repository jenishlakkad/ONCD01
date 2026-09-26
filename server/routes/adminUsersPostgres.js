const express = require('express');
const db = require('../db/postgres');
const { asyncRoute, ApiError } = require('../middleware/errorHandler');
const requireAdmin = require('../middleware/requireAdminPostgres');
const requirePermission = require('../middleware/requirePermission');
const { writeAudit } = require('../lib/auditPostgres');

// PostgreSQL counterpart to server/routes/adminUsers.js (SQLite). Parallel/
// isolated file only — NOT mounted in app.js.
//
// Current behavior confirmed by re-reading the source, worth stating
// explicitly:
// - GET / has NO search, filter, or pagination of any kind — it always
//   returns every customer, ordered by created_at DESC. Preserved exactly,
//   not "improved" with query-param support that doesn't exist in SQLite.
// - Status transitions are NOT driven by a user-supplied `status` field —
//   there are 4 fixed endpoints (approve/reject/suspend/reactivate), each
//   hardcoding its own target status. There is no "invalid status" input
//   path to validate; the only per-customer validation is existence.
// - reactivate writes the SAME status ('approved') as approve, but logs a
//   DIFFERENT audit action ('Reactivated user' vs 'Approved user') —
//   preserved exactly as two semantically distinct actions with identical
//   DB effects.
// - setStatus's response does NOT re-fetch the customer after the UPDATE —
//   it merges the pre-update row with only the new `status` field
//   (`{ ...customer, status }`). This means the response's `updatedAt` is
//   STALE (still the pre-update value), not the `NOW()` just written to the
//   DB. This is an existing quirk, preserved exactly, not "fixed" by
//   re-querying.
// - GET /:id/inquiries' nested item list has no ORDER BY at all in the
//   SQLite source (same class of "relies on implicit order" issue found
//   for homepage_sections/content_blocks in Batch E) — but inquiry_items
//   has no durable ordering column, and no schema change was authorized for
//   this step, so the query is preserved exactly, unordered, as-is.
// - No transaction anywhere in this file — every write is a single
//   independent UPDATE. No db.transaction() is invented here.
// - No customer-session invalidation of any kind — moderation never
//   touches sessions. Not added here either.

const router = express.Router();
router.use(requireAdmin, requirePermission('users', 'manage'));

// customers.id is BIGINT -> Number(...). Every other exposed customer field
// is TEXT/TIMESTAMPTZ, no further conversion needed. Timestamp columns
// (created_at/updated_at/email_verified_at) are returned by `pg` as native
// JS Date objects, which res.json() serializes via .toISOString() — a
// different string SHAPE than SQLite's raw "YYYY-MM-DD HH:MM:SS" TEXT
// column, but this is an inherent, project-wide consequence of Postgres's
// native TIMESTAMPTZ type already present in every other batch that exposes
// a raw timestamp (e.g. adminContactPostgres.js's createdAt/updatedAt) —
// not something unique to this file, and not "fixed" here in isolation.
function publicCustomer(c) {
  const { password_hash, ...rest } = c;
  return { ...rest, id: Number(rest.id) };
}

router.get('/', asyncRoute(async (req, res) => {
  const rows = await db.all('SELECT * FROM customers ORDER BY created_at DESC');
  res.json({ data: rows.map(publicCustomer) });
}));

function setStatus(status, actionLabel) {
  return asyncRoute(async (req, res) => {
    const customer = await db.get('SELECT * FROM customers WHERE id = $1', [req.params.id]);
    if (!customer) throw new ApiError(404, 'Customer not found.');
    await db.query("UPDATE customers SET status = $1, updated_at = NOW() WHERE id = $2", [status, customer.id]);
    await writeAudit({ actor: req.adminUser.full_name, action: actionLabel, target: customer.full_name, module: 'Users' });
    // Same as the SQLite source: merges the PRE-update row with only the
    // new status, does not re-fetch — updatedAt in this response is stale.
    res.json({ data: publicCustomer({ ...customer, status }) });
  });
}

router.get('/:id/cart', asyncRoute(async (req, res) => {
  const customer = await db.get('SELECT id FROM customers WHERE id = $1', [req.params.id]);
  if (!customer) throw new ApiError(404, 'Customer not found.');
  const rows = await db.all(
    'SELECT sku, name, price_label AS "priceLabel", qty, updated_at AS "updatedAt" FROM cart_items WHERE customer_id = $1 ORDER BY updated_at DESC',
    [customer.id]
  );
  res.json({ data: rows });
}));

router.get('/:id/inquiries', asyncRoute(async (req, res) => {
  const customer = await db.get('SELECT id FROM customers WHERE id = $1', [req.params.id]);
  if (!customer) throw new ApiError(404, 'Customer not found.');
  const rows = await db.all(
    'SELECT id, channel, status, created_at AS "createdAt" FROM inquiries WHERE customer_id = $1 ORDER BY created_at DESC',
    [customer.id]
  );
  // Independent per-inquiry reads — safe to parallelize with Promise.all,
  // same reasoning already used for this identical enrichment shape in
  // inquiriesPostgres.js's GET /mine. inquiries.id is BIGINT -> Number(...).
  // The nested items query itself has no ORDER BY, matching the SQLite
  // source exactly (see file-header note).
  const data = await Promise.all(rows.map(async (r) => {
    const items = await db.all('SELECT sku, name, qty, price_label AS "priceLabel" FROM inquiry_items WHERE inquiry_id = $1', [r.id]);
    return { ...r, id: Number(r.id), items };
  }));
  res.json({ data });
}));

router.get('/:id/saved-items', asyncRoute(async (req, res) => {
  const customer = await db.get('SELECT id FROM customers WHERE id = $1', [req.params.id]);
  if (!customer) throw new ApiError(404, 'Customer not found.');
  const rows = await db.all(
    'SELECT sku, name, price_label AS "priceLabel", product_type AS "productType", created_at AS "createdAt" FROM saved_items WHERE customer_id = $1 ORDER BY created_at DESC',
    [customer.id]
  );
  res.json({ data: rows });
}));

router.post('/:id/approve', setStatus('approved', 'Approved user'));
router.post('/:id/reject', setStatus('rejected', 'Rejected user'));
router.post('/:id/suspend', setStatus('suspended', 'Suspended user'));
router.post('/:id/reactivate', setStatus('approved', 'Reactivated user'));

module.exports = router;
