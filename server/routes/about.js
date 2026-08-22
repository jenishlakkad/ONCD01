const express = require('express');
const db = require('../db/connection');
const { asyncRoute } = require('../middleware/errorHandler');

const router = express.Router();

router.get('/', asyncRoute(async (req, res) => {
  const blockRows = db.prepare(
    `SELECT key, kicker, title, body, cta, href, image_url AS imageUrl FROM content_blocks WHERE page = 'about'`
  ).all();
  const blocks = {};
  for (const r of blockRows) blocks[r.key] = r;

  const team = db.prepare(
    `SELECT id, name, role, photo_url AS photoUrl FROM team_members WHERE enabled = 1 ORDER BY sort_order`
  ).all();
  const timeline = db.prepare(
    `SELECT id, year, title, description FROM company_timeline WHERE enabled = 1 ORDER BY sort_order`
  ).all();
  const certs = db.prepare(
    `SELECT id, name, logo_url AS logoUrl FROM certifications WHERE enabled = 1 ORDER BY sort_order`
  ).all();
  const gallery = db.prepare(
    `SELECT id, kind, url, caption FROM about_gallery ORDER BY sort_order`
  ).all();
  const whyUs = db.prepare(
    `SELECT title, description FROM why_us_bullets WHERE page = 'about' AND enabled = 1 ORDER BY sort_order`
  ).all();

  res.json({ data: { blocks, team, timeline, certs, gallery, whyUs } });
}));

module.exports = router;
