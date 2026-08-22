const express = require('express');
const db = require('../db/connection');
const { asyncRoute } = require('../middleware/errorHandler');

const router = express.Router();

router.get('/', asyncRoute(async (req, res) => {
  const { type, group } = req.query;
  let sql = `SELECT c.id, c.name, c.group_key AS groupKey, c.sort_order AS sortOrder, pt.key AS productType
             FROM categories c JOIN product_types pt ON pt.id = c.product_type_id
             WHERE c.enabled = 1 AND pt.enabled = 1`;
  const params = [];
  if (type) { sql += ' AND pt.key = ?'; params.push(type); }
  if (group) { sql += ' AND c.group_key = ?'; params.push(group); }
  sql += ' ORDER BY c.sort_order, c.name';
  res.json({ data: db.prepare(sql).all(...params) });
}));

router.get('/subcategories', asyncRoute(async (req, res) => {
  res.json({ data: db.prepare('SELECT id, name, sort_order AS sortOrder FROM subcategories WHERE enabled = 1 ORDER BY sort_order, name').all() });
}));

module.exports = router;
