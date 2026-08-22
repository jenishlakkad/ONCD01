const express = require('express');
const db = require('../db/connection');
const { asyncRoute, ApiError } = require('../middleware/errorHandler');
const requireAdmin = require('../middleware/requireAdmin');
const requirePermission = require('../middleware/requirePermission');
const { writeAudit } = require('../lib/audit');

const router = express.Router();
router.use(requireAdmin, requirePermission('seo', 'manage'));

router.get('/', asyncRoute(async (req, res) => {
  res.json({ data: db.prepare('SELECT page_key AS pageKey, meta_title AS metaTitle, meta_description AS metaDescription FROM seo_pages ORDER BY page_key').all() });
}));

router.put('/:pageKey', asyncRoute(async (req, res) => {
  const existing = db.prepare('SELECT * FROM seo_pages WHERE page_key = ?').get(req.params.pageKey);
  if (!existing) throw new ApiError(404, 'Unknown page.');
  const { metaTitle, metaDescription } = req.body || {};
  db.prepare(`UPDATE seo_pages SET meta_title = ?, meta_description = ?, updated_at = datetime('now') WHERE page_key = ?`)
    .run(metaTitle || null, metaDescription || null, existing.page_key);
  writeAudit({ actor: req.adminUser.full_name, action: 'Updated SEO meta', target: existing.page_key.charAt(0).toUpperCase() + existing.page_key.slice(1), module: 'SEO' });
  res.json({ data: { updated: true } });
}));

module.exports = router;
