const express = require('express');
const db = require('../db/connection');
const { asyncRoute } = require('../middleware/errorHandler');
const requireAdmin = require('../middleware/requireAdmin');
const requirePermission = require('../middleware/requirePermission');

const router = express.Router();
router.use(requireAdmin, requirePermission('roles', 'view'));

router.get('/', asyncRoute(async (req, res) => {
  const roles = db.prepare('SELECT id, name, description FROM roles ORDER BY id').all();
  const data = roles.map((r) => ({
    ...r,
    userCount: db.prepare('SELECT COUNT(*) AS n FROM admin_users WHERE role_id = ?').get(r.id).n,
  }));
  res.json({ data });
}));

module.exports = router;
