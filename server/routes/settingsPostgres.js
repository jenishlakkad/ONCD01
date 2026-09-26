const express = require('express');
const db = require('../db/postgres');
const { asyncRoute } = require('../middleware/errorHandler');

// PostgreSQL counterpart to server/routes/settings.js (SQLite). Parallel/
// isolated file only — NOT mounted in app.js. Read-only, no writes.
//
// The masking behavior (only these 7 named fields ever leave this route,
// nothing else off site_settings) is preserved exactly via the same manual
// object reshape the SQLite version already uses — no additional field is
// exposed.

const router = express.Router();

router.get('/public', asyncRoute(async (req, res) => {
  const s = (await db.get('SELECT * FROM site_settings WHERE id = 1')) || {};
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
