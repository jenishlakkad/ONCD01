const express = require('express');
const db = require('../db/connection');
const { asyncRoute, ApiError } = require('../middleware/errorHandler');
const requireAdmin = require('../middleware/requireAdmin');
const requirePermission = require('../middleware/requirePermission');
const { writeAudit } = require('../lib/audit');

const router = express.Router();
router.use(requireAdmin, requirePermission('categories', 'manage'));

const VALID_TYPES = ['shape', 'color', 'certification'];
const PRODUCT_COLUMN = { shape: 'shape', color: 'color', certification: 'certificate_authority' };

function assertType(type) {
  if (!VALID_TYPES.includes(type)) throw new ApiError(400, 'Invalid attribute type.');
}

router.get('/', asyncRoute(async (req, res) => {
  const { type } = req.query;
  if (type) assertType(type);
  const rows = type
    ? db.prepare(
        `SELECT a.id, a.attribute_type AS attributeType, a.name, a.sort_order AS sortOrder, a.enabled,
                (SELECT COUNT(*) FROM products p WHERE p.${PRODUCT_COLUMN[type]} = a.name) AS productCount
         FROM product_attributes a WHERE a.attribute_type = ? ORDER BY a.sort_order, a.name`
      ).all(type)
    : db.prepare('SELECT id, attribute_type AS attributeType, name, sort_order AS sortOrder, enabled FROM product_attributes ORDER BY attribute_type, sort_order, name').all();
  res.json({ data: rows });
}));

router.post('/', asyncRoute(async (req, res) => {
  const { attributeType, name } = req.body || {};
  assertType(attributeType);
  if (!name || !String(name).trim()) throw new ApiError(400, 'name is required.');
  const trimmed = name.trim();
  const dup = db.prepare('SELECT id FROM product_attributes WHERE attribute_type = ? AND name = ? COLLATE NOCASE').get(attributeType, trimmed);
  if (dup) throw new ApiError(409, 'This value already exists.');
  const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM product_attributes WHERE attribute_type = ?').get(attributeType).m;
  const info = db.prepare('INSERT INTO product_attributes (attribute_type, name, sort_order, enabled) VALUES (?, ?, ?, 1)')
    .run(attributeType, trimmed, maxOrder + 1);
  writeAudit({ actor: req.adminUser.full_name, action: `Added ${attributeType}`, target: trimmed, module: 'Categories' });
  res.status(201).json({ data: { id: info.lastInsertRowid } });
}));

router.put('/reorder', asyncRoute(async (req, res) => {
  const { attributeType, order } = req.body || {};
  assertType(attributeType);
  if (!Array.isArray(order) || !order.length) throw new ApiError(400, 'A non-empty order array is required.');
  const existing = db.prepare('SELECT id FROM product_attributes WHERE attribute_type = ?').all(attributeType);
  const existingIds = new Set(existing.map((r) => r.id));
  if (order.length !== existing.length || !order.every((id) => existingIds.has(id))) {
    throw new ApiError(400, 'order must contain exactly this list\'s ids.');
  }
  const setOrder = db.prepare('UPDATE product_attributes SET sort_order = ? WHERE id = ?');
  db.transaction(() => { order.forEach((id, i) => setOrder.run(i, id)); })();
  writeAudit({ actor: req.adminUser.full_name, action: `Reordered ${attributeType}`, target: attributeType, module: 'Categories' });
  res.json({ data: { reordered: true } });
}));

router.put('/:id', asyncRoute(async (req, res) => {
  const existing = db.prepare('SELECT * FROM product_attributes WHERE id = ?').get(req.params.id);
  if (!existing) throw new ApiError(404, 'Attribute not found.');
  const { name, enabled, sortOrder } = req.body || {};
  if (name && name.trim() && name.trim() !== existing.name) {
    const dup = db.prepare('SELECT id FROM product_attributes WHERE attribute_type = ? AND name = ? COLLATE NOCASE AND id != ?')
      .get(existing.attribute_type, name.trim(), existing.id);
    if (dup) throw new ApiError(409, 'A value with this name already exists.');
  }
  db.prepare('UPDATE product_attributes SET name = COALESCE(?, name), enabled = COALESCE(?, enabled), sort_order = COALESCE(?, sort_order) WHERE id = ?')
    .run(name ?? null, enabled === undefined ? null : (enabled ? 1 : 0), sortOrder === undefined ? null : sortOrder, existing.id);
  writeAudit({ actor: req.adminUser.full_name, action: `Updated ${existing.attribute_type}`, target: name || existing.name, module: 'Categories' });
  res.json({ data: { updated: true } });
}));

router.delete('/:id', asyncRoute(async (req, res) => {
  const existing = db.prepare('SELECT * FROM product_attributes WHERE id = ?').get(req.params.id);
  if (!existing) throw new ApiError(404, 'Attribute not found.');
  const column = PRODUCT_COLUMN[existing.attribute_type];
  const inUse = db.prepare(`SELECT COUNT(*) AS n FROM products WHERE ${column} = ?`).get(existing.name).n;
  if (inUse > 0) throw new ApiError(409, `${inUse} product(s) still use this value.`);
  db.prepare('DELETE FROM product_attributes WHERE id = ?').run(existing.id);
  writeAudit({ actor: req.adminUser.full_name, action: `Removed ${existing.attribute_type}`, target: existing.name, module: 'Categories' });
  res.json({ data: { deleted: true } });
}));

module.exports = router;
