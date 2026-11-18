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
  const rows = await db.all(sql, params);

  // Only jewelry has metal variations; other listings skip the query.
  const jewelryIds = rows.filter((r) => r.type === 'jewelry').map((r) => r.id);
  const [ctx, lookupFor, variantsMap] = await Promise.all([
    loadPriceContext(req), buildEnrichmentLookup(rows), batchVariants(jewelryIds),
  ]);
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
  const row = await db.get(
    `SELECT p.* FROM products p JOIN product_types pt ON pt.key = p.type
     WHERE p.sku = $1 AND p.status = 'active' AND p.visibility = 'visible' AND pt.enabled = TRUE`,
    [req.params.sku]
  );
  if (!row) throw new ApiError(404, 'Product not found.');

  const [ctx, rawVariants] = await Promise.all([loadPriceContext(req), getVariants(row.id)]);
  const { mode, viewer, pricesEnabled } = ctx;
  const mainLookup = await buildEnrichmentLookup([row]);
  const masked = applyPriceVisibility(row, mode, viewer, pricesEnabled);
  const { category, subcategory, media } = mainLookup(row);
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

  const relatedRows = await db.all(
    `SELECT p.* FROM products p JOIN product_types pt ON pt.key = p.type
     WHERE p.type = $1 AND p.sku != $2 AND p.status = 'active' AND p.visibility = 'visible' AND pt.enabled = TRUE
     ORDER BY RANDOM() LIMIT 4`,
    [row.type, row.sku]
  );
  // Same batch mechanism for the (small, <=4) related set — no subcategory
  // in the related shape (only { category, media } is passed).
  const relatedLookup = await buildEnrichmentLookup(relatedRows);
  const related = relatedRows.map((r) => {
    const m = applyPriceVisibility(r, mode, viewer, pricesEnabled);
    const { category: rCategory, media: rMedia } = relatedLookup(r);
    return serializeProduct({ ...m, id: Number(r.id) }, { category: rCategory, media: rMedia, offer: publicOfferFor(r, m, ctx) });
  });

  res.json({ data: { ...product, related } });
}));

module.exports = router;
