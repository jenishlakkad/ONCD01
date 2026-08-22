const express = require('express');
const db = require('../db/connection');
const { asyncRoute } = require('../middleware/errorHandler');
const requireAdmin = require('../middleware/requireAdmin');
const requirePermission = require('../middleware/requirePermission');

const router = express.Router();
router.use(requireAdmin, requirePermission('audit', 'view'));

router.get('/', asyncRoute(async (req, res) => {
  const { month, year, from, to, limit } = req.query;
  let sql = 'SELECT id, date, time, actor, action, target, module FROM audit_log WHERE 1=1';
  const params = [];
  if (month) { sql += ' AND date LIKE ?'; params.push(`${month}%`); }
  if (year) { sql += ' AND date LIKE ?'; params.push(`${year}%`); }
  if (from) { sql += ' AND date >= ?'; params.push(from); }
  if (to) { sql += ' AND date <= ?'; params.push(to); }
  sql += ' ORDER BY date DESC, time DESC';
  if (limit) { sql += ' LIMIT ?'; params.push(Number(limit)); }
  res.json({ data: db.prepare(sql).all(...params) });
}));

module.exports = router;
