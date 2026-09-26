const express = require('express');
const db = require('../db/postgres');
const { asyncRoute } = require('../middleware/errorHandler');
const requireAdmin = require('../middleware/requireAdminPostgres');
const requirePermission = require('../middleware/requirePermission');

// PostgreSQL counterpart to server/routes/adminAudit.js (SQLite). Parallel/
// isolated file only — NOT mounted in app.js. Read-only, no writes.
//
// Ordering note: `ORDER BY date DESC, time DESC` sorts TEXT columns that are
// always digit-only ('YYYY-MM-DD' / 'HH:MM', no letters) — digit characters
// sort identically under SQLite's BINARY collation and this database's
// en_US.UTF-8 collation, so no COLLATE "C" is needed here (unlike
// categories.name in Step 8, which contains letters that DO reorder).
//
// LIKE note: SQLite's LIKE is case-insensitive by default; PostgreSQL's is
// case-sensitive by default (ILIKE would be needed for case-insensitivity).
// Checked and irrelevant here too — the LIKE patterns only ever match
// digit-only `date` prefixes (`'2026-08%'`), which have no case to differ on.
//
// No explicit offset-based pagination exists in the original — only an
// optional row-count `limit` — preserved exactly as-is.

const router = express.Router();
router.use(requireAdmin, requirePermission('audit', 'view'));

router.get('/', asyncRoute(async (req, res) => {
  const { month, year, from, to, limit } = req.query;
  let sql = 'SELECT id, date, time, actor, action, target, module FROM audit_log WHERE 1=1';
  const params = [];
  if (month) { params.push(`${month}%`); sql += ` AND date LIKE $${params.length}`; }
  if (year) { params.push(`${year}%`); sql += ` AND date LIKE $${params.length}`; }
  if (from) { params.push(from); sql += ` AND date >= $${params.length}`; }
  if (to) { params.push(to); sql += ` AND date <= $${params.length}`; }
  sql += ' ORDER BY date DESC, time DESC';
  if (limit) { params.push(Number(limit)); sql += ` LIMIT $${params.length}`; }
  const rows = await db.all(sql, params);
  // audit_log.id is BIGINT -> pg returns it as a string; Number(...) keeps
  // the response shape identical to the SQLite version.
  res.json({ data: rows.map((r) => ({ ...r, id: Number(r.id) })) });
}));

module.exports = router;
