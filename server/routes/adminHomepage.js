const fs = require('fs');
const path = require('path');
const express = require('express');
const db = require('../db/connection');
const { asyncRoute, ApiError } = require('../middleware/errorHandler');
const requireAdmin = require('../middleware/requireAdmin');
const requirePermission = require('../middleware/requirePermission');
const { makeUploader } = require('../middleware/upload');
const { writeAudit } = require('../lib/audit');
const env = require('../config/env');

const router = express.Router();
const upload = makeUploader('homepage');
router.use(requireAdmin, requirePermission('homepage', 'manage'));

const BLOCK_KEYS = ['promo', 'spotlight', 'storyTeaser'];

function removeUploadedFile(url) {
  if (!url) return;
  const p = path.join(env.rootDir, url.replace(/^\//, ''));
  fs.unlink(p, () => {});
}

router.get('/', asyncRoute(async (req, res) => {
  const slides = db.prepare(
    `SELECT id, title, kicker, sub, cta, href, image_url AS imageUrl, sort_order AS sortOrder, enabled
     FROM homepage_slides ORDER BY sort_order`
  ).all();
  const sections = db.prepare('SELECT key, label, enabled FROM homepage_sections ORDER BY rowid').all();
  const blocks = db.prepare(
    `SELECT key, kicker, title, body, cta, href, image_url AS imageUrl FROM content_blocks WHERE page = 'home'`
  ).all();
  const collections = db.prepare(
    `SELECT id, key, title, description, href, image_url AS imageUrl, sort_order AS sortOrder
     FROM homepage_collections ORDER BY sort_order`
  ).all();
  const whyUs = db.prepare(
    `SELECT id, title, description, sort_order AS sortOrder, enabled FROM why_us_bullets WHERE page = 'home' ORDER BY sort_order`
  ).all();
  res.json({ data: { slides, sections, blocks, collections, whyUs } });
}));

router.post('/slides', asyncRoute(async (req, res) => {
  const { title, kicker, sub, cta, href } = req.body || {};
  if (!title || !String(title).trim()) throw new ApiError(400, 'title is required.');
  const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM homepage_slides').get().m;
  const info = db.prepare('INSERT INTO homepage_slides (title, kicker, sub, cta, href, sort_order, enabled) VALUES (?, ?, ?, ?, ?, ?, 1)')
    .run(title.trim(), kicker || null, sub || null, cta || null, href || null, maxOrder + 1);
  writeAudit({ actor: req.adminUser.full_name, action: 'Added slide', target: title.trim(), module: 'Homepage' });
  res.status(201).json({ data: { id: info.lastInsertRowid } });
}));

router.put('/slides/:id', asyncRoute(async (req, res) => {
  const existing = db.prepare('SELECT * FROM homepage_slides WHERE id = ?').get(req.params.id);
  if (!existing) throw new ApiError(404, 'Slide not found.');
  const { title, kicker, sub, cta, href, enabled } = req.body || {};
  db.prepare(
    `UPDATE homepage_slides SET title = COALESCE(?, title), kicker = COALESCE(?, kicker), sub = COALESCE(?, sub),
     cta = COALESCE(?, cta), href = COALESCE(?, href), enabled = COALESCE(?, enabled) WHERE id = ?`
  ).run(title ?? null, kicker ?? null, sub ?? null, cta ?? null, href ?? null, enabled === undefined ? null : (enabled ? 1 : 0), existing.id);
  writeAudit({ actor: req.adminUser.full_name, action: 'Edited slide', target: title || existing.title, module: 'Homepage' });
  res.json({ data: { updated: true } });
}));

router.post('/slides/:id/image', upload.single('image'), asyncRoute(async (req, res) => {
  const existing = db.prepare('SELECT * FROM homepage_slides WHERE id = ?').get(req.params.id);
  if (!existing) throw new ApiError(404, 'Slide not found.');
  if (!req.file) throw new ApiError(400, 'No image uploaded.');
  const url = `/uploads/homepage/${path.basename(req.file.path)}`;
  db.prepare('UPDATE homepage_slides SET image_url = ? WHERE id = ?').run(url, existing.id);
  removeUploadedFile(existing.image_url);
  writeAudit({ actor: req.adminUser.full_name, action: 'Updated slide image', target: existing.title, module: 'Homepage' });
  res.json({ data: { imageUrl: url } });
}));

router.delete('/slides/:id', asyncRoute(async (req, res) => {
  const existing = db.prepare('SELECT * FROM homepage_slides WHERE id = ?').get(req.params.id);
  if (!existing) throw new ApiError(404, 'Slide not found.');
  db.prepare('DELETE FROM homepage_slides WHERE id = ?').run(existing.id);
  removeUploadedFile(existing.image_url);
  writeAudit({ actor: req.adminUser.full_name, action: 'Removed slide', target: existing.title, module: 'Homepage' });
  res.json({ data: { deleted: true } });
}));

router.put('/sections/:key', asyncRoute(async (req, res) => {
  const existing = db.prepare('SELECT * FROM homepage_sections WHERE key = ?').get(req.params.key);
  if (!existing) throw new ApiError(404, 'Unknown section.');
  const enabled = !!(req.body || {}).enabled;
  db.prepare('UPDATE homepage_sections SET enabled = ? WHERE key = ?').run(enabled ? 1 : 0, existing.key);
  writeAudit({ actor: req.adminUser.full_name, action: 'Toggled homepage section', target: existing.label, module: 'Homepage' });
  res.json({ data: { key: existing.key, enabled } });
}));

// ---- Marketing blocks: promo banner, spotlight, story teaser ----

router.put('/blocks/:key', asyncRoute(async (req, res) => {
  if (!BLOCK_KEYS.includes(req.params.key)) throw new ApiError(404, 'Unknown block.');
  const existing = db.prepare(`SELECT * FROM content_blocks WHERE key = ? AND page = 'home'`).get(req.params.key);
  if (!existing) throw new ApiError(404, 'Unknown block.');
  const { kicker, title, body, cta, href } = req.body || {};
  db.prepare(
    `UPDATE content_blocks SET kicker = COALESCE(?, kicker), title = COALESCE(?, title), body = COALESCE(?, body),
     cta = COALESCE(?, cta), href = COALESCE(?, href), updated_at = datetime('now') WHERE key = ?`
  ).run(kicker ?? null, title ?? null, body ?? null, cta ?? null, href ?? null, existing.key);
  writeAudit({ actor: req.adminUser.full_name, action: 'Edited marketing block', target: title || existing.title || existing.key, module: 'Homepage' });
  res.json({ data: { updated: true } });
}));

router.post('/blocks/:key/image', upload.single('image'), asyncRoute(async (req, res) => {
  if (!BLOCK_KEYS.includes(req.params.key)) throw new ApiError(404, 'Unknown block.');
  const existing = db.prepare(`SELECT * FROM content_blocks WHERE key = ? AND page = 'home'`).get(req.params.key);
  if (!existing) throw new ApiError(404, 'Unknown block.');
  if (!req.file) throw new ApiError(400, 'No image uploaded.');
  const url = `/uploads/homepage/${path.basename(req.file.path)}`;
  db.prepare(`UPDATE content_blocks SET image_url = ?, updated_at = datetime('now') WHERE key = ?`).run(url, existing.key);
  removeUploadedFile(existing.image_url);
  writeAudit({ actor: req.adminUser.full_name, action: 'Updated marketing block image', target: existing.title || existing.key, module: 'Homepage' });
  res.json({ data: { imageUrl: url } });
}));

// ---- Collection tiles (Diamonds / Jewelry / Gemstones cards) ----

router.put('/collections/:key', asyncRoute(async (req, res) => {
  const existing = db.prepare('SELECT * FROM homepage_collections WHERE key = ?').get(req.params.key);
  if (!existing) throw new ApiError(404, 'Unknown collection.');
  const { title, description, href } = req.body || {};
  db.prepare(
    `UPDATE homepage_collections SET title = COALESCE(?, title), description = COALESCE(?, description),
     href = COALESCE(?, href) WHERE key = ?`
  ).run(title ?? null, description ?? null, href ?? null, existing.key);
  writeAudit({ actor: req.adminUser.full_name, action: 'Edited collection tile', target: title || existing.title, module: 'Homepage' });
  res.json({ data: { updated: true } });
}));

router.post('/collections/:key/image', upload.single('image'), asyncRoute(async (req, res) => {
  const existing = db.prepare('SELECT * FROM homepage_collections WHERE key = ?').get(req.params.key);
  if (!existing) throw new ApiError(404, 'Unknown collection.');
  if (!req.file) throw new ApiError(400, 'No image uploaded.');
  const url = `/uploads/homepage/${path.basename(req.file.path)}`;
  db.prepare('UPDATE homepage_collections SET image_url = ? WHERE key = ?').run(url, existing.key);
  removeUploadedFile(existing.image_url);
  writeAudit({ actor: req.adminUser.full_name, action: 'Updated collection tile image', target: existing.title, module: 'Homepage' });
  res.json({ data: { imageUrl: url } });
}));

// ---- Why Choose Us bullets (Home's own list) ----

router.post('/why-us', asyncRoute(async (req, res) => {
  const { title, description } = req.body || {};
  if (!title || !String(title).trim()) throw new ApiError(400, 'title is required.');
  const maxOrder = db.prepare(`SELECT COALESCE(MAX(sort_order), -1) AS m FROM why_us_bullets WHERE page = 'home'`).get().m;
  const info = db.prepare(`INSERT INTO why_us_bullets (page, title, description, sort_order, enabled) VALUES ('home', ?, ?, ?, 1)`)
    .run(title.trim(), description || null, maxOrder + 1);
  writeAudit({ actor: req.adminUser.full_name, action: 'Added Why Us bullet', target: title.trim(), module: 'Homepage' });
  res.status(201).json({ data: { id: info.lastInsertRowid } });
}));

router.put('/why-us/reorder', asyncRoute(async (req, res) => {
  const order = Array.isArray((req.body || {}).order) ? req.body.order : null;
  if (!order || !order.length) throw new ApiError(400, 'order must be a non-empty array of ids.');
  const existing = db.prepare(`SELECT id FROM why_us_bullets WHERE page = 'home'`).all();
  const existingIds = new Set(existing.map((r) => r.id));
  if (order.length !== existing.length || !order.every((id) => existingIds.has(id))) {
    throw new ApiError(400, "order must contain exactly Home's why-us bullet ids.");
  }
  const setOrder = db.prepare(`UPDATE why_us_bullets SET sort_order = ? WHERE id = ? AND page = 'home'`);
  db.transaction(() => { order.forEach((id, i) => setOrder.run(i, id)); })();
  res.json({ data: { reordered: true } });
}));

router.put('/why-us/:id', asyncRoute(async (req, res) => {
  const existing = db.prepare(`SELECT * FROM why_us_bullets WHERE id = ? AND page = 'home'`).get(req.params.id);
  if (!existing) throw new ApiError(404, 'Bullet not found.');
  const { title, description, enabled } = req.body || {};
  db.prepare(
    `UPDATE why_us_bullets SET title = COALESCE(?, title), description = COALESCE(?, description),
     enabled = COALESCE(?, enabled) WHERE id = ?`
  ).run(title ?? null, description ?? null, enabled === undefined ? null : (enabled ? 1 : 0), existing.id);
  writeAudit({ actor: req.adminUser.full_name, action: 'Edited Why Us bullet', target: title || existing.title, module: 'Homepage' });
  res.json({ data: { updated: true } });
}));

router.delete('/why-us/:id', asyncRoute(async (req, res) => {
  const existing = db.prepare(`SELECT * FROM why_us_bullets WHERE id = ? AND page = 'home'`).get(req.params.id);
  if (!existing) throw new ApiError(404, 'Bullet not found.');
  db.prepare('DELETE FROM why_us_bullets WHERE id = ?').run(existing.id);
  writeAudit({ actor: req.adminUser.full_name, action: 'Removed Why Us bullet', target: existing.title, module: 'Homepage' });
  res.json({ data: { deleted: true } });
}));

// Multer errors (bad file type, too large) land here instead of the generic error handler
// because they're thrown synchronously inside the upload middleware before res is touched.
router.use((err, req, res, next) => {
  if (err && (err.message || '').startsWith('Unsupported file type')) return res.status(400).json({ error: err.message });
  if (err && err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: 'File is too large (50MB max).' });
  next(err);
});

module.exports = router;
