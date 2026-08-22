const express = require('express');
const db = require('../db/connection');
const { asyncRoute, ApiError } = require('../middleware/errorHandler');
const { applyPriceVisibility } = require('../lib/priceVisibility');
const { serializeProduct } = require('../lib/serializeProduct');

const router = express.Router();

function getViewer(req) {
  const customerId = req.session && req.session.customerId;
  if (!customerId) return null;
  const customer = db.prepare('SELECT status FROM customers WHERE id = ?').get(customerId);
  if (!customer) return null;
  return { type: 'customer', status: customer.status };
}

function getPriceMode() {
  const row = db.prepare('SELECT price_mode FROM site_settings WHERE id = 1').get();
  return row ? row.price_mode : 'approved';
}

function getPricesEnabled() {
  const row = db.prepare("SELECT enabled FROM feature_flags WHERE key = 'prices'").get();
  return !row || !!row.enabled;
}

function categoryRow(id) {
  return id ? db.prepare('SELECT id, name FROM categories WHERE id = ?').get(id) : null;
}
function subcategoryRow(id) {
  return id ? db.prepare('SELECT id, name FROM subcategories WHERE id = ?').get(id) : null;
}
function mediaFor(productId) {
  return db.prepare('SELECT id, kind, url, sort_order AS sortOrder FROM product_media WHERE product_id = ? ORDER BY sort_order').all(productId);
}

router.get('/', asyncRoute(async (req, res) => {
  const { type, category, shape, color, cert } = req.query;
  let sql = `SELECT p.* FROM products p JOIN product_types pt ON pt.key = p.type
             WHERE p.status = 'active' AND p.visibility = 'visible' AND pt.enabled = 1`;
  const params = [];
  if (type) { sql += ' AND p.type = ?'; params.push(type); }
  if (shape) { sql += ' AND p.shape = ?'; params.push(shape); }
  if (color) { sql += ' AND p.color = ?'; params.push(color); }
  if (cert) { sql += ' AND p.certificate_authority = ?'; params.push(cert); }
  if (category) { sql += ' AND p.category_id IN (SELECT id FROM categories WHERE name = ?)'; params.push(category); }
  sql += ' ORDER BY p.created_at DESC, p.id DESC';
  const rows = db.prepare(sql).all(...params);

  const mode = getPriceMode();
  const viewer = getViewer(req);
  const pricesEnabled = getPricesEnabled();
  const data = rows.map((row) => {
    const masked = applyPriceVisibility(row, mode, viewer, pricesEnabled);
    return serializeProduct(masked, { category: categoryRow(row.category_id), subcategory: subcategoryRow(row.subcategory_id), media: mediaFor(row.id) });
  });
  res.json({ data });
}));

router.get('/:sku', asyncRoute(async (req, res) => {
  const row = db.prepare(
    `SELECT p.* FROM products p JOIN product_types pt ON pt.key = p.type
     WHERE p.sku = ? AND p.status = 'active' AND p.visibility = 'visible' AND pt.enabled = 1`
  ).get(req.params.sku);
  if (!row) throw new ApiError(404, 'Product not found.');

  const mode = getPriceMode();
  const viewer = getViewer(req);
  const pricesEnabled = getPricesEnabled();
  const masked = applyPriceVisibility(row, mode, viewer, pricesEnabled);
  const product = serializeProduct(masked, {
    category: categoryRow(row.category_id),
    subcategory: subcategoryRow(row.subcategory_id),
    media: mediaFor(row.id),
  });

  const relatedRows = db.prepare(
    `SELECT p.* FROM products p JOIN product_types pt ON pt.key = p.type
     WHERE p.type = ? AND p.sku != ? AND p.status = 'active' AND p.visibility = 'visible' AND pt.enabled = 1
     ORDER BY RANDOM() LIMIT 4`
  ).all(row.type, row.sku);
  const related = relatedRows.map((r) => {
    const m = applyPriceVisibility(r, mode, viewer, pricesEnabled);
    return serializeProduct(m, { category: categoryRow(r.category_id), media: mediaFor(r.id) });
  });

  res.json({ data: { ...product, related } });
}));

module.exports = router;
