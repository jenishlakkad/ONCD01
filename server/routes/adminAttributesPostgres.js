const express = require('express');
const db = require('../db/postgres');
const { asyncRoute, ApiError } = require('../middleware/errorHandler');
const requireAdmin = require('../middleware/requireAdminPostgres');
const requirePermission = require('../middleware/requirePermission');
const { writeAudit } = require('../lib/auditPostgres');

// PostgreSQL counterpart to server/routes/adminAttributes.js (SQLite).
// Parallel/isolated file only — NOT mounted in app.js.
//
// NOTE: this router intentionally gates on the 'categories' permission
// module, not 'attributes' — that's not a typo, it's the existing SQLite
// route's actual behavior (attribute picklists are managed under the same
// admin permission as categories), preserved exactly.

const router = express.Router();
router.use(requireAdmin, requirePermission('categories', 'manage'));

const VALID_TYPES = ['shape', 'color', 'certification'];
// Fixed, hardcoded column-name whitelist — never built from user input, so
// interpolating it directly into SQL below is safe (no injection surface).
const PRODUCT_COLUMN = { shape: 'shape', color: 'color', certification: 'certificate_authority' };

function assertType(type) {
  if (!VALID_TYPES.includes(type)) throw new ApiError(400, 'Invalid attribute type.');
}

// NOTE: `AS attributeType`, `AS sortOrder`, `AS productCount` must be
// double-quoted. `a.name COLLATE "C"` / `name COLLATE "C"` preserve
// SQLite's BINARY tie-break ordering (attribute names like color grades
// mix case, e.g. "D"/"E"/"Fancy Yellow", so this one is a real, not just
// defensive, fix — same class of issue found in Step 8's categories query).
router.get('/', asyncRoute(async (req, res) => {
  const { type } = req.query;
  if (type) assertType(type);
  if (type) {
    const rows = await db.all(
      `SELECT a.id, a.attribute_type AS "attributeType", a.name, a.sort_order AS "sortOrder", a.enabled,
              (SELECT COUNT(*) FROM products p WHERE p.${PRODUCT_COLUMN[type]} = a.name) AS "productCount"
       FROM product_attributes a WHERE a.attribute_type = $1 ORDER BY a.sort_order, a.name COLLATE "C"`,
      [type]
    );
    // product_attributes.id is BIGINT -> Number(...). COUNT(*) always
    // returns BIGINT in PostgreSQL regardless of the counted table's own
    // column types, so productCount needs the same treatment. `enabled` is
    // a real BOOLEAN column here (unchanged internally) but the existing
    // SQLite API has always returned it as 1/0 — normalized only in this
    // response mapping.
    res.json({ data: rows.map((r) => ({ ...r, id: Number(r.id), productCount: Number(r.productCount), enabled: r.enabled ? 1 : 0 })) });
  } else {
    const rows = await db.all(
      'SELECT id, attribute_type AS "attributeType", name, sort_order AS "sortOrder", enabled FROM product_attributes ORDER BY attribute_type, sort_order, name COLLATE "C"'
    );
    res.json({ data: rows.map((r) => ({ ...r, id: Number(r.id), enabled: r.enabled ? 1 : 0 })) });
  }
}));

router.post('/', asyncRoute(async (req, res) => {
  const { attributeType, name } = req.body || {};
  assertType(attributeType);
  if (!name || !String(name).trim()) throw new ApiError(400, 'name is required.');
  const trimmed = name.trim();
  // name = ? COLLATE NOCASE (SQLite case-insensitive compare) -> LOWER(name) = LOWER($N).
  // The PostgreSQL schema already has the matching case-insensitive unique
  // index on (attribute_type, LOWER(name)) — confirmed read-only — so this
  // mirrors that same case-insensitivity at the application dup-check level.
  const dup = await db.get('SELECT id FROM product_attributes WHERE attribute_type = $1 AND LOWER(name) = LOWER($2)', [attributeType, trimmed]);
  if (dup) throw new ApiError(409, 'This value already exists.');
  const maxOrderRow = await db.get('SELECT COALESCE(MAX(sort_order), -1) AS m FROM product_attributes WHERE attribute_type = $1', [attributeType]);
  const inserted = await db.get(
    'INSERT INTO product_attributes (attribute_type, name, sort_order, enabled) VALUES ($1, $2, $3, TRUE) RETURNING id',
    [attributeType, trimmed, maxOrderRow.m + 1]
  );
  await writeAudit({ actor: req.adminUser.full_name, action: `Added ${attributeType}`, target: trimmed, module: 'Categories' });
  res.status(201).json({ data: { id: Number(inserted.id) } });
}));

router.put('/reorder', asyncRoute(async (req, res) => {
  const { attributeType, order } = req.body || {};
  assertType(attributeType);
  if (!Array.isArray(order) || !order.length) throw new ApiError(400, 'A non-empty order array is required.');
  const existing = await db.all('SELECT id FROM product_attributes WHERE attribute_type = $1', [attributeType]);
  const existingIds = new Set(existing.map((r) => Number(r.id)));
  if (order.length !== existing.length || !order.every((id) => existingIds.has(id))) {
    throw new ApiError(400, 'order must contain exactly this list\'s ids.');
  }
  // Single pooled client for the whole transaction, sequential writes only.
  await db.transaction(async (client) => {
    for (const [i, id] of order.entries()) {
      await client.query('UPDATE product_attributes SET sort_order = $1 WHERE id = $2', [i, id]);
    }
  });
  await writeAudit({ actor: req.adminUser.full_name, action: `Reordered ${attributeType}`, target: attributeType, module: 'Categories' });
  res.json({ data: { reordered: true } });
}));

router.put('/:id', asyncRoute(async (req, res) => {
  const existing = await db.get('SELECT * FROM product_attributes WHERE id = $1', [req.params.id]);
  if (!existing) throw new ApiError(404, 'Attribute not found.');
  const { name, enabled, sortOrder } = req.body || {};
  if (name && name.trim() && name.trim() !== existing.name) {
    const dup = await db.get(
      'SELECT id FROM product_attributes WHERE attribute_type = $1 AND LOWER(name) = LOWER($2) AND id != $3',
      [existing.attribute_type, name.trim(), existing.id]
    );
    if (dup) throw new ApiError(409, 'A value with this name already exists.');
  }
  await db.query(
    'UPDATE product_attributes SET name = COALESCE($1, name), enabled = COALESCE($2, enabled), sort_order = COALESCE($3, sort_order) WHERE id = $4',
    [name ?? null, enabled === undefined ? null : !!enabled, sortOrder === undefined ? null : sortOrder, existing.id]
  );
  await writeAudit({ actor: req.adminUser.full_name, action: `Updated ${existing.attribute_type}`, target: name || existing.name, module: 'Categories' });
  res.json({ data: { updated: true } });
}));

router.delete('/:id', asyncRoute(async (req, res) => {
  const existing = await db.get('SELECT * FROM product_attributes WHERE id = $1', [req.params.id]);
  if (!existing) throw new ApiError(404, 'Attribute not found.');
  const column = PRODUCT_COLUMN[existing.attribute_type];
  const inUseRow = await db.get(`SELECT COUNT(*) AS n FROM products WHERE ${column} = $1`, [existing.name]);
  if (Number(inUseRow.n) > 0) throw new ApiError(409, `${Number(inUseRow.n)} product(s) still use this value.`);
  await db.query('DELETE FROM product_attributes WHERE id = $1', [existing.id]);
  await writeAudit({ actor: req.adminUser.full_name, action: `Removed ${existing.attribute_type}`, target: existing.name, module: 'Categories' });
  res.json({ data: { deleted: true } });
}));

module.exports = router;
