const express = require('express');
const db = require('../db/postgres');
const { asyncRoute, ApiError } = require('../middleware/errorHandler');

// PostgreSQL counterpart to server/routes/attributes.js (SQLite). Parallel/
// isolated file only — NOT mounted in app.js. Read-only, no writes.

const router = express.Router();

const VALID_TYPES = ['shape', 'color', 'certification'];

// NOTE: `AS attributeType` must be double-quoted, same reasoning as
// categoriesPostgres.js — Postgres would otherwise fold it to `attributetype`.
router.get('/', asyncRoute(async (req, res) => {
  const { type } = req.query;
  if (type && !VALID_TYPES.includes(type)) throw new ApiError(400, 'Invalid attribute type.');
  const rows = type
    ? await db.all(
        'SELECT id, attribute_type AS "attributeType", name FROM product_attributes WHERE attribute_type = $1 AND enabled = TRUE ORDER BY sort_order, name',
        [type]
      )
    : await db.all(
        'SELECT id, attribute_type AS "attributeType", name FROM product_attributes WHERE enabled = TRUE ORDER BY attribute_type, sort_order, name'
      );
  // product_attributes.id is BIGINT -> pg returns it as a string; Number(...)
  // keeps the response shape identical to the SQLite version.
  res.json({ data: rows.map((r) => ({ ...r, id: Number(r.id) })) });
}));

module.exports = router;
