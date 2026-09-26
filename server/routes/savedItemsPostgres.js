const express = require('express');
const db = require('../db/postgres');
const { asyncRoute, ApiError } = require('../middleware/errorHandler');
const requireCustomer = require('../middleware/requireCustomerPostgres');

// PostgreSQL counterpart to server/routes/savedItems.js (SQLite). Parallel/
// isolated file only — NOT mounted in app.js.
//
// Current behavior confirmed by re-reading the source: like cart.js, this
// route stores a point-in-time snapshot (sku/name/priceLabel/productType)
// with no live join back to `products` — GET / returns exactly what was
// saved, not freshly re-enriched data.

const router = express.Router();

// NOTE: `AS priceLabel`, `AS productType`, `AS createdAt` must be
// double-quoted — Postgres folds unquoted identifiers to lowercase.
router.get('/', requireCustomer, asyncRoute(async (req, res) => {
  const rows = await db.all(
    `SELECT sku, name, price_label AS "priceLabel", product_type AS "productType", created_at AS "createdAt"
     FROM saved_items WHERE customer_id = $1 ORDER BY created_at DESC`,
    [req.customer.id]
  );
  res.json({ data: rows });
}));

router.post('/', requireCustomer, asyncRoute(async (req, res) => {
  const b = req.body || {};
  const sku = String(b.sku || '').trim();
  if (!sku) throw new ApiError(400, 'sku is required.');
  // INSERT OR IGNORE -> ON CONFLICT (customer_id, sku) DO NOTHING, matching
  // saved_items' real UNIQUE (customer_id, sku) constraint (confirmed
  // read-only). A duplicate save silently no-ops on both engines; the
  // response is unconditionally {saved:true} either way — preserved
  // exactly as the SQLite route already does (it never distinguishes
  // "inserted" from "ignored" in its response).
  await db.query(
    `INSERT INTO saved_items (customer_id, sku, name, price_label, product_type) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (customer_id, sku) DO NOTHING`,
    [req.customer.id, sku, b.name || null, b.priceLabel || null, b.productType || null]
  );
  res.json({ data: { saved: true } });
}));

router.delete('/:sku', requireCustomer, asyncRoute(async (req, res) => {
  await db.query('DELETE FROM saved_items WHERE customer_id = $1 AND sku = $2', [req.customer.id, req.params.sku]);
  res.json({ data: { removed: true } });
}));

module.exports = router;
