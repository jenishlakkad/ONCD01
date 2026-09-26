const express = require('express');
const db = require('../db/postgres');
const { asyncRoute } = require('../middleware/errorHandler');
const requireCustomer = require('../middleware/requireCustomerPostgres');

// PostgreSQL counterpart to server/routes/cart.js (SQLite). Parallel/
// isolated file only — NOT mounted in app.js.
//
// Current behavior confirmed by re-reading the source (nothing here was
// missed by the earlier audit, but worth stating explicitly): this route
// does NOT look up or enrich against `products` at all, and does NOT apply
// any price-visibility logic — it stores whatever sku/name/priceLabel/qty
// the client sends directly, verbatim, as a pure admin-visibility mirror of
// the customer's localStorage cart (matches the existing source comment).
// `count` in the response is the raw submitted array length, not the
// actual number of rows inserted — an existing quirk (a submitted item
// with a blank sku is silently skipped in the insert loop but still counted)
// preserved exactly, not "fixed".

const router = express.Router();

router.put('/', requireCustomer, asyncRoute(async (req, res) => {
  const items = Array.isArray((req.body || {}).items) ? req.body.items : [];
  // Single pooled client for the whole transaction — every statement below
  // runs sequentially against that SAME client, never db.query() (which
  // could hand statements to different pool connections and silently lose
  // atomicity of the delete-then-reinsert).
  await db.transaction(async (client) => {
    await client.query('DELETE FROM cart_items WHERE customer_id = $1', [req.customer.id]);
    for (const it of items) {
      const sku = String((it && it.sku) || '').trim();
      if (!sku) continue;
      const qty = Math.max(1, Number(it.qty) || 1);
      await client.query(
        'INSERT INTO cart_items (customer_id, sku, name, price_label, qty) VALUES ($1, $2, $3, $4, $5)',
        [req.customer.id, sku, it.name || null, it.priceLabel || null, qty]
      );
    }
  });
  res.json({ data: { saved: true, count: items.length } });
}));

module.exports = router;
