const express = require('express');
const db = require('../db/postgres');
const { asyncRoute, ApiError } = require('../middleware/errorHandler');
const requireCustomer = require('../middleware/requireCustomerPostgres');
const { getMessagingSchema, cleanBody, REF_RE } = require('../lib/messaging');

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


const router = express.Router();

const VALID_CHANNELS = ['whatsapp', 'email', 'line', 'skype'];

// Two clicks on the same channel button (or WhatsApp then Email for the
// same cart) are one request from the customer, not two inquiries. With the
// messaging migration the client's reference makes this exact; before it, a
// logged-in customer's identical item list on the same channel within this
// window is treated as the same inquiry.
const DUPLICATE_WINDOW_MINUTES = 10;

router.post('/', asyncRoute(async (req, res) => {
  const { items, channel, guestName, guestEmail } = req.body || {};
  if (!Array.isArray(items) || items.length === 0) throw new ApiError(400, 'At least one item is required.');
  if (items.length > 100) throw new ApiError(400, 'Too many items in one inquiry.');
  if (!VALID_CHANNELS.includes(channel)) throw new ApiError(400, 'Invalid channel.');

  const customerId = req.session && req.session.customerId ? req.session.customerId : null;
  if (channel !== 'email') {
    const gateCustomer = customerId ? await db.get('SELECT status FROM customers WHERE id = $1', [customerId]) : null;
    if (!gateCustomer || gateCustomer.status !== 'approved') {
      throw new ApiError(403, 'WhatsApp, LINE, and Skype inquiries are reserved for approved trade accounts.');
    }
  }

  // One lookup for every SKU; the first unknown SKU (in the order sent) is
  // still the one reported, as before.
  const skus = items.map((it) => String((it && it.sku) || ''));
  const found = await db.all('SELECT id, sku FROM products WHERE sku = ANY($1)', [skus]);
  const idBySku = new Map(found.map((p) => [p.sku, p.id]));
  const resolved = [];
  for (const it of items) {
    const sku = String((it && it.sku) || '');
    if (!idBySku.has(sku)) throw new ApiError(400, `Unknown SKU: ${sku}`);
    resolved.push({
      productId: idBySku.get(sku), sku, name: String(it.name || sku).slice(0, 300),
      qty: Math.max(1, Math.min(9999, Number(it.qty) || 1)), priceLabel: it.priceLabel ? String(it.priceLabel).slice(0, 120) : null,
    });
  }

  const schema = await getMessagingSchema();
  const rawRef = String((req.body || {}).ref || '').trim().toUpperCase();
  const ref = schema.inquiryRefs && REF_RE.test(rawRef) ? rawRef : null;
  const note = schema.inquiryRefs ? cleanBody((req.body || {}).note).slice(0, 2000) || null : null;

  // Same reference = same inquiry (a repeated click). Only the sender may
  // match their own reference.
  const sameRef = async () => {
    const existing = await db.get('SELECT id, customer_id, ref FROM inquiries WHERE ref = $1', [ref]);
    if (!existing) return null;
    const sameSender = existing.customer_id === null ? !customerId : Number(existing.customer_id) === Number(customerId);
    if (!sameSender) throw new ApiError(409, 'This inquiry reference is already in use. Please refresh and try again.');
    return { id: Number(existing.id), ref: existing.ref, duplicate: true };
  };
  if (ref) {
    const dup = await sameRef();
    if (dup) return res.json({ data: dup });
  } else if (customerId) {
    const signature = resolved.map((r) => `${r.sku}:${r.qty}`).sort().join('|');
    const recent = await db.all(
      `SELECT i.id, string_agg(ii.sku || ':' || ii.qty, '|' ORDER BY ii.sku || ':' || ii.qty) AS sig
       FROM inquiries i JOIN inquiry_items ii ON ii.inquiry_id = i.id
       WHERE i.customer_id = $1 AND i.channel = $2 AND i.created_at > NOW() - ($3 || ' minutes')::interval
       GROUP BY i.id`,
      [customerId, channel, String(DUPLICATE_WINDOW_MINUTES)]
    );
    const dup = recent.find((r) => r.sig === signature);
    if (dup) return res.json({ data: { id: Number(dup.id), ref: null, duplicate: true } });
  }

  // ONE transaction: the header and every item commit together or not at all.
  let inquiryId;
  try {
    inquiryId = await db.transaction(async (client) => {
      const result = schema.inquiryRefs
        ? await client.query(
          `INSERT INTO inquiries (customer_id, guest_name, guest_email, channel, status, ref, note, updated_at)
           VALUES ($1, $2, $3, $4, 'pending', $5, $6, NOW()) RETURNING id`,
          [customerId, guestName || null, guestEmail || null, channel, ref, note])
        : await client.query(
          `INSERT INTO inquiries (customer_id, guest_name, guest_email, channel, status) VALUES ($1, $2, $3, $4, 'pending') RETURNING id`,
          [customerId, guestName || null, guestEmail || null, channel]);
      const id = result.rows[0].id;
      for (const it of resolved) {
        await client.query(
          `INSERT INTO inquiry_items (inquiry_id, product_id, sku, name, qty, price_label) VALUES ($1, $2, $3, $4, $5, $6)`,
          [id, it.productId, it.sku, it.name, it.qty, it.priceLabel]
        );
      }
      return id;
    });
  } catch (err) {
    // Two clicks racing past the check above: the unique index lets only one
    // through, and the other is answered with the inquiry that won.
    if (ref && err && err.code === '23505') {
      const dup = await sameRef();
      if (dup) return res.json({ data: dup });
    }
    throw err;
  }

  res.json({ data: { id: Number(inquiryId), ref } });
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
