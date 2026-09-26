const fs = require('fs');
const path = require('path');
const express = require('express');
const multer = require('multer');
const db = require('../db/postgres');
const { asyncRoute, ApiError } = require('../middleware/errorHandler');
const requireAdmin = require('../middleware/requireAdminPostgres');
const requirePermission = require('../middleware/requirePermission');
const { makeUploader, kindOf, convertHeic } = require('../middleware/upload');
const { serializeProduct } = require('../lib/serializeProduct');
const { toPublicMediaUrl } = require('../lib/mediaUrl');
const { writeAudit } = require('../lib/auditPostgres');
const { COLUMN_DEFS: IMPORT_COLUMN_DEFS, buildTemplate, buildStockExport, importWorkbook, productColumns } = require('../lib/excelImportPostgres');
const env = require('../config/env');

// PostgreSQL counterpart to server/routes/adminProducts.js (SQLite).
// Parallel/isolated test route file only — NOT mounted in app.js. Media
// handling (makeUploader/kindOf/convertHeic, upload.js) is reused UNCHANGED —
// it has no database dependency, so nothing about it needs a Postgres variant.

const router = express.Router();
const upload = makeUploader('products');
const importUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

router.use(requireAdmin, requirePermission('products', 'manage'));

const FIELDS = [
  'sku', 'type', 'category_id', 'subcategory_id', 'status', 'visibility', 'featured',
  'weight_carat', 'shape', 'color', 'clarity', 'measurements',
  'certificate_authority', 'certificate_number', 'certificate_website',
  'metal', 'gold_purity', 'gold_color', 'gold_weight_grams',
  'stone_name', 'origin',
  'price_per_carat', 'total_price', 'price_visibility',
];

function pickBody(body) {
  const out = {};
  for (const f of FIELDS) {
    if (body[f] !== undefined) out[f] = body[f] === '' ? null : body[f];
  }
  return out;
}

async function categoryRow(id) {
  if (!id) return null;
  const row = await db.get('SELECT id, name FROM categories WHERE id = $1', [id]);
  return row ? { id: Number(row.id), name: row.name } : null;
}
async function subcategoryRow(id) {
  if (!id) return null;
  const row = await db.get('SELECT id, name FROM subcategories WHERE id = $1', [id]);
  return row ? { id: Number(row.id), name: row.name } : null;
}
// NOTE: both `AS sortOrder` and `AS originalName` must be double-quoted —
// unquoted, Postgres would fold them to `sortorder`/`originalname`, silently
// breaking every r.sortOrder / r.originalName read below.
async function mediaFor(productId) {
  const rows = await db.all(
    'SELECT id, kind, url, sort_order AS "sortOrder", original_name AS "originalName", crop FROM product_media WHERE product_id = $1 ORDER BY sort_order',
    [productId]
  );
  return rows.map((r) => ({ ...r, id: Number(r.id), url: toPublicMediaUrl(r.url), crop: r.crop ? JSON.parse(r.crop) : null }));
}
async function fullProduct(row) {
  const [category, subcategory, media] = await Promise.all([
    categoryRow(row.category_id),
    subcategoryRow(row.subcategory_id),
    mediaFor(row.id),
  ]);
  return serializeProduct({ ...row, id: Number(row.id) }, { category, subcategory, media });
}

router.get('/', asyncRoute(async (req, res) => {
  const { type } = req.query;
  let sql = 'SELECT * FROM products';
  const params = [];
  if (type) { params.push(type); sql += ` WHERE type = $${params.length}`; }
  sql += ' ORDER BY created_at DESC, id DESC';
  const rows = await db.all(sql, params);
  const data = await Promise.all(rows.map(fullProduct));
  res.json({ data });
}));

router.post('/', asyncRoute(async (req, res) => {
  const b = pickBody(req.body || {});
  if (!b.sku || !String(b.sku).trim()) throw new ApiError(400, 'SKU is required.');
  if (!['diamond', 'jewelry', 'gemstone'].includes(b.type)) throw new ApiError(400, 'A valid product type is required.');
  const dup = await db.get('SELECT id FROM products WHERE sku = $1', [b.sku]);
  if (dup) throw new ApiError(409, `A product with SKU ${b.sku} already exists.`);

  const cols = Object.keys(b);
  const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
  const values = cols.map((c) => b[c]);
  const inserted = await db.get(`INSERT INTO products (${cols.join(', ')}) VALUES (${placeholders}) RETURNING id`, values);
  const row = await db.get('SELECT * FROM products WHERE id = $1', [inserted.id]);

  await writeAudit({ actor: req.adminUser.full_name, action: 'Added product', target: row.sku, module: 'Products' });
  res.status(201).json({ data: await fullProduct(row) });
}));

router.put('/:id', asyncRoute(async (req, res) => {
  const existing = await db.get('SELECT * FROM products WHERE id = $1', [req.params.id]);
  if (!existing) throw new ApiError(404, 'Product not found.');
  const b = pickBody(req.body || {});
  if (b.sku && b.sku !== existing.sku) {
    const dup = await db.get('SELECT id FROM products WHERE sku = $1 AND id != $2', [b.sku, existing.id]);
    if (dup) throw new ApiError(409, `A product with SKU ${b.sku} already exists.`);
  }
  const cols = Object.keys(b);
  if (cols.length) {
    const setClause = cols.map((c, i) => `${c} = $${i + 1}`).join(', ');
    const values = cols.map((c) => b[c]);
    await db.query(`UPDATE products SET ${setClause}, updated_at = NOW() WHERE id = $${cols.length + 1}`, [...values, existing.id]);
  }
  const row = await db.get('SELECT * FROM products WHERE id = $1', [existing.id]);

  const statusChanged = b.status && b.status !== existing.status;
  await writeAudit({
    actor: req.adminUser.full_name,
    action: statusChanged ? (b.status === 'hidden' ? 'Hid product' : 'Updated product') : 'Updated product',
    target: row.sku,
    module: 'Products',
  });
  res.json({ data: await fullProduct(row) });
}));

router.delete('/:id', asyncRoute(async (req, res) => {
  const existing = await db.get('SELECT * FROM products WHERE id = $1', [req.params.id]);
  if (!existing) throw new ApiError(404, 'Product not found.');
  const media = await mediaFor(existing.id);
  await db.query('DELETE FROM products WHERE id = $1', [existing.id]);
  for (const m of media) {
    const p = path.join(env.rootDir, m.url.replace(/^\//, ''));
    fs.unlink(p, () => {});
  }
  await writeAudit({ actor: req.adminUser.full_name, action: 'Deleted product', target: existing.sku, module: 'Products' });
  res.json({ data: { deleted: true } });
}));

router.post('/:id/media', upload.array('files', 12), convertHeic, asyncRoute(async (req, res) => {
  const product = await db.get('SELECT * FROM products WHERE id = $1', [req.params.id]);
  if (!product) throw new ApiError(404, 'Product not found.');
  if (!req.files || !req.files.length) throw new ApiError(400, 'No files uploaded.');
  const maxOrderRow = await db.get('SELECT COALESCE(MAX(sort_order), -1) AS m FROM product_media WHERE product_id = $1', [product.id]);
  const maxOrder = maxOrderRow.m;

  // Sequential for...of + await, NOT an unawaited .map() — each insert is
  // independent so parallelizing would also be correct, but sequential keeps
  // this first Postgres conversion pass the most conservative and matches
  // the original code's own sequential (synchronous) execution order.
  const created = [];
  for (let i = 0; i < req.files.length; i++) {
    const f = req.files[i];
    const url = `/uploads/products/${path.basename(f.path)}`;
    const kind = kindOf(f.mimetype, f.originalname);
    const inserted = await db.get(
      'INSERT INTO product_media (product_id, kind, url, sort_order, original_name) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      [product.id, kind, url, maxOrder + 1 + i, f.originalname]
    );
    created.push({ id: Number(inserted.id), kind, url, originalName: f.originalname });
  }
  await writeAudit({ actor: req.adminUser.full_name, action: 'Uploaded media', target: product.sku, module: 'Products' });
  res.status(201).json({ data: created });
}));

router.put('/:id/media/reorder', asyncRoute(async (req, res) => {
  const product = await db.get('SELECT * FROM products WHERE id = $1', [req.params.id]);
  if (!product) throw new ApiError(404, 'Product not found.');
  const order = Array.isArray((req.body || {}).order) ? req.body.order : null;
  if (!order || !order.length) throw new ApiError(400, 'order must be a non-empty array of media ids.');
  const existing = await mediaFor(product.id);
  const existingIds = new Set(existing.map((m) => m.id));
  if (order.length !== existing.length || !order.every((id) => existingIds.has(id))) {
    throw new ApiError(400, 'order must contain exactly this product\'s media ids.');
  }
  // Single pooled client for the whole transaction — every statement below
  // runs sequentially against that SAME client, never through db.query()
  // (which could hand different statements to different pool connections
  // and silently lose atomicity).
  await db.transaction(async (client) => {
    for (let i = 0; i < order.length; i++) {
      await client.query('UPDATE product_media SET sort_order = $1 WHERE id = $2 AND product_id = $3', [i, order[i], product.id]);
    }
  });
  await writeAudit({ actor: req.adminUser.full_name, action: 'Reordered media', target: product.sku, module: 'Products' });
  res.json({ data: await mediaFor(product.id) });
}));

router.delete('/:id/media/:mediaId', asyncRoute(async (req, res) => {
  const media = await db.get('SELECT * FROM product_media WHERE id = $1 AND product_id = $2', [req.params.mediaId, req.params.id]);
  if (!media) throw new ApiError(404, 'Media not found.');
  const product = await db.get('SELECT sku FROM products WHERE id = $1', [req.params.id]);
  await db.query('DELETE FROM product_media WHERE id = $1', [media.id]);
  const p = path.join(env.rootDir, media.url.replace(/^\//, ''));
  fs.unlink(p, () => {});
  await writeAudit({ actor: req.adminUser.full_name, action: 'Removed media', target: product ? product.sku : `#${req.params.id}`, module: 'Products' });
  res.json({ data: { deleted: true } });
}));

router.put('/:id/media/:mediaId', upload.single('file'), convertHeic, asyncRoute(async (req, res) => {
  const product = await db.get('SELECT * FROM products WHERE id = $1', [req.params.id]);
  if (!product) throw new ApiError(404, 'Product not found.');
  const media = await db.get('SELECT * FROM product_media WHERE id = $1 AND product_id = $2', [req.params.mediaId, product.id]);
  if (!media) throw new ApiError(404, 'Media not found.');
  if (!req.file) throw new ApiError(400, 'No file uploaded.');

  const newUrl = `/uploads/products/${path.basename(req.file.path)}`;
  const newKind = kindOf(req.file.mimetype, req.file.originalname);
  await db.query('UPDATE product_media SET kind = $1, url = $2, original_name = $3 WHERE id = $4', [newKind, newUrl, req.file.originalname, media.id]);
  const oldPath = path.join(env.rootDir, media.url.replace(/^\//, ''));
  fs.unlink(oldPath, () => {});

  await writeAudit({ actor: req.adminUser.full_name, action: 'Edited media', target: product.sku, module: 'Products' });
  res.json({ data: { id: Number(media.id), kind: newKind, url: newUrl, originalName: req.file.originalname } });
}));

// Video framing (pan/zoom crop) is stored as metadata, not re-encoded — see
// utils/videoCropper.js. { x, y } are percentage pan offsets, { scale } is
// the zoom factor, { aspect } is one of imageCropper's aspect keys, matching
// the shape the client already draws for image cropping. `crop: null`
// clears it back to an uncropped, natural-aspect display.
router.put('/:id/media/:mediaId/crop', asyncRoute(async (req, res) => {
  const product = await db.get('SELECT * FROM products WHERE id = $1', [req.params.id]);
  if (!product) throw new ApiError(404, 'Product not found.');
  const media = await db.get('SELECT * FROM product_media WHERE id = $1 AND product_id = $2', [req.params.mediaId, product.id]);
  if (!media) throw new ApiError(404, 'Media not found.');
  if (media.kind !== 'video') throw new ApiError(400, 'Crop framing only applies to video media.');

  const { crop } = req.body || {};
  let stored = null;
  if (crop !== null && crop !== undefined) {
    const { x, y, scale, aspect } = crop;
    if (typeof x !== 'number' || typeof y !== 'number' || typeof scale !== 'number' || typeof aspect !== 'string') {
      throw new ApiError(400, 'crop must be { x, y, scale, aspect } or null.');
    }
    stored = JSON.stringify({
      x: Math.max(-100, Math.min(100, x)),
      y: Math.max(-100, Math.min(100, y)),
      scale: Math.max(1, Math.min(4, scale)),
      aspect,
    });
  }
  await db.query('UPDATE product_media SET crop = $1 WHERE id = $2', [stored, media.id]);
  await writeAudit({ actor: req.adminUser.full_name, action: 'Reframed video', target: product.sku, module: 'Products' });
  res.json({ data: { id: Number(media.id), crop: stored ? JSON.parse(stored) : null } });
}));

router.get('/import/:type/template', asyncRoute(async (req, res) => {
  const { type } = req.params;
  if (!IMPORT_COLUMN_DEFS[type]) throw new ApiError(404, 'Unknown product type.');
  const buffer = await buildTemplate(type);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="oncd-${type}-stock-template.xlsx"`);
  res.send(buffer);
}));

router.get('/export/:type', asyncRoute(async (req, res) => {
  const { type } = req.params;
  if (!IMPORT_COLUMN_DEFS[type]) throw new ApiError(404, 'Unknown product type.');

  const idsParam = String(req.query.ids || '').trim();
  let rows;
  let selectedOnly = false;
  if (idsParam) {
    const ids = idsParam.split(',').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0);
    if (!ids.length) throw new ApiError(400, 'No valid product ids were provided.');
    selectedOnly = true;
    const placeholders = ids.map((_, i) => `$${i + 2}`).join(', ');
    rows = await db.all(`SELECT * FROM products WHERE type = $1 AND id IN (${placeholders}) ORDER BY created_at DESC, id DESC`, [type, ...ids]);
  } else {
    rows = await db.all('SELECT * FROM products WHERE type = $1 ORDER BY created_at DESC, id DESC', [type]);
  }
  if (!rows.length) throw new ApiError(400, 'No products to export.');

  const buffer = await buildStockExport(type, rows);
  await writeAudit({
    actor: req.adminUser.full_name,
    action: `Exported ${rows.length} ${type} product(s) to Excel${selectedOnly ? ' (selected)' : ''}`,
    target: `${rows.length} product(s)`,
    module: 'Products',
  });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="oncd-${type}-stock-export${selectedOnly ? '-selected' : ''}.xlsx"`);
  res.send(buffer);
}));

router.post('/import/:type', (req, res, next) => {
  importUpload.single('file')(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: 'File is too large (10MB max).' });
    res.status(400).json({ error: err.message || 'Upload failed.' });
  });
}, asyncRoute(async (req, res) => {
  const { type } = req.params;
  if (!IMPORT_COLUMN_DEFS[type]) throw new ApiError(404, 'Unknown product type.');
  if (!req.file) throw new ApiError(400, 'No file uploaded.');
  const name = (req.file.originalname || '').toLowerCase();
  if (!name.endsWith('.xlsx') && !name.endsWith('.xls')) {
    throw new ApiError(400, 'Please upload an Excel file (.xlsx or .xls).');
  }

  const { topLevelError, results } = await importWorkbook(type, req.file.buffer);
  if (topLevelError) throw new ApiError(400, topLevelError);

  const validRows = results.filter((r) => r.ok);
  const errorRows = results.filter((r) => !r.ok);

  const cols = productColumns(type);
  // Same single-client transaction requirement as media reorder above — a
  // partially-committed bulk import (some rows in, some silently dropped by
  // a later failure) is exactly the corrupted state the original SQLite
  // db.transaction() already guarded against.
  await db.transaction(async (client) => {
    for (const r of validRows) {
      const values = cols.map((c) => (r.product[c] === undefined ? null : r.product[c]));
      const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
      await client.query(`INSERT INTO products (${cols.join(', ')}) VALUES (${placeholders})`, values);
    }
  });

  await writeAudit({
    actor: req.adminUser.full_name,
    action: `Imported ${validRows.length} of ${results.length} ${type} products via Excel`,
    target: req.file.originalname || 'import.xlsx',
    module: 'Products',
  });

  res.json({
    data: {
      imported: validRows.length,
      totalRows: results.length,
      errors: errorRows.map((r) => ({ row: r.row, sku: r.sku || '', messages: r.errors, messageText: r.errors.join('; ') })),
    },
  });
}));

// Multer errors (bad file type, too large) land here instead of the generic error handler
// because they're thrown synchronously inside the upload middleware before res is touched.
router.use((err, req, res, next) => {
  if (err && (err.message || '').startsWith('Unsupported file type')) {
    return res.status(400).json({ error: err.message });
  }
  if (err && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({ error: 'File is too large (50MB max).' });
  }
  next(err);
});

module.exports = router;
