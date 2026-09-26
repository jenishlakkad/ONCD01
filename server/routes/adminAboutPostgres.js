const fs = require('fs');
const path = require('path');
const express = require('express');
const db = require('../db/postgres');
const { asyncRoute, ApiError } = require('../middleware/errorHandler');
const requireAdmin = require('../middleware/requireAdminPostgres');
const requirePermission = require('../middleware/requirePermission');
const { makeUploader, kindOf, convertHeic } = require('../middleware/upload');
const { writeAudit } = require('../lib/auditPostgres');
const { toPublicMediaUrl } = require('../lib/mediaUrl');
const env = require('../config/env');

// PostgreSQL counterpart to server/routes/adminAbout.js (SQLite). Parallel/
// isolated file only — NOT mounted in app.js.
//
// `content_blocks` (page='about') now reads `ORDER BY sort_order` (Step
// 13B durable-ordering migration), matching the same fix applied in
// adminHomepagePostgres.js — the SQLite source never explicitly ordered
// this query either.
//
// Boolean parity: `enabled` is normalized to 1/0 for team/timeline/certs/
// whyUs in GET / — the current SQLite API exposes these as raw 0/1. `about_
// gallery` has no `enabled` column at all (confirmed read-only), so nothing
// to normalize there.

const router = express.Router();
const upload = makeUploader('about');
router.use(requireAdmin, requirePermission('about', 'manage'));

const BLOCK_KEYS = ['hero', 'story', 'mission', 'vision'];

function removeUploadedFile(url) {
  if (!url) return;
  const p = path.join(env.rootDir, url.replace(/^\//, ''));
  fs.unlink(p, () => {});
}

// NOTE: `AS "sortOrder"` must be double-quoted. about_gallery.id is BIGINT
// -> Number(...). Used by both GET / and PUT /gallery/reorder's response,
// exactly like the SQLite source's shared galleryList() helper.
async function galleryList() {
  const rows = await db.all(
    `SELECT id, kind, url, caption, sort_order AS "sortOrder" FROM about_gallery ORDER BY sort_order`
  );
  return rows.map((r) => ({ ...r, id: Number(r.id), url: toPublicMediaUrl(r.url) }));
}

router.get('/', asyncRoute(async (req, res) => {
  const blocks = await db.all(
    `SELECT key, kicker, title, body, cta, href, image_url AS "imageUrl" FROM content_blocks WHERE page = 'about' ORDER BY sort_order`
  );
  const team = await db.all(
    `SELECT id, name, role, photo_url AS "photoUrl", sort_order AS "sortOrder", enabled FROM team_members ORDER BY sort_order`
  );
  const timeline = await db.all(
    `SELECT id, year, title, description, sort_order AS "sortOrder", enabled FROM company_timeline ORDER BY sort_order`
  );
  const certs = await db.all(
    `SELECT id, name, logo_url AS "logoUrl", sort_order AS "sortOrder", enabled FROM certifications ORDER BY sort_order`
  );
  const whyUs = await db.all(
    `SELECT id, title, description, sort_order AS "sortOrder", enabled FROM why_us_bullets WHERE page = 'about' ORDER BY sort_order`
  );
  res.json({
    data: {
      blocks: blocks.map((r) => ({ ...r, imageUrl: toPublicMediaUrl(r.imageUrl) })),
      team: team.map((r) => ({ ...r, id: Number(r.id), enabled: r.enabled ? 1 : 0, photoUrl: toPublicMediaUrl(r.photoUrl) })),
      timeline: timeline.map((r) => ({ ...r, id: Number(r.id), enabled: r.enabled ? 1 : 0 })),
      certs: certs.map((r) => ({ ...r, id: Number(r.id), enabled: r.enabled ? 1 : 0, logoUrl: toPublicMediaUrl(r.logoUrl) })),
      gallery: await galleryList(),
      whyUs: whyUs.map((r) => ({ ...r, id: Number(r.id), enabled: r.enabled ? 1 : 0 })),
    },
  });
}));

// ---- Text/photo blocks: hero intro, our story, mission, vision ----

router.put('/blocks/:key', asyncRoute(async (req, res) => {
  if (!BLOCK_KEYS.includes(req.params.key)) throw new ApiError(404, 'Unknown block.');
  const existing = await db.get(`SELECT * FROM content_blocks WHERE key = $1 AND page = 'about'`, [req.params.key]);
  if (!existing) throw new ApiError(404, 'Unknown block.');
  const { kicker, title, body, cta, href } = req.body || {};
  await db.query(
    `UPDATE content_blocks SET kicker = COALESCE($1, kicker), title = COALESCE($2, title), body = COALESCE($3, body),
     cta = COALESCE($4, cta), href = COALESCE($5, href), updated_at = NOW() WHERE key = $6`,
    [kicker ?? null, title ?? null, body ?? null, cta ?? null, href ?? null, existing.key]
  );
  await writeAudit({ actor: req.adminUser.full_name, action: 'Edited About block', target: title || existing.title || existing.key, module: 'About' });
  res.json({ data: { updated: true } });
}));

router.post('/blocks/:key/image', upload.single('image'), convertHeic, asyncRoute(async (req, res) => {
  if (!BLOCK_KEYS.includes(req.params.key)) throw new ApiError(404, 'Unknown block.');
  const existing = await db.get(`SELECT * FROM content_blocks WHERE key = $1 AND page = 'about'`, [req.params.key]);
  if (!existing) throw new ApiError(404, 'Unknown block.');
  if (!req.file) throw new ApiError(400, 'No image uploaded.');
  const url = `/uploads/about/${path.basename(req.file.path)}`;
  await db.query(`UPDATE content_blocks SET image_url = $1, updated_at = NOW() WHERE key = $2`, [url, existing.key]);
  removeUploadedFile(existing.image_url);
  await writeAudit({ actor: req.adminUser.full_name, action: 'Updated About block image', target: existing.title || existing.key, module: 'About' });
  res.json({ data: { imageUrl: url } });
}));

// ---- Team members ----

router.post('/team', asyncRoute(async (req, res) => {
  const { name, role } = req.body || {};
  if (!name || !String(name).trim()) throw new ApiError(400, 'name is required.');
  const maxOrderRow = await db.get('SELECT COALESCE(MAX(sort_order), -1) AS m FROM team_members');
  const inserted = await db.get(
    'INSERT INTO team_members (name, role, photo_url, sort_order, enabled) VALUES ($1, $2, NULL, $3, TRUE) RETURNING id',
    [name.trim(), role || null, maxOrderRow.m + 1]
  );
  await writeAudit({ actor: req.adminUser.full_name, action: 'Added team member', target: name.trim(), module: 'About' });
  res.status(201).json({ data: { id: Number(inserted.id) } });
}));

router.put('/team/:id', asyncRoute(async (req, res) => {
  const existing = await db.get('SELECT * FROM team_members WHERE id = $1', [req.params.id]);
  if (!existing) throw new ApiError(404, 'Team member not found.');
  const { name, role, enabled } = req.body || {};
  await db.query(
    `UPDATE team_members SET name = COALESCE($1, name), role = COALESCE($2, role), enabled = COALESCE($3, enabled) WHERE id = $4`,
    [name ?? null, role ?? null, enabled === undefined ? null : !!enabled, existing.id]
  );
  await writeAudit({ actor: req.adminUser.full_name, action: 'Edited team member', target: name || existing.name, module: 'About' });
  res.json({ data: { updated: true } });
}));

router.put('/team/reorder', asyncRoute(async (req, res) => {
  const order = Array.isArray((req.body || {}).order) ? req.body.order : null;
  if (!order || !order.length) throw new ApiError(400, 'order must be a non-empty array of ids.');
  const existing = await db.all('SELECT id FROM team_members');
  const existingIds = new Set(existing.map((r) => Number(r.id)));
  if (order.length !== existing.length || !order.every((id) => existingIds.has(id))) {
    throw new ApiError(400, "order must contain exactly the team's member ids.");
  }
  // Single pooled client, sequential writes, no audit — matches the SQLite
  // source exactly (this reorder endpoint never wrote to audit_log).
  await db.transaction(async (client) => {
    for (const [i, id] of order.entries()) {
      await client.query('UPDATE team_members SET sort_order = $1 WHERE id = $2', [i, id]);
    }
  });
  res.json({ data: { reordered: true } });
}));

router.post('/team/:id/photo', upload.single('photo'), convertHeic, asyncRoute(async (req, res) => {
  const existing = await db.get('SELECT * FROM team_members WHERE id = $1', [req.params.id]);
  if (!existing) throw new ApiError(404, 'Team member not found.');
  if (!req.file) throw new ApiError(400, 'No photo uploaded.');
  const url = `/uploads/about/${path.basename(req.file.path)}`;
  await db.query('UPDATE team_members SET photo_url = $1 WHERE id = $2', [url, existing.id]);
  removeUploadedFile(existing.photo_url);
  await writeAudit({ actor: req.adminUser.full_name, action: 'Updated team member photo', target: existing.name, module: 'About' });
  res.json({ data: { photoUrl: url } });
}));

router.delete('/team/:id', asyncRoute(async (req, res) => {
  const existing = await db.get('SELECT * FROM team_members WHERE id = $1', [req.params.id]);
  if (!existing) throw new ApiError(404, 'Team member not found.');
  await db.query('DELETE FROM team_members WHERE id = $1', [existing.id]);
  removeUploadedFile(existing.photo_url);
  await writeAudit({ actor: req.adminUser.full_name, action: 'Removed team member', target: existing.name, module: 'About' });
  res.json({ data: { deleted: true } });
}));

// ---- Timeline / milestones (no images) ----

router.post('/timeline', asyncRoute(async (req, res) => {
  const { year, title, description } = req.body || {};
  if (!year || !String(year).trim()) throw new ApiError(400, 'year is required.');
  const maxOrderRow = await db.get('SELECT COALESCE(MAX(sort_order), -1) AS m FROM company_timeline');
  const inserted = await db.get(
    'INSERT INTO company_timeline (year, title, description, sort_order, enabled) VALUES ($1, $2, $3, $4, TRUE) RETURNING id',
    [year.trim(), title || null, description || null, maxOrderRow.m + 1]
  );
  await writeAudit({ actor: req.adminUser.full_name, action: 'Added timeline entry', target: year.trim(), module: 'About' });
  res.status(201).json({ data: { id: Number(inserted.id) } });
}));

router.put('/timeline/:id', asyncRoute(async (req, res) => {
  const existing = await db.get('SELECT * FROM company_timeline WHERE id = $1', [req.params.id]);
  if (!existing) throw new ApiError(404, 'Timeline entry not found.');
  const { year, title, description, enabled } = req.body || {};
  await db.query(
    `UPDATE company_timeline SET year = COALESCE($1, year), title = COALESCE($2, title),
     description = COALESCE($3, description), enabled = COALESCE($4, enabled) WHERE id = $5`,
    [year ?? null, title ?? null, description ?? null, enabled === undefined ? null : !!enabled, existing.id]
  );
  await writeAudit({ actor: req.adminUser.full_name, action: 'Edited timeline entry', target: year || existing.year, module: 'About' });
  res.json({ data: { updated: true } });
}));

router.delete('/timeline/:id', asyncRoute(async (req, res) => {
  const existing = await db.get('SELECT * FROM company_timeline WHERE id = $1', [req.params.id]);
  if (!existing) throw new ApiError(404, 'Timeline entry not found.');
  await db.query('DELETE FROM company_timeline WHERE id = $1', [existing.id]);
  await writeAudit({ actor: req.adminUser.full_name, action: 'Removed timeline entry', target: existing.year, module: 'About' });
  res.json({ data: { deleted: true } });
}));

router.put('/timeline/reorder', asyncRoute(async (req, res) => {
  const order = Array.isArray((req.body || {}).order) ? req.body.order : null;
  if (!order || !order.length) throw new ApiError(400, 'order must be a non-empty array of ids.');
  const existing = await db.all('SELECT id FROM company_timeline');
  const existingIds = new Set(existing.map((r) => Number(r.id)));
  if (order.length !== existing.length || !order.every((id) => existingIds.has(id))) {
    throw new ApiError(400, 'order must contain exactly the timeline entry ids.');
  }
  await db.transaction(async (client) => {
    for (const [i, id] of order.entries()) {
      await client.query('UPDATE company_timeline SET sort_order = $1 WHERE id = $2', [i, id]);
    }
  });
  res.json({ data: { reordered: true } });
}));

// ---- Certifications / accreditation logos ----

router.post('/certs', asyncRoute(async (req, res) => {
  const { name } = req.body || {};
  if (!name || !String(name).trim()) throw new ApiError(400, 'name is required.');
  const maxOrderRow = await db.get('SELECT COALESCE(MAX(sort_order), -1) AS m FROM certifications');
  const inserted = await db.get(
    'INSERT INTO certifications (name, logo_url, sort_order, enabled) VALUES ($1, NULL, $2, TRUE) RETURNING id',
    [name.trim(), maxOrderRow.m + 1]
  );
  await writeAudit({ actor: req.adminUser.full_name, action: 'Added certification', target: name.trim(), module: 'About' });
  res.status(201).json({ data: { id: Number(inserted.id) } });
}));

router.put('/certs/:id', asyncRoute(async (req, res) => {
  const existing = await db.get('SELECT * FROM certifications WHERE id = $1', [req.params.id]);
  if (!existing) throw new ApiError(404, 'Certification not found.');
  const { name, enabled } = req.body || {};
  await db.query(
    `UPDATE certifications SET name = COALESCE($1, name), enabled = COALESCE($2, enabled) WHERE id = $3`,
    [name ?? null, enabled === undefined ? null : !!enabled, existing.id]
  );
  await writeAudit({ actor: req.adminUser.full_name, action: 'Edited certification', target: name || existing.name, module: 'About' });
  res.json({ data: { updated: true } });
}));

router.post('/certs/:id/logo', upload.single('logo'), convertHeic, asyncRoute(async (req, res) => {
  const existing = await db.get('SELECT * FROM certifications WHERE id = $1', [req.params.id]);
  if (!existing) throw new ApiError(404, 'Certification not found.');
  if (!req.file) throw new ApiError(400, 'No logo uploaded.');
  const url = `/uploads/about/${path.basename(req.file.path)}`;
  await db.query('UPDATE certifications SET logo_url = $1 WHERE id = $2', [url, existing.id]);
  removeUploadedFile(existing.logo_url);
  await writeAudit({ actor: req.adminUser.full_name, action: 'Updated certification logo', target: existing.name, module: 'About' });
  res.json({ data: { logoUrl: url } });
}));

router.delete('/certs/:id', asyncRoute(async (req, res) => {
  const existing = await db.get('SELECT * FROM certifications WHERE id = $1', [req.params.id]);
  if (!existing) throw new ApiError(404, 'Certification not found.');
  await db.query('DELETE FROM certifications WHERE id = $1', [existing.id]);
  removeUploadedFile(existing.logo_url);
  await writeAudit({ actor: req.adminUser.full_name, action: 'Removed certification', target: existing.name, module: 'About' });
  res.json({ data: { deleted: true } });
}));

// ---- Factory photo/video gallery ----

router.post('/gallery', upload.array('files', 12), convertHeic, asyncRoute(async (req, res) => {
  if (!req.files || !req.files.length) throw new ApiError(400, 'No files uploaded.');
  const maxOrderRow = await db.get('SELECT COALESCE(MAX(sort_order), -1) AS m FROM about_gallery');
  // NOT wrapped in db.transaction() — matches the SQLite source exactly,
  // which also never wrapped this loop in a transaction (see Step 13A
  // audit: a partial-batch DB failure here can leave already-uploaded
  // files on disk with no DB row, preserved as-is per instructions).
  // Sequential, independent pooled INSERT ... RETURNING id per file.
  const created = [];
  for (let i = 0; i < req.files.length; i++) {
    const f = req.files[i];
    const url = `/uploads/about/${path.basename(f.path)}`;
    const kind = kindOf(f.mimetype, f.originalname);
    const sortOrder = maxOrderRow.m + 1 + i;
    const inserted = await db.get(
      'INSERT INTO about_gallery (kind, url, caption, sort_order) VALUES ($1, $2, $3, $4) RETURNING id',
      [kind, url, null, sortOrder]
    );
    created.push({ id: Number(inserted.id), kind, url, caption: null, sortOrder });
  }
  await writeAudit({ actor: req.adminUser.full_name, action: 'Uploaded gallery media', target: `${created.length} file(s)`, module: 'About' });
  res.status(201).json({ data: created });
}));

router.put('/gallery/reorder', asyncRoute(async (req, res) => {
  const order = Array.isArray((req.body || {}).order) ? req.body.order : null;
  if (!order || !order.length) throw new ApiError(400, 'order must be a non-empty array of ids.');
  const existing = await galleryList();
  const existingIds = new Set(existing.map((r) => r.id));
  if (order.length !== existing.length || !order.every((id) => existingIds.has(id))) {
    throw new ApiError(400, "order must contain exactly the gallery's media ids.");
  }
  await db.transaction(async (client) => {
    for (const [i, id] of order.entries()) {
      await client.query('UPDATE about_gallery SET sort_order = $1 WHERE id = $2', [i, id]);
    }
  });
  // Response is the full refreshed list, not {reordered:true} — preserved
  // exactly as the SQLite source's distinct response shape for this route.
  res.json({ data: await galleryList() });
}));

router.delete('/gallery/:id', asyncRoute(async (req, res) => {
  const existing = await db.get('SELECT * FROM about_gallery WHERE id = $1', [req.params.id]);
  if (!existing) throw new ApiError(404, 'Media not found.');
  await db.query('DELETE FROM about_gallery WHERE id = $1', [existing.id]);
  removeUploadedFile(existing.url);
  await writeAudit({ actor: req.adminUser.full_name, action: 'Removed gallery media', target: `#${Number(existing.id)}`, module: 'About' });
  res.json({ data: { deleted: true } });
}));

// ---- Why Choose Us bullets (About's own list) ----

router.post('/why-us', asyncRoute(async (req, res) => {
  const { title, description } = req.body || {};
  if (!title || !String(title).trim()) throw new ApiError(400, 'title is required.');
  const maxOrderRow = await db.get(`SELECT COALESCE(MAX(sort_order), -1) AS m FROM why_us_bullets WHERE page = 'about'`);
  const inserted = await db.get(
    `INSERT INTO why_us_bullets (page, title, description, sort_order, enabled) VALUES ('about', $1, $2, $3, TRUE) RETURNING id`,
    [title.trim(), description || null, maxOrderRow.m + 1]
  );
  await writeAudit({ actor: req.adminUser.full_name, action: 'Added Why Us bullet', target: title.trim(), module: 'About' });
  res.status(201).json({ data: { id: Number(inserted.id) } });
}));

router.put('/why-us/reorder', asyncRoute(async (req, res) => {
  const order = Array.isArray((req.body || {}).order) ? req.body.order : null;
  if (!order || !order.length) throw new ApiError(400, 'order must be a non-empty array of ids.');
  const existing = await db.all(`SELECT id FROM why_us_bullets WHERE page = 'about'`);
  const existingIds = new Set(existing.map((r) => Number(r.id)));
  if (order.length !== existing.length || !order.every((id) => existingIds.has(id))) {
    throw new ApiError(400, "order must contain exactly About's why-us bullet ids.");
  }
  await db.transaction(async (client) => {
    for (const [i, id] of order.entries()) {
      await client.query(`UPDATE why_us_bullets SET sort_order = $1 WHERE id = $2 AND page = 'about'`, [i, id]);
    }
  });
  res.json({ data: { reordered: true } });
}));

router.put('/why-us/:id', asyncRoute(async (req, res) => {
  const existing = await db.get(`SELECT * FROM why_us_bullets WHERE id = $1 AND page = 'about'`, [req.params.id]);
  if (!existing) throw new ApiError(404, 'Bullet not found.');
  const { title, description, enabled } = req.body || {};
  await db.query(
    `UPDATE why_us_bullets SET title = COALESCE($1, title), description = COALESCE($2, description),
     enabled = COALESCE($3, enabled) WHERE id = $4`,
    [title ?? null, description ?? null, enabled === undefined ? null : !!enabled, existing.id]
  );
  await writeAudit({ actor: req.adminUser.full_name, action: 'Edited Why Us bullet', target: title || existing.title, module: 'About' });
  res.json({ data: { updated: true } });
}));

router.delete('/why-us/:id', asyncRoute(async (req, res) => {
  const existing = await db.get(`SELECT * FROM why_us_bullets WHERE id = $1 AND page = 'about'`, [req.params.id]);
  if (!existing) throw new ApiError(404, 'Bullet not found.');
  await db.query('DELETE FROM why_us_bullets WHERE id = $1', [existing.id]);
  await writeAudit({ actor: req.adminUser.full_name, action: 'Removed Why Us bullet', target: existing.title, module: 'About' });
  res.json({ data: { deleted: true } });
}));

router.use((err, req, res, next) => {
  if (err && (err.message || '').startsWith('Unsupported file type')) return res.status(400).json({ error: err.message });
  if (err && err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: 'File is too large (50MB max).' });
  next(err);
});

module.exports = router;
