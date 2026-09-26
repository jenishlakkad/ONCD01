const express = require('express');
const db = require('../db/postgres');
const { asyncRoute, ApiError } = require('../middleware/errorHandler');
const requireCustomer = require('../middleware/requireCustomerPostgres');

// PostgreSQL counterpart to server/routes/inquiries.js (SQLite). Parallel/
// isolated file only — NOT mounted in app.js.
//
// Current behavior confirmed by re-reading the source (worth stating
// explicitly, not previously called out in the earlier product-focused
// audits): POST / is NOT gated by requireCustomer at all — it's a fully
// public route that accepts both guests and logged-in customers, reading
// `req.session.customerId` directly rather than via `req.customer`. The
// WhatsApp/LINE/Skype approval gate is a separate, self-contained inline
// check (re-querying customers.status) distinct from requireCustomer's own
// semantics (no session-nulling on failure, no password_hash handling,
// since it never attaches a customer object to req at all) — preserved
// here as the same inline pattern, not routed through requireCustomerPostgres.
//
// Also: the product lookup query selects `sku AS name`, but that aliased
// value is never actually read — the final item's `name` always comes from
// the client-submitted `it.name` (falling back to `it.sku`), never from the
// DB row. Preserved exactly as-is (including the unused alias) rather than
// "cleaned up", to avoid any subtle behavior change.

const router = express.Router();

const VALID_CHANNELS = ['whatsapp', 'email', 'line', 'skype'];

router.post('/', asyncRoute(async (req, res) => {
  const { items, channel, guestName, guestEmail } = req.body || {};
  if (!Array.isArray(items) || items.length === 0) throw new ApiError(400, 'At least one item is required.');
  if (!VALID_CHANNELS.includes(channel)) throw new ApiError(400, 'Invalid channel.');

  if (channel !== 'email') {
    const gateCustomerId = req.session && req.session.customerId;
    const gateCustomer = gateCustomerId ? await db.get('SELECT status FROM customers WHERE id = $1', [gateCustomerId]) : null;
    if (!gateCustomer || gateCustomer.status !== 'approved') {
      throw new ApiError(403, 'WhatsApp, LINE, and Skype inquiries are reserved for approved trade accounts.');
    }
  }

  // Sequential, not Promise.all — preserves the original's short-circuit
  // behavior of stopping at the first unknown SKU without firing off
  // lookups for items after it.
  const resolved = [];
  for (const it of items) {
    const p = await db.get('SELECT id, sku, sku AS name FROM products WHERE sku = $1', [it.sku]);
    if (!p) throw new ApiError(400, `Unknown SKU: ${it.sku}`);
    resolved.push({ productId: p.id, sku: it.sku, name: it.name || it.sku, qty: Number(it.qty) || 1, priceLabel: it.priceLabel || null });
  }

  const customerId = req.session && req.session.customerId ? req.session.customerId : null;

  // ONE transaction, ONE client throughout: the inquiry header and every
  // inquiry_items row are inserted sequentially against the same client,
  // so an item-insert failure rolls back the header too — never allowed to
  // commit a header with no items. RETURNING id replaces lastInsertRowid.
  const inquiryId = await db.transaction(async (client) => {
    const result = await client.query(
      `INSERT INTO inquiries (customer_id, guest_name, guest_email, channel, status) VALUES ($1, $2, $3, $4, 'pending') RETURNING id`,
      [customerId, guestName || null, guestEmail || null, channel]
    );
    const id = result.rows[0].id;
    for (const it of resolved) {
      await client.query(
        `INSERT INTO inquiry_items (inquiry_id, product_id, sku, name, qty, price_label) VALUES ($1, $2, $3, $4, $5, $6)`,
        [id, it.productId, it.sku, it.name, it.qty, it.priceLabel]
      );
    }
    return id;
  });

  // inquiries.id is BIGINT -> pg returns it as a string; Number(...) keeps
  // the response shape identical to the SQLite version.
  res.json({ data: { id: Number(inquiryId) } });
}));

router.get('/mine', requireCustomer, asyncRoute(async (req, res) => {
  const rows = await db.all(
    `SELECT id, channel, status, created_at AS "createdAt" FROM inquiries WHERE customer_id = $1 ORDER BY created_at DESC`,
    [req.customer.id]
  );
  // Independent per-inquiry reads — safe and appropriate to parallelize
  // with Promise.all (same reasoning as the enrichment fan-outs in the
  // products routes).
  const data = await Promise.all(rows.map(async (r) => {
    const items = await db.all(
      'SELECT inquiry_id AS "inquiryId", sku, name, qty, price_label AS "priceLabel" FROM inquiry_items WHERE inquiry_id = $1',
      [r.id]
    );
    return { ...r, id: Number(r.id), items: items.map((it) => ({ ...it, inquiryId: Number(it.inquiryId) })) };
  }));
  res.json({ data });
}));

module.exports = router;
