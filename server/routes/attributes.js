const express = require('express');
const db = require('../db/connection');
const { asyncRoute, ApiError } = require('../middleware/errorHandler');

const router = express.Router();

const VALID_TYPES = ['shape', 'color', 'certification'];

router.get('/', asyncRoute(async (req, res) => {
  const { type } = req.query;
  if (type && !VALID_TYPES.includes(type)) throw new ApiError(400, 'Invalid attribute type.');
  const rows = type
    ? db.prepare('SELECT id, attribute_type AS attributeType, name FROM product_attributes WHERE attribute_type = ? AND enabled = 1 ORDER BY sort_order, name').all(type)
    : db.prepare('SELECT id, attribute_type AS attributeType, name FROM product_attributes WHERE enabled = 1 ORDER BY attribute_type, sort_order, name').all();
  res.json({ data: rows });
}));

module.exports = router;
