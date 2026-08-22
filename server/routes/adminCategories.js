const express = require('express');
const db = require('../db/connection');
const { asyncRoute, ApiError } = require('../middleware/errorHandler');
const requireAdmin = require('../middleware/requireAdmin');
const requirePermission = require('../middleware/requirePermission');
const { writeAudit } = require('../lib/audit');

const router = express.Router();
router.use(requireAdmin, requirePermission('categories', 'manage'));

function typeIdByKey(key) {
  const row = db.prepare('SELECT id FROM product_types WHERE key = ?').get(key);
  if (!row) throw new ApiError(400, `Unknown product type: ${key}`);
  return row.id;
}

router.get('/', asyncRoute(async (req, res) => {
  const rows = db.prepare(
    `SELECT c.id, c.name, c.group_key AS groupKey, c.sort_order AS sortOrder, c.enabled, pt.key AS productType,
            (SELECT COUNT(*) FROM products p WHERE p.category_id = c.id) AS productCount
     FROM categories c JOIN product_types pt ON pt.id = c.product_type_id
     ORDER BY pt.key, c.group_key, c.sort_order, c.name`
  ).all();
  res.json({ data: rows });
}));

router.post('/', asyncRoute(async (req, res) => {
  const { productType, groupKey, name } = req.body || {};
  if (!productType || !name || !String(name).trim()) throw new ApiError(400, 'productType and name are required.');
  const typeId = typeIdByKey(productType);
  const dup = db.prepare('SELECT id FROM categories WHERE product_type_id = ? AND group_key IS ? AND name = ?').get(typeId, groupKey || null, name.trim());
  if (dup) throw new ApiError(409, 'This category already exists.');
  const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM categories WHERE product_type_id = ? AND group_key IS ?').get(typeId, groupKey || null).m;
  const info = db.prepare('INSERT INTO categories (product_type_id, group_key, name, sort_order, enabled) VALUES (?, ?, ?, ?, 1)')
    .run(typeId, groupKey || null, name.trim(), maxOrder + 1);
  writeAudit({ actor: req.adminUser.full_name, action: 'Added category', target: name.trim(), module: 'Categories' });
  res.status(201).json({ data: { id: info.lastInsertRowid } });
}));

router.put('/reorder', asyncRoute(async (req, res) => {
  const { productType, groupKey, order } = req.body || {};
  if (!productType || !Array.isArray(order) || !order.length) throw new ApiError(400, 'productType and a non-empty order array are required.');
  const typeId = typeIdByKey(productType);
  const existing = db.prepare('SELECT id FROM categories WHERE product_type_id = ? AND group_key IS ?').all(typeId, groupKey || null);
  const existingIds = new Set(existing.map((c) => c.id));
  if (order.length !== existing.length || !order.every((id) => existingIds.has(id))) {
    throw new ApiError(400, 'order must contain exactly this group\'s category ids.');
  }
  const setOrder = db.prepare('UPDATE categories SET sort_order = ? WHERE id = ?');
  db.transaction(() => { order.forEach((id, i) => setOrder.run(i, id)); })();
  writeAudit({ actor: req.adminUser.full_name, action: 'Reordered categories', target: productType, module: 'Categories' });
  res.json({ data: { reordered: true } });
}));

router.put('/:id', asyncRoute(async (req, res) => {
  const existing = db.prepare('SELECT * FROM categories WHERE id = ?').get(req.params.id);
  if (!existing) throw new ApiError(404, 'Category not found.');
  const { name, enabled, sortOrder } = req.body || {};
  if (name && name.trim() && name.trim() !== existing.name) {
    const dup = db.prepare('SELECT id FROM categories WHERE product_type_id = ? AND group_key IS ? AND name = ? AND id != ?')
      .get(existing.product_type_id, existing.group_key, name.trim(), existing.id);
    if (dup) throw new ApiError(409, 'A category with this name already exists.');
  }
  db.prepare('UPDATE categories SET name = COALESCE(?, name), enabled = COALESCE(?, enabled), sort_order = COALESCE(?, sort_order) WHERE id = ?')
    .run(name ?? null, enabled === undefined ? null : (enabled ? 1 : 0), sortOrder === undefined ? null : sortOrder, existing.id);
  writeAudit({ actor: req.adminUser.full_name, action: 'Updated category', target: name || existing.name, module: 'Categories' });
  res.json({ data: { updated: true } });
}));

router.delete('/:id', asyncRoute(async (req, res) => {
  const existing = db.prepare('SELECT * FROM categories WHERE id = ?').get(req.params.id);
  if (!existing) throw new ApiError(404, 'Category not found.');
  const inUse = db.prepare('SELECT COUNT(*) AS n FROM products WHERE category_id = ?').get(existing.id).n;
  if (inUse > 0) throw new ApiError(409, `${inUse} product(s) still use this category.`);
  db.prepare('DELETE FROM categories WHERE id = ?').run(existing.id);
  writeAudit({ actor: req.adminUser.full_name, action: 'Removed category', target: existing.name, module: 'Categories' });
  res.json({ data: { deleted: true } });
}));

router.get('/subcategories', asyncRoute(async (req, res) => {
  res.json({
    data: db.prepare(
      `SELECT s.id, s.name, s.sort_order AS sortOrder, s.enabled,
              (SELECT COUNT(*) FROM products p WHERE p.subcategory_id = s.id) AS productCount
       FROM subcategories s ORDER BY s.sort_order, s.name`
    ).all(),
  });
}));

router.post('/subcategories', asyncRoute(async (req, res) => {
  const { name } = req.body || {};
  if (!name || !String(name).trim()) throw new ApiError(400, 'name is required.');
  const dup = db.prepare('SELECT id FROM subcategories WHERE name = ?').get(name.trim());
  if (dup) throw new ApiError(409, 'This subcategory already exists.');
  const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM subcategories').get().m;
  const info = db.prepare('INSERT INTO subcategories (name, sort_order, enabled) VALUES (?, ?, 1)').run(name.trim(), maxOrder + 1);
  writeAudit({ actor: req.adminUser.full_name, action: 'Added subcategory', target: name.trim(), module: 'Categories' });
  res.status(201).json({ data: { id: info.lastInsertRowid } });
}));

router.put('/subcategories/reorder', asyncRoute(async (req, res) => {
  const { order } = req.body || {};
  if (!Array.isArray(order) || !order.length) throw new ApiError(400, 'A non-empty order array is required.');
  const existing = db.prepare('SELECT id FROM subcategories').all();
  const existingIds = new Set(existing.map((s) => s.id));
  if (order.length !== existing.length || !order.every((id) => existingIds.has(id))) {
    throw new ApiError(400, 'order must contain exactly all subcategory ids.');
  }
  const setOrder = db.prepare('UPDATE subcategories SET sort_order = ? WHERE id = ?');
  db.transaction(() => { order.forEach((id, i) => setOrder.run(i, id)); })();
  writeAudit({ actor: req.adminUser.full_name, action: 'Reordered subcategories', target: 'Subcategories', module: 'Categories' });
  res.json({ data: { reordered: true } });
}));

router.put('/subcategories/:id', asyncRoute(async (req, res) => {
  const existing = db.prepare('SELECT * FROM subcategories WHERE id = ?').get(req.params.id);
  if (!existing) throw new ApiError(404, 'Subcategory not found.');
  const { name, enabled, sortOrder } = req.body || {};
  if (name && name.trim() && name.trim() !== existing.name) {
    const dup = db.prepare('SELECT id FROM subcategories WHERE name = ? AND id != ?').get(name.trim(), existing.id);
    if (dup) throw new ApiError(409, 'A subcategory with this name already exists.');
  }
  db.prepare('UPDATE subcategories SET name = COALESCE(?, name), enabled = COALESCE(?, enabled), sort_order = COALESCE(?, sort_order) WHERE id = ?')
    .run(name ?? null, enabled === undefined ? null : (enabled ? 1 : 0), sortOrder === undefined ? null : sortOrder, existing.id);
  writeAudit({ actor: req.adminUser.full_name, action: 'Updated subcategory', target: name || existing.name, module: 'Categories' });
  res.json({ data: { updated: true } });
}));

router.delete('/subcategories/:id', asyncRoute(async (req, res) => {
  const existing = db.prepare('SELECT * FROM subcategories WHERE id = ?').get(req.params.id);
  if (!existing) throw new ApiError(404, 'Subcategory not found.');
  const inUse = db.prepare('SELECT COUNT(*) AS n FROM products WHERE subcategory_id = ?').get(existing.id).n;
  if (inUse > 0) throw new ApiError(409, `${inUse} product(s) still use this subcategory.`);
  db.prepare('DELETE FROM subcategories WHERE id = ?').run(existing.id);
  writeAudit({ actor: req.adminUser.full_name, action: 'Removed subcategory', target: existing.name, module: 'Categories' });
  res.json({ data: { deleted: true } });
}));

module.exports = router;
