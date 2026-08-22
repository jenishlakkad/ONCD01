const express = require('express');
const db = require('../db/connection');
const { asyncRoute } = require('../middleware/errorHandler');

const router = express.Router();

router.get('/product-types', asyncRoute(async (req, res) => {
  res.json({ data: db.prepare('SELECT key, label, enabled FROM product_types ORDER BY id').all() });
}));

router.get('/feature-flags', asyncRoute(async (req, res) => {
  res.json({ data: db.prepare('SELECT key, label, description, enabled FROM feature_flags ORDER BY key').all() });
}));

module.exports = router;
