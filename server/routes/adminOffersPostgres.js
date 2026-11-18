const express = require('express');
const db = require('../db/postgres');
const { asyncRoute, ApiError } = require('../middleware/errorHandler');
const requireAdmin = require('../middleware/requireAdminPostgres');
const requirePermission = require('../middleware/requirePermission');
const { writeAudit } = require('../lib/auditPostgres');
const {
  OFFERS_MIGRATION_SQL, SITE_TZ_LABEL, MAX_PERCENT, LABEL_MAX, getOffersSchema, resetOffersSchemaCache,
  loadLivePromotions, invalidatePromotions, normalizePromotion, normalizeScope, promotionMatches,
  resolveOffer, discountedPrice, badgeFor, windowState, parseOfferDate, normalizeOwnDiscount, iso,
} = require('../lib/offers');

// Admin > Sales & Discounts. Sales (the `promotions` table) discount every
// product their scope matches; products can also carry their own discount
// (edited here in bulk, in the product form, or via Excel). All pricing
// decisions are made by lib/offers.js — this file only stores settings and
// reports what they do.

const router = express.Router();
router.use(requireAdmin, requirePermission('products', 'manage'));

const NAME_MAX = 80;
const BANNER_MAX = 160;
const ENDING_SOON_MS = 72 * 3600 * 1000;
const TYPE_LABEL = { diamond: 'Diamond', jewelry: 'Jewelry', gemstone: 'Gemstone' };

// Every product, with just what offer decisions need.
async function productRows() {
  const schema = await getOffersSchema();
  const own = schema.productColumns
    ? 'p.discount_type, p.discount_value, p.discount_label, p.discount_starts_at, p.discount_ends_at'
    : 'NULL::text AS discount_type, NULL::numeric AS discount_value, NULL::text AS discount_label, NULL::timestamptz AS discount_starts_at, NULL::timestamptz AS discount_ends_at';
  return db.all(
    `SELECT p.id, p.sku, p.type, p.status, p.visibility, p.category_id, p.subcategory_id, p.total_price, p.price_per_carat,
            p.weight_carat, p.shape, p.stone_name, c.name AS category_name, ${own}
     FROM products p LEFT JOIN categories c ON c.id = p.category_id
     ORDER BY p.created_at DESC, p.id DESC`
  );
}
const isPublic = (r) => r.status === 'active' && r.visibility === 'visible';

function productTitle(r) {
  if (r.type === 'diamond') return [r.weight_carat ? `${r.weight_carat}ct` : '', r.shape || '', 'Diamond'].filter(Boolean).join(' ');
  if (r.type === 'gemstone') return r.stone_name || r.category_name || 'Gemstone';
  return r.category_name || r.stone_name || 'Jewelry';
}

async function allPromotions() {
  const schema = await getOffersSchema();
  if (!schema.promotions) return [];
  const rows = await db.all('SELECT * FROM promotions ORDER BY created_at DESC, id DESC');
  return rows.map(normalizePromotion);
}

function saleStatus(p, now) {
  if (!p.active) return windowState(p.startsAt, p.endsAt, now) === 'ended' ? 'ended' : 'paused';
  return windowState(p.startsAt, p.endsAt, now);
}

// What a sale with these settings would do across the catalog. `others` =
// the other LIVE sales (they compete: the customer gets the biggest saving).
function saleReach(sale, products, others, now) {
  // Counts storefront pieces only (active + visible); hidden/draft matches
  // are reported separately — they'd get the discount once published.
  const out = { eligible: 0, applies: 0, ownWins: 0, excluded: 0, betterElsewhere: 0, tooSmallPrice: 0, notPublic: 0, sample: [] };
  for (const r of products) {
    if (!promotionMatches(sale, r)) continue;
    if (!isPublic(r)) { out.notPublic += 1; continue; }
    out.eligible += 1;
    if (r.discount_type === 'none') { out.excluded += 1; continue; }
    const ownRunning = (r.discount_type === 'percent' || r.discount_type === 'amount')
      && windowState(r.discount_starts_at, r.discount_ends_at, now) === 'live';
    if (ownRunning) { out.ownWins += 1; continue; }
    const base = Number(r.total_price) || 0;
    const offer = { type: sale.type, value: sale.value };
    if (sale.type === 'amount' && !(base > sale.value)) { out.tooSmallPrice += 1; continue; }
    // This sale goes first so an equal saving counts for it (a tie isn't "bigger elsewhere").
    const competing = resolveOffer({ ...r, discount_type: null }, [{ ...sale, active: true, startsAt: null, endsAt: null }, ...others], now);
    if (!competing) { out.tooSmallPrice += 1; continue; } // no price to discount
    if (competing.promotionId !== sale.id) { out.betterElsewhere += 1; continue; }
    out.applies += 1;
    if (out.sample.length < 8) {
      out.sample.push({
        sku: r.sku, productType: TYPE_LABEL[r.type] || r.type, title: productTitle(r), isPublic: isPublic(r),
        price: base > 0 ? base : null, salePrice: discountedPrice(base, offer),
      });
    }
  }
  return out;
}

function serializeSale(p, products, live, now) {
  const status = saleStatus(p, now);
  const reach = saleReach(p, products, live.filter((x) => x.id !== p.id), now);
  return {
    id: p.id, name: p.name, badgeLabel: p.badgeLabel, type: p.type, value: p.value, badge: badgeFor(p.type, p.value),
    scope: p.scope, startsAt: iso(p.startsAt), endsAt: iso(p.endsAt), active: p.active,
    showBanner: p.showBanner, bannerText: p.bannerText, status,
    reach: { eligible: reach.eligible, applies: reach.applies, ownWins: reach.ownWins, excluded: reach.excluded, betterElsewhere: reach.betterElsewhere, tooSmallPrice: reach.tooSmallPrice, notPublic: reach.notPublic },
    createdAt: p.createdAt, updatedAt: p.updatedAt,
  };
}

router.get('/', asyncRoute(async (req, res) => {
  const schema = await getOffersSchema();
  const now = new Date();
  const [products, promos, categories, subcategories] = await Promise.all([
    productRows(),
    allPromotions(),
    db.all(`SELECT c.id, c.name, pt.key AS type FROM categories c JOIN product_types pt ON pt.id = c.product_type_id ORDER BY pt.key, c.sort_order, c.name`),
    db.all('SELECT id, name FROM subcategories ORDER BY sort_order, name'),
  ]);
  const live = promos.filter((p) => saleStatus(p, now) === 'live');

  // Products with their own discount setting (incl. "No discount").
  const productDiscounts = [];
  let onSaleNow = 0;
  let endingSoon = 0;
  for (const r of products) {
    const offer = resolveOffer(r, live, now);
    if (offer && isPublic(r)) {
      onSaleNow += 1;
      if (offer.endsAt && offer.endsAt - now < ENDING_SOON_MS) endingSoon += 1;
    }
    if (!r.discount_type) continue;
    const base = Number(r.total_price) || null;
    const ownOffer = r.discount_type === 'none' ? null : { type: r.discount_type, value: Number(r.discount_value) };
    productDiscounts.push({
      id: Number(r.id), sku: r.sku, productType: r.type, productTypeLabel: TYPE_LABEL[r.type] || r.type, title: productTitle(r),
      isPublic: isPublic(r), totalPrice: base,
      discountType: r.discount_type, discountValue: r.discount_value == null ? null : Number(r.discount_value),
      badge: ownOffer ? badgeFor(ownOffer.type, ownOffer.value) : 'No discount',
      discountLabel: r.discount_label || '', startsAt: iso(r.discount_starts_at), endsAt: iso(r.discount_ends_at),
      state: r.discount_type === 'none' ? 'excluded' : windowState(r.discount_starts_at, r.discount_ends_at, now),
      salePrice: ownOffer ? discountedPrice(base, ownOffer) : null,
    });
  }

  res.json({
    data: {
      schema: { ready: schema.ready, productColumns: schema.productColumns, promotions: schema.promotions },
      migrationSql: schema.ready ? '' : OFFERS_MIGRATION_SQL,
      timezone: SITE_TZ_LABEL,
      limits: { maxPercent: MAX_PERCENT, labelMax: LABEL_MAX, nameMax: NAME_MAX, bannerMax: BANNER_MAX },
      stats: {
        liveSales: live.length,
        scheduledSales: promos.filter((p) => saleStatus(p, now) === 'scheduled').length,
        onSaleNow,
        endingSoon,
        productDiscounts: productDiscounts.filter((d) => d.state === 'live').length,
        totalPublic: products.filter(isPublic).length,
      },
      sales: promos.map((p) => serializeSale(p, products, live, now)),
      productDiscounts,
      options: {
        categories: categories.map((c) => ({ id: Number(c.id), name: c.name, type: c.type })),
        subcategories: subcategories.map((s) => ({ id: Number(s.id), name: s.name })),
        skus: products.map((r) => ({ sku: r.sku, productType: r.type, title: productTitle(r), price: Number(r.total_price) || null, isPublic: isPublic(r) })),
      },
    },
  });
}));

// Cheap check for other admin screens (the product form): can discounts be
// saved yet?
router.get('/status', asyncRoute(async (req, res) => {
  const schema = await getOffersSchema();
  res.json({ data: { ready: schema.ready, productColumns: schema.productColumns, promotions: schema.promotions, timezone: SITE_TZ_LABEL } });
}));

// Re-checks the schema now (after the owner runs the SQL) instead of
// waiting for the cache to expire.
router.post('/recheck', asyncRoute(async (req, res) => {
  resetOffersSchemaCache();
  invalidatePromotions();
  const schema = await getOffersSchema();
  res.json({ data: { ready: schema.ready, productColumns: schema.productColumns, promotions: schema.promotions } });
}));

// ── Sales ─────────────────────────────────────────────────────────────────
async function requireSalesTable() {
  const schema = await getOffersSchema();
  if (!schema.promotions) throw new ApiError(409, 'Sales need a one-time database update first — run the SQL shown on this page.');
}

// Validates a sale from the request body -> DB values. Throws ApiError.
async function saleFromBody(body) {
  const b = body || {};
  const errors = [];
  const name = String(b.name || '').trim();
  if (!name) errors.push('Give the sale a name, e.g. "Diwali Sale".');
  else if (name.length > NAME_MAX) errors.push(`The name can be at most ${NAME_MAX} characters.`);
  const badgeLabel = String(b.badgeLabel || '').trim();
  if (badgeLabel.length > LABEL_MAX) errors.push(`The label shown to customers can be at most ${LABEL_MAX} characters.`);
  const type = b.type;
  if (!['percent', 'amount'].includes(type)) errors.push('Choose % off or $ off.');
  const value = Number(b.value);
  if (!(value > 0)) errors.push('Enter the discount (a number above 0).');
  else if (type === 'percent' && value > MAX_PERCENT) errors.push(`A percentage discount can be at most ${MAX_PERCENT}%.`);

  const scope = normalizeScope(b.scope);
  if (scope.mode === 'skus') {
    if (!scope.skus.length) errors.push('Add at least one SKU, or choose a different "Applies to".');
    else {
      const found = await db.all('SELECT sku FROM products WHERE UPPER(sku) = ANY($1)', [scope.skus.map((s) => s.toUpperCase())]);
      const byUpper = new Map(found.map((r) => [String(r.sku).toUpperCase(), r.sku]));
      const missing = scope.skus.filter((s) => !byUpper.has(s.toUpperCase()));
      if (missing.length) errors.push(`These SKUs don't exist: ${missing.slice(0, 12).join(', ')}${missing.length > 12 ? ` and ${missing.length - 12} more` : ''}.`);
      scope.skus = scope.skus.map((s) => byUpper.get(s.toUpperCase()) || s);
    }
  }
  if (scope.mode !== 'skus') scope.skus = [];
  if (scope.mode !== 'filter') { scope.types = []; scope.categoryIds = []; scope.subcategoryIds = []; scope.minPrice = null; scope.maxPrice = null; }
  if (scope.minPrice != null && scope.maxPrice != null && scope.maxPrice < scope.minPrice) errors.push('The maximum price must be above the minimum price.');

  const startsAt = b.startsAt ? parseOfferDate(b.startsAt) : null;
  const endsAt = b.endsAt ? parseOfferDate(b.endsAt, { endOfDay: true }) : null;
  if (startsAt === undefined) errors.push("The start date isn't a valid date.");
  if (endsAt === undefined) errors.push("The end date isn't a valid date.");
  if (startsAt && endsAt && endsAt <= startsAt) errors.push('The sale must end after it starts.');

  const bannerText = String(b.bannerText || '').trim();
  if (bannerText.length > BANNER_MAX) errors.push(`The banner text can be at most ${BANNER_MAX} characters.`);

  if (errors.length) throw new ApiError(400, errors.join(' '));
  return {
    name, badge_label: badgeLabel || null, discount_type: type, discount_value: Math.round(value * 100) / 100,
    scope: JSON.stringify(scope), starts_at: startsAt || null, ends_at: endsAt || null,
    active: b.active === undefined ? true : !!b.active, show_banner: !!b.showBanner, banner_text: bannerText || null,
  };
}

// What a sale would do, before saving it.
router.post('/sales/preview', asyncRoute(async (req, res) => {
  const v = await saleFromBody({ ...(req.body || {}), name: 'Preview' });
  const now = new Date();
  const id = Number((req.body || {}).id) || -1;
  const [products, promos] = await Promise.all([productRows(), allPromotions()]);
  const live = promos.filter((p) => p.id !== id && saleStatus(p, now) === 'live');
  const sale = normalizePromotion({ id, name: v.name, discount_type: v.discount_type, discount_value: v.discount_value, scope: JSON.parse(v.scope), active: true });
  const reach = saleReach(sale, products, live, now);
  res.json({ data: { badge: badgeFor(sale.type, sale.value), ...reach } });
}));

async function saleResponse(id) {
  const now = new Date();
  const [products, promos] = await Promise.all([productRows(), allPromotions()]);
  const live = promos.filter((p) => saleStatus(p, now) === 'live');
  const p = promos.find((x) => x.id === Number(id));
  return p ? serializeSale(p, products, live, now) : null;
}

router.post('/sales', asyncRoute(async (req, res) => {
  await requireSalesTable();
  const v = await saleFromBody(req.body);
  const cols = Object.keys(v);
  const row = await db.get(
    `INSERT INTO promotions (${cols.join(', ')}) VALUES (${cols.map((c, i) => (c === 'scope' ? `$${i + 1}::jsonb` : `$${i + 1}`)).join(', ')}) RETURNING id`,
    cols.map((c) => v[c])
  );
  invalidatePromotions();
  await writeAudit({ actor: req.adminUser.full_name, action: `Created sale (${badgeFor(v.discount_type, v.discount_value)})`, target: v.name, module: 'Sales' });
  res.status(201).json({ data: await saleResponse(row.id) });
}));

router.put('/sales/:id', asyncRoute(async (req, res) => {
  await requireSalesTable();
  const existing = await db.get('SELECT * FROM promotions WHERE id = $1', [req.params.id]);
  if (!existing) throw new ApiError(404, 'Sale not found.');
  const v = await saleFromBody(req.body);
  const cols = Object.keys(v);
  await db.query(
    `UPDATE promotions SET ${cols.map((c, i) => `${c} = ${c === 'scope' ? `$${i + 1}::jsonb` : `$${i + 1}`}`).join(', ')}, updated_at = NOW() WHERE id = $${cols.length + 1}`,
    [...cols.map((c) => v[c]), existing.id]
  );
  invalidatePromotions();
  await writeAudit({ actor: req.adminUser.full_name, action: 'Updated sale', target: v.name, module: 'Sales' });
  res.json({ data: await saleResponse(existing.id) });
}));

// Pause / resume without touching anything else.
router.put('/sales/:id/active', asyncRoute(async (req, res) => {
  await requireSalesTable();
  const existing = await db.get('SELECT id, name FROM promotions WHERE id = $1', [req.params.id]);
  if (!existing) throw new ApiError(404, 'Sale not found.');
  const active = !!(req.body || {}).active;
  await db.query('UPDATE promotions SET active = $1, updated_at = NOW() WHERE id = $2', [active, existing.id]);
  invalidatePromotions();
  await writeAudit({ actor: req.adminUser.full_name, action: active ? 'Resumed sale' : 'Paused sale', target: existing.name, module: 'Sales' });
  res.json({ data: await saleResponse(existing.id) });
}));

router.delete('/sales/:id', asyncRoute(async (req, res) => {
  await requireSalesTable();
  const existing = await db.get('SELECT id, name FROM promotions WHERE id = $1', [req.params.id]);
  if (!existing) throw new ApiError(404, 'Sale not found.');
  await db.query('DELETE FROM promotions WHERE id = $1', [existing.id]);
  invalidatePromotions();
  await writeAudit({ actor: req.adminUser.full_name, action: 'Deleted sale', target: existing.name, module: 'Sales' });
  res.json({ data: { deleted: true } });
}));

// ── Product discounts, in bulk ────────────────────────────────────────────
// body: { skus: [...], discount: { type: ''|'percent'|'amount'|'none', value, label, startsAt, endsAt } }
// type '' removes the product's own discount (it follows sales again).
// All or nothing: one bad SKU/price and nothing is written.
router.put('/products', asyncRoute(async (req, res) => {
  const schema = await getOffersSchema();
  if (!schema.productColumns) throw new ApiError(409, 'Product discounts need a one-time database update first — run the SQL shown on this page.');
  const b = req.body || {};
  const skus = [...new Set((Array.isArray(b.skus) ? b.skus : []).map((s) => String(s).trim()).filter(Boolean))];
  if (!skus.length) throw new ApiError(400, 'Choose at least one product.');
  if (skus.length > 2000) throw new ApiError(400, 'Too many products in one go (2000 max).');
  const d = b.discount || {};
  const startsAt = d.startsAt ? parseOfferDate(d.startsAt) : null;
  const endsAt = d.endsAt ? parseOfferDate(d.endsAt, { endOfDay: true }) : null;
  if (startsAt === undefined || endsAt === undefined) throw new ApiError(400, "One of the dates isn't a valid date.");

  const rows = await db.all('SELECT id, sku, total_price FROM products WHERE UPPER(sku) = ANY($1)', [skus.map((s) => s.toUpperCase())]);
  const found = new Set(rows.map((r) => String(r.sku).toUpperCase()));
  const missing = skus.filter((s) => !found.has(s.toUpperCase()));
  if (missing.length) throw new ApiError(400, `These SKUs don't exist: ${missing.slice(0, 12).join(', ')}.`);

  const updates = [];
  const problems = [];
  for (const r of rows) {
    const f = { discount_type: d.type || null, discount_value: d.value, discount_label: d.label, discount_starts_at: startsAt, discount_ends_at: endsAt };
    const errs = normalizeOwnDiscount(f, Number(r.total_price) || null);
    if (errs.length) problems.push(`${r.sku}: ${errs.join(' ')}`);
    else updates.push({ id: r.id, f });
  }
  if (problems.length) throw new ApiError(400, problems.slice(0, 8).join(' ') + (problems.length > 8 ? ` (+${problems.length - 8} more)` : ''));

  await db.transaction(async (client) => {
    for (const u of updates) {
      await client.query(
        `UPDATE products SET discount_type = $1, discount_value = $2, discount_label = $3, discount_starts_at = $4, discount_ends_at = $5, updated_at = NOW() WHERE id = $6`,
        [u.f.discount_type, u.f.discount_value, u.f.discount_label, u.f.discount_starts_at, u.f.discount_ends_at, u.id]
      );
    }
  });
  const what = !d.type ? 'Removed product discount' : d.type === 'none' ? 'Excluded from sales' : `Set product discount (${badgeFor(d.type, Number(d.value))})`;
  await writeAudit({ actor: req.adminUser.full_name, action: what, target: rows.length === 1 ? rows[0].sku : `${rows.length} products`, module: 'Sales' });
  res.json({ data: { updated: updates.length } });
}));

module.exports = router;
