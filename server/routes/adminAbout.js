const fs = require('fs');
const path = require('path');
const express = require('express');
const db = require('../db/connection');
const { asyncRoute, ApiError } = require('../middleware/errorHandler');
const requireAdmin = require('../middleware/requireAdmin');
const requirePermission = require('../middleware/requirePermission');
const { makeUploader, kindOf } = require('../middleware/upload');
const { writeAudit } = require('../lib/audit');
const env = require('../config/env');

const router = express.Router();
const upload = makeUploader('about');
router.use(requireAdmin, requirePermission('about', 'manage'));

const BLOCK_KEYS = ['hero', 'story', 'mission', 'vision'];

function removeUploadedFile(url) {
  if (!url) return;
  const p = path.join(env.rootDir, url.replace(/^\//, ''));
  fs.unlink(p, () => {});
}

function galleryList() {
  return db.prepare(
    `SELECT id, kind, url, caption, sort_order AS sortOrder FROM about_gallery ORDER BY sort_order`
  ).all();
}

router.get('/', asyncRoute(async (req, res) => {
  const blocks = db.prepare(
    `SELECT key, kicker, title, body, cta, href, image_url AS imageUrl FROM content_blocks WHERE page = 'about'`
  ).all();
  const team = db.prepare(
    `SELECT id, name, role, photo_url AS photoUrl, sort_order AS sortOrder, enabled FROM team_members ORDER BY sort_order`
  ).all();
  const timeline = db.prepare(
    `SELECT id, year, title, description, sort_order AS sortOrder, enabled FROM company_timeline ORDER BY sort_order`
  ).all();
  const certs = db.prepare(
    `SELECT id, name, logo_url AS logoUrl, sort_order AS sortOrder, enabled FROM certifications ORDER BY sort_order`
  ).all();
  const whyUs = db.prepare(
    `SELECT id, title, description, sort_order AS sortOrder, enabled FROM why_us_bullets WHERE page = 'about' ORDER BY sort_order`
  ).all();
  res.json({ data: { blocks, team, timeline, certs, gallery: galleryList(), whyUs } });
}));

// ---- Text/photo blocks: hero intro, our story, mission, vision ----

router.put('/blocks/:key', asyncRoute(async (req, res) => {
  if (!BLOCK_KEYS.includes(req.params.key)) throw new ApiError(404, 'Unknown block.');
  const existing = db.prepare(`SELECT * FROM content_blocks WHERE key = ? AND page = 'about'`).get(req.params.key);
  if (!existing) throw new ApiError(404, 'Unknown block.');
  const { kicker, title, body, cta, href } = req.body || {};
  db.prepare(
    `UPDATE content_blocks SET kicker = COALESCE(?, kicker), title = COALESCE(?, title), body = COALESCE(?, body),
     cta = COALESCE(?, cta), href = COALESCE(?, href), updated_at = datetime('now') WHERE key = ?`
  ).run(kicker ?? null, title ?? null, body ?? null, cta ?? null, href ?? null, existing.key);
  writeAudit({ actor: req.adminUser.full_name, action: 'Edited About block', target: title || existing.title || existing.key, module: 'About' });
  res.json({ data: { updated: true } });
}));

router.post('/blocks/:key/image', upload.single('image'), asyncRoute(async (req, res) => {
  if (!BLOCK_KEYS.includes(req.params.key)) throw new ApiError(404, 'Unknown block.');
  const existing = db.prepare(`SELECT * FROM content_blocks WHERE key = ? AND page = 'about'`).get(req.params.key);
  if (!existing) throw new ApiError(404, 'Unknown block.');
  if (!req.file) throw new ApiError(400, 'No image uploaded.');
  const url = `/uploads/about/${path.basename(req.file.path)}`;
  db.prepare(`UPDATE content_blocks SET image_url = ?, updated_at = datetime('now') WHERE key = ?`).run(url, existing.key);
  removeUploadedFile(existing.image_url);
  writeAudit({ actor: req.adminUser.full_name, action: 'Updated About block image', target: existing.title || existing.key, module: 'About' });
  res.json({ data: { imageUrl: url } });
}));

// ---- Team members ----

router.post('/team', asyncRoute(async (req, res) => {
  const { name, role } = req.body || {};
  if (!name || !String(name).trim()) throw new ApiError(400, 'name is required.');
  const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM team_members').get().m;
  const info = db.prepare('INSERT INTO team_members (name, role, photo_url, sort_order, enabled) VALUES (?, ?, NULL, ?, 1)')
    .run(name.trim(), role || null, maxOrder + 1);
  writeAudit({ actor: req.adminUser.full_name, action: 'Added team member', target: name.trim(), module: 'About' });
  res.status(201).json({ data: { id: info.lastInsertRowid } });
}));

router.put('/team/:id', asyncRoute(async (req, res) => {
  const existing = db.prepare('SELECT * FROM team_members WHERE id = ?').get(req.params.id);
  if (!existing) throw new ApiError(404, 'Team member not found.');
  const { name, role, enabled } = req.body || {};
  db.prepare(
    `UPDATE team_members SET name = COALESCE(?, name), role = COALESCE(?, role), enabled = COALESCE(?, enabled) WHERE id = ?`
  ).run(name ?? null, role ?? null, enabled === undefined ? null : (enabled ? 1 : 0), existing.id);
  writeAudit({ actor: req.adminUser.full_name, action: 'Edited team member', target: name || existing.name, module: 'About' });
  res.json({ data: { updated: true } });
}));

router.put('/team/reorder', asyncRoute(async (req, res) => {
  const order = Array.isArray((req.body || {}).order) ? req.body.order : null;
  if (!order || !order.length) throw new ApiError(400, 'order must be a non-empty array of ids.');
  const existing = db.prepare('SELECT id FROM team_members').all();
  const existingIds = new Set(existing.map((r) => r.id));
  if (order.length !== existing.length || !order.every((id) => existingIds.has(id))) {
    throw new ApiError(400, "order must contain exactly the team's member ids.");
  }
  const setOrder = db.prepare('UPDATE team_members SET sort_order = ? WHERE id = ?');
  db.transaction(() => { order.forEach((id, i) => setOrder.run(i, id)); })();
  res.json({ data: { reordered: true } });
}));

router.post('/team/:id/photo', upload.single('photo'), asyncRoute(async (req, res) => {
  const existing = db.prepare('SELECT * FROM team_members WHERE id = ?').get(req.params.id);
  if (!existing) throw new ApiError(404, 'Team member not found.');
  if (!req.file) throw new ApiError(400, 'No photo uploaded.');
  const url = `/uploads/about/${path.basename(req.file.path)}`;
  db.prepare('UPDATE team_members SET photo_url = ? WHERE id = ?').run(url, existing.id);
  removeUploadedFile(existing.photo_url);
  writeAudit({ actor: req.adminUser.full_name, action: 'Updated team member photo', target: existing.name, module: 'About' });
  res.json({ data: { photoUrl: url } });
}));

router.delete('/team/:id', asyncRoute(async (req, res) => {
  const existing = db.prepare('SELECT * FROM team_members WHERE id = ?').get(req.params.id);
  if (!existing) throw new ApiError(404, 'Team member not found.');
  db.prepare('DELETE FROM team_members WHERE id = ?').run(existing.id);
  removeUploadedFile(existing.photo_url);
  writeAudit({ actor: req.adminUser.full_name, action: 'Removed team member', target: existing.name, module: 'About' });
  res.json({ data: { deleted: true } });
}));

// ---- Timeline / milestones (no images) ----

router.post('/timeline', asyncRoute(async (req, res) => {
  const { year, title, description } = req.body || {};
  if (!year || !String(year).trim()) throw new ApiError(400, 'year is required.');
  const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM company_timeline').get().m;
  const info = db.prepare('INSERT INTO company_timeline (year, title, description, sort_order, enabled) VALUES (?, ?, ?, ?, 1)')
    .run(year.trim(), title || null, description || null, maxOrder + 1);
  writeAudit({ actor: req.adminUser.full_name, action: 'Added timeline entry', target: year.trim(), module: 'About' });
  res.status(201).json({ data: { id: info.lastInsertRowid } });
}));

router.put('/timeline/:id', asyncRoute(async (req, res) => {
  const existing = db.prepare('SELECT * FROM company_timeline WHERE id = ?').get(req.params.id);
  if (!existing) throw new ApiError(404, 'Timeline entry not found.');
  const { year, title, description, enabled } = req.body || {};
  db.prepare(
    `UPDATE company_timeline SET year = COALESCE(?, year), title = COALESCE(?, title),
     description = COALESCE(?, description), enabled = COALESCE(?, enabled) WHERE id = ?`
  ).run(year ?? null, title ?? null, description ?? null, enabled === undefined ? null : (enabled ? 1 : 0), existing.id);
  writeAudit({ actor: req.adminUser.full_name, action: 'Edited timeline entry', target: year || existing.year, module: 'About' });
  res.json({ data: { updated: true } });
}));

router.delete('/timeline/:id', asyncRoute(async (req, res) => {
  const existing = db.prepare('SELECT * FROM company_timeline WHERE id = ?').get(req.params.id);
  if (!existing) throw new ApiError(404, 'Timeline entry not found.');
  db.prepare('DELETE FROM company_timeline WHERE id = ?').run(existing.id);
  writeAudit({ actor: req.adminUser.full_name, action: 'Removed timeline entry', target: existing.year, module: 'About' });
  res.json({ data: { deleted: true } });
}));

router.put('/timeline/reorder', asyncRoute(async (req, res) => {
  const order = Array.isArray((req.body || {}).order) ? req.body.order : null;
  if (!order || !order.length) throw new ApiError(400, 'order must be a non-empty array of ids.');
  const existing = db.prepare('SELECT id FROM company_timeline').all();
  const existingIds = new Set(existing.map((r) => r.id));
  if (order.length !== existing.length || !order.every((id) => existingIds.has(id))) {
    throw new ApiError(400, 'order must contain exactly the timeline entry ids.');
  }
  const setOrder = db.prepare('UPDATE company_timeline SET sort_order = ? WHERE id = ?');
  db.transaction(() => { order.forEach((id, i) => setOrder.run(i, id)); })();
  res.json({ data: { reordered: true } });
}));

// ---- Certifications / accreditation logos ----

router.post('/certs', asyncRoute(async (req, res) => {
  const { name } = req.body || {};
  if (!name || !String(name).trim()) throw new ApiError(400, 'name is required.');
  const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM certifications').get().m;
  const info = db.prepare('INSERT INTO certifications (name, logo_url, sort_order, enabled) VALUES (?, NULL, ?, 1)')
    .run(name.trim(), maxOrder + 1);
  writeAudit({ actor: req.adminUser.full_name, action: 'Added certification', target: name.trim(), module: 'About' });
  res.status(201).json({ data: { id: info.lastInsertRowid } });
}));

router.put('/certs/:id', asyncRoute(async (req, res) => {
  const existing = db.prepare('SELECT * FROM certifications WHERE id = ?').get(req.params.id);
  if (!existing) throw new ApiError(404, 'Certification not found.');
  const { name, enabled } = req.body || {};
  db.prepare(
    `UPDATE certifications SET name = COALESCE(?, name), enabled = COALESCE(?, enabled) WHERE id = ?`
  ).run(name ?? null, enabled === undefined ? null : (enabled ? 1 : 0), existing.id);
  writeAudit({ actor: req.adminUser.full_name, action: 'Edited certification', target: name || existing.name, module: 'About' });
  res.json({ data: { updated: true } });
}));

router.post('/certs/:id/logo', upload.single('logo'), asyncRoute(async (req, res) => {
  const existing = db.prepare('SELECT * FROM certifications WHERE id = ?').get(req.params.id);
  if (!existing) throw new ApiError(404, 'Certification not found.');
  if (!req.file) throw new ApiError(400, 'No logo uploaded.');
  const url = `/uploads/about/${path.basename(req.file.path)}`;
  db.prepare('UPDATE certifications SET logo_url = ? WHERE id = ?').run(url, existing.id);
  removeUploadedFile(existing.logo_url);
  writeAudit({ actor: req.adminUser.full_name, action: 'Updated certification logo', target: existing.name, module: 'About' });
  res.json({ data: { logoUrl: url } });
}));

router.delete('/certs/:id', asyncRoute(async (req, res) => {
  const existing = db.prepare('SELECT * FROM certifications WHERE id = ?').get(req.params.id);
  if (!existing) throw new ApiError(404, 'Certification not found.');
  db.prepare('DELETE FROM certifications WHERE id = ?').run(existing.id);
  removeUploadedFile(existing.logo_url);
  writeAudit({ actor: req.adminUser.full_name, action: 'Removed certification', target: existing.name, module: 'About' });
  res.json({ data: { deleted: true } });
}));

// ---- Factory photo/video gallery ----

router.post('/gallery', upload.array('files', 12), asyncRoute(async (req, res) => {
  if (!req.files || !req.files.length) throw new ApiError(400, 'No files uploaded.');
  const ins = db.prepare('INSERT INTO about_gallery (kind, url, caption, sort_order) VALUES (?, ?, ?, ?)');
  const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM about_gallery').get().m;
  const created = req.files.map((f, i) => {
    const url = `/uploads/about/${path.basename(f.path)}`;
    const kind = kindOf(f.mimetype);
    const info = ins.run(kind, url, null, maxOrder + 1 + i);
    return { id: info.lastInsertRowid, kind, url, caption: null, sortOrder: maxOrder + 1 + i };
  });
  writeAudit({ actor: req.adminUser.full_name, action: 'Uploaded gallery media', target: `${created.length} file(s)`, module: 'About' });
  res.status(201).json({ data: created });
}));

router.put('/gallery/reorder', asyncRoute(async (req, res) => {
  const order = Array.isArray((req.body || {}).order) ? req.body.order : null;
  if (!order || !order.length) throw new ApiError(400, 'order must be a non-empty array of ids.');
  const existing = galleryList();
  const existingIds = new Set(existing.map((r) => r.id));
  if (order.length !== existing.length || !order.every((id) => existingIds.has(id))) {
    throw new ApiError(400, "order must contain exactly the gallery's media ids.");
  }
  const setOrder = db.prepare('UPDATE about_gallery SET sort_order = ? WHERE id = ?');
  db.transaction(() => { order.forEach((id, i) => setOrder.run(i, id)); })();
  res.json({ data: galleryList() });
}));

router.delete('/gallery/:id', asyncRoute(async (req, res) => {
  const existing = db.prepare('SELECT * FROM about_gallery WHERE id = ?').get(req.params.id);
  if (!existing) throw new ApiError(404, 'Media not found.');
  db.prepare('DELETE FROM about_gallery WHERE id = ?').run(existing.id);
  removeUploadedFile(existing.url);
  writeAudit({ actor: req.adminUser.full_name, action: 'Removed gallery media', target: `#${existing.id}`, module: 'About' });
  res.json({ data: { deleted: true } });
}));

// ---- Why Choose Us bullets (About's own list) ----

router.post('/why-us', asyncRoute(async (req, res) => {
  const { title, description } = req.body || {};
  if (!title || !String(title).trim()) throw new ApiError(400, 'title is required.');
  const maxOrder = db.prepare(`SELECT COALESCE(MAX(sort_order), -1) AS m FROM why_us_bullets WHERE page = 'about'`).get().m;
  const info = db.prepare(`INSERT INTO why_us_bullets (page, title, description, sort_order, enabled) VALUES ('about', ?, ?, ?, 1)`)
    .run(title.trim(), description || null, maxOrder + 1);
  writeAudit({ actor: req.adminUser.full_name, action: 'Added Why Us bullet', target: title.trim(), module: 'About' });
  res.status(201).json({ data: { id: info.lastInsertRowid } });
}));

router.put('/why-us/reorder', asyncRoute(async (req, res) => {
  const order = Array.isArray((req.body || {}).order) ? req.body.order : null;
  if (!order || !order.length) throw new ApiError(400, 'order must be a non-empty array of ids.');
  const existing = db.prepare(`SELECT id FROM why_us_bullets WHERE page = 'about'`).all();
  const existingIds = new Set(existing.map((r) => r.id));
  if (order.length !== existing.length || !order.every((id) => existingIds.has(id))) {
    throw new ApiError(400, "order must contain exactly About's why-us bullet ids.");
  }
  const setOrder = db.prepare(`UPDATE why_us_bullets SET sort_order = ? WHERE id = ? AND page = 'about'`);
  db.transaction(() => { order.forEach((id, i) => setOrder.run(i, id)); })();
  res.json({ data: { reordered: true } });
}));

router.put('/why-us/:id', asyncRoute(async (req, res) => {
  const existing = db.prepare(`SELECT * FROM why_us_bullets WHERE id = ? AND page = 'about'`).get(req.params.id);
  if (!existing) throw new ApiError(404, 'Bullet not found.');
  const { title, description, enabled } = req.body || {};
  db.prepare(
    `UPDATE why_us_bullets SET title = COALESCE(?, title), description = COALESCE(?, description),
     enabled = COALESCE(?, enabled) WHERE id = ?`
  ).run(title ?? null, description ?? null, enabled === undefined ? null : (enabled ? 1 : 0), existing.id);
  writeAudit({ actor: req.adminUser.full_name, action: 'Edited Why Us bullet', target: title || existing.title, module: 'About' });
  res.json({ data: { updated: true } });
}));

router.delete('/why-us/:id', asyncRoute(async (req, res) => {
  const existing = db.prepare(`SELECT * FROM why_us_bullets WHERE id = ? AND page = 'about'`).get(req.params.id);
  if (!existing) throw new ApiError(404, 'Bullet not found.');
  db.prepare('DELETE FROM why_us_bullets WHERE id = ?').run(existing.id);
  writeAudit({ actor: req.adminUser.full_name, action: 'Removed Why Us bullet', target: existing.title, module: 'About' });
  res.json({ data: { deleted: true } });
}));

router.use((err, req, res, next) => {
  if (err && (err.message || '').startsWith('Unsupported file type')) return res.status(400).json({ error: err.message });
  if (err && err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: 'File is too large (50MB max).' });
  next(err);
});

module.exports = router;
