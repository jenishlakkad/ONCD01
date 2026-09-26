const express = require('express');
const db = require('../db/postgres');
const { asyncRoute, ApiError } = require('../middleware/errorHandler');
const requireAdmin = require('../middleware/requireAdminPostgres');
const requirePermission = require('../middleware/requirePermission');
const { writeAudit } = require('../lib/auditPostgres');

// PostgreSQL counterpart to server/routes/adminCategories.js (SQLite).
// Parallel/isolated file only — NOT mounted in app.js.

const router = express.Router();
router.use(requireAdmin, requirePermission('categories', 'manage'));

async function typeIdByKey(key) {
  const row = await db.get('SELECT id FROM product_types WHERE key = $1', [key]);
  if (!row) throw new ApiError(400, `Unknown product type: ${key}`);
  return row.id;
}

// NOTE: `AS groupKey`, `AS sortOrder`, `AS productType`, `AS productCount`
// must be double-quoted — Postgres folds unquoted identifiers to lowercase.
//
// NOTE: `c.name COLLATE "C"` on the trailing tie-break. This query's
// primary sort keys (pt.key, c.group_key, c.sort_order) already separate
// rows by product type and group before name is ever consulted, so the
// Step 8 cross-type collation issue mostly doesn't apply here — but a
// manually-edited duplicate sort_order within the same (type, group) could
// still tie on name, so the same SQLite-BINARY-preserving fix is applied
// defensively, at zero cost, consistent with how subcategories was handled
// proactively in Step 8.
router.get('/', asyncRoute(async (req, res) => {
  const rows = await db.all(
    `SELECT c.id, c.name, c.group_key AS "groupKey", c.sort_order AS "sortOrder", c.enabled, pt.key AS "productType",
            (SELECT COUNT(*) FROM products p WHERE p.category_id = c.id) AS "productCount"
     FROM categories c JOIN product_types pt ON pt.id = c.product_type_id
     ORDER BY pt.key, c.group_key, c.sort_order, c.name COLLATE "C"`
  );
  // categories.id is BIGINT -> Number(...). COUNT(*) always returns BIGINT
  // in PostgreSQL regardless of the counted table's own column types, so
  // productCount needs the same treatment. `enabled` is a real BOOLEAN
  // column here (unchanged internally) but the existing SQLite API has
  // always returned it as 1/0 — normalized only in this response mapping.
  res.json({ data: rows.map((r) => ({ ...r, id: Number(r.id), productCount: Number(r.productCount), enabled: r.enabled ? 1 : 0 })) });
}));

router.post('/', asyncRoute(async (req, res) => {
  const { productType, groupKey, name } = req.body || {};
  if (!productType || !name || !String(name).trim()) throw new ApiError(400, 'productType and name are required.');
  const typeId = await typeIdByKey(productType);
  // group_key IS ? (SQLite null-safe equality) -> IS NOT DISTINCT FROM $N.
  // group_key = $N would be wrong: NULL = NULL is never true in PostgreSQL,
  // so ungrouped categories (group_key IS NULL, e.g. every diamond/jewelry
  // category) would never match their own duplicate/maxOrder lookups.
  const dup = await db.get(
    'SELECT id FROM categories WHERE product_type_id = $1 AND group_key IS NOT DISTINCT FROM $2 AND name = $3',
    [typeId, groupKey || null, name.trim()]
  );
  if (dup) throw new ApiError(409, 'This category already exists.');
  const maxOrderRow = await db.get(
    'SELECT COALESCE(MAX(sort_order), -1) AS m FROM categories WHERE product_type_id = $1 AND group_key IS NOT DISTINCT FROM $2',
    [typeId, groupKey || null]
  );
  const inserted = await db.get(
    'INSERT INTO categories (product_type_id, group_key, name, sort_order, enabled) VALUES ($1, $2, $3, $4, TRUE) RETURNING id',
    [typeId, groupKey || null, name.trim(), maxOrderRow.m + 1]
  );
  await writeAudit({ actor: req.adminUser.full_name, action: 'Added category', target: name.trim(), module: 'Categories' });
  res.status(201).json({ data: { id: Number(inserted.id) } });
}));

router.put('/reorder', asyncRoute(async (req, res) => {
  const { productType, groupKey, order } = req.body || {};
  if (!productType || !Array.isArray(order) || !order.length) throw new ApiError(400, 'productType and a non-empty order array are required.');
  const typeId = await typeIdByKey(productType);
  const existing = await db.all(
    'SELECT id FROM categories WHERE product_type_id = $1 AND group_key IS NOT DISTINCT FROM $2',
    [typeId, groupKey || null]
  );
  const existingIds = new Set(existing.map((c) => Number(c.id)));
  if (order.length !== existing.length || !order.every((id) => existingIds.has(id))) {
    throw new ApiError(400, 'order must contain exactly this group\'s category ids.');
  }
  // Single pooled client for the whole transaction — every statement below
  // runs sequentially against that SAME client, never db.query() (which
  // could hand statements to different pool connections and silently lose
  // atomicity). Sequential for...of, not Promise.all, for ordered writes.
  await db.transaction(async (client) => {
    for (const [i, id] of order.entries()) {
      await client.query('UPDATE categories SET sort_order = $1 WHERE id = $2', [i, id]);
    }
  });
  await writeAudit({ actor: req.adminUser.full_name, action: 'Reordered categories', target: productType, module: 'Categories' });
  res.json({ data: { reordered: true } });
}));

router.put('/:id', asyncRoute(async (req, res) => {
  const existing = await db.get('SELECT * FROM categories WHERE id = $1', [req.params.id]);
  if (!existing) throw new ApiError(404, 'Category not found.');
  const { name, enabled, sortOrder } = req.body || {};
  if (name && name.trim() && name.trim() !== existing.name) {
    const dup = await db.get(
      'SELECT id FROM categories WHERE product_type_id = $1 AND group_key IS NOT DISTINCT FROM $2 AND name = $3 AND id != $4',
      [existing.product_type_id, existing.group_key, name.trim(), existing.id]
    );
    if (dup) throw new ApiError(409, 'A category with this name already exists.');
  }
  await db.query(
    'UPDATE categories SET name = COALESCE($1, name), enabled = COALESCE($2, enabled), sort_order = COALESCE($3, sort_order) WHERE id = $4',
    [name ?? null, enabled === undefined ? null : !!enabled, sortOrder === undefined ? null : sortOrder, existing.id]
  );
  await writeAudit({ actor: req.adminUser.full_name, action: 'Updated category', target: name || existing.name, module: 'Categories' });
  res.json({ data: { updated: true } });
}));

router.delete('/:id', asyncRoute(async (req, res) => {
  const existing = await db.get('SELECT * FROM categories WHERE id = $1', [req.params.id]);
  if (!existing) throw new ApiError(404, 'Category not found.');
  const inUseRow = await db.get('SELECT COUNT(*) AS n FROM products WHERE category_id = $1', [existing.id]);
  if (Number(inUseRow.n) > 0) throw new ApiError(409, `${Number(inUseRow.n)} product(s) still use this category.`);
  await db.query('DELETE FROM categories WHERE id = $1', [existing.id]);
  await writeAudit({ actor: req.adminUser.full_name, action: 'Removed category', target: existing.name, module: 'Categories' });
  res.json({ data: { deleted: true } });
}));

router.get('/subcategories', asyncRoute(async (req, res) => {
  const rows = await db.all(
    `SELECT s.id, s.name, s.sort_order AS "sortOrder", s.enabled,
            (SELECT COUNT(*) FROM products p WHERE p.subcategory_id = s.id) AS "productCount"
     FROM subcategories s ORDER BY s.sort_order, s.name COLLATE "C"`
  );
  res.json({ data: rows.map((r) => ({ ...r, id: Number(r.id), productCount: Number(r.productCount), enabled: r.enabled ? 1 : 0 })) });
}));

router.post('/subcategories', asyncRoute(async (req, res) => {
  const { name } = req.body || {};
  if (!name || !String(name).trim()) throw new ApiError(400, 'name is required.');
  const dup = await db.get('SELECT id FROM subcategories WHERE name = $1', [name.trim()]);
  if (dup) throw new ApiError(409, 'This subcategory already exists.');
  const maxOrderRow = await db.get('SELECT COALESCE(MAX(sort_order), -1) AS m FROM subcategories');
  const inserted = await db.get(
    'INSERT INTO subcategories (name, sort_order, enabled) VALUES ($1, $2, TRUE) RETURNING id',
    [name.trim(), maxOrderRow.m + 1]
  );
  await writeAudit({ actor: req.adminUser.full_name, action: 'Added subcategory', target: name.trim(), module: 'Categories' });
  res.status(201).json({ data: { id: Number(inserted.id) } });
}));

router.put('/subcategories/reorder', asyncRoute(async (req, res) => {
  const { order } = req.body || {};
  if (!Array.isArray(order) || !order.length) throw new ApiError(400, 'A non-empty order array is required.');
  const existing = await db.all('SELECT id FROM subcategories');
  const existingIds = new Set(existing.map((s) => Number(s.id)));
  if (order.length !== existing.length || !order.every((id) => existingIds.has(id))) {
    throw new ApiError(400, 'order must contain exactly all subcategory ids.');
  }
  await db.transaction(async (client) => {
    for (const [i, id] of order.entries()) {
      await client.query('UPDATE subcategories SET sort_order = $1 WHERE id = $2', [i, id]);
    }
  });
  await writeAudit({ actor: req.adminUser.full_name, action: 'Reordered subcategories', target: 'Subcategories', module: 'Categories' });
  res.json({ data: { reordered: true } });
}));

router.put('/subcategories/:id', asyncRoute(async (req, res) => {
  const existing = await db.get('SELECT * FROM subcategories WHERE id = $1', [req.params.id]);
  if (!existing) throw new ApiError(404, 'Subcategory not found.');
  const { name, enabled, sortOrder } = req.body || {};
  if (name && name.trim() && name.trim() !== existing.name) {
    const dup = await db.get('SELECT id FROM subcategories WHERE name = $1 AND id != $2', [name.trim(), existing.id]);
    if (dup) throw new ApiError(409, 'A subcategory with this name already exists.');
  }
  await db.query(
    'UPDATE subcategories SET name = COALESCE($1, name), enabled = COALESCE($2, enabled), sort_order = COALESCE($3, sort_order) WHERE id = $4',
    [name ?? null, enabled === undefined ? null : !!enabled, sortOrder === undefined ? null : sortOrder, existing.id]
  );
  await writeAudit({ actor: req.adminUser.full_name, action: 'Updated subcategory', target: name || existing.name, module: 'Categories' });
  res.json({ data: { updated: true } });
}));

router.delete('/subcategories/:id', asyncRoute(async (req, res) => {
  const existing = await db.get('SELECT * FROM subcategories WHERE id = $1', [req.params.id]);
  if (!existing) throw new ApiError(404, 'Subcategory not found.');
  const inUseRow = await db.get('SELECT COUNT(*) AS n FROM products WHERE subcategory_id = $1', [existing.id]);
  if (Number(inUseRow.n) > 0) throw new ApiError(409, `${Number(inUseRow.n)} product(s) still use this subcategory.`);
  await db.query('DELETE FROM subcategories WHERE id = $1', [existing.id]);
  await writeAudit({ actor: req.adminUser.full_name, action: 'Removed subcategory', target: existing.name, module: 'Categories' });
  res.json({ data: { deleted: true } });
}));

module.exports = router;
