const express = require('express');
const db = require('../db/postgres');
const { asyncRoute, ApiError } = require('../middleware/errorHandler');
const requireAdmin = require('../middleware/requireAdminPostgres');
const requirePermission = require('../middleware/requirePermission');
const { writeAudit } = require('../lib/auditPostgres');

// PostgreSQL counterpart to server/routes/adminSeo.js (SQLite). Parallel/
// isolated file only — NOT mounted in app.js.
//
// Ordering note: `ORDER BY page_key` — values are 'home'/'diamonds'/
// 'jewelry'/'gemstones', all lowercase and unique (primary key), so no
// case-variation tie exists and no COLLATE "C" is needed here.

const router = express.Router();
router.use(requireAdmin, requirePermission('seo', 'manage'));

router.get('/', asyncRoute(async (req, res) => {
  const rows = await db.all(
    'SELECT page_key AS "pageKey", meta_title AS "metaTitle", meta_description AS "metaDescription" FROM seo_pages ORDER BY page_key'
  );
  res.json({ data: rows });
}));

router.put('/:pageKey', asyncRoute(async (req, res) => {
  const existing = await db.get('SELECT * FROM seo_pages WHERE page_key = $1', [req.params.pageKey]);
  if (!existing) throw new ApiError(404, 'Unknown page.');
  const { metaTitle, metaDescription } = req.body || {};
  await db.query(
    `UPDATE seo_pages SET meta_title = $1, meta_description = $2, updated_at = NOW() WHERE page_key = $3`,
    [metaTitle || null, metaDescription || null, existing.page_key]
  );
  await writeAudit({ actor: req.adminUser.full_name, action: 'Updated SEO meta', target: existing.page_key.charAt(0).toUpperCase() + existing.page_key.slice(1), module: 'SEO' });
  res.json({ data: { updated: true } });
}));

module.exports = router;
