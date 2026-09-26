const express = require('express');
const db = require('../db/postgres');
const { asyncRoute } = require('../middleware/errorHandler');

// PostgreSQL counterpart to server/routes/productTypes.js (SQLite). Parallel/
// isolated file only — NOT mounted in app.js. Read-only, no writes.
//
// Neither query here selects `id` (only key/label/description/enabled), and
// neither filters on `enabled` (both intentionally return disabled rows too,
// same as the SQLite version) — so no BIGINT-Number normalization and no
// enabled=1->TRUE rewrite apply to this file.
//
// `enabled` IS exposed in both responses below. product_types.enabled /
// feature_flags.enabled are real PostgreSQL BOOLEAN columns (confirmed
// read-only), so `pg` hands back true/false — but the existing SQLite API
// has always returned the raw INTEGER value (1/0) here, with no coercion
// anywhere in the original route. To preserve that exact API shape without
// touching the BOOLEAN columns themselves, the boolean is normalized to
// 1/0 only at the response-mapping step, per row.

const router = express.Router();

router.get('/product-types', asyncRoute(async (req, res) => {
  const rows = await db.all('SELECT key, label, enabled FROM product_types ORDER BY id');
  res.json({ data: rows.map((r) => ({ ...r, enabled: r.enabled ? 1 : 0 })) });
}));

router.get('/feature-flags', asyncRoute(async (req, res) => {
  const rows = await db.all('SELECT key, label, description, enabled FROM feature_flags ORDER BY key');
  res.json({ data: rows.map((r) => ({ ...r, enabled: r.enabled ? 1 : 0 })) });
}));

module.exports = router;
