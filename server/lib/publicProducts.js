const db = require('../db/postgres');
const { applyPriceVisibility } = require('./priceVisibility');
const { serializeProduct } = require('./serializeProduct');
const { toPublicMediaUrl } = require('./mediaUrl');

// Shared building blocks for every PUBLIC (storefront-facing) product
// response — the catalog routes (routes/productsPostgres.js) and the
// homepage feed (routes/homepagePostgres.js) both go through these, so a
// product can never be shown with different price-masking or visibility
// rules depending on which page it appears on.

// The one definition of "publicly visible product". Every public query
// joins product_types as `pt` against products as `p`.
const PUBLIC_FROM = 'FROM products p JOIN product_types pt ON pt.key = p.type';
const PUBLIC_WHERE = "p.status = 'active' AND p.visibility = 'visible' AND pt.enabled = TRUE";

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
async function batchLookup(table, ids) {
  const unique = [...new Set(ids.filter((id) => id !== null && id !== undefined).map((id) => String(id)))];
  const map = new Map();
  if (!unique.length) return map;
  const rows = await db.all(`SELECT id, name FROM ${table} WHERE id = ANY($1::bigint[])`, [unique]);
  for (const r of rows) map.set(Number(r.id), { id: Number(r.id), name: r.name });
  return map;
}

// Batch media lookup: ONE query for every product's media, ordered by
// sort_order within a product. The public media shape is
// {id, kind, url, sortOrder, crop} — `product_id` is only used for grouping.
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

// Exactly 3 batch queries (run concurrently) for a whole set of rows,
// returning a per-row lookup of {category, subcategory, media}.
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

// The per-request price context (mode, viewer, kill-switch) in ONE round
// trip instead of three — same results as getPriceMode()/getViewer()/
// getPricesEnabled() above, including their missing-row cases (hence the
// EXISTS flags: a missing row and a NULL column must stay distinguishable).
async function loadPriceContext(req) {
  const customerId = (req.session && req.session.customerId) || null;
  const row = await db.get(
    `SELECT EXISTS (SELECT 1 FROM site_settings WHERE id = 1) AS has_settings,
            (SELECT price_mode FROM site_settings WHERE id = 1) AS price_mode,
            EXISTS (SELECT 1 FROM feature_flags WHERE key = 'prices') AS has_prices_flag,
            (SELECT enabled FROM feature_flags WHERE key = 'prices') AS prices_enabled,
            EXISTS (SELECT 1 FROM customers WHERE id = $1) AS customer_exists,
            (SELECT status FROM customers WHERE id = $1) AS customer_status`,
    [customerId]
  );
  return {
    mode: row.has_settings ? row.price_mode : 'approved',
    viewer: customerId && row.customer_exists ? { type: 'customer', status: row.customer_status } : null,
    pricesEnabled: !row.has_prices_flag || !!row.prices_enabled,
  };
}

// Price-masks, enriches and serializes raw product rows for a public
// response. `priceContext` may be passed in when the caller already loaded
// it for this request (avoids re-querying it per list on the homepage feed).
async function serializePublicRows(req, rows, priceContext) {
  if (!rows.length) return [];
  const ctx = priceContext || (await loadPriceContext(req));
  const lookupFor = await buildEnrichmentLookup(rows);
  return rows.map((row) => {
    const masked = applyPriceVisibility(row, ctx.mode, ctx.viewer, ctx.pricesEnabled);
    const { category, subcategory, media } = lookupFor(row);
    return serializeProduct({ ...masked, id: Number(row.id) }, { category, subcategory, media });
  });
}

module.exports = {
  PUBLIC_FROM,
  PUBLIC_WHERE,
  getViewer,
  getPriceMode,
  getPricesEnabled,
  batchLookup,
  batchMedia,
  buildEnrichmentLookup,
  loadPriceContext,
  serializePublicRows,
};
