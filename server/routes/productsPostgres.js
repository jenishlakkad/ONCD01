const express = require('express');
const db = require('../db/postgres');
const { asyncRoute, ApiError } = require('../middleware/errorHandler');
const { applyPriceVisibility } = require('../lib/priceVisibility');
const { serializeProduct } = require('../lib/serializeProduct');
const { toPublicMediaUrl } = require('../lib/mediaUrl');

// PostgreSQL counterpart to server/routes/products.js (SQLite). Parallel/
// isolated test route file only — NOT mounted in app.js.
//
// STEP 17B performance rewrite: the original per-row categoryRow()/
// subcategoryRow()/mediaFor() helpers issued one query EACH per product
// (confirmed by Step 17A's diagnostic: 598 total queries for 282 products,
// ~12-13.5s, entirely explained by round-trip count × network latency
// through the pool — see that audit for the full evidence trail). Replaced
// with three batch queries (categories/subcategories/media), each using
// `WHERE id = ANY($1::bigint[])`, assembled into Maps and looked up per row
// in JS — the response shape, ordering, price-visibility logic and every
// exposed field are byte-for-byte unchanged; only the number of round trips
// changes. getPriceMode/getViewer/getPricesEnabled are untouched — they
// already ran exactly once per request before this change too.

const router = express.Router();

async function getViewer(req) {
  const customerId = req.session && req.session.customerId;
  if (!customerId) return null;
  const customer = await db.get('SELECT status FROM customers WHERE id = $1', [customerId]);
  if (!customer) return null;
  return { type: 'customer', status: customer.status };
}

async function getPriceMode() {
  const row = await db.get('SELECT price_mode FROM site_settings WHERE id = 1');
  return row ? row.price_mode : 'approved';
}

async function getPricesEnabled() {
  const row = await db.get("SELECT enabled FROM feature_flags WHERE key = 'prices'");
  return !row || !!row.enabled;
}

// Batch category/subcategory lookups: collect unique non-null ids across the
// whole result set, fetch them in ONE query each, return a Map<Number, {id,name}>.
// Same object shape as the old per-row categoryRow()/subcategoryRow().
async function batchLookup(table, ids) {
  const unique = [...new Set(ids.filter((id) => id !== null && id !== undefined).map((id) => String(id)))];
  const map = new Map();
  if (!unique.length) return map;
  const rows = await db.all(`SELECT id, name FROM ${table} WHERE id = ANY($1::bigint[])`, [unique]);
  for (const r of rows) map.set(Number(r.id), { id: Number(r.id), name: r.name });
  return map;
}

// Batch media lookup: ONE query for every product's media, ordered exactly
// as the old per-product query was (`ORDER BY sort_order` within a product),
// grouped into a Map<Number productId, mediaArray> in JS. `product_id` is
// selected only to group rows here — it is never included in the media
// objects returned to the client, preserving the exact existing shape.
//
// NOTE: the CURRENT public media shape is {id, kind, url, sortOrder, crop} —
// no `originalName` (that field only exists on the admin route's media
// query). Preserved exactly as the existing code already has it, not
// expanded.
async function batchMedia(productIds) {
  const unique = [...new Set(productIds.map((id) => String(id)))];
  const map = new Map();
  if (!unique.length) return map;
  const rows = await db.all(
    `SELECT id, product_id, kind, url, sort_order AS "sortOrder", crop
     FROM product_media WHERE product_id = ANY($1::bigint[]) ORDER BY product_id, sort_order`,
    [unique]
  );
  for (const r of rows) {
    const pid = Number(r.product_id);
    if (!map.has(pid)) map.set(pid, []);
    map.get(pid).push({
      id: Number(r.id),
      kind: r.kind,
      url: toPublicMediaUrl(r.url),
      sortOrder: r.sortOrder,
      crop: r.crop ? JSON.parse(r.crop) : null,
    });
  }
  return map;
}

// Assembles the {category, subcategory, media} lookups for one set of
// product rows via exactly 3 batch queries (run concurrently), returning a
// function that reproduces the old per-row categoryRow/subcategoryRow/
// mediaFor()'s exact output shape for a given row, from the pre-fetched Maps.
async function buildEnrichmentLookup(rows) {
  const [categoriesMap, subcategoriesMap, mediaMap] = await Promise.all([
    batchLookup('categories', rows.map((r) => r.category_id)),
    batchLookup('subcategories', rows.map((r) => r.subcategory_id)),
    batchMedia(rows.map((r) => r.id)),
  ]);
  return (row) => ({
    category: row.category_id ? categoriesMap.get(Number(row.category_id)) || null : null,
    subcategory: row.subcategory_id ? subcategoriesMap.get(Number(row.subcategory_id)) || null : null,
    media: mediaMap.get(Number(row.id)) || [],
  });
}

router.get('/', asyncRoute(async (req, res) => {
  const { type, category, shape, color, cert } = req.query;
  let sql = `SELECT p.* FROM products p JOIN product_types pt ON pt.key = p.type
             WHERE p.status = 'active' AND p.visibility = 'visible' AND pt.enabled = TRUE`;
  const params = [];
  if (type) { params.push(type); sql += ` AND p.type = $${params.length}`; }
  if (shape) { params.push(shape); sql += ` AND p.shape = $${params.length}`; }
  if (color) { params.push(color); sql += ` AND p.color = $${params.length}`; }
  if (cert) { params.push(cert); sql += ` AND p.certificate_authority = $${params.length}`; }
  if (category) { params.push(category); sql += ` AND p.category_id IN (SELECT id FROM categories WHERE name = $${params.length})`; }
  sql += ' ORDER BY p.created_at DESC, p.id DESC';
  const rows = await db.all(sql, params);

  const [mode, viewer, pricesEnabled] = await Promise.all([getPriceMode(), getViewer(req), getPricesEnabled()]);
  const lookupFor = await buildEnrichmentLookup(rows);

  const data = rows.map((row) => {
    const masked = applyPriceVisibility(row, mode, viewer, pricesEnabled);
    const { category: cat, subcategory: sub, media } = lookupFor(row);
    return serializeProduct({ ...masked, id: Number(row.id) }, { category: cat, subcategory: sub, media });
  });
  res.json({ data });
}));

router.get('/:sku', asyncRoute(async (req, res) => {
  const row = await db.get(
    `SELECT p.* FROM products p JOIN product_types pt ON pt.key = p.type
     WHERE p.sku = $1 AND p.status = 'active' AND p.visibility = 'visible' AND pt.enabled = TRUE`,
    [req.params.sku]
  );
  if (!row) throw new ApiError(404, 'Product not found.');

  const [mode, viewer, pricesEnabled] = await Promise.all([getPriceMode(), getViewer(req), getPricesEnabled()]);
  const mainLookup = await buildEnrichmentLookup([row]);
  const masked = applyPriceVisibility(row, mode, viewer, pricesEnabled);
  const { category, subcategory, media } = mainLookup(row);
  const product = serializeProduct({ ...masked, id: Number(row.id) }, { category, subcategory, media });

  const relatedRows = await db.all(
    `SELECT p.* FROM products p JOIN product_types pt ON pt.key = p.type
     WHERE p.type = $1 AND p.sku != $2 AND p.status = 'active' AND p.visibility = 'visible' AND pt.enabled = TRUE
     ORDER BY RANDOM() LIMIT 4`,
    [row.type, row.sku]
  );
  // Same batch mechanism for the (small, <=4) related set — no subcategory
  // in the related shape, matching the original code exactly (it only ever
  // passed { category: rCategory, media: rMedia }, never subcategory).
  const relatedLookup = await buildEnrichmentLookup(relatedRows);
  const related = relatedRows.map((r) => {
    const m = applyPriceVisibility(r, mode, viewer, pricesEnabled);
    const { category: rCategory, media: rMedia } = relatedLookup(r);
    return serializeProduct({ ...m, id: Number(r.id) }, { category: rCategory, media: rMedia });
  });

  res.json({ data: { ...product, related } });
}));

module.exports = router;
