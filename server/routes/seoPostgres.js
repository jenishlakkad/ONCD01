const express = require('express');
const db = require('../db/postgres');
const { asyncRoute } = require('../middleware/errorHandler');

// PostgreSQL counterpart to server/routes/seo.js (SQLite). Parallel/isolated
// file only — NOT mounted in app.js. Read-only, no writes.
//
// NOTE: `AS pageKey`, `AS metaTitle`, `AS metaDescription` must be
// double-quoted, same reasoning as every other *Postgres.js file — Postgres
// folds unquoted identifiers to lowercase.

const router = express.Router();

router.get('/:pageKey', asyncRoute(async (req, res) => {
  const row = await db.get(
    'SELECT page_key AS "pageKey", meta_title AS "metaTitle", meta_description AS "metaDescription" FROM seo_pages WHERE page_key = $1',
    [req.params.pageKey]
  );
  res.json({ data: row || { pageKey: req.params.pageKey, metaTitle: null, metaDescription: null } });
}));

module.exports = router;
