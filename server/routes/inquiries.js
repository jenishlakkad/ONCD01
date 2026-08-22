const express = require('express');
const db = require('../db/connection');
const { asyncRoute, ApiError } = require('../middleware/errorHandler');
const requireCustomer = require('../middleware/requireCustomer');

const router = express.Router();

const VALID_CHANNELS = ['whatsapp', 'email', 'line', 'skype'];

router.post('/', asyncRoute(async (req, res) => {
  const { items, channel, guestName, guestEmail } = req.body || {};
  if (!Array.isArray(items) || items.length === 0) throw new ApiError(400, 'At least one item is required.');
  if (!VALID_CHANNELS.includes(channel)) throw new ApiError(400, 'Invalid channel.');

  if (channel !== 'email') {
    const gateCustomerId = req.session && req.session.customerId;
    const gateCustomer = gateCustomerId ? db.prepare('SELECT status FROM customers WHERE id = ?').get(gateCustomerId) : null;
    if (!gateCustomer || gateCustomer.status !== 'approved') {
      throw new ApiError(403, 'WhatsApp, LINE, and Skype inquiries are reserved for approved trade accounts.');
    }
  }

  const findProduct = db.prepare('SELECT id, sku, sku AS name FROM products WHERE sku = ?');
  const resolved = items.map((it) => {
    const p = findProduct.get(it.sku);
    if (!p) throw new ApiError(400, `Unknown SKU: ${it.sku}`);
    return { productId: p.id, sku: it.sku, name: it.name || it.sku, qty: Number(it.qty) || 1, priceLabel: it.priceLabel || null };
  });

  const customerId = req.session && req.session.customerId ? req.session.customerId : null;

  const insInq = db.prepare(
    `INSERT INTO inquiries (customer_id, guest_name, guest_email, channel, status) VALUES (?, ?, ?, ?, 'pending')`
  );
  const insItem = db.prepare(
    `INSERT INTO inquiry_items (inquiry_id, product_id, sku, name, qty, price_label) VALUES (?, ?, ?, ?, ?, ?)`
  );
  const inquiryId = db.transaction(() => {
    const id = insInq.run(customerId, guestName || null, guestEmail || null, channel).lastInsertRowid;
    for (const it of resolved) insItem.run(id, it.productId, it.sku, it.name, it.qty, it.priceLabel);
    return id;
  })();

  res.json({ data: { id: inquiryId } });
}));

router.get('/mine', requireCustomer, asyncRoute(async (req, res) => {
  const rows = db.prepare(
    `SELECT id, channel, status, created_at AS createdAt FROM inquiries WHERE customer_id = ? ORDER BY created_at DESC`
  ).all(req.customer.id);
  const items = db.prepare('SELECT inquiry_id AS inquiryId, sku, name, qty, price_label AS priceLabel FROM inquiry_items WHERE inquiry_id = ?');
  const data = rows.map((r) => ({ ...r, items: items.all(r.id) }));
  res.json({ data });
}));

module.exports = router;
