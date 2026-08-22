const express = require('express');
const db = require('../db/connection');
const { asyncRoute, ApiError } = require('../middleware/errorHandler');
const requireAdmin = require('../middleware/requireAdmin');
const requirePermission = require('../middleware/requirePermission');
const { writeAudit } = require('../lib/audit');

const router = express.Router();
router.use(requireAdmin, requirePermission('producttypes', 'manage'));

router.get('/product-types', asyncRoute(async (req, res) => {
  res.json({ data: db.prepare('SELECT key, label, enabled FROM product_types ORDER BY id').all() });
}));

router.put('/product-types/:key', asyncRoute(async (req, res) => {
  const existing = db.prepare('SELECT * FROM product_types WHERE key = ?').get(req.params.key);
  if (!existing) throw new ApiError(404, 'Unknown product type.');
  const enabled = !!(req.body || {}).enabled;
  db.prepare('UPDATE product_types SET enabled = ? WHERE key = ?').run(enabled ? 1 : 0, existing.key);
  writeAudit({ actor: req.adminUser.full_name, action: 'Toggled product type', target: `${existing.label} ${enabled ? 'enabled' : 'disabled'}`, module: 'Product Types' });
  res.json({ data: { key: existing.key, enabled } });
}));

router.get('/feature-flags', asyncRoute(async (req, res) => {
  res.json({ data: db.prepare('SELECT key, label, description, enabled FROM feature_flags ORDER BY key').all() });
}));

router.put('/feature-flags/:key', asyncRoute(async (req, res) => {
  const existing = db.prepare('SELECT * FROM feature_flags WHERE key = ?').get(req.params.key);
  if (!existing) throw new ApiError(404, 'Unknown feature flag.');
  const enabled = !!(req.body || {}).enabled;
  db.prepare('UPDATE feature_flags SET enabled = ? WHERE key = ?').run(enabled ? 1 : 0, existing.key);
  writeAudit({ actor: req.adminUser.full_name, action: `${enabled ? 'Enabled' : 'Disabled'} feature`, target: `${existing.label} feature`, module: 'Product Types' });
  res.json({ data: { key: existing.key, enabled } });
}));

module.exports = router;
