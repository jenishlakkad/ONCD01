const express = require('express');
const db = require('../db/connection');
const { asyncRoute } = require('../middleware/errorHandler');
const requireCustomer = require('../middleware/requireCustomer');

const router = express.Router();

// Admin-visibility mirror of the customer's localStorage cart — see utils/cart.js.
// Always replaces the full set for this customer; the client always sends its
// complete current cart, so there's no per-item add/remove endpoint to keep in sync.
router.put('/', requireCustomer, asyncRoute(async (req, res) => {
  const items = Array.isArray((req.body || {}).items) ? req.body.items : [];
  const del = db.prepare('DELETE FROM cart_items WHERE customer_id = ?');
  const ins = db.prepare('INSERT INTO cart_items (customer_id, sku, name, price_label, qty) VALUES (?, ?, ?, ?, ?)');
  db.transaction(() => {
    del.run(req.customer.id);
    for (const it of items) {
      const sku = String((it && it.sku) || '').trim();
      if (!sku) continue;
      const qty = Math.max(1, Number(it.qty) || 1);
      ins.run(req.customer.id, sku, it.name || null, it.priceLabel || null, qty);
    }
  })();
  res.json({ data: { saved: true, count: items.length } });
}));

module.exports = router;
