// Offers & discounts — the ONE place that decides what a product costs after
// discounts. Every public price (catalog, product page, related items,
// homepage feed, customer dashboard) and the admin/Excel views go through
// resolveOffer() + buildPublicOffer(), so a piece can never show one price on
// a card and another on its page.
//
// Two sources of discount:
//   1. The product's OWN discount (Admin > Products form / Excel columns):
//      products.discount_type = 'percent' | 'amount' | 'none' | NULL.
//      NULL   = no own discount, the product follows any running sale;
//      'none' = never discounted, excluded from every sale.
//      Optional label and start/end dates.
//   2. SALES (Admin > Sales & Discounts): a `promotions` row whose scope
//      (product types / categories / subcategories / SKUs / price range)
//      matches the product, while live (active, inside its dates).
//
// Precedence: the product's own discount wins while it is running. Otherwise
// the sale that saves the customer the most applies. Discounts never stack.
//
// The schema (5 product columns + the promotions table) is added by
// OFFERS_MIGRATION_SQL, run by the site owner in Supabase. Until then every
// function here degrades to "no offers anywhere", and the admin screens show
// the SQL to run.
const db = require('../db/postgres');

const OFFERS_MIGRATION_SQL = `-- ONCD offers & discounts: per-product discounts + sales.
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS discount_type text,
  ADD COLUMN IF NOT EXISTS discount_value numeric(12,2),
  ADD COLUMN IF NOT EXISTS discount_label text,
  ADD COLUMN IF NOT EXISTS discount_starts_at timestamptz,
  ADD COLUMN IF NOT EXISTS discount_ends_at timestamptz;

DO $$ BEGIN
  ALTER TABLE products ADD CONSTRAINT products_discount_type_check
    CHECK (discount_type IS NULL OR discount_type IN ('percent', 'amount', 'none'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS promotions (
  id             bigserial PRIMARY KEY,
  name           text NOT NULL,
  badge_label    text,
  discount_type  text NOT NULL CHECK (discount_type IN ('percent', 'amount')),
  discount_value numeric(12,2) NOT NULL CHECK (discount_value > 0),
  scope          jsonb NOT NULL DEFAULT '{}'::jsonb,
  starts_at      timestamptz,
  ends_at        timestamptz,
  active         boolean NOT NULL DEFAULT true,
  show_banner    boolean NOT NULL DEFAULT false,
  banner_text    text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS promotions_active_idx ON promotions (active, ends_at);
`;

const PRODUCT_OFFER_COLUMNS = ['discount_type', 'discount_value', 'discount_label', 'discount_starts_at', 'discount_ends_at'];
const OWN_DISCOUNT_TYPES = ['percent', 'amount', 'none'];
const SALE_DISCOUNT_TYPES = ['percent', 'amount'];
const LABEL_MAX = 40;
const MAX_PERCENT = 95;

// The business runs on Hong Kong time: a date typed without a time (admin
// form, Excel) means that day in HK — starts at 00:00, ends at 23:59:59.
const SITE_UTC_OFFSET_MIN = 8 * 60;
const SITE_TZ_LABEL = 'Hong Kong time';

// ── Schema detection ───────────────────────────────────────────────────────
// Resolved through the search path (to_regclass / ::regclass), not
// information_schema, so a session's TEMP shadow tables are honoured too.
let schemaCache = null;
let schemaCheckedAt = 0;
const SCHEMA_RECHECK_MS = 60 * 1000;

async function getOffersSchema() {
  if (schemaCache && schemaCache.ready) return schemaCache;
  if (schemaCache && Date.now() - schemaCheckedAt < SCHEMA_RECHECK_MS) return schemaCache;
  const row = await db.get(
    `SELECT (SELECT COUNT(*) FROM pg_attribute
              WHERE attrelid = to_regclass('products') AND attname = ANY($1) AND NOT attisdropped) AS cols,
            to_regclass('promotions') IS NOT NULL AS promos`,
    [PRODUCT_OFFER_COLUMNS]
  );
  const productColumns = Number(row.cols) === PRODUCT_OFFER_COLUMNS.length;
  const promotions = !!row.promos;
  schemaCache = { productColumns, promotions, ready: productColumns && promotions };
  schemaCheckedAt = Date.now();
  return schemaCache;
}
function resetOffersSchemaCache() { schemaCache = null; schemaCheckedAt = 0; }

// ── Small helpers ──────────────────────────────────────────────────────────
const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
const toDate = (v) => {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};
const iso = (v) => { const d = toDate(v); return d ? d.toISOString() : null; };
const round2 = (n) => Math.round(n * 100) / 100;
const fmtNumber = (n) => Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 });

function inWindow(startsAt, endsAt, now) {
  const s = toDate(startsAt);
  const e = toDate(endsAt);
  if (s && now < s) return false;
  if (e && now >= e) return false;
  return true;
}

// 'live' | 'scheduled' | 'ended' (dates only — pausing is separate).
function windowState(startsAt, endsAt, now = new Date()) {
  const s = toDate(startsAt);
  const e = toDate(endsAt);
  if (e && now >= e) return 'ended';
  if (s && now < s) return 'scheduled';
  return 'live';
}

function badgeFor(type, value) {
  return type === 'percent' ? `${fmtNumber(value)}% OFF` : `$${fmtNumber(value)} OFF`;
}

// The discounted price, or null when the offer can't apply to this price
// (no price, or a fixed amount that would take it to zero or below).
// Percentage results round to whole dollars (retail convention); a fixed
// amount off keeps the cents exactly.
function discountedPrice(price, offer) {
  const p = num(price);
  if (!(p > 0) || !offer) return null;
  const v = Number(offer.value);
  const s = offer.type === 'percent' ? Math.round(p * (1 - v / 100)) : round2(p - v);
  if (!(s > 0) || s >= p) return null;
  return s;
}

// ── Sales (promotions) ─────────────────────────────────────────────────────
function normalizeScope(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  const arr = (v) => (Array.isArray(v) ? v : []);
  const mode = ['all', 'filter', 'skus'].includes(s.mode) ? s.mode : 'all';
  const skus = [...new Set(arr(s.skus).map((x) => String(x).trim()).filter(Boolean))];
  const excludeSkus = [...new Set(arr(s.excludeSkus).map((x) => String(x).trim()).filter(Boolean))];
  return {
    mode,
    types: arr(s.types).filter((t) => ['diamond', 'jewelry', 'gemstone'].includes(t)),
    categoryIds: arr(s.categoryIds).map(Number).filter((n) => Number.isInteger(n) && n > 0),
    subcategoryIds: arr(s.subcategoryIds).map(Number).filter((n) => Number.isInteger(n) && n > 0),
    skus,
    excludeSkus,
    minPrice: num(s.minPrice) > 0 ? num(s.minPrice) : null,
    maxPrice: num(s.maxPrice) > 0 ? num(s.maxPrice) : null,
  };
}

function normalizePromotion(r) {
  const scope = normalizeScope(r.scope);
  return {
    id: Number(r.id),
    name: r.name,
    badgeLabel: r.badge_label || '',
    type: r.discount_type,
    value: Number(r.discount_value),
    scope,
    skuSet: new Set(scope.skus.map((s) => s.toUpperCase())),
    excludeSet: new Set(scope.excludeSkus.map((s) => s.toUpperCase())),
    startsAt: toDate(r.starts_at),
    endsAt: toDate(r.ends_at),
    active: !!r.active,
    showBanner: !!r.show_banner,
    bannerText: r.banner_text || '',
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function promotionMatches(promo, row) {
  const s = promo.scope;
  const sku = String(row.sku || '').toUpperCase();
  if (promo.excludeSet.has(sku)) return false;
  if (s.mode === 'skus') return promo.skuSet.has(sku);
  if (s.mode === 'all') return true;
  if (s.types.length && !s.types.includes(row.type)) return false;
  if (s.categoryIds.length && !s.categoryIds.includes(Number(row.category_id))) return false;
  if (s.subcategoryIds.length && !s.subcategoryIds.includes(Number(row.subcategory_id))) return false;
  if (s.minPrice != null || s.maxPrice != null) {
    const p = num(row.total_price);
    if (!(p > 0)) return false;
    if (s.minPrice != null && p < s.minPrice) return false;
    if (s.maxPrice != null && p > s.maxPrice) return false;
  }
  return true;
}

// Live sales are cached briefly per process: every catalog request needs
// them, and the list is tiny. Admin edits clear the cache immediately; other
// processes (live site vs. a dev server) pick changes up within the TTL.
const PROMO_TTL_MS = 30 * 1000;
let promoCache = { at: 0, list: [] };

async function loadLivePromotions() {
  if (Date.now() - promoCache.at < PROMO_TTL_MS) return promoCache.list;
  const schema = await getOffersSchema();
  let list = [];
  if (schema.promotions) {
    try {
      const rows = await db.all('SELECT * FROM promotions WHERE active = TRUE AND (ends_at IS NULL OR ends_at > NOW())');
      list = rows.map(normalizePromotion);
    } catch (err) {
      if (!(err && err.code === '42P01')) throw err;
      resetOffersSchemaCache();
    }
  }
  promoCache = { at: Date.now(), list };
  return list;
}
function invalidatePromotions() { promoCache = { at: 0, list: [] }; }

// ── Resolution ─────────────────────────────────────────────────────────────
function offerIsUsable(offer, basePrice) {
  const v = Number(offer.value);
  if (!(v > 0)) return false;
  if (offer.type === 'percent') return v < 100;
  if (offer.type === 'amount') return basePrice > 0 && v < basePrice;
  return false;
}

// The offer that applies to a raw products row right now, or null.
// `promos` = loadLivePromotions(). Works on the RAW row (before price
// masking), so the decision never depends on who is looking.
function resolveOffer(row, promos, now = new Date()) {
  if (!row) return null;
  const own = row.discount_type;
  if (own === 'none') return null;
  const base = num(row.total_price);
  const ppc = num(row.price_per_carat);
  if (!(base > 0) && !(ppc > 0)) return null; // nothing to discount

  if ((own === 'percent' || own === 'amount') && inWindow(row.discount_starts_at, row.discount_ends_at, now)) {
    const offer = {
      source: 'product', promotionId: null, type: own, value: Number(row.discount_value),
      label: row.discount_label || null, startsAt: toDate(row.discount_starts_at), endsAt: toDate(row.discount_ends_at),
    };
    if (offerIsUsable(offer, base)) return offer;
  }

  let best = null;
  let bestSaving = -1;
  for (const p of promos || []) {
    if (!p.active || !inWindow(p.startsAt, p.endsAt, now) || !promotionMatches(p, row)) continue;
    const offer = {
      source: 'sale', promotionId: p.id, type: p.type, value: p.value,
      label: p.badgeLabel || p.name, startsAt: p.startsAt, endsAt: p.endsAt,
    };
    if (!offerIsUsable(offer, base)) continue;
    const sale = discountedPrice(base, offer);
    const saving = base > 0 ? (sale == null ? -1 : base - sale) : (offer.type === 'percent' ? offer.value : -1);
    if (saving < 0) continue;
    // Bigger saving wins; on a tie, the one ending sooner (more urgent).
    if (saving > bestSaving || (saving === bestSaving && best && offer.endsAt && (!best.endsAt || offer.endsAt < best.endsAt))) {
      best = offer;
      bestSaving = saving;
    }
  }
  return best;
}

// The public `offer` object for a product response. Prices inside it follow
// the SAME visibility as the product's own price: when the viewer can't see
// the price they get the badge (the hook) but never the numbers.
function buildPublicOffer(offer, row, priceVisible) {
  if (!offer) return null;
  const base = num(row.total_price);
  const ppc = num(row.price_per_carat);
  const salePrice = discountedPrice(base, offer);
  let salePricePerCarat = null;
  if (ppc > 0) {
    if (offer.type === 'percent') salePricePerCarat = Math.round(ppc * (1 - offer.value / 100));
    else if (salePrice != null && base > 0) salePricePerCarat = Math.round(ppc * (salePrice / base));
  }
  return {
    source: offer.source,
    saleId: offer.promotionId || null,
    type: offer.type,
    value: offer.value,
    badge: badgeFor(offer.type, offer.value),
    label: offer.label || null,
    startsAt: iso(offer.startsAt),
    endsAt: iso(offer.endsAt),
    salePrice: priceVisible ? salePrice : null,
    salePricePerCarat: priceVisible ? salePricePerCarat : null,
    savings: priceVisible && salePrice != null ? round2(base - salePrice) : null,
  };
}

// Sale price for one jewelry metal variation under the product's offer.
function variantSalePrice(price, offer) {
  if (!offer) return null;
  if (offer.type === 'amount' && !(Number(price) > Number(offer.value))) return null;
  return discountedPrice(price, offer);
}

// ── Banners (catalog pages) ────────────────────────────────────────────────
// Live sales flagged "show banner" that actually discount at least one piece
// in this listing. `countsBySale` = Map(saleId -> pieces on that sale here).
function bannersFor(promos, countsBySale, now = new Date()) {
  return (promos || [])
    .filter((p) => p.active && p.showBanner && inWindow(p.startsAt, p.endsAt, now) && countsBySale.get(p.id))
    .map((p) => ({
      id: p.id,
      name: p.name,
      badge: badgeFor(p.type, p.value),
      label: p.badgeLabel || p.name,
      text: p.bannerText || '',
      endsAt: iso(p.endsAt),
      count: countsBySale.get(p.id),
    }));
}

// ── Input parsing / validation (admin form, Excel, Sales page) ─────────────
// A wall-clock time in Hong Kong -> Date. parts = [y, m, d, hh, mm, ss].
function siteTime(y, m, d, hh = 0, mm = 0, ss = 0) {
  const utc = Date.UTC(y, m - 1, d, hh, mm, ss) - SITE_UTC_OFFSET_MIN * 60 * 1000;
  const date = new Date(utc);
  // Reject impossible dates like 2026-02-31 (Date.UTC would roll them over).
  const check = new Date(utc + SITE_UTC_OFFSET_MIN * 60 * 1000);
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) return null;
  return date;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

// Accepts: ISO timestamps (with zone), "2026-12-31", "2026-12-31 18:00",
// "2026/12/31", "31 Dec 2026", "Dec 31, 2026", and Excel date serials.
// A date with no time = start of that day (or end of it when endOfDay).
// Returns Date, null (blank) or undefined (unreadable).
function parseOfferDate(v, { endOfDay = false } = {}) {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? undefined : v;
  if (typeof v === 'number') {
    if (!Number.isFinite(v) || v < 20000 || v > 80000) return undefined; // Excel serial ~1954..2119
    const days = Math.floor(v);
    const frac = v - days;
    const base = new Date(Date.UTC(1899, 11, 30) + days * 86400000);
    const y = base.getUTCFullYear(); const m = base.getUTCMonth() + 1; const d = base.getUTCDate();
    if (frac < 1e-6) return endOfDay ? siteTime(y, m, d, 23, 59, 59) : siteTime(y, m, d);
    const secs = Math.round(frac * 86400);
    return siteTime(y, m, d, Math.floor(secs / 3600), Math.floor((secs % 3600) / 60), secs % 60);
  }
  const s = String(v).trim();
  if (!s) return null;
  // Full ISO with an explicit zone (what the admin pages send).
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/.test(s)) {
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? undefined : d;
  }
  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (m) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (m[4] !== undefined) return siteTime(y, mo, d, Number(m[4]), Number(m[5]), Number(m[6] || 0)) || undefined;
    return (endOfDay ? siteTime(y, mo, d, 23, 59, 59) : siteTime(y, mo, d)) || undefined;
  }
  m = s.match(/^(\d{1,2})[ -]([A-Za-z]{3,9})[ ,-]*(\d{4})$/) || null;
  let y; let mo; let d;
  if (m) { d = Number(m[1]); mo = MONTHS.indexOf(m[2].slice(0, 3).toLowerCase()) + 1; y = Number(m[3]); }
  else {
    m = s.match(/^([A-Za-z]{3,9})[ -](\d{1,2}),?[ -](\d{4})$/);
    if (m) { mo = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase()) + 1; d = Number(m[2]); y = Number(m[3]); }
  }
  if (m && mo > 0) return (endOfDay ? siteTime(y, mo, d, 23, 59, 59) : siteTime(y, mo, d)) || undefined;
  return undefined;
}

// Date -> "2026-12-31" (or "2026-12-31 18:30") in Hong Kong time. An end at
// 23:59:59 prints as the bare date, so it reads back as the same instant.
// `endOfDay` says which bare-date reading applies when the text goes back
// in (start of day for a start date, end of day for an end date).
function formatSiteDate(v, { endOfDay = false } = {}) {
  const d = toDate(v);
  if (!d) return '';
  const t = new Date(d.getTime() + SITE_UTC_OFFSET_MIN * 60 * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  const day = `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
  const hh = t.getUTCHours(); const mm = t.getUTCMinutes(); const ss = t.getUTCSeconds();
  if (!endOfDay && hh === 0 && mm === 0 && ss === 0) return day;
  if (endOfDay && hh === 23 && mm === 59 && ss === 59) return day;
  if (ss !== 0) return `${day} ${pad(hh)}:${pad(mm)}:${pad(ss)}`;
  return `${day} ${pad(hh)}:${pad(mm)}`;
}

// Checks a product's own-discount fields (snake_case, already parsed) and
// tidies them: no own discount -> everything cleared; 'none' -> no value.
// Returns a list of problems ([] = fine). `basePrice` = the product's total
// price after this save (null if unknown/none).
function normalizeOwnDiscount(f, basePrice) {
  const errors = [];
  const type = f.discount_type === '' || f.discount_type === undefined ? null : f.discount_type;
  f.discount_type = type;
  if (type !== null && !OWN_DISCOUNT_TYPES.includes(type)) {
    errors.push('Discount type must be % off, $ off or "No discount".');
    return errors;
  }
  if (type === null || type === 'none') {
    f.discount_value = null; f.discount_label = null; f.discount_starts_at = null; f.discount_ends_at = null;
    return errors;
  }
  const v = num(f.discount_value);
  if (v === null || Number.isNaN(v) || !(v > 0)) errors.push('Enter the discount amount (a number above 0).');
  else if (type === 'percent' && v > MAX_PERCENT) errors.push(`A percentage discount can be at most ${MAX_PERCENT}%.`);
  else if (type === 'amount' && basePrice > 0 && v >= basePrice) errors.push(`The $ discount ($${fmtNumber(v)}) must be less than the total price ($${fmtNumber(basePrice)}).`);
  else if (type === 'amount' && !(basePrice > 0)) errors.push('A $ discount needs a Total Price to take it off.');
  f.discount_value = v === null || Number.isNaN(v) ? null : round2(v);
  const label = f.discount_label == null ? '' : String(f.discount_label).trim();
  if (label.length > LABEL_MAX) errors.push(`The offer label can be at most ${LABEL_MAX} characters.`);
  f.discount_label = label || null;
  const s = toDate(f.discount_starts_at);
  const e = toDate(f.discount_ends_at);
  if (s && e && e <= s) errors.push('The offer must end after it starts.');
  f.discount_starts_at = s;
  f.discount_ends_at = e;
  return errors;
}

module.exports = {
  OFFERS_MIGRATION_SQL,
  PRODUCT_OFFER_COLUMNS,
  OWN_DISCOUNT_TYPES,
  SALE_DISCOUNT_TYPES,
  LABEL_MAX,
  MAX_PERCENT,
  SITE_TZ_LABEL,
  getOffersSchema,
  resetOffersSchemaCache,
  loadLivePromotions,
  invalidatePromotions,
  normalizePromotion,
  normalizeScope,
  promotionMatches,
  resolveOffer,
  buildPublicOffer,
  variantSalePrice,
  discountedPrice,
  badgeFor,
  bannersFor,
  windowState,
  parseOfferDate,
  formatSiteDate,
  normalizeOwnDiscount,
  toDate,
  iso,
};
