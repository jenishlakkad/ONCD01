const express = require('express');
const db = require('../db/connection');
const { asyncRoute } = require('../middleware/errorHandler');

const router = express.Router();

router.get('/public', asyncRoute(async (req, res) => {
  const s = db.prepare('SELECT * FROM site_settings WHERE id = 1').get() || {};
  res.json({
    data: {
      siteName: s.site_name || null,
      supportEmail: s.support_email || null,
      whatsapp: s.whatsapp_number || null,
      inquiryEmail: s.inquiry_email || null,
      lineId: s.line_id || null,
      skypeId: s.skype_id || null,
      priceMode: s.price_mode || 'approved',
    },
  });
}));

module.exports = router;
