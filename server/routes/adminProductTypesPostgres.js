const express = require('express');
const db = require('../db/postgres');
const { asyncRoute, ApiError } = require('../middleware/errorHandler');
const requireAdmin = require('../middleware/requireAdminPostgres');
const requirePermission = require('../middleware/requirePermission');
const { writeAudit } = require('../lib/auditPostgres');

// PostgreSQL counterpart to server/routes/adminProductTypes.js (SQLite).
// Parallel/isolated file only — NOT mounted in app.js.
//
// Ordering note: `ORDER BY id` (numeric) and `ORDER BY key` (feature_flags'
// key values are 'prices'/'videos'/'certificates' — all lowercase, unique,
// no case variation) — neither is affected by SQLite-vs-PostgreSQL default
// collation, so no COLLATE "C" is needed anywhere in this file.

const router = express.Router();
router.use(requireAdmin, requirePermission('producttypes', 'manage'));

// `enabled` here is read straight off the BOOLEAN column, so PostgreSQL
// would otherwise return true/false where the existing SQLite API returns
// 1/0 — normalized back to 1/0 to preserve the exact response shape (same
// fix already applied to productTypesPostgres.js in Step 8).
router.get('/product-types', asyncRoute(async (req, res) => {
  const rows = await db.all('SELECT key, label, enabled FROM product_types ORDER BY id');
  res.json({ data: rows.map((r) => ({ ...r, enabled: r.enabled ? 1 : 0 })) });
}));

router.put('/product-types/:key', asyncRoute(async (req, res) => {
  const existing = await db.get('SELECT * FROM product_types WHERE key = $1', [req.params.key]);
  if (!existing) throw new ApiError(404, 'Unknown product type.');
  // `enabled` here is computed from the request body, not read from the DB,
  // so it's already a genuine JS boolean in both the SQLite and PostgreSQL
  // versions — no 1/0 normalization needed for THIS response.
  const enabled = !!(req.body || {}).enabled;
  await db.query('UPDATE product_types SET enabled = $1 WHERE key = $2', [enabled, existing.key]);
  await writeAudit({ actor: req.adminUser.full_name, action: 'Toggled product type', target: `${existing.label} ${enabled ? 'enabled' : 'disabled'}`, module: 'Product Types' });
  res.json({ data: { key: existing.key, enabled } });
}));

router.get('/feature-flags', asyncRoute(async (req, res) => {
  const rows = await db.all('SELECT key, label, description, enabled FROM feature_flags ORDER BY key');
  res.json({ data: rows.map((r) => ({ ...r, enabled: r.enabled ? 1 : 0 })) });
}));

router.put('/feature-flags/:key', asyncRoute(async (req, res) => {
  const existing = await db.get('SELECT * FROM feature_flags WHERE key = $1', [req.params.key]);
  if (!existing) throw new ApiError(404, 'Unknown feature flag.');
  const enabled = !!(req.body || {}).enabled;
  await db.query('UPDATE feature_flags SET enabled = $1 WHERE key = $2', [enabled, existing.key]);
  await writeAudit({ actor: req.adminUser.full_name, action: `${enabled ? 'Enabled' : 'Disabled'} feature`, target: `${existing.label} feature`, module: 'Product Types' });
  res.json({ data: { key: existing.key, enabled } });
}));

module.exports = router;
