const express = require('express');
const db = require('../db/postgres');
const { asyncRoute, ApiError } = require('../middleware/errorHandler');
const requireAdmin = require('../middleware/requireAdminPostgres');
const requirePermission = require('../middleware/requirePermission');
const { writeAudit } = require('../lib/auditPostgres');

// PostgreSQL counterpart to server/routes/adminSettings.js (SQLite).
// Parallel/isolated file only — NOT mounted in app.js. No additional
// sensitive setting is exposed beyond what the SQLite version already returns.

const router = express.Router();
router.use(requireAdmin, requirePermission('settings', 'manage'));

router.get('/', asyncRoute(async (req, res) => {
  const s = (await db.get('SELECT * FROM site_settings WHERE id = 1')) || {};
  res.json({
    data: {
      siteName: s.site_name || '', supportEmail: s.support_email || '',
      whatsappNumber: s.whatsapp_number || '', inquiryEmail: s.inquiry_email || '',
      lineId: s.line_id || '', skypeId: s.skype_id || '', priceMode: s.price_mode || 'approved',
    },
  });
}));

const VALID_PRICE_MODES = ['show', 'hide', 'contact', 'approved'];

router.put('/', asyncRoute(async (req, res) => {
  const b = req.body || {};
  const priceMode = b.priceMode || 'approved';
  if (!VALID_PRICE_MODES.includes(priceMode)) {
    throw new ApiError(400, `Invalid price mode. Use one of: ${VALID_PRICE_MODES.join(', ')}.`);
  }
  const before = await db.get('SELECT price_mode FROM site_settings WHERE id = 1');
  await db.query(
    `UPDATE site_settings SET site_name = $1, support_email = $2, whatsapp_number = $3, inquiry_email = $4, line_id = $5, skype_id = $6, price_mode = $7, updated_at = NOW() WHERE id = 1`,
    [b.siteName || null, b.supportEmail || null, b.whatsappNumber || null, b.inquiryEmail || null, b.lineId || null, b.skypeId || null, priceMode]
  );
  const priceLabels = { show: 'Show Prices to Everyone', hide: 'Hide Prices Entirely', contact: 'Contact for Price', approved: 'Show Prices Only to Approved Users' };
  if (before && before.price_mode !== priceMode) {
    await writeAudit({ actor: req.adminUser.full_name, action: 'Updated price visibility', target: priceLabels[priceMode] || priceMode, module: 'Settings' });
  } else {
    await writeAudit({ actor: req.adminUser.full_name, action: 'Updated settings', target: 'Site Settings', module: 'Settings' });
  }
  res.json({ data: { updated: true } });
}));

module.exports = router;
