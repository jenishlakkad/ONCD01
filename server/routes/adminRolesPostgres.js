const express = require('express');
const db = require('../db/postgres');
const { asyncRoute } = require('../middleware/errorHandler');
const requireAdmin = require('../middleware/requireAdminPostgres');
const requirePermission = require('../middleware/requirePermission');

// PostgreSQL counterpart to server/routes/adminRoles.js (SQLite). Parallel/
// isolated file only — NOT mounted in app.js. Read-only, no writes.
//
// Ordering note: `ORDER BY id` is numeric — unaffected by collation.

const router = express.Router();
router.use(requireAdmin, requirePermission('roles', 'view'));

router.get('/', asyncRoute(async (req, res) => {
  const roles = await db.all('SELECT id, name, description FROM roles ORDER BY id');
  // Per-role read fan-out — independent reads, safe and appropriate to
  // parallelize with Promise.all (same reasoning as the product list
  // enrichment in productsPostgres.js/adminProductsPostgres.js).
  //
  // COUNT(*) always returns BIGINT in PostgreSQL regardless of the counted
  // table's own column types, so `countRow.n` needs Number(...) just like
  // roles.id does — a gotcha distinct from (and in addition to) the usual
  // "this column is declared BIGINT" case.
  const data = await Promise.all(roles.map(async (r) => {
    const countRow = await db.get('SELECT COUNT(*) AS n FROM admin_users WHERE role_id = $1', [r.id]);
    return { ...r, id: Number(r.id), userCount: Number(countRow.n) };
  }));
  res.json({ data });
}));

module.exports = router;
