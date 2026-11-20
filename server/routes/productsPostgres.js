const express = require('express');
const db = require('../db/postgres');
const { asyncRoute, ApiError } = require('../middleware/errorHandler');
const { applyPriceVisibility } = require('../lib/priceVisibility');
const { serializeProduct } = require('../lib/serializeProduct');
const { getVariants, batchVariants } = require('../lib/productVariants');
const { loadPriceContext, buildEnrichmentLookup, publicOfferFor } = require('../lib/publicProducts');
const { resolveOffer, variantSalePrice, bannersFor } = require('../lib/offers');

// Public catalog routes. The batching helpers (one query each for
// categories/subcategories/media across a whole result set instead of one
// per product — see the STEP 17B performance rewrite in git history) live
// in lib/publicProducts.js, shared with the homepage feed so both apply the
// exact same visibility and price-masking rules.

const router = express.Router();

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
  // The price context doesn't depend on the rows: fetch both together.
  const [rows, ctx] = await Promise.all([db.all(sql, params), loadPriceContext(req)]);

  // Only jewelry has metal variations; other listings skip the query.
  const jewelryIds = rows.filter((r) => r.type === 'jewelry').map((r) => r.id);
  const [lookupFor, variantsMap] = await Promise.all([buildEnrichmentLookup(rows), batchVariants(jewelryIds)]);
  const { mode, viewer, pricesEnabled } = ctx;

  const data = rows.map((row) => {
    const masked = applyPriceVisibility(row, mode, viewer, pricesEnabled);
    const { category: cat, subcategory: sub, media } = lookupFor(row);
    const variants = variantsMap.get(Number(row.id)) || [];
    const offer = publicOfferFor(row, masked, ctx);
    return serializeProduct({ ...masked, id: Number(row.id) }, { category: cat, subcategory: sub, media, variants, offer });
  });
  // Live sales flagged to show a banner, when they discount something here.
  const countsBySale = new Map();
  for (const p of data) if (p.offer && p.offer.saleId) countsBySale.set(p.offer.saleId, (countsBySale.get(p.offer.saleId) || 0) + 1);
  const banners = bannersFor(ctx.promotions, countsBySale, ctx.now);
  res.json({ data, banners });
}));

router.get('/:sku', asyncRoute(async (req, res) => {
  // Two database round trips in total (was five, one after another):
  //  1. the product, up to 4 related pieces of the same type (found by the
  //     SKU itself, so they don't wait for the product) and the price context;
  //  2. categories / media for all of them together, plus metal variations.
  const [row, relatedRows, ctx] = await Promise.all([
    db.get(
      `SELECT p.* FROM products p JOIN product_types pt ON pt.key = p.type
       WHERE p.sku = $1 AND p.status = 'active' AND p.visibility = 'visible' AND pt.enabled = TRUE`,
      [req.params.sku]
    ),
    db.all(
      `SELECT p.* FROM products p JOIN product_types pt ON pt.key = p.type
       WHERE p.type = (SELECT type FROM products WHERE sku = $1) AND p.sku != $1
         AND p.status = 'active' AND p.visibility = 'visible' AND pt.enabled = TRUE
       ORDER BY RANDOM() LIMIT 4`,
      [req.params.sku]
    ),
    loadPriceContext(req),
  ]);
  if (!row) throw new ApiError(404, 'Product not found.');
  const { mode, viewer, pricesEnabled } = ctx;

  const [lookupFor, rawVariants] = await Promise.all([
    buildEnrichmentLookup([row, ...relatedRows]),
    row.type === 'jewelry' ? getVariants(row.id) : Promise.resolve([]),
  ]);
  const masked = applyPriceVisibility(row, mode, viewer, pricesEnabled);
  const { category, subcategory, media } = lookupFor(row);
  const offer = publicOfferFor(row, masked, ctx);
  const rawOffer = offer ? resolveOffer(row, ctx.promotions, ctx.now) : null;
  // Same visibility decision as the base product's own totalPrice (price
  // visibility is a per-PRODUCT setting, not per-variant) — a variant's
  // price (and its sale price under the product's offer) is only ever
  // included when masked.priceVisible is true.
  const variants = rawVariants.map((v) => ({
    id: Number(v.id), metal: v.metal,
    price: masked.priceVisible ? Number(v.price) : null,
    salePrice: masked.priceVisible ? variantSalePrice(v.price, rawOffer) : null,
    coverMediaId: v.cover_media_id ? Number(v.cover_media_id) : null,
  }));
  const product = serializeProduct({ ...masked, id: Number(row.id) }, { category, subcategory, media, variants, offer });

  // No subcategory in the related shape (only { category, media }).
  const related = relatedRows.map((r) => {
    const m = applyPriceVisibility(r, mode, viewer, pricesEnabled);
    const { category: rCategory, media: rMedia } = lookupFor(r);
    return serializeProduct({ ...m, id: Number(r.id) }, { category: rCategory, media: rMedia, offer: publicOfferFor(r, m, ctx) });
  });

  res.json({ data: { ...product, related } });
}));

module.exports = router;
