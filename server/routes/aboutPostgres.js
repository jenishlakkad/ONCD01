const express = require('express');
const db = require('../db/postgres');
const { asyncRoute } = require('../middleware/errorHandler');
const { toPublicMediaUrl } = require('../lib/mediaUrl');

// PostgreSQL counterpart to server/routes/about.js (SQLite). Parallel/
// isolated file only — NOT mounted in app.js.
//
// team/timeline/certs/gallery all expose `enabled`-free response shapes
// (the SQLite source never selects `enabled` here, only filters by it, and
// `about_gallery` has no `enabled` column at all) — no boolean normalization
// needed anywhere in this file, confirmed by re-reading the source.

const router = express.Router();

router.get('/', asyncRoute(async (req, res) => {
  const blockRows = await db.all(
    `SELECT key, kicker, title, body, cta, href, image_url AS "imageUrl" FROM content_blocks WHERE page = 'about' ORDER BY sort_order`
  );
  const blocks = {};
  for (const r of blockRows) blocks[r.key] = { ...r, imageUrl: toPublicMediaUrl(r.imageUrl) };

  const team = await db.all(
    `SELECT id, name, role, photo_url AS "photoUrl" FROM team_members WHERE enabled = true ORDER BY sort_order`
  );
  const timeline = await db.all(
    `SELECT id, year, title, description FROM company_timeline WHERE enabled = true ORDER BY sort_order`
  );
  const certs = await db.all(
    `SELECT id, name, logo_url AS "logoUrl" FROM certifications WHERE enabled = true ORDER BY sort_order`
  );
  const gallery = await db.all(
    `SELECT id, kind, url, caption FROM about_gallery ORDER BY sort_order`
  );
  const whyUs = await db.all(
    `SELECT title, description FROM why_us_bullets WHERE page = 'about' AND enabled = true ORDER BY sort_order`
  );

  // team_members/company_timeline/certifications/about_gallery ids are all
  // BIGINT -> Number(...).
  res.json({
    data: {
      blocks,
      team: team.map((r) => ({ ...r, id: Number(r.id), photoUrl: toPublicMediaUrl(r.photoUrl) })),
      timeline: timeline.map((r) => ({ ...r, id: Number(r.id) })),
      certs: certs.map((r) => ({ ...r, id: Number(r.id), logoUrl: toPublicMediaUrl(r.logoUrl) })),
      gallery: gallery.map((r) => ({ ...r, id: Number(r.id), url: toPublicMediaUrl(r.url) })),
      whyUs,
    },
  });
}));

module.exports = router;
