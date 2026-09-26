const express = require('express');
const db = require('../db/postgres');
const { asyncRoute } = require('../middleware/errorHandler');
const requireAdmin = require('../middleware/requireAdminPostgres');
const requirePermission = require('../middleware/requirePermission');

// PostgreSQL counterpart to server/routes/adminDashboard.js (SQLite).
// Parallel/isolated file only — NOT mounted in app.js. Read-only, no writes.
//
// Ordering note: every ORDER BY here is either numeric (`id`) or a
// TIMESTAMPTZ column (`created_at`) — timestamps compare chronologically
// regardless of collation, and none of these queries sorts by a text
// column, so no COLLATE "C" is needed anywhere in this file.

const router = express.Router();
router.use(requireAdmin, requirePermission('dashboard', 'view'));

router.get('/stats', asyncRoute(async (req, res) => {
  // COUNT(*) always returns BIGINT in PostgreSQL, independent of the
  // counted table's own column types — every .n below needs Number(...).
  const [pendingApprovalsRow, totalProductsRow, inquiriesThisWeekRow, activeProductTypesRow] = await Promise.all([
    db.get("SELECT COUNT(*) AS n FROM customers WHERE status = 'pending'"),
    db.get('SELECT COUNT(*) AS n FROM products'),
    // datetime('now', '-7 days') -> NOW() - INTERVAL '7 days'
    db.get(`SELECT COUNT(*) AS n FROM inquiries WHERE created_at >= NOW() - INTERVAL '7 days'`),
    db.get('SELECT COUNT(*) AS n FROM product_types WHERE enabled = TRUE'),
  ]);

  const pendingUsers = await db.all(
    "SELECT full_name AS name, company_name AS company, country FROM customers WHERE status = 'pending' ORDER BY created_at DESC"
  );

  const recentInquiriesRaw = await db.all(
    `SELECT i.id, i.channel, i.created_at AS date,
            COALESCE(c.full_name, i.guest_name, 'Guest') AS customer,
            (SELECT sku FROM inquiry_items WHERE inquiry_id = i.id ORDER BY id LIMIT 1) AS sku
     FROM inquiries i LEFT JOIN customers c ON c.id = i.customer_id
     ORDER BY i.created_at DESC LIMIT 4`
  );
  // inquiries.id is BIGINT -> pg returns it as a string; Number(...) keeps
  // the response shape identical to the SQLite version.
  const recentInquiries = recentInquiriesRaw.map((r) => ({ ...r, id: Number(r.id) }));

  // No `id` column is selected here, so no BIGINT normalization applies.
  const recentAudits = await db.all('SELECT date, actor, action, target, module FROM audit_log ORDER BY id DESC LIMIT 8');

  res.json({
    data: {
      stats: [
        { label: 'Pending Approvals', value: Number(pendingApprovalsRow.n) },
        { label: 'Total Products', value: Number(totalProductsRow.n) },
        { label: 'Inquiries This Week', value: Number(inquiriesThisWeekRow.n) },
        { label: 'Active Product Types', value: Number(activeProductTypesRow.n) },
      ],
      pendingUsers, recentInquiries, recentAudits,
    },
  });
}));

module.exports = router;
