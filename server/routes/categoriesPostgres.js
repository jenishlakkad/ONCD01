const express = require('express');
const db = require('../db/postgres');
const { asyncRoute } = require('../middleware/errorHandler');

// PostgreSQL counterpart to server/routes/categories.js (SQLite). Parallel/
// isolated file only — NOT mounted in app.js. Read-only, no writes.

const router = express.Router();

// NOTE: `AS groupKey`, `AS sortOrder`, `AS productType` must be double-quoted.
// Postgres folds unquoted identifiers to lowercase, so unquoted aliases would
// come back as groupkey/sortorder/producttype — silently breaking every
// consumer expecting the camelCase shape the SQLite version has always returned.
//
// NOTE: `name COLLATE "C"` on the tie-break. SQLite's default TEXT collation
// is plain byte order (BINARY) — categories.name has no explicit COLLATE in
// schema.sql, so `ORDER BY c.sort_order, c.name` sorts ties byte-wise there
// (uppercase before lowercase). This database's default collation is
// en_US.UTF-8 (locale-aware, case is a secondary factor), which reorders
// those same ties differently — confirmed directly: an unfiltered request
// put "Cubic Zirconia" before "CVD Diamonds" under en_US.UTF-8 even though
// SQLite (and every admin who has only ever seen the SQLite-backed site)
// always shows "CVD Diamonds" first. `COLLATE "C"` reproduces SQLite's byte
// order exactly (verified read-only: matches SQLite's order for every row
// currently tied on sort_order=3) without touching any data or sort_order.
router.get('/', asyncRoute(async (req, res) => {
  const { type, group } = req.query;
  let sql = `SELECT c.id, c.name, c.group_key AS "groupKey", c.sort_order AS "sortOrder", pt.key AS "productType"
             FROM categories c JOIN product_types pt ON pt.id = c.product_type_id
             WHERE c.enabled = TRUE AND pt.enabled = TRUE`;
  const params = [];
  if (type) { params.push(type); sql += ` AND pt.key = $${params.length}`; }
  if (group) { params.push(group); sql += ` AND c.group_key = $${params.length}`; }
  sql += ' ORDER BY c.sort_order, c.name COLLATE "C"';
  const rows = await db.all(sql, params);
  // categories.id is BIGINT -> pg returns it as a string; Number(...) keeps
  // the response shape identical to the SQLite version.
  res.json({ data: rows.map((r) => ({ ...r, id: Number(r.id) })) });
}));

// Same sort_order/name tie-break shape as the query above, so the same
// COLLATE "C" fix is applied here proactively even though no tie has been
// observed in the current 8-row subcategories data — the underlying cause
// (no explicit collation on subcategories.name either) is identical.
router.get('/subcategories', asyncRoute(async (req, res) => {
  const rows = await db.all(
    'SELECT id, name, sort_order AS "sortOrder" FROM subcategories WHERE enabled = TRUE ORDER BY sort_order, name COLLATE "C"'
  );
  res.json({ data: rows.map((r) => ({ ...r, id: Number(r.id) })) });
}));

module.exports = router;
