// STEP 17B — Read-only behavioral parity + query-count + performance test
// for the batch-optimized server/routes/productsPostgres.js. Makes ZERO
// database writes (every query in this file, including the "oracle"
// computation, is a SELECT). No production row is created, updated, or
// deleted.
//
// Parity strategy: this script recomputes the expected /api/products and
// /api/products/:sku output using the ORIGINAL, pre-optimization per-row
// technique (one query per category/subcategory/media lookup, exactly as
// the old productsPostgres.js code did — reproduced here only as a
// read-only test oracle, never reintroduced into application code), reusing
// the real, unchanged server/lib/priceVisibility.js and
// server/lib/serializeProduct.js modules directly. It then compares that
// oracle, field-for-field, against the ACTUAL live HTTP response from the
// real (now-batched) route mounted in an isolated Express app. Byte-for-byte
// equality between the two proves the optimization changed nothing about
// the response contract.
//
// Query-count strategy: db.get/db.all on the shared server/db/postgres.js
// singleton are wrapped with counting logic AFTER the oracle has already
// been computed (using captured, unwrapped references) and BEFORE
// server/routes/productsPostgres.js is required — the route accesses
// db.get(...)/db.all(...) as live property lookups each call (not a
// destructured copy), so this is transparent and required no source edits.
// No instrumentation is left in any application file.

const express = require('express');
require('dotenv').config();

const db = require('./server/db/postgres');
const { applyPriceVisibility } = require('./server/lib/priceVisibility');
const { serializeProduct } = require('./server/lib/serializeProduct');

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail: detail || '' });
  console.log(`${ok ? 'PASS' : 'FAIL'} - ${name}${detail ? '  (' + detail + ')' : ''}`);
}
function assert(condition, message) {
  if (!condition) throw new Error(message);
}
function sameJson(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ---------------------------------------------------------------------------
// Oracle: reproduces the ORIGINAL per-row lookup technique, read-only, using
// UNWRAPPED db functions captured before any instrumentation is installed.
// ---------------------------------------------------------------------------
const dbGetRaw = db.get.bind(db);
const dbAllRaw = db.all.bind(db);

async function oracleCategory(id) {
  if (!id) return null;
  const row = await dbGetRaw('SELECT id, name FROM categories WHERE id = $1', [id]);
  return row ? { id: Number(row.id), name: row.name } : null;
}
async function oracleSubcategory(id) {
  if (!id) return null;
  const row = await dbGetRaw('SELECT id, name FROM subcategories WHERE id = $1', [id]);
  return row ? { id: Number(row.id), name: row.name } : null;
}
async function oracleMedia(productId) {
  const rows = await dbAllRaw(
    'SELECT id, kind, url, sort_order AS "sortOrder", crop FROM product_media WHERE product_id = $1 ORDER BY sort_order',
    [productId]
  );
  return rows.map((r) => ({ ...r, id: Number(r.id), crop: r.crop ? JSON.parse(r.crop) : null }));
}
async function oraclePriceMode() {
  const row = await dbGetRaw('SELECT price_mode FROM site_settings WHERE id = 1');
  return row ? row.price_mode : 'approved';
}
async function oraclePricesEnabled() {
  const row = await dbGetRaw("SELECT enabled FROM feature_flags WHERE key = 'prices'");
  return !row || !!row.enabled;
}
async function oracleBaseRows(extraWhere, params) {
  let sql = `SELECT p.* FROM products p JOIN product_types pt ON pt.key = p.type
             WHERE p.status = 'active' AND p.visibility = 'visible' AND pt.enabled = TRUE`;
  if (extraWhere) sql += ' AND ' + extraWhere;
  sql += ' ORDER BY p.created_at DESC, p.id DESC';
  return dbAllRaw(sql, params || []);
}
async function oracleSerialize(row, mode, viewer, pricesEnabled, { withSubcategory = true } = {}) {
  const masked = applyPriceVisibility(row, mode, viewer, pricesEnabled);
  const [category, subcategory, media] = await Promise.all([
    oracleCategory(row.category_id),
    withSubcategory ? oracleSubcategory(row.subcategory_id) : Promise.resolve(undefined),
    oracleMedia(row.id),
  ]);
  return serializeProduct({ ...masked, id: Number(row.id) }, { category, subcategory, media });
}

async function main() {
  // =========================================================================
  // Build the full-dataset oracle BEFORE any instrumentation is installed.
  // =========================================================================
  const guestMode = await oraclePriceMode();
  const guestPricesEnabled = await oraclePricesEnabled();
  const guestViewer = null; // this test is strictly read-only, so it never
  // logs in as a customer/admin (that would require a session write); price
  // visibility for a logged-in approved viewer is already covered exhaustively
  // by lib/priceVisibility.js's own unit coverage in earlier batches and is
  // a pure function untouched by this step — only the guest branch is
  // re-verified here, end-to-end, through the live route.

  const allRows = await oracleBaseRows();
  const expectedAll = [];
  for (const row of allRows) expectedAll.push(await oracleSerialize(row, guestMode, guestViewer, guestPricesEnabled));

  const diamondRows = await oracleBaseRows('p.type = $1', ['diamond']);
  const expectedDiamond = [];
  for (const row of diamondRows) expectedDiamond.push(await oracleSerialize(row, guestMode, guestViewer, guestPricesEnabled));

  const SUB_SKU = 'AC-J2201';
  const MEDIA_SKU = 'HK-PK-02-09';
  const NO_MEDIA_SKU = 'VS-HK-50-01';
  const CROP_PRODUCT_ID = 257;

  const subRow = await dbGetRaw(`SELECT p.* FROM products p JOIN product_types pt ON pt.key=p.type WHERE p.sku = $1`, [SUB_SKU]);
  const expectedSubProduct = await oracleSerialize(subRow, guestMode, guestViewer, guestPricesEnabled);

  const detailRow = await dbGetRaw(`SELECT p.* FROM products p JOIN product_types pt ON pt.key=p.type WHERE p.sku = $1`, [MEDIA_SKU]);
  const expectedDetailProduct = await oracleSerialize(detailRow, guestMode, guestViewer, guestPricesEnabled);

  // =========================================================================
  // Install query-count instrumentation, THEN require the real route.
  // =========================================================================
  let calls = [];
  const originalGet = db.get;
  const originalAll = db.all;
  db.get = async function counted(sql, params) { const t0 = Date.now(); const r = await originalGet(sql, params); calls.push({ fn: 'get', sql, ms: Date.now() - t0 }); return r; };
  db.all = async function counted(sql, params) { const t0 = Date.now(); const r = await originalAll(sql, params); calls.push({ fn: 'all', sql, ms: Date.now() - t0 }); return r; };

  const productsPostgresRouter = require('./server/routes/productsPostgres');
  const app = express();
  app.use('/test/products', productsPostgresRouter);
  const server = app.listen(0);
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    // =========================================================================
    // A/M. Full unfiltered guest list — deep parity against the oracle.
    // =========================================================================
    try {
      calls = [];
      const res = await fetch(`${baseUrl}/test/products/`);
      const body = await res.json();
      assert(res.status === 200, `expected 200, got ${res.status}`);
      assert(body.data.length === expectedAll.length, `count mismatch: actual=${body.data.length} expected=${expectedAll.length}`);
      assert(sameJson(body.data, expectedAll), 'full dataset does not byte-for-byte match the pre-optimization oracle');
      record('A/M. GET /products (guest, unfiltered) — full dataset byte-for-byte matches pre-optimization oracle', true, `${body.data.length} products`);
    } catch (err) { record('A/M. GET /products (guest, unfiltered) — full dataset byte-for-byte matches pre-optimization oracle', false, err.message); }

    // =========================================================================
    // B. Filtering behavior (?type=diamond)
    // =========================================================================
    try {
      const res = await fetch(`${baseUrl}/test/products/?type=diamond`);
      const body = await res.json();
      assert(res.status === 200, `expected 200, got ${res.status}`);
      assert(sameJson(body.data, expectedDiamond), 'filtered (?type=diamond) result does not match oracle');
      assert(body.data.every((p) => p.type === 'diamond'), 'filtered result contains a non-diamond product');
      record('B. GET /products?type=diamond — filtered result matches oracle exactly', true, `${body.data.length} products`);
    } catch (err) { record('B. GET /products?type=diamond — filtered result matches oracle exactly', false, err.message); }

    // =========================================================================
    // C. Product with category (every active/visible product has one)
    // =========================================================================
    try {
      const found = (await (await fetch(`${baseUrl}/test/products/`)).json()).data[0];
      assert(found.category && typeof found.category.id === 'number' && typeof found.category.name === 'string', `category shape wrong: ${JSON.stringify(found.category)}`);
      record('C. product.category — exact {id:Number, name} shape', true);
    } catch (err) { record('C. product.category — exact {id:Number, name} shape', false, err.message); }

    // =========================================================================
    // D. Product with subcategory (real fixture: AC-J2201)
    // =========================================================================
    try {
      const res = await fetch(`${baseUrl}/test/products/${SUB_SKU}`);
      const body = await res.json();
      assert(res.status === 200, `expected 200, got ${res.status}`);
      assert(body.data.subcategory && typeof body.data.subcategory.id === 'number', `subcategory missing/wrong shape: ${JSON.stringify(body.data.subcategory)}`);
      assert(sameJson({ ...body.data, related: undefined }, { ...expectedSubProduct, related: undefined }), 'subcategory product does not match oracle');
      record('D. product with real subcategory — exact {id:Number, name} shape, matches oracle', true, `sku=${SUB_SKU}`);
    } catch (err) { record('D. product with real subcategory — exact {id:Number, name} shape, matches oracle', false, err.message); }

    // =========================================================================
    // E. Product with media (real fixture: HK-PK-02-09, 7 media rows)
    // =========================================================================
    try {
      const res = await fetch(`${baseUrl}/test/products/${MEDIA_SKU}`);
      const body = await res.json();
      assert(res.status === 200, `expected 200, got ${res.status}`);
      assert(Array.isArray(body.data.media) && body.data.media.length === 7, `expected 7 media items, got ${body.data.media.length}`);
      record('E. product with media — exact count and array present', true, `${body.data.media.length} item(s)`);
    } catch (err) { record('E. product with media — exact count and array present', false, err.message); }

    // =========================================================================
    // F. Product without media (real fixture: VS-HK-50-01)
    // =========================================================================
    try {
      const res = await fetch(`${baseUrl}/test/products/${NO_MEDIA_SKU}`);
      const body = await res.json();
      assert(res.status === 200, `expected 200, got ${res.status}`);
      assert(Array.isArray(body.data.media) && body.data.media.length === 0, `expected media:[], got ${JSON.stringify(body.data.media)}`);
      record('F. product without media — exact media:[]', true);
    } catch (err) { record('F. product without media — exact media:[]', false, err.message); }

    // =========================================================================
    // G. Price visibility (guest, current real price_mode)
    // =========================================================================
    try {
      const found = (await (await fetch(`${baseUrl}/test/products/`)).json()).data[0];
      const expectedFirst = expectedAll[0];
      assert(found.priceVisible === expectedFirst.priceVisible && found.priceLabel === expectedFirst.priceLabel && found.priceCta === expectedFirst.priceCta,
        `price visibility mismatch: actual=${JSON.stringify({ v: found.priceVisible, l: found.priceLabel, c: found.priceCta })} expected=${JSON.stringify({ v: expectedFirst.priceVisible, l: expectedFirst.priceLabel, c: expectedFirst.priceCta })}`);
      record(`G. guest price visibility — matches applyPriceVisibility exactly (mode="${guestMode}", pricesEnabled=${guestPricesEnabled})`, true);
    } catch (err) { record('G. guest price visibility — matches applyPriceVisibility exactly', false, err.message); }

    // =========================================================================
    // H. GET /api/products/:sku — basic detail fetch
    // =========================================================================
    try {
      const res = await fetch(`${baseUrl}/test/products/${MEDIA_SKU}`);
      const body = await res.json();
      assert(res.status === 200 && body.data.sku === MEDIA_SKU, `unexpected: ${res.status} ${JSON.stringify(body).slice(0, 200)}`);
      const { related: _r, ...mainOnly } = body.data;
      assert(sameJson(mainOnly, expectedDetailProduct), 'detail main-product fields do not match oracle');
      record('H. GET /products/:sku — main product fields match oracle exactly', true);
    } catch (err) { record('H. GET /products/:sku — main product fields match oracle exactly', false, err.message); }

    // =========================================================================
    // I. Related products
    // =========================================================================
    try {
      const res = await fetch(`${baseUrl}/test/products/${MEDIA_SKU}`);
      const body = await res.json();
      assert(Array.isArray(body.data.related), 'related is not an array');
      assert(body.data.related.length <= 4, `related length ${body.data.related.length} exceeds max 4`);
      assert(body.data.related.every((r) => r.sku !== MEDIA_SKU), 'related list includes the main product itself');
      assert(body.data.related.every((r) => r.type === detailRow.type), 'related list includes a different-type product');
      // serializeProduct is never given a subcategory option for related
      // items (matches the original code exactly), so it always falls back
      // to null there — asserted directly, not loosely.
      assert(body.data.related.every((r) => r.subcategory === null), `related item subcategory should always be null, got: ${JSON.stringify(body.data.related.map((r) => r.subcategory))}`);
      for (const r of body.data.related) {
        assert(typeof r.id === 'number', `related item id is ${typeof r.id}, expected number`);
        assert(Array.isArray(r.media), 'related item media is not an array');
      }
      record('I. related products — <=4, excludes self, same type, correct shape', true, `${body.data.related.length} related item(s)`);
    } catch (err) { record('I. related products — <=4, excludes self, same type, correct shape', false, err.message); }

    // =========================================================================
    // J. Media ordering (ascending sort_order, same product with 7 items)
    // =========================================================================
    try {
      const res = await fetch(`${baseUrl}/test/products/${MEDIA_SKU}`);
      const body = await res.json();
      const orders = body.data.media.map((m) => m.sortOrder);
      const sorted = [...orders].sort((a, b) => a - b);
      assert(sameJson(orders, sorted), `media not in ascending sort_order: ${JSON.stringify(orders)}`);
      record('J. media ordering — ascending sort_order preserved', true, JSON.stringify(orders));
    } catch (err) { record('J. media ordering — ascending sort_order preserved', false, err.message); }

    // =========================================================================
    // K. Crop parsing (real fixture: product id 257)
    // =========================================================================
    try {
      const cropProductRow = await dbGetRaw('SELECT sku FROM products WHERE id = $1', [CROP_PRODUCT_ID]);
      const res = await fetch(`${baseUrl}/test/products/${encodeURIComponent(cropProductRow.sku)}`);
      const body = await res.json();
      assert(res.status === 200, `expected 200, got ${res.status}`);
      const withCrop = body.data.media.find((m) => m.crop !== null);
      assert(withCrop, 'no media item with a parsed (non-null) crop found');
      assert(typeof withCrop.crop === 'object', `crop is ${typeof withCrop.crop}, expected parsed object`);
      assert('x' in withCrop.crop && 'y' in withCrop.crop, `crop object missing expected keys: ${JSON.stringify(withCrop.crop)}`);
      record('K. crop parsing — non-null crop parsed into an object, not a raw string', true, JSON.stringify(withCrop.crop));
    } catch (err) { record('K. crop parsing — non-null crop parsed into an object, not a raw string', false, err.message); }

    // =========================================================================
    // L. Exposed IDs remain Number
    // =========================================================================
    try {
      const res = await fetch(`${baseUrl}/test/products/${SUB_SKU}`);
      const body = await res.json();
      assert(typeof body.data.id === 'number', `product.id is ${typeof body.data.id}`);
      assert(typeof body.data.category.id === 'number', `category.id is ${typeof body.data.category.id}`);
      assert(typeof body.data.subcategory.id === 'number', `subcategory.id is ${typeof body.data.subcategory.id}`);
      const mediaRes = await fetch(`${baseUrl}/test/products/${MEDIA_SKU}`);
      const mediaBody = await mediaRes.json();
      for (const m of mediaBody.data.media) assert(typeof m.id === 'number', `media.id is ${typeof m.id}`);
      record('L. exposed BIGINT ids (product/category/subcategory/media) are all JS Number', true);
    } catch (err) { record('L. exposed BIGINT ids (product/category/subcategory/media) are all JS Number', false, err.message); }

    // =========================================================================
    // 9. QUERY COUNT — reset counter, fire ONE clean guest request, count.
    // =========================================================================
    try {
      calls = [];
      const res = await fetch(`${baseUrl}/test/products/`);
      await res.json();
      const total = calls.length;
      const byCat = {};
      for (const c of calls) {
        const s = c.sql.replace(/\s+/g, ' ').trim();
        let cat = 'OTHER';
        if (s.startsWith('SELECT p.* FROM products')) cat = 'base products query';
        else if (s.includes('FROM categories WHERE id = ANY')) cat = 'batch categories';
        else if (s.includes('FROM subcategories WHERE id = ANY')) cat = 'batch subcategories';
        else if (s.includes('FROM product_media WHERE product_id = ANY')) cat = 'batch media';
        else if (s.startsWith('SELECT price_mode')) cat = 'getPriceMode';
        else if (s.startsWith('SELECT enabled FROM feature_flags')) cat = 'getPricesEnabled';
        byCat[cat] = (byCat[cat] || 0) + 1;
      }
      console.log('Query breakdown for one GET /products (guest):', byCat);
      assert(total <= 7, `expected approximately 6 queries, measured ${total} — per-product N+1 pattern may still be present`);
      assert((byCat['batch categories'] || 0) <= 1, 'categories fetched more than once — not batched');
      assert((byCat['batch subcategories'] || 0) <= 1, 'subcategories fetched more than once — not batched');
      assert((byCat['batch media'] || 0) <= 1, 'media fetched more than once — not batched');
      assert(!byCat['OTHER'] || byCat['OTHER'] === 0, `unexpected uncategorized queries: ${JSON.stringify(calls.filter(c => true).map(c=>c.sql.slice(0,80)))}`);
      record('9. QUERY COUNT — measured total queries for one guest GET /products', true, `${total} total queries (target ~6)`);
    } catch (err) { record('9. QUERY COUNT — measured total queries for one guest GET /products', false, err.message); }

    // =========================================================================
    // 10. PERFORMANCE — 1 warm-up + 3 measured runs
    // =========================================================================
    console.log('\n--- PERFORMANCE (1 warm-up + 3 measured runs) ---');
    await fetch(`${baseUrl}/test/products/`); // warm-up (pool connections, query planner cache)
    const timings = [];
    for (let i = 1; i <= 3; i++) {
      const t0 = Date.now();
      const res = await fetch(`${baseUrl}/test/products/`);
      await res.json();
      const ms = Date.now() - t0;
      timings.push(ms);
      console.log(`  Run ${i}: ${ms}ms (HTTP ${res.status})`);
    }
    const sorted = [...timings].sort((a, b) => a - b);
    const median = sorted[1];
    console.log(`  Median: ${median}ms`);
    record('10. PERFORMANCE — 3 timed runs after warm-up, median recorded', true, `${timings.join('ms, ')}ms — median ${median}ms`);

    const failed = results.filter((r) => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
    if (failed.length) {
      console.log('FAILURES:');
      for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`);
      process.exitCode = 1;
    } else {
      console.log('ALL PARITY/PERFORMANCE CHECKS PASSED');
    }
  } finally {
    await server.close();
    db.get = originalGet;
    db.all = originalAll;
    await db.pool.end();
  }
}

main().catch((err) => {
  console.error('test-postgres-products-performance.js FAILED:', err.message);
  process.exitCode = 1;
});
