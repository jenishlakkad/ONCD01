const express = require('express');
const db = require('../db/connection');
const { asyncRoute } = require('../middleware/errorHandler');

const router = express.Router();

router.get('/', asyncRoute(async (req, res) => {
  const slides = db.prepare(
    `SELECT id, title, kicker, sub, cta, href, image_url AS imageUrl, sort_order AS sortOrder
     FROM homepage_slides WHERE enabled = 1 ORDER BY sort_order`
  ).all();
  const sectionRows = db.prepare('SELECT key, enabled FROM homepage_sections').all();
  const sections = {};
  for (const r of sectionRows) sections[r.key] = !!r.enabled;

  const blockRows = db.prepare(
    `SELECT key, kicker, title, body, cta, href, image_url AS imageUrl FROM content_blocks WHERE page = 'home'`
  ).all();
  const blocks = {};
  for (const r of blockRows) blocks[r.key] = r;

  const collections = db.prepare(
    `SELECT key, title, description, href, image_url AS imageUrl FROM homepage_collections ORDER BY sort_order`
  ).all();

  const whyUs = db.prepare(
    `SELECT title, description FROM why_us_bullets WHERE page = 'home' AND enabled = 1 ORDER BY sort_order`
  ).all();

  res.json({ data: { slides, sections, blocks, collections, whyUs } });
}));

module.exports = router;
