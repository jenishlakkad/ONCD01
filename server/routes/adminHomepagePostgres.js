const fs = require('fs');
const path = require('path');
const express = require('express');
const db = require('../db/postgres');
const { asyncRoute, ApiError } = require('../middleware/errorHandler');
const requireAdmin = require('../middleware/requireAdminPostgres');
const requirePermission = require('../middleware/requirePermission');
const { makeUploader, convertHeic } = require('../middleware/upload');
const { writeAudit } = require('../lib/auditPostgres');
const { toPublicMediaUrl } = require('../lib/mediaUrl');
const { persistUploadedFile, discardPersistedFile, removeR2ObjectForUrl } = require('../lib/mediaUpload');
const {
  HOMEPAGE_MIGRATION_SQL, SECTIONS, SECTION_BY_KEY, FLOW_KEYS, TEXT_FIELDS,
  sanitizeSettings, sanitizeText, loadSectionRows, flowOrder, getMergedSections, describeForAdmin,
} = require('../lib/homepageSections');
const env = require('../config/env');

// PostgreSQL counterpart to server/routes/adminHomepage.js (SQLite).
// Parallel/isolated file only — NOT mounted in app.js.
//
// Durable ordering: `homepage_sections` and `content_blocks` now both carry
// a real `sort_order INTEGER NOT NULL DEFAULT 0` column (added in Step 13B,
// migrated from SQLite's exact rowid order). `ORDER BY rowid` is GONE —
// replaced with `ORDER BY sort_order` everywhere, including the
// `content_blocks` admin-array response, which the SQLite source never
// explicitly ordered at all (relying on physical/insertion order — see the
// Step 13A audit). No reorder API is added for either table; this route
// only ever *reads* sort_order for these two, never writes it.
//
// Boolean parity (mixed on purpose, matches the current SQLite API exactly):
// - GET / normalizes `enabled` to 1/0 for slides, the sections array, and
//   whyUs — the current SQLite API exposes these as raw 0/1 integers.
// - PUT /sections/:key echoes a REAL boolean (`!!(req.body||{}).enabled`),
//   built fresh from the request body, never read back from the DB row —
//   preserved exactly, NOT normalized to 1/0.

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
  const slides = await db.all(
    `SELECT id, title, kicker, sub, cta, href, image_url AS "imageUrl", sort_order AS "sortOrder", enabled
     FROM homepage_slides ORDER BY sort_order`
  );
  const sections = await db.all('SELECT key, label, enabled FROM homepage_sections ORDER BY sort_order');
  const blocks = await db.all(
    `SELECT key, kicker, title, body, cta, href, image_url AS "imageUrl" FROM content_blocks WHERE page = 'home' ORDER BY sort_order`
  );
  const collections = await db.all(
    `SELECT id, key, title, description, href, image_url AS "imageUrl", sort_order AS "sortOrder"
     FROM homepage_collections ORDER BY sort_order`
  );
  const whyUs = await db.all(
    `SELECT id, title, description, sort_order AS "sortOrder", enabled FROM why_us_bullets WHERE page = 'home' ORDER BY sort_order`
  );
  const { sections: merged, schemaReady } = await getMergedSections({ fresh: true });
  // Live numbers behind the hints shown next to product-driven sections
  // (e.g. "no products starred yet" explains why Featured isn't showing).
  const [featuredRows, requestedRow] = await Promise.all([
    db.all(
      `SELECT p.type, COUNT(*)::int AS n FROM products p JOIN product_types pt ON pt.key = p.type
       WHERE p.featured = TRUE AND p.status = 'active' AND p.visibility = 'visible' AND pt.enabled = TRUE GROUP BY p.type`
    ),
    db.get(
      `SELECT COUNT(DISTINCT ii.product_id)::int AS n FROM inquiry_items ii
       JOIN products p ON p.id = ii.product_id JOIN product_types pt ON pt.key = p.type
       WHERE p.status = 'active' AND p.visibility = 'visible' AND pt.enabled = TRUE`
    ),
  ]);
  const featuredByType = { diamond: 0, jewelry: 0, gemstone: 0 };
  for (const r of featuredRows) featuredByType[r.type] = r.n;
  res.json({
    data: {
      slides: slides.map((r) => ({ ...r, id: Number(r.id), enabled: r.enabled ? 1 : 0, imageUrl: toPublicMediaUrl(r.imageUrl) })),
      sections: sections.map((r) => ({ ...r, enabled: r.enabled ? 1 : 0 })),
      blocks: blocks.map((r) => ({ ...r, imageUrl: toPublicMediaUrl(r.imageUrl) })),
      collections: collections.map((r) => ({ ...r, id: Number(r.id), imageUrl: toPublicMediaUrl(r.imageUrl) })),
      whyUs: whyUs.map((r) => ({ ...r, id: Number(r.id), enabled: r.enabled ? 1 : 0 })),
      sectionList: merged.map((m) => describeForAdmin(SECTION_BY_KEY.get(m.key), m)),
      schemaReady,
      migrationSql: schemaReady ? '' : HOMEPAGE_MIGRATION_SQL,
      stats: {
        featuredByType,
        featuredTotal: featuredByType.diamond + featuredByType.jewelry + featuredByType.gemstone,
        requestedProducts: requestedRow ? requestedRow.n : 0,
      },
    },
  });
}));

router.post('/slides', asyncRoute(async (req, res) => {
  const { title, kicker, sub, cta, href } = req.body || {};
  if (!title || !String(title).trim()) throw new ApiError(400, 'title is required.');
  const maxOrderRow = await db.get('SELECT COALESCE(MAX(sort_order), -1) AS m FROM homepage_slides');
  const inserted = await db.get(
    'INSERT INTO homepage_slides (title, kicker, sub, cta, href, sort_order, enabled) VALUES ($1, $2, $3, $4, $5, $6, TRUE) RETURNING id',
    [title.trim(), kicker || null, sub || null, cta || null, href || null, maxOrderRow.m + 1]
  );
  await writeAudit({ actor: req.adminUser.full_name, action: 'Added slide', target: title.trim(), module: 'Homepage' });
  res.status(201).json({ data: { id: Number(inserted.id) } });
}));

router.put('/slides/:id', asyncRoute(async (req, res) => {
  const existing = await db.get('SELECT * FROM homepage_slides WHERE id = $1', [req.params.id]);
  if (!existing) throw new ApiError(404, 'Slide not found.');
  const { title, kicker, sub, cta, href, enabled } = req.body || {};
  await db.query(
    `UPDATE homepage_slides SET title = COALESCE($1, title), kicker = COALESCE($2, kicker), sub = COALESCE($3, sub),
     cta = COALESCE($4, cta), href = COALESCE($5, href), enabled = COALESCE($6, enabled) WHERE id = $7`,
    [title ?? null, kicker ?? null, sub ?? null, cta ?? null, href ?? null, enabled === undefined ? null : !!enabled, existing.id]
  );
  await writeAudit({ actor: req.adminUser.full_name, action: 'Edited slide', target: title || existing.title, module: 'Homepage' });
  res.json({ data: { updated: true } });
}));

router.post('/slides/:id/image', upload.single('image'), convertHeic, asyncRoute(async (req, res) => {
  const existing = await db.get('SELECT * FROM homepage_slides WHERE id = $1', [req.params.id]);
  if (!existing) throw new ApiError(404, 'Slide not found.');
  if (!req.file) throw new ApiError(400, 'No image uploaded.');

  let url;
  try {
    url = await persistUploadedFile(req.file, 'homepage');
  } catch (err) {
    throw new ApiError(502, 'Failed to upload the image. Please try again.');
  }
  try {
    await db.query('UPDATE homepage_slides SET image_url = $1 WHERE id = $2', [url, existing.id]);
  } catch (err) {
    await discardPersistedFile(url, req.file);
    throw new ApiError(502, 'Failed to save the image. Please try again.');
  }
  await removeR2ObjectForUrl(existing.image_url);
  removeUploadedFile(existing.image_url);
  await writeAudit({ actor: req.adminUser.full_name, action: 'Updated slide image', target: existing.title, module: 'Homepage' });
  res.json({ data: { imageUrl: url } });
}));

router.delete('/slides/:id', asyncRoute(async (req, res) => {
  const existing = await db.get('SELECT * FROM homepage_slides WHERE id = $1', [req.params.id]);
  if (!existing) throw new ApiError(404, 'Slide not found.');
  await db.query('DELETE FROM homepage_slides WHERE id = $1', [existing.id]); // authoritative — commits first
  await removeR2ObjectForUrl(existing.image_url);
  removeUploadedFile(existing.image_url);
  await writeAudit({ actor: req.adminUser.full_name, action: 'Removed slide', target: existing.title, module: 'Homepage' });
  res.json({ data: { deleted: true } });
}));

// Sections defined in lib/homepageSections.js may not have a row yet. The
// first write that needs one stores EVERY flow section's current position,
// so the page order never shifts as a side effect of saving one section
// (the stored order only takes over once all flow sections have rows).
async function ensureRows(client, rows) {
  const order = flowOrder(rows);
  const missing = SECTIONS.some((d) => !rows.has(d.key));
  if (!missing) return;
  for (const def of SECTIONS) {
    const existing = rows.get(def.key);
    const sortOrder = def.pinned ? -1 : order.indexOf(def.key);
    await client.query(
      `INSERT INTO homepage_sections (key, label, enabled, sort_order) VALUES ($1, $2, $3, $4)
       ON CONFLICT (key) DO UPDATE SET sort_order = EXCLUDED.sort_order`,
      [def.key, def.label, existing ? !!existing.enabled : def.defaultEnabled, sortOrder]
    );
  }
}

// Must be registered before /sections/:key, which would otherwise capture
// "reorder" as a section key.
router.put('/sections/reorder', asyncRoute(async (req, res) => {
  const order = Array.isArray((req.body || {}).order) ? req.body.order.map(String) : null;
  if (!order || order.length !== FLOW_KEYS.length || new Set(order).size !== order.length || !order.every((k) => FLOW_KEYS.includes(k))) {
    throw new ApiError(400, 'order must list every homepage section key exactly once.');
  }
  const { rows } = await loadSectionRows({ fresh: true });
  await db.transaction(async (client) => {
    await ensureRows(client, rows);
    for (const [i, key] of order.entries()) {
      await client.query('UPDATE homepage_sections SET sort_order = $1 WHERE key = $2', [i, key]);
    }
  });
  await writeAudit({ actor: req.adminUser.full_name, action: 'Reordered homepage sections', target: 'Homepage layout', module: 'Homepage' });
  res.json({ data: { reordered: true } });
}));

// Body may carry any of: enabled, the section's text fields (kicker, title,
// subtitle, ctaLabel, ctaHref), settings (merged key-by-key into what's
// stored), or reset:true (back to registry defaults). A body with only
// `enabled` keeps the original toggle contract: { key, enabled }.
router.put('/sections/:key', asyncRoute(async (req, res) => {
  const def = SECTION_BY_KEY.get(req.params.key);
  if (!def) throw new ApiError(404, 'Unknown section.');
  const body = req.body || {};
  const text = sanitizeText(def, body);
  const settings = sanitizeSettings(def, body.settings);
  const wantsContent = body.reset === true || Object.keys(text).length > 0 || Object.keys(settings).length > 0;
  const wantsToggle = body.enabled !== undefined;
  if (wantsToggle && def.togglable === false) throw new ApiError(400, `${def.label} is always shown and can't be switched off.`);

  const { rows, schemaReady } = await loadSectionRows({ fresh: true });
  if (wantsContent && !schemaReady) {
    throw new ApiError(409, 'Editing section text and settings needs a one-time database update. Open the Homepage page in admin for the SQL to run.');
  }

  const enabled = !!body.enabled;
  await db.transaction(async (client) => {
    await ensureRows(client, rows);
    if (wantsToggle) await client.query('UPDATE homepage_sections SET enabled = $1 WHERE key = $2', [enabled, def.key]);
    if (body.reset === true) {
      await client.query(
        `UPDATE homepage_sections SET kicker = NULL, title = NULL, subtitle = NULL, cta_label = NULL, cta_href = NULL, settings = '{}'::jsonb WHERE key = $1`,
        [def.key]
      );
    } else if (wantsContent) {
      const sets = [];
      const values = [];
      for (const [field, column] of TEXT_FIELDS) {
        if (text[field] === undefined) continue;
        values.push(text[field]);
        sets.push(`${column} = $${values.length}`);
      }
      if (Object.keys(settings).length) {
        values.push(JSON.stringify(settings));
        sets.push(`settings = settings || $${values.length}::jsonb`);
      }
      values.push(def.key);
      await client.query(`UPDATE homepage_sections SET ${sets.join(', ')} WHERE key = $${values.length}`, values);
    }
  });

  const action = body.reset === true ? 'Reset homepage section' : wantsContent ? 'Edited homepage section' : 'Toggled homepage section';
  await writeAudit({ actor: req.adminUser.full_name, action, target: def.label, module: 'Homepage' });
  if (!wantsContent) {
    // Real boolean built from the request body (the original toggle contract).
    return res.json({ data: { key: def.key, enabled } });
  }
  const { sections: merged } = await getMergedSections({ fresh: true });
  const fresh = merged.find((m) => m.key === def.key);
  res.json({ data: describeForAdmin(def, fresh) });
}));

// ---- Marketing blocks: promo banner, spotlight, story teaser ----

router.put('/blocks/:key', asyncRoute(async (req, res) => {
  if (!BLOCK_KEYS.includes(req.params.key)) throw new ApiError(404, 'Unknown block.');
  const existing = await db.get(`SELECT * FROM content_blocks WHERE key = $1 AND page = 'home'`, [req.params.key]);
  if (!existing) throw new ApiError(404, 'Unknown block.');
  const { kicker, title, body, cta, href } = req.body || {};
  await db.query(
    `UPDATE content_blocks SET kicker = COALESCE($1, kicker), title = COALESCE($2, title), body = COALESCE($3, body),
     cta = COALESCE($4, cta), href = COALESCE($5, href), updated_at = NOW() WHERE key = $6`,
    [kicker ?? null, title ?? null, body ?? null, cta ?? null, href ?? null, existing.key]
  );
  await writeAudit({ actor: req.adminUser.full_name, action: 'Edited marketing block', target: title || existing.title || existing.key, module: 'Homepage' });
  res.json({ data: { updated: true } });
}));

router.post('/blocks/:key/image', upload.single('image'), convertHeic, asyncRoute(async (req, res) => {
  if (!BLOCK_KEYS.includes(req.params.key)) throw new ApiError(404, 'Unknown block.');
  const existing = await db.get(`SELECT * FROM content_blocks WHERE key = $1 AND page = 'home'`, [req.params.key]);
  if (!existing) throw new ApiError(404, 'Unknown block.');
  if (!req.file) throw new ApiError(400, 'No image uploaded.');

  let url;
  try {
    url = await persistUploadedFile(req.file, 'homepage');
  } catch (err) {
    throw new ApiError(502, 'Failed to upload the image. Please try again.');
  }
  try {
    await db.query(`UPDATE content_blocks SET image_url = $1, updated_at = NOW() WHERE key = $2`, [url, existing.key]);
  } catch (err) {
    await discardPersistedFile(url, req.file);
    throw new ApiError(502, 'Failed to save the image. Please try again.');
  }
  await removeR2ObjectForUrl(existing.image_url);
  removeUploadedFile(existing.image_url);
  await writeAudit({ actor: req.adminUser.full_name, action: 'Updated marketing block image', target: existing.title || existing.key, module: 'Homepage' });
  res.json({ data: { imageUrl: url } });
}));

// ---- Collection tiles (Diamonds / Jewelry / Gemstones cards) ----

router.put('/collections/:key', asyncRoute(async (req, res) => {
  const existing = await db.get('SELECT * FROM homepage_collections WHERE key = $1', [req.params.key]);
  if (!existing) throw new ApiError(404, 'Unknown collection.');
  const { title, description, href } = req.body || {};
  await db.query(
    `UPDATE homepage_collections SET title = COALESCE($1, title), description = COALESCE($2, description),
     href = COALESCE($3, href) WHERE key = $4`,
    [title ?? null, description ?? null, href ?? null, existing.key]
  );
  await writeAudit({ actor: req.adminUser.full_name, action: 'Edited collection tile', target: title || existing.title, module: 'Homepage' });
  res.json({ data: { updated: true } });
}));

router.post('/collections/:key/image', upload.single('image'), convertHeic, asyncRoute(async (req, res) => {
  const existing = await db.get('SELECT * FROM homepage_collections WHERE key = $1', [req.params.key]);
  if (!existing) throw new ApiError(404, 'Unknown collection.');
  if (!req.file) throw new ApiError(400, 'No image uploaded.');

  let url;
  try {
    url = await persistUploadedFile(req.file, 'homepage');
  } catch (err) {
    throw new ApiError(502, 'Failed to upload the image. Please try again.');
  }
  try {
    await db.query('UPDATE homepage_collections SET image_url = $1 WHERE key = $2', [url, existing.key]);
  } catch (err) {
    await discardPersistedFile(url, req.file);
    throw new ApiError(502, 'Failed to save the image. Please try again.');
  }
  await removeR2ObjectForUrl(existing.image_url);
  removeUploadedFile(existing.image_url);
  await writeAudit({ actor: req.adminUser.full_name, action: 'Updated collection tile image', target: existing.title, module: 'Homepage' });
  res.json({ data: { imageUrl: url } });
}));

// ---- Why Choose Us bullets (Home's own list) ----

router.post('/why-us', asyncRoute(async (req, res) => {
  const { title, description } = req.body || {};
  if (!title || !String(title).trim()) throw new ApiError(400, 'title is required.');
  const maxOrderRow = await db.get(`SELECT COALESCE(MAX(sort_order), -1) AS m FROM why_us_bullets WHERE page = 'home'`);
  const inserted = await db.get(
    `INSERT INTO why_us_bullets (page, title, description, sort_order, enabled) VALUES ('home', $1, $2, $3, TRUE) RETURNING id`,
    [title.trim(), description || null, maxOrderRow.m + 1]
  );
  await writeAudit({ actor: req.adminUser.full_name, action: 'Added Why Us bullet', target: title.trim(), module: 'Homepage' });
  res.status(201).json({ data: { id: Number(inserted.id) } });
}));

router.put('/why-us/reorder', asyncRoute(async (req, res) => {
  const order = Array.isArray((req.body || {}).order) ? req.body.order : null;
  if (!order || !order.length) throw new ApiError(400, 'order must be a non-empty array of ids.');
  const existing = await db.all(`SELECT id FROM why_us_bullets WHERE page = 'home'`);
  const existingIds = new Set(existing.map((r) => Number(r.id)));
  if (order.length !== existing.length || !order.every((id) => existingIds.has(id))) {
    throw new ApiError(400, "order must contain exactly Home's why-us bullet ids.");
  }
  // Single pooled client for the whole transaction, sequential writes only —
  // no audit call here, matching the SQLite source exactly (this is the one
  // reorder endpoint in adminHomepage.js, and it never wrote to audit_log).
  await db.transaction(async (client) => {
    for (const [i, id] of order.entries()) {
      await client.query(`UPDATE why_us_bullets SET sort_order = $1 WHERE id = $2 AND page = 'home'`, [i, id]);
    }
  });
  res.json({ data: { reordered: true } });
}));

router.put('/why-us/:id', asyncRoute(async (req, res) => {
  const existing = await db.get(`SELECT * FROM why_us_bullets WHERE id = $1 AND page = 'home'`, [req.params.id]);
  if (!existing) throw new ApiError(404, 'Bullet not found.');
  const { title, description, enabled } = req.body || {};
  await db.query(
    `UPDATE why_us_bullets SET title = COALESCE($1, title), description = COALESCE($2, description),
     enabled = COALESCE($3, enabled) WHERE id = $4`,
    [title ?? null, description ?? null, enabled === undefined ? null : !!enabled, existing.id]
  );
  await writeAudit({ actor: req.adminUser.full_name, action: 'Edited Why Us bullet', target: title || existing.title, module: 'Homepage' });
  res.json({ data: { updated: true } });
}));

router.delete('/why-us/:id', asyncRoute(async (req, res) => {
  const existing = await db.get(`SELECT * FROM why_us_bullets WHERE id = $1 AND page = 'home'`, [req.params.id]);
  if (!existing) throw new ApiError(404, 'Bullet not found.');
  await db.query('DELETE FROM why_us_bullets WHERE id = $1', [existing.id]);
  await writeAudit({ actor: req.adminUser.full_name, action: 'Removed Why Us bullet', target: existing.title, module: 'Homepage' });
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
