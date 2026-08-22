const express = require('express');
const db = require('../db/connection');
const { asyncRoute, ApiError } = require('../middleware/errorHandler');
const requireCustomer = require('../middleware/requireCustomer');

const router = express.Router();

router.get('/', requireCustomer, asyncRoute(async (req, res) => {
  const rows = db.prepare(
    `SELECT sku, name, price_label AS priceLabel, product_type AS productType, created_at AS createdAt
     FROM saved_items WHERE customer_id = ? ORDER BY created_at DESC`
  ).all(req.customer.id);
  res.json({ data: rows });
}));

router.post('/', requireCustomer, asyncRoute(async (req, res) => {
  const b = req.body || {};
  const sku = String(b.sku || '').trim();
  if (!sku) throw new ApiError(400, 'sku is required.');
  db.prepare(
    `INSERT OR IGNORE INTO saved_items (customer_id, sku, name, price_label, product_type) VALUES (?, ?, ?, ?, ?)`
  ).run(req.customer.id, sku, b.name || null, b.priceLabel || null, b.productType || null);
  res.json({ data: { saved: true } });
}));

router.delete('/:sku', requireCustomer, asyncRoute(async (req, res) => {
  db.prepare('DELETE FROM saved_items WHERE customer_id = ? AND sku = ?').run(req.customer.id, req.params.sku);
  res.json({ data: { removed: true } });
}));

module.exports = router;
