const express = require('express');
const db = require('../db/postgres');
const { asyncRoute, ApiError } = require('../middleware/errorHandler');
const { toPublicMediaUrl } = require('../lib/mediaUrl');
const { PUBLIC_FROM, PUBLIC_WHERE, loadPriceContext, serializePublicRows } = require('../lib/publicProducts');
const { getMergedSections } = require('../lib/homepageSections');

const router = express.Router();

const PRODUCT_TYPES = ['diamond', 'jewelry', 'gemstone'];
// Home grids are at most 5 columns wide (see Home.dc.html's column logic),
// so `rows` settings translate to at most rows * 5 products.
const MAX_COLUMNS = 5;
const HAS_MEDIA = 'EXISTS (SELECT 1 FROM product_media m WHERE m.product_id = p.id)';
const NEWSLETTER_SUBJECT = 'Newsletter subscription';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Cards only ever show the first image (and first video on hover), so the
// homepage doesn't ship every photo of every product.
function trimMedia(product) {
  const media = product.media || [];
  const image = media.find((m) => m.kind === 'image');
  const video = media.find((m) => m.kind === 'video');
  return { ...product, media: [image, video].filter(Boolean) };
}

// Serializes the rows of several lists in one enrichment pass (3 batch
// queries total, not 3 per list), returning a sku -> product dictionary.
async function serializeAll(req, rowLists, priceContext) {
  const byId = new Map();
  for (const rows of rowLists) for (const r of rows) byId.set(String(r.id), r);
  const products = await serializePublicRows(req, [...byId.values()], priceContext);
  const bySku = {};
  for (const p of products) bySku[p.sku] = trimMedia(p);
  return bySku;
}

router.get('/', asyncRoute(async (req, res) => {
  // Independent reads, run together — each is a full network round trip to
  // the database, so running them one after another multiplied page latency.
  const [slides, { sections: sectionList }, blockRows, collections, whyUs] = await Promise.all([
    db.all(
      `SELECT id, title, kicker, sub, cta, href, image_url AS "imageUrl", sort_order AS "sortOrder"
       FROM homepage_slides WHERE enabled = true ORDER BY sort_order`
    ),
    getMergedSections(),
    db.all(`SELECT key, kicker, title, body, cta, href, image_url AS "imageUrl" FROM content_blocks WHERE page = 'home' ORDER BY sort_order`),
    db.all(`SELECT key, title, description, href, image_url AS "imageUrl" FROM homepage_collections ORDER BY sort_order`),
    db.all(`SELECT title, description FROM why_us_bullets WHERE page = 'home' AND enabled = true ORDER BY sort_order`),
  ]);
  // Legacy key -> enabled map, kept alongside the richer sectionList.
  const sections = {};
  for (const s of sectionList) sections[s.key] = s.enabled;
  const blocks = {};
  for (const r of blockRows) blocks[r.key] = { ...r, imageUrl: toPublicMediaUrl(r.imageUrl) };

  res.json({
    data: {
      slides: slides.map((s) => ({ ...s, id: Number(s.id), imageUrl: toPublicMediaUrl(s.imageUrl) })),
      sections,
      sectionList,
      blocks,
      collections: collections.map((c) => ({ ...c, imageUrl: toPublicMediaUrl(c.imageUrl) })),
      whyUs,
    },
  });
}));

// Every product list the homepage needs, built server-side from each
// section's admin settings — a few KB instead of downloading the whole
// catalog to the browser. Disabled sections are skipped entirely.
router.get('/feed', asyncRoute(async (req, res) => {
  const { sections } = await getMergedSections();
  const cfg = {};
  for (const s of sections) cfg[s.key] = s;
  const on = (key) => cfg[key] && cfg[key].enabled;
  // Only needed at serialization time, so it loads alongside the lists
  // below instead of adding its own round trip in front of them.
  const priceContextP = loadPriceContext(req);

  // Collection counts, shape-tile counts and "new since your last visit"
  // all come from this one grouped query.
  const sinceDate = req.query.since ? new Date(String(req.query.since)) : null;
  const hasSince = !!sinceDate && !Number.isNaN(sinceDate.getTime());
  const countsP = db.all(
    `SELECT p.type, p.shape, COUNT(*)::int AS n, COUNT(*) FILTER (WHERE p.created_at > $1)::int AS n_since
     ${PUBLIC_FROM} WHERE ${PUBLIC_WHERE} GROUP BY p.type, p.shape`,
    [hasSince ? sinceDate.toISOString() : '9999-12-31T00:00:00Z']
  );

  // All product lists in ONE query (UNION ALL of per-list subqueries,
  // tagged with list_name/list_pos): each extra parallel query can force the
  // pool to open a fresh database connection, which costs far more than the
  // queries themselves.
  const params = [];
  const P = (value) => { params.push(value); return '$' + params.length; };
  const media = (photosOnly) => (photosOnly ? ` AND ${HAS_MEDIA}` : '');
  const ctes = [];
  const parts = [];
  if (on('featured')) {
    const s = cfg.featured.settings;
    // Starring a product bumps updated_at, so the latest pick leads.
    parts.push(`(SELECT p.*, 'featured'::text AS list_name,
        ROW_NUMBER() OVER (ORDER BY p.updated_at DESC NULLS LAST, p.created_at DESC, p.id DESC)::int AS list_pos
      ${PUBLIC_FROM} WHERE ${PUBLIC_WHERE} AND p.featured = TRUE${s.type !== 'all' ? ` AND p.type = ${P(s.type)}` : ''}${media(s.photosOnly)}
      ORDER BY list_pos LIMIT ${P(s.limit)})`);
  }
  if (on('newArrivals')) {
    const s = cfg.newArrivals.settings;
    parts.push(`(SELECT * FROM (SELECT p.*, 'arrivals'::text AS list_name,
        ROW_NUMBER() OVER (PARTITION BY p.type ORDER BY p.created_at DESC, p.id DESC)::int AS list_pos
      ${PUBLIC_FROM} WHERE ${PUBLIC_WHERE}${media(s.photosOnly)}) per_type WHERE per_type.list_pos <= ${P(s.rows * MAX_COLUMNS)})`);
  }
  // Ranked by distinct inquiries inside the chosen window, then all-time
  // inquiries — only products that were genuinely requested at least once
  // can ever appear here (inner join on the request counts).
  if (on('favorites')) {
    const s = cfg.favorites.settings;
    ctes.push(`all_time AS (
        SELECT ii.product_id, COUNT(DISTINCT ii.inquiry_id)::int AS n_all
        FROM inquiry_items ii WHERE ii.product_id IS NOT NULL GROUP BY ii.product_id
      ), in_window AS (
        SELECT ii.product_id, COUNT(DISTINCT ii.inquiry_id)::int AS n_window
        FROM inquiry_items ii JOIN inquiries i ON i.id = ii.inquiry_id
        WHERE ii.product_id IS NOT NULL AND i.created_at >= NOW() - make_interval(days => ${P(s.days)}::int)
        GROUP BY ii.product_id
      )`);
    parts.push(`(SELECT p.*, 'requested'::text AS list_name,
        ROW_NUMBER() OVER (ORDER BY COALESCE(w.n_window, 0) DESC, a.n_all DESC, p.created_at DESC, p.id DESC)::int AS list_pos
      FROM all_time a JOIN products p ON p.id = a.product_id JOIN product_types pt ON pt.key = p.type
      LEFT JOIN in_window w ON w.product_id = p.id
      WHERE ${PUBLIC_WHERE}${s.type !== 'all' ? ` AND p.type = ${P(s.type)}` : ''}${media(s.photosOnly)}
      ORDER BY list_pos LIMIT ${P(s.limit)})`);
  }
  if (on('gemHighlights')) {
    const s = cfg.gemHighlights.settings;
    parts.push(`(SELECT p.*, 'gems'::text AS list_name,
        ROW_NUMBER() OVER (ORDER BY p.created_at DESC, p.id DESC)::int AS list_pos
      ${PUBLIC_FROM} WHERE ${PUBLIC_WHERE} AND p.type = 'gemstone'${media(s.photosOnly)}
      ORDER BY list_pos LIMIT ${P(s.rows * MAX_COLUMNS)})`);
  }
  // One representative in-stock diamond (with a photo) per shape on the
  // admin-managed shape list — the same list the Diamonds filter uses, so
  // every tile's ?shape= link lands on a value that filter actually matches.
  // list_pos carries the shape's own sort order.
  if (on('shapePicker')) {
    parts.push(`(SELECT DISTINCT ON (p.shape) p.*, 'shapes'::text AS list_name, a.sort_order::int AS list_pos
      ${PUBLIC_FROM} JOIN product_attributes a ON a.attribute_type = 'shape' AND a.enabled = TRUE AND a.name = p.shape
      WHERE ${PUBLIC_WHERE} AND p.type = 'diamond' AND ${HAS_MEDIA}
      ORDER BY p.shape, p.created_at DESC, p.id DESC)`);
  }
  const listsP = parts.length
    ? db.all(`${ctes.length ? 'WITH ' + ctes.join(', ') + ' ' : ''}${parts.join(' UNION ALL ')}`, params)
    : Promise.resolve([]);

  const [countRows, listRows, priceContext] = await Promise.all([countsP, listsP, priceContextP]);
  const list = (name) => listRows.filter((r) => r.list_name === name);
  const byPos = (a, b) => a.list_pos - b.list_pos;
  const featuredRows = list('featured').sort(byPos);
  const arrivalRows = list('arrivals').sort((a, b) => (new Date(b.created_at) - new Date(a.created_at)) || (Number(b.id) - Number(a.id)));
  const requestedRows = list('requested').sort(byPos);
  const gemRows = list('gems').sort(byPos);
  const shapeReps = list('shapes').sort((a, b) => byPos(a, b) || a.shape.localeCompare(b.shape));

  const products = await serializeAll(req, [featuredRows, arrivalRows, requestedRows, gemRows, shapeReps], priceContext);

  const byType = { diamond: 0, jewelry: 0, gemstone: 0 };
  const diamondShapeCount = new Map();
  const newSince = hasSince ? { total: 0, byType: { diamond: 0, jewelry: 0, gemstone: 0 } } : null;
  for (const r of countRows) {
    byType[r.type] = (byType[r.type] || 0) + r.n;
    if (r.type === 'diamond' && r.shape) diamondShapeCount.set(r.shape, r.n);
    if (newSince) { newSince.byType[r.type] = (newSince.byType[r.type] || 0) + r.n_since; newSince.total += r.n_since; }
  }

  const arrivalsPerType = on('newArrivals') ? cfg.newArrivals.settings.rows * MAX_COLUMNS : 0;
  const newArrivals = { all: arrivalRows.slice(0, arrivalsPerType).map((r) => r.sku) };
  for (const t of PRODUCT_TYPES) newArrivals[t] = arrivalRows.filter((r) => r.type === t).map((r) => r.sku);

  const shapeTiles = shapeReps.map((r) => ({ name: r.shape, count: diamondShapeCount.get(r.shape) || 0, sku: r.sku }));

  res.json({
    data: {
      products,
      featured: featuredRows.map((r) => r.sku),
      newArrivals,
      mostRequested: requestedRows.map((r) => r.sku),
      gemHighlights: gemRows.map((r) => r.sku),
      shapeTiles,
      counts: { byType },
      newSince,
    },
  });
}));

// --- Personal modules: Recently Viewed + Recommended for You ---

function skuList(value, max) {
  const raw = Array.isArray(value) ? value : (value ? [value] : []);
  return [...new Set(raw.map((v) => String(v).trim().slice(0, 80)).filter(Boolean))].slice(0, max);
}

const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };
const same = (a, b) => !!a && !!b && String(a).toLowerCase() === String(b).toLowerCase();

// How alike a candidate is to one seed product. Shape/category/stone are
// what buyers actually browse by, so they dominate; finer attributes only
// break ties. Zero means "nothing in common beyond the product type".
function similarity(seed, c) {
  if (seed.type !== c.type) return 0;
  let score = 0;
  if (c.type === 'diamond') {
    if (same(seed.shape, c.shape)) score += 3;
    if (same(seed.color, c.color)) score += 1;
    const sw = num(seed.weight_carat); const cw = num(c.weight_carat);
    if (sw && cw && Math.abs(sw - cw) / sw <= 0.25) score += 1;
  } else if (c.type === 'jewelry') {
    if (seed.subcategory_id && same(seed.subcategory_id, c.subcategory_id)) score += 3;
    if (seed.category_id && same(seed.category_id, c.category_id)) score += 2;
    if (same(seed.metal, c.metal)) score += 1;
    if (same(seed.stone_name, c.stone_name)) score += 1;
  } else {
    if (same(seed.stone_name, c.stone_name)) score += 3;
    if (same(seed.color, c.color)) score += 1;
    if (same(seed.shape, c.shape)) score += 1;
  }
  return score;
}

// viewed / cart / saved are SKU lists the browser already holds (recently
// viewed lives in localStorage, the cart too, saved items come from the
// customer's own saved-items call) — nothing here is stored server-side.
router.get('/personal', asyncRoute(async (req, res) => {
  const viewed = skuList(req.query.viewed, 12);
  const cart = skuList(req.query.cart, 12);
  const saved = skuList(req.query.saved, 12);
  const seedSkus = [...new Set([...viewed, ...cart, ...saved])];
  if (!seedSkus.length) return res.json({ data: { products: {}, recentlyViewed: [], recommended: [] } });

  const [{ sections }, seedRows, priceContext] = await Promise.all([
    getMergedSections(),
    db.all(`SELECT p.* ${PUBLIC_FROM} WHERE ${PUBLIC_WHERE} AND p.sku = ANY($1)`, [seedSkus]),
    loadPriceContext(req),
  ]);
  const cfg = {};
  for (const s of sections) cfg[s.key] = s;
  const seedBySku = new Map(seedRows.map((r) => [r.sku, r]));

  let recommendedRows = [];
  const recommended = [];
  if (cfg.recommended && cfg.recommended.enabled && seedRows.length) {
    const limit = cfg.recommended.settings.rows * MAX_COLUMNS;
    // Most recently viewed counts most; cart and saved items are strong
    // signals regardless of when they were added.
    const seeds = seedSkus.filter((s) => seedBySku.has(s)).map((sku) => {
      const vi = viewed.indexOf(sku);
      const weight = cart.includes(sku) || saved.includes(sku) ? 1 : Math.pow(0.85, Math.max(0, vi));
      return { row: seedBySku.get(sku), weight };
    });
    const types = [...new Set(seeds.map((s) => s.row.type))];
    // Full rows up front (a few hundred at most) so the picks below don't
    // need a second round trip to load what they'll display.
    const candidates = await db.all(
      `SELECT p.* ${PUBLIC_FROM} WHERE ${PUBLIC_WHERE} AND p.type = ANY($1) AND NOT (p.sku = ANY($2)) AND ${HAS_MEDIA}`,
      [types, seedSkus]
    );
    const scored = candidates.map((c) => {
      let best = 0; let basedOn = null;
      for (const s of seeds) {
        const score = similarity(s.row, c) * s.weight;
        if (score > best) { best = score; basedOn = s.row.sku; }
      }
      return { c, score: best, basedOn };
    });
    // Each candidate belongs to the seed it most resembles; seeds then take
    // turns (most recent first) so one heavily-matched item — jewelry
    // categories score higher than diamond shapes — can't crowd out the rest.
    const groups = new Map();
    for (const x of scored) {
      if (x.score < 2) continue;
      if (!groups.has(x.basedOn)) groups.set(x.basedOn, []);
      groups.get(x.basedOn).push(x);
    }
    for (const g of groups.values()) g.sort((a, b) => (b.score - a.score) || (new Date(b.c.created_at) - new Date(a.c.created_at)));
    const seedOrder = seeds.map((s) => s.row.sku).filter((sku) => groups.has(sku));
    const similar = [];
    for (let round = 0; similar.length < limit; round++) {
      const before = similar.length;
      for (const sku of seedOrder) {
        const pick = groups.get(sku)[round];
        if (pick && similar.length < limit) similar.push(pick);
      }
      if (similar.length === before) break;
    }
    // Not enough close matches: top up with the newest pieces of the same
    // product types, labeled as such rather than passed off as "similar".
    const picked = new Set(similar.map((x) => x.c.sku));
    const topUp = scored.filter((x) => !picked.has(x.c.sku))
      .sort((a, b) => new Date(b.c.created_at) - new Date(a.c.created_at))
      .slice(0, Math.max(0, limit - similar.length));
    for (const x of similar) recommended.push({ sku: x.c.sku, basedOn: x.basedOn, reason: 'similar' });
    for (const x of topUp) recommended.push({ sku: x.c.sku, basedOn: null, reason: 'new' });
    recommendedRows = [...similar, ...topUp].map((x) => x.c);
  }

  const products = await serializeAll(req, [seedRows, recommendedRows], priceContext);
  const recentLimit = cfg.recentlyViewed ? cfg.recentlyViewed.settings.limit : 10;
  res.json({
    data: {
      products,
      recentlyViewed: viewed.filter((sku) => products[sku]).slice(0, recentLimit),
      recommended: recommended.filter((r) => products[r.sku]),
    },
  });
}));

// --- Newsletter signup ---
// Lands in the existing Contact Messages inbox (no extra table needed);
// a repeat signup for the same address is accepted but not duplicated.
const signupHits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const recent = (signupHits.get(ip) || []).filter((t) => now - t < 60 * 60 * 1000);
  recent.push(now);
  signupHits.set(ip, recent);
  if (signupHits.size > 5000) signupHits.clear();
  return recent.length > 5;
}

router.post('/newsletter', asyncRoute(async (req, res) => {
  const email = String((req.body || {}).email || '').trim().toLowerCase().slice(0, 254);
  if (!EMAIL_RE.test(email)) throw new ApiError(400, 'Please enter a valid email address.');
  // app.js doesn't set 'trust proxy', so behind a hosting proxy req.ip can
  // be the proxy itself for every visitor — keying on it would rate-limit
  // everyone together. The forwarded client address avoids that; it can be
  // spoofed, but the worst case is the same as the unlimited contact form.
  const clientIp = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip;
  if (rateLimited(clientIp)) throw new ApiError(429, 'Too many signups from this connection. Please try again later.');

  const existing = await db.get(
    'SELECT id FROM contact_messages WHERE subject = $1 AND lower(email) = $2 LIMIT 1',
    [NEWSLETTER_SUBJECT, email]
  );
  if (!existing) {
    const customerId = req.session && req.session.customerId ? req.session.customerId : null;
    const customer = customerId ? await db.get('SELECT full_name FROM customers WHERE id = $1', [customerId]) : null;
    await db.query(
      `INSERT INTO contact_messages (customer_id, full_name, email, phone, subject, message, status)
       VALUES ($1, $2, $3, '', $4, $5, 'new')`,
      [customerId, (customer && customer.full_name) || 'Newsletter subscriber', email, NEWSLETTER_SUBJECT,
        'Subscribed to the newsletter from the homepage signup form.']
    );
  }
  res.status(existing ? 200 : 201).json({ data: { subscribed: true, alreadySubscribed: !!existing } });
}));

module.exports = router;
