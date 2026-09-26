const express = require('express');
const db = require('../db/postgres');
const { asyncRoute } = require('../middleware/errorHandler');
const { toPublicMediaUrl } = require('../lib/mediaUrl');

// PostgreSQL counterpart to server/routes/homepage.js (SQLite). Parallel/
// isolated file only — NOT mounted in app.js.
//
// sections[r.key] = !!r.enabled must stay a REAL boolean here — this is the
// one place in Batch E where the current SQLite API already returns
// true/false, not 1/0, so PostgreSQL's native boolean needs zero
// normalization (see adminHomepagePostgres.js for the opposite case).

const router = express.Router();

router.get('/', asyncRoute(async (req, res) => {
  const slides = await db.all(
    `SELECT id, title, kicker, sub, cta, href, image_url AS "imageUrl", sort_order AS "sortOrder"
     FROM homepage_slides WHERE enabled = true ORDER BY sort_order`
  );
  const sectionRows = await db.all('SELECT key, enabled FROM homepage_sections ORDER BY sort_order');
  const sections = {};
  for (const r of sectionRows) sections[r.key] = !!r.enabled;

  const blockRows = await db.all(
    `SELECT key, kicker, title, body, cta, href, image_url AS "imageUrl" FROM content_blocks WHERE page = 'home' ORDER BY sort_order`
  );
  const blocks = {};
  for (const r of blockRows) blocks[r.key] = { ...r, imageUrl: toPublicMediaUrl(r.imageUrl) };

  const collections = await db.all(
    `SELECT key, title, description, href, image_url AS "imageUrl" FROM homepage_collections ORDER BY sort_order`
  );

  const whyUs = await db.all(
    `SELECT title, description FROM why_us_bullets WHERE page = 'home' AND enabled = true ORDER BY sort_order`
  );

  // homepage_slides.id is BIGINT -> Number(...); every other exposed field
  // here has a TEXT or BOOLEAN key, no other conversion needed.
  res.json({
    data: {
      slides: slides.map((s) => ({ ...s, id: Number(s.id), imageUrl: toPublicMediaUrl(s.imageUrl) })),
      sections,
      blocks,
      collections: collections.map((c) => ({ ...c, imageUrl: toPublicMediaUrl(c.imageUrl) })),
      whyUs,
    },
  });
}));

module.exports = router;
