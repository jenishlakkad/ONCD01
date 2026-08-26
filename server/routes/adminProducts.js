const fs = require('fs');
const path = require('path');
const express = require('express');
const multer = require('multer');
const db = require('../db/connection');
const { asyncRoute, ApiError } = require('../middleware/errorHandler');
const requireAdmin = require('../middleware/requireAdmin');
const requirePermission = require('../middleware/requirePermission');
const { makeUploader, kindOf } = require('../middleware/upload');
const { serializeProduct } = require('../lib/serializeProduct');
const { writeAudit } = require('../lib/audit');
const { COLUMN_DEFS: IMPORT_COLUMN_DEFS, buildTemplate, buildStockExport, importWorkbook, productColumns } = require('../lib/excelImport');
const env = require('../config/env');

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

function categoryRow(id) { return id ? db.prepare('SELECT id, name FROM categories WHERE id = ?').get(id) : null; }
function subcategoryRow(id) { return id ? db.prepare('SELECT id, name FROM subcategories WHERE id = ?').get(id) : null; }
function mediaFor(productId) {
  return db.prepare('SELECT id, kind, url, sort_order AS sortOrder, original_name AS originalName FROM product_media WHERE product_id = ? ORDER BY sort_order').all(productId);
}
function fullProduct(row) {
  return serializeProduct(row, { category: categoryRow(row.category_id), subcategory: subcategoryRow(row.subcategory_id), media: mediaFor(row.id) });
}

router.get('/', asyncRoute(async (req, res) => {
  const { type } = req.query;
  let sql = 'SELECT * FROM products';
  const params = [];
  if (type) { sql += ' WHERE type = ?'; params.push(type); }
  sql += ' ORDER BY created_at DESC, id DESC';
  const rows = db.prepare(sql).all(...params);
  res.json({ data: rows.map(fullProduct) });
}));

router.post('/', asyncRoute(async (req, res) => {
  const b = pickBody(req.body || {});
  if (!b.sku || !String(b.sku).trim()) throw new ApiError(400, 'SKU is required.');
  if (!['diamond', 'jewelry', 'gemstone'].includes(b.type)) throw new ApiError(400, 'A valid product type is required.');
  const dup = db.prepare('SELECT id FROM products WHERE sku = ?').get(b.sku);
  if (dup) throw new ApiError(409, `A product with SKU ${b.sku} already exists.`);

  const cols = Object.keys(b);
  const placeholders = cols.map(() => '?').join(', ');
  const info = db.prepare(`INSERT INTO products (${cols.join(', ')}) VALUES (${placeholders})`).run(...cols.map((c) => b[c]));
  const row = db.prepare('SELECT * FROM products WHERE id = ?').get(info.lastInsertRowid);

  writeAudit({ actor: req.adminUser.full_name, action: 'Added product', target: row.sku, module: 'Products' });
  res.status(201).json({ data: fullProduct(row) });
}));

router.put('/:id', asyncRoute(async (req, res) => {
  const existing = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (!existing) throw new ApiError(404, 'Product not found.');
  const b = pickBody(req.body || {});
  if (b.sku && b.sku !== existing.sku) {
    const dup = db.prepare('SELECT id FROM products WHERE sku = ? AND id != ?').get(b.sku, existing.id);
    if (dup) throw new ApiError(409, `A product with SKU ${b.sku} already exists.`);
  }
  const cols = Object.keys(b);
  if (cols.length) {
    const setClause = cols.map((c) => `${c} = ?`).join(', ');
    db.prepare(`UPDATE products SET ${setClause}, updated_at = datetime('now') WHERE id = ?`).run(...cols.map((c) => b[c]), existing.id);
  }
  const row = db.prepare('SELECT * FROM products WHERE id = ?').get(existing.id);

  const statusChanged = b.status && b.status !== existing.status;
  writeAudit({
    actor: req.adminUser.full_name,
    action: statusChanged ? (b.status === 'hidden' ? 'Hid product' : 'Updated product') : 'Updated product',
    target: row.sku,
    module: 'Products',
  });
  res.json({ data: fullProduct(row) });
}));

router.delete('/:id', asyncRoute(async (req, res) => {
  const existing = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (!existing) throw new ApiError(404, 'Product not found.');
  const media = mediaFor(existing.id);
  db.prepare('DELETE FROM products WHERE id = ?').run(existing.id);
  for (const m of media) {
    const p = path.join(env.rootDir, m.url.replace(/^\//, ''));
    fs.unlink(p, () => {});
  }
  writeAudit({ actor: req.adminUser.full_name, action: 'Deleted product', target: existing.sku, module: 'Products' });
  res.json({ data: { deleted: true } });
}));

router.post('/:id/media', upload.array('files', 12), asyncRoute(async (req, res) => {
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (!product) throw new ApiError(404, 'Product not found.');
  if (!req.files || !req.files.length) throw new ApiError(400, 'No files uploaded.');
  const ins = db.prepare('INSERT INTO product_media (product_id, kind, url, sort_order, original_name) VALUES (?, ?, ?, ?, ?)');
  const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM product_media WHERE product_id = ?').get(product.id).m;
  const created = req.files.map((f, i) => {
    const url = `/uploads/products/${path.basename(f.path)}`;
    const info = ins.run(product.id, kindOf(f.mimetype), url, maxOrder + 1 + i, f.originalname);
    return { id: info.lastInsertRowid, kind: kindOf(f.mimetype), url, originalName: f.originalname };
  });
  writeAudit({ actor: req.adminUser.full_name, action: 'Uploaded media', target: product.sku, module: 'Products' });
  res.status(201).json({ data: created });
}));

router.put('/:id/media/reorder', asyncRoute(async (req, res) => {
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (!product) throw new ApiError(404, 'Product not found.');
  const order = Array.isArray((req.body || {}).order) ? req.body.order : null;
  if (!order || !order.length) throw new ApiError(400, 'order must be a non-empty array of media ids.');
  const existing = mediaFor(product.id);
  const existingIds = new Set(existing.map((m) => m.id));
  if (order.length !== existing.length || !order.every((id) => existingIds.has(id))) {
    throw new ApiError(400, 'order must contain exactly this product\'s media ids.');
  }
  const setOrder = db.prepare('UPDATE product_media SET sort_order = ? WHERE id = ? AND product_id = ?');
  db.transaction(() => {
    order.forEach((id, i) => setOrder.run(i, id, product.id));
  })();
  writeAudit({ actor: req.adminUser.full_name, action: 'Reordered media', target: product.sku, module: 'Products' });
  res.json({ data: mediaFor(product.id) });
}));

router.delete('/:id/media/:mediaId', asyncRoute(async (req, res) => {
  const media = db.prepare('SELECT * FROM product_media WHERE id = ? AND product_id = ?').get(req.params.mediaId, req.params.id);
  if (!media) throw new ApiError(404, 'Media not found.');
  const product = db.prepare('SELECT sku FROM products WHERE id = ?').get(req.params.id);
  db.prepare('DELETE FROM product_media WHERE id = ?').run(media.id);
  const p = path.join(env.rootDir, media.url.replace(/^\//, ''));
  fs.unlink(p, () => {});
  writeAudit({ actor: req.adminUser.full_name, action: 'Removed media', target: product ? product.sku : `#${req.params.id}`, module: 'Products' });
  res.json({ data: { deleted: true } });
}));

router.put('/:id/media/:mediaId', upload.single('file'), asyncRoute(async (req, res) => {
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (!product) throw new ApiError(404, 'Product not found.');
  const media = db.prepare('SELECT * FROM product_media WHERE id = ? AND product_id = ?').get(req.params.mediaId, product.id);
  if (!media) throw new ApiError(404, 'Media not found.');
  if (!req.file) throw new ApiError(400, 'No file uploaded.');

  const newUrl = `/uploads/products/${path.basename(req.file.path)}`;
  const newKind = kindOf(req.file.mimetype);
  db.prepare('UPDATE product_media SET kind = ?, url = ?, original_name = ? WHERE id = ?').run(newKind, newUrl, req.file.originalname, media.id);
  const oldPath = path.join(env.rootDir, media.url.replace(/^\//, ''));
  fs.unlink(oldPath, () => {});

  writeAudit({ actor: req.adminUser.full_name, action: 'Edited media', target: product.sku, module: 'Products' });
  res.json({ data: { id: media.id, kind: newKind, url: newUrl, originalName: req.file.originalname } });
}));

router.get('/import/:type/template', asyncRoute(async (req, res) => {
  const { type } = req.params;
  if (!IMPORT_COLUMN_DEFS[type]) throw new ApiError(404, 'Unknown product type.');
  const buffer = buildTemplate(type);
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
    const placeholders = ids.map(() => '?').join(', ');
    rows = db.prepare(`SELECT * FROM products WHERE type = ? AND id IN (${placeholders}) ORDER BY created_at DESC, id DESC`).all(type, ...ids);
  } else {
    rows = db.prepare('SELECT * FROM products WHERE type = ? ORDER BY created_at DESC, id DESC').all(type);
  }
  if (!rows.length) throw new ApiError(400, 'No products to export.');

  const buffer = buildStockExport(type, rows);
  writeAudit({
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

  const { topLevelError, results } = importWorkbook(type, req.file.buffer);
  if (topLevelError) throw new ApiError(400, topLevelError);

  const validRows = results.filter((r) => r.ok);
  const errorRows = results.filter((r) => !r.ok);

  const cols = productColumns(type);
  const insertStmt = db.prepare(`INSERT INTO products (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`);
  db.transaction(() => {
    for (const r of validRows) insertStmt.run(...cols.map((c) => (r.product[c] === undefined ? null : r.product[c])));
  })();

  writeAudit({
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
