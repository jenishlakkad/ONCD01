const express = require('express');
const db = require('../db/connection');
const { asyncRoute } = require('../middleware/errorHandler');
const requireAdmin = require('../middleware/requireAdmin');
const requirePermission = require('../middleware/requirePermission');

const router = express.Router();
router.use(requireAdmin, requirePermission('dashboard', 'view'));

router.get('/stats', asyncRoute(async (req, res) => {
  const pendingApprovals = db.prepare("SELECT COUNT(*) AS n FROM customers WHERE status = 'pending'").get().n;
  const totalProducts = db.prepare('SELECT COUNT(*) AS n FROM products').get().n;
  const inquiriesThisWeek = db.prepare("SELECT COUNT(*) AS n FROM inquiries WHERE created_at >= datetime('now', '-7 days')").get().n;
  const activeProductTypes = db.prepare('SELECT COUNT(*) AS n FROM product_types WHERE enabled = 1').get().n;

  const pendingUsers = db.prepare(
    "SELECT full_name AS name, company_name AS company, country FROM customers WHERE status = 'pending' ORDER BY created_at DESC"
  ).all();

  const recentInquiries = db.prepare(
    `SELECT i.id, i.channel, i.created_at AS date,
            COALESCE(c.full_name, i.guest_name, 'Guest') AS customer,
            (SELECT sku FROM inquiry_items WHERE inquiry_id = i.id ORDER BY id LIMIT 1) AS sku
     FROM inquiries i LEFT JOIN customers c ON c.id = i.customer_id
     ORDER BY i.created_at DESC LIMIT 4`
  ).all();

  const recentAudits = db.prepare('SELECT date, actor, action, target, module FROM audit_log ORDER BY id DESC LIMIT 8').all();

  res.json({
    data: {
      stats: [
        { label: 'Pending Approvals', value: pendingApprovals },
        { label: 'Total Products', value: totalProducts },
        { label: 'Inquiries This Week', value: inquiriesThisWeek },
        { label: 'Active Product Types', value: activeProductTypes },
      ],
      pendingUsers, recentInquiries, recentAudits,
    },
  });
}));

module.exports = router;
