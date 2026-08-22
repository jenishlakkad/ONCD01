const express = require('express');
const db = require('../db/connection');
const { asyncRoute, ApiError } = require('../middleware/errorHandler');
const requireAdmin = require('../middleware/requireAdmin');
const requirePermission = require('../middleware/requirePermission');
const { writeAudit } = require('../lib/audit');

const router = express.Router();
router.use(requireAdmin, requirePermission('settings', 'manage'));

router.get('/', asyncRoute(async (req, res) => {
  const s = db.prepare('SELECT * FROM site_settings WHERE id = 1').get() || {};
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
  const before = db.prepare('SELECT price_mode FROM site_settings WHERE id = 1').get();
  db.prepare(
    `UPDATE site_settings SET site_name = ?, support_email = ?, whatsapp_number = ?, inquiry_email = ?, line_id = ?, skype_id = ?, price_mode = ?, updated_at = datetime('now') WHERE id = 1`
  ).run(
    b.siteName || null, b.supportEmail || null, b.whatsappNumber || null, b.inquiryEmail || null,
    b.lineId || null, b.skypeId || null, priceMode
  );
  const priceLabels = { show: 'Show Prices to Everyone', hide: 'Hide Prices Entirely', contact: 'Contact for Price', approved: 'Show Prices Only to Approved Users' };
  if (before && before.price_mode !== priceMode) {
    writeAudit({ actor: req.adminUser.full_name, action: 'Updated price visibility', target: priceLabels[priceMode] || priceMode, module: 'Settings' });
  } else {
    writeAudit({ actor: req.adminUser.full_name, action: 'Updated settings', target: 'Site Settings', module: 'Settings' });
  }
  res.json({ data: { updated: true } });
}));

module.exports = router;
