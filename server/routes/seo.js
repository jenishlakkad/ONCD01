const express = require('express');
const db = require('../db/connection');
const { asyncRoute } = require('../middleware/errorHandler');

const router = express.Router();

router.get('/:pageKey', asyncRoute(async (req, res) => {
  const row = db.prepare('SELECT page_key AS pageKey, meta_title AS metaTitle, meta_description AS metaDescription FROM seo_pages WHERE page_key = ?').get(req.params.pageKey);
  res.json({ data: row || { pageKey: req.params.pageKey, metaTitle: null, metaDescription: null } });
}));

module.exports = router;
