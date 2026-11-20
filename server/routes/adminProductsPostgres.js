const fs = require('fs');
const path = require('path');
const express = require('express');
const multer = require('multer');
const db = require('../db/postgres');
const { asyncRoute, ApiError } = require('../middleware/errorHandler');
const requireAdmin = require('../middleware/requireAdminPostgres');
const requirePermission = require('../middleware/requirePermission');
const { makeUploader, kindOf, convertHeic } = require('../middleware/upload');
const { serializeProduct } = require('../lib/serializeProduct');
const { toPublicMediaUrl } = require('../lib/mediaUrl');
const { persistUploadedFile, discardPersistedFile, removeR2ObjectForUrl } = require('../lib/mediaUpload');
const { stripVideoAudio } = require('../lib/stripVideoAudio');
const { processVideo } = require('../lib/processVideo');
const { createAndStorePreview, removePreview } = require('../lib/videoPreview');
const r2Storage = require('../services/r2Storage');
const os = require('os');
const crypto = require('crypto');
const { METAL_OPTIONS } = require('../lib/productVariants');
const { writeAudit } = require('../lib/auditPostgres');
const { COLUMN_DEFS: IMPORT_COLUMN_DEFS, buildTemplate, buildStockExport, importWorkbook, applyImport } = require('../lib/excelImportPostgres');
const env = require('../config/env');
const {
  PRODUCT_OFFER_COLUMNS, getOffersSchema, loadLivePromotions, resolveOffer, buildPublicOffer,
  normalizeOwnDiscount, parseOfferDate,
} = require('../lib/offers');

// PostgreSQL counterpart to server/routes/adminProducts.js (SQLite).
// Parallel/isolated test route file only — NOT mounted in app.js. Media
// handling (makeUploader/kindOf/convertHeic, upload.js) is reused UNCHANGED —
// it has no database dependency, so nothing about it needs a Postgres variant.

const router = express.Router();
const upload = makeUploader('products');
const importUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

router.use(requireAdmin, requirePermission('products', 'manage'));

const FIELDS = [
  'sku', 'type', 'category_id', 'subcategory_id', 'status', 'visibility', 'featured',
  'weight_carat', 'shape', 'color', 'clarity', 'measurements',
  'certificate_authority', 'certificate_number', 'certificate_website',
  'metal', 'gold_purity', 'gold_color', 'gold_weight_grams',
  'stone_name', 'origin',
  'price_per_carat', 'total_price', 'price_visibility',
  ...PRODUCT_OFFER_COLUMNS,
];

function pickBody(body) {
  const out = {};
  for (const f of FIELDS) {
    if (body[f] !== undefined) out[f] = body[f] === '' ? null : body[f];
  }
  for (const f of ['discount_starts_at', 'discount_ends_at']) {
    if (out[f] === undefined || out[f] === null) continue;
    const d = parseOfferDate(out[f], { endOfDay: f === 'discount_ends_at' });
    if (!d) throw new ApiError(400, `The offer ${f === 'discount_starts_at' ? 'start' : 'end'} date isn't a valid date.`);
    out[f] = d;
  }
  return out;
}

// The product's own discount (Offer section of the form). Checked whenever
// a save touches it OR changes the price a $-off discount depends on.
// Before the offers SQL has been run the fields are dropped (an empty
// discount) or refused (a real one) instead of breaking the whole save.
async function applyOwnDiscount(b, existing) {
  const touches = PRODUCT_OFFER_COLUMNS.some((c) => b[c] !== undefined);
  const schema = await getOffersSchema();
  if (!schema.productColumns) {
    const wantsDiscount = b.discount_type && b.discount_type !== '';
    for (const c of PRODUCT_OFFER_COLUMNS) delete b[c];
    if (wantsDiscount) {
      throw new ApiError(409, 'Discounts need a one-time database update first. Open Admin > Sales & Discounts for the SQL to run.');
    }
    return;
  }
  const priceChanges = existing && b.total_price !== undefined && existing.discount_type === 'amount';
  if (!touches && !priceChanges) return;
  const merged = {};
  for (const c of PRODUCT_OFFER_COLUMNS) merged[c] = b[c] !== undefined ? b[c] : (existing ? existing[c] : null);
  const basePrice = b.total_price !== undefined ? (b.total_price === null ? null : Number(b.total_price)) : (existing ? Number(existing.total_price) || null : null);
  const errors = normalizeOwnDiscount(merged, basePrice);
  if (errors.length) throw new ApiError(400, errors.join(' '));
  for (const c of PRODUCT_OFFER_COLUMNS) b[c] = merged[c];
}

// NOTE: both `AS sortOrder` and `AS originalName` must be double-quoted —
// unquoted, Postgres would fold them to `sortorder`/`originalname`, silently
// breaking every r.sortOrder / r.originalName read below.
async function mediaFor(productId) {
  const rows = await db.all(
    'SELECT id, kind, url, sort_order AS "sortOrder", original_name AS "originalName", crop FROM product_media WHERE product_id = $1 ORDER BY sort_order',
    [productId]
  );
  return rows.map((r) => ({ ...r, id: Number(r.id), url: toPublicMediaUrl(r.url), crop: r.crop ? JSON.parse(r.crop) : null }));
}
// Every admin product response, for one product or the whole catalog, in a
// FIXED number of queries (categories, subcategories, media, variations,
// live sales — run together) instead of 4 per product. The list used to
// fire ~1,100 queries for 283 products, on every load and after every save.
async function fullProducts(rows) {
  if (!rows.length) return [];
  const ids = rows.map((r) => String(r.id));
  const idSet = (key) => [...new Set(rows.map((r) => r[key]).filter((v) => v !== null && v !== undefined).map(String))];
  const variantRows = db.all('SELECT * FROM product_variants WHERE product_id = ANY($1::bigint[])', [ids])
    .catch((err) => { if (err && err.code === '42P01') return []; throw err; });
  const [cats, subs, mediaRows, rawVariants, promos] = await Promise.all([
    idSet('category_id').length ? db.all('SELECT id, name FROM categories WHERE id = ANY($1::bigint[])', [idSet('category_id')]) : [],
    idSet('subcategory_id').length ? db.all('SELECT id, name FROM subcategories WHERE id = ANY($1::bigint[])', [idSet('subcategory_id')]) : [],
    db.all(
      `SELECT id, product_id, kind, url, sort_order AS "sortOrder", original_name AS "originalName", crop
       FROM product_media WHERE product_id = ANY($1::bigint[]) ORDER BY product_id, sort_order`,
      [ids]
    ),
    variantRows,
    loadLivePromotions(),
  ]);
  const catById = new Map(cats.map((c) => [Number(c.id), { id: Number(c.id), name: c.name }]));
  const subById = new Map(subs.map((c) => [Number(c.id), { id: Number(c.id), name: c.name }]));
  const mediaBy = new Map();
  for (const m of mediaRows) {
    const pid = Number(m.product_id);
    if (!mediaBy.has(pid)) mediaBy.set(pid, []);
    mediaBy.get(pid).push({ id: Number(m.id), kind: m.kind, url: toPublicMediaUrl(m.url), sortOrder: m.sortOrder, originalName: m.originalName, crop: m.crop ? JSON.parse(m.crop) : null });
  }
  const variantsBy = new Map();
  for (const v of rawVariants) {
    const pid = Number(v.product_id);
    if (!variantsBy.has(pid)) variantsBy.set(pid, []);
    // Admin always sees the real price on every variant (no masking).
    variantsBy.get(pid).push({ id: Number(v.id), metal: v.metal, price: Number(v.price), coverMediaId: v.cover_media_id ? Number(v.cover_media_id) : null });
  }
  for (const list of variantsBy.values()) list.sort((a, b) => METAL_OPTIONS.indexOf(a.metal) - METAL_OPTIONS.indexOf(b.metal));
  const now = new Date();
  return rows.map((row) => {
    const id = Number(row.id);
    // The offer customers get right now (own discount or a running sale),
    // unmasked — so the list can show the effective price at a glance.
    const offer = buildPublicOffer(resolveOffer(row, promos, now), row, true);
    return serializeProduct({ ...row, id }, {
      category: row.category_id != null ? catById.get(Number(row.category_id)) || null : null,
      subcategory: row.subcategory_id != null ? subById.get(Number(row.subcategory_id)) || null : null,
      media: mediaBy.get(id) || [], variants: variantsBy.get(id) || [], offer, admin: true,
    });
  });
}
async function fullProduct(row) {
  return (await fullProducts([row]))[0];
}

// Route ids must be whole numbers ("abc" used to reach Postgres and come
// back as an unexplained server error).
function productId(raw) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new ApiError(404, 'Product not found.');
  return n;
}

// Files on disk / in R2 that belong to these media rows — and ONLY to them.
// A file is removed only when no remaining product_media row (any product)
// still points at it, and only from the products upload folder, so a
// delete can never take another product's photo with it.
const PRODUCT_FILE_RE = /^\/uploads\/products\/[A-Za-z0-9._-]+$/;
async function removeMediaFiles(mediaRows) {
  const candidates = [...new Map(mediaRows.filter((m) => m && PRODUCT_FILE_RE.test(String(m.url || ''))).map((m) => [m.url, m])).values()];
  if (!candidates.length) return { removed: 0, kept: 0 };
  const stillUsed = new Set((await db.all('SELECT DISTINCT url FROM product_media WHERE url = ANY($1)', [candidates.map((m) => m.url)])).map((r) => r.url));
  const doomed = candidates.filter((m) => !stillUsed.has(m.url));
  const removeOne = async (m) => {
    await removeR2ObjectForUrl(m.url);
    if (m.kind === 'video') await removePreview(m.url);
    await fs.promises.unlink(path.join(env.rootDir, m.url.replace(/^\//, ''))).catch(() => {});
  };
  // A few at a time: fast for a bulk delete, gentle on R2.
  for (let i = 0; i < doomed.length; i += 8) await Promise.all(doomed.slice(i, i + 8).map(removeOne));
  return { removed: doomed.length, kept: candidates.length - doomed.length };
}

// Deletes products (and, by cascade, their media rows and metal variations)
// in ONE transaction, then their files. Inquiry history is kept: each
// inquiry line already stores its own SKU, name and quoted price, so only
// its link to the product is cleared — that link is what used to make
// deleting any product a customer had inquired about fail.
async function deleteProducts(ids) {
  const result = await db.transaction(async (client) => {
    const found = (await client.query('SELECT id, sku FROM products WHERE id = ANY($1::bigint[]) FOR UPDATE', [ids.map(String)])).rows;
    if (!found.length) return { found: [], media: [] };
    const foundIds = found.map((r) => String(r.id));
    const media = (await client.query('SELECT url, kind FROM product_media WHERE product_id = ANY($1::bigint[])', [foundIds])).rows;
    await client.query('UPDATE inquiry_items SET product_id = NULL WHERE product_id = ANY($1::bigint[])', [foundIds]);
    await client.query('DELETE FROM products WHERE id = ANY($1::bigint[])', [foundIds]);
    return { found, media };
  });
  const files = await removeMediaFiles(result.media);
  return { deleted: result.found, files };
}

router.get('/', asyncRoute(async (req, res) => {
  const { type } = req.query;
  let sql = 'SELECT * FROM products';
  const params = [];
  if (type) { params.push(type); sql += ` WHERE type = $${params.length}`; }
  sql += ' ORDER BY created_at DESC, id DESC';
  const rows = await db.all(sql, params);
  res.json({ data: await fullProducts(rows) });
}));

router.post('/', asyncRoute(async (req, res) => {
  const b = pickBody(req.body || {});
  if (!b.sku || !String(b.sku).trim()) throw new ApiError(400, 'SKU is required.');
  if (!['diamond', 'jewelry', 'gemstone'].includes(b.type)) throw new ApiError(400, 'A valid product type is required.');
  const dup = await db.get('SELECT id FROM products WHERE sku = $1', [b.sku]);
  if (dup) throw new ApiError(409, `A product with SKU ${b.sku} already exists.`);
  await applyOwnDiscount(b, null);

  const cols = Object.keys(b);
  const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
  const values = cols.map((c) => b[c]);
  const inserted = await db.get(`INSERT INTO products (${cols.join(', ')}) VALUES (${placeholders}) RETURNING id`, values)
    .catch((err) => { if (err && err.code === '23505') throw new ApiError(409, `A product with SKU ${b.sku} already exists.`); throw err; });
  const row = await db.get('SELECT * FROM products WHERE id = $1', [inserted.id]);

  await writeAudit({ actor: req.adminUser.full_name, action: 'Added product', target: row.sku, module: 'Products' });
  res.status(201).json({ data: await fullProduct(row) });
}));

router.put('/:id', asyncRoute(async (req, res) => {
  const existing = await db.get('SELECT * FROM products WHERE id = $1', [productId(req.params.id)]);
  if (!existing) throw new ApiError(404, 'Product not found.');
  const b = pickBody(req.body || {});
  if (b.sku && b.sku !== existing.sku) {
    const dup = await db.get('SELECT id FROM products WHERE sku = $1 AND id != $2', [b.sku, existing.id]);
    if (dup) throw new ApiError(409, `A product with SKU ${b.sku} already exists.`);
  }
  await applyOwnDiscount(b, existing);
  const cols = Object.keys(b);
  if (cols.length) {
    const setClause = cols.map((c, i) => `${c} = $${i + 1}`).join(', ');
    const values = cols.map((c) => b[c]);
    await db.query(`UPDATE products SET ${setClause}, updated_at = NOW() WHERE id = $${cols.length + 1}`, [...values, existing.id])
      .catch((err) => { if (err && err.code === '23505') throw new ApiError(409, `A product with SKU ${b.sku} already exists.`); throw err; });
  }
  const row = await db.get('SELECT * FROM products WHERE id = $1', [existing.id]);

  const statusChanged = b.status && b.status !== existing.status;
  const featuredChanged = b.featured !== undefined && !!b.featured !== !!existing.featured;
  let action = 'Updated product';
  if (statusChanged) action = b.status === 'hidden' ? 'Hid product' : 'Updated product';
  else if (featuredChanged && cols.length === 1) action = b.featured ? 'Featured product on homepage' : 'Removed product from homepage Featured';
  await writeAudit({ actor: req.adminUser.full_name, action, target: row.sku, module: 'Products' });
  res.json({ data: await fullProduct(row) });
}));

router.delete('/:id', asyncRoute(async (req, res) => {
  const id = productId(req.params.id);
  const { deleted, files } = await deleteProducts([id]);
  if (!deleted.length) throw new ApiError(404, 'Product not found — it may already have been deleted.');
  await writeAudit({ actor: req.adminUser.full_name, action: 'Deleted product', target: deleted[0].sku, module: 'Products' });
  res.json({ data: { deleted: true, ids: [id], filesRemoved: files.removed } });
}));

// Many products in one request and one transaction (the page used to fire
// one DELETE per selected product at once, and large selections partly
// failed).
router.post('/bulk-delete', asyncRoute(async (req, res) => {
  const raw = Array.isArray((req.body || {}).ids) ? req.body.ids : [];
  const ids = [...new Set(raw.map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  if (!ids.length) throw new ApiError(400, 'Choose at least one product to delete.');
  if (ids.length > 2000) throw new ApiError(400, 'Too many products in one go (2000 max).');
  const { deleted, files } = await deleteProducts(ids);
  if (deleted.length) {
    await writeAudit({
      actor: req.adminUser.full_name,
      action: deleted.length === 1 ? 'Deleted product' : `Deleted ${deleted.length} products`,
      target: deleted.length === 1 ? deleted[0].sku : deleted.slice(0, 8).map((d) => d.sku).join(', ') + (deleted.length > 8 ? ` +${deleted.length - 8} more` : ''),
      module: 'Products',
    });
  }
  res.json({ data: { deleted: deleted.length, ids: deleted.map((d) => Number(d.id)), missing: ids.length - deleted.length, filesRemoved: files.removed } });
}));

// Turns an uploaded video into what the storefront actually serves: framed
// (centered square unless the admin chose a frame), compressed, no sound —
// see lib/processVideo.js. Rewrites `file` in place (path/name/mimetype) so
// persistUploadedFile() stores the processed .mp4. If a file can't be
// re-encoded (unusual codec), it falls back to the old behaviour (audio
// stripped by stream copy, original framing) rather than losing the upload.
async function prepareVideo(file, frame) {
  const inputPath = file.path;
  let outPath;
  let processed = true;
  try {
    outPath = await processVideo(inputPath, frame);
  } catch (err) {
    console.error('[media] video processing failed, keeping original framing:', err.message);
    processed = false;
    outPath = await stripVideoAudio(inputPath);
  }
  fs.unlink(inputPath, () => {});
  file.path = outPath;
  file.filename = path.basename(outPath);
  if (processed) {
    file.mimetype = 'video/mp4';
    file.originalname = String(file.originalname || 'video').replace(/\.[^.]+$/, '') + '.mp4';
  }
  return processed;
}

function framesFrom(body) {
  const raw = body && body.frames;
  if (!raw) return [];
  try { const v = JSON.parse(raw); return Array.isArray(v) ? v : []; } catch { return []; }
}

router.post('/:id/media', upload.array('files', 12), convertHeic, asyncRoute(async (req, res) => {
  const product = await db.get('SELECT * FROM products WHERE id = $1', [productId(req.params.id)]);
  if (!product) throw new ApiError(404, 'Product not found.');
  if (!req.files || !req.files.length) throw new ApiError(400, 'No files uploaded.');
  const maxOrderRow = await db.get('SELECT COALESCE(MAX(sort_order), -1) AS m FROM product_media WHERE product_id = $1', [product.id]);
  const maxOrder = maxOrderRow.m;

  // Two-stage, per-file: (1) upload to R2 — on failure, nothing else for this
  // file happens, its local temp copy is already cleaned up by
  // persistUploadedFile() itself; (2) DB insert — if THIS fails after R2
  // already succeeded, discardPersistedFile() removes ONLY that file's just-
  // created R2 object + local file so nothing is orphaned. Either failure
  // mode is reported per-file in `errors` and never affects other files in
  // the same batch — sequential for...of, not Promise.all, so each file's
  // two stages fully resolve before the next file starts.
  const created = [];
  const failed = [];
  // Optional per-file framing chosen in the admin's framing tool, in the
  // same order as `files` (null/missing = centered square).
  const frames = framesFrom(req.body);
  for (const [i, f] of req.files.entries()) {
    const kind = kindOf(f.mimetype, f.originalname);
    let url;
    try {
      // Videos are framed, compressed and muted before they ever reach
      // storage, so no product video carries sound or wasted pixels.
      if (kind === 'video') await prepareVideo(f, frames[i] || null);
      url = await persistUploadedFile(f, 'products');
    } catch (err) {
      failed.push({ originalName: f.originalname, error: 'Failed to upload this file. Please try again.' });
      continue;
    }
    try {
      const inserted = await db.get(
        'INSERT INTO product_media (product_id, kind, url, sort_order, original_name) VALUES ($1, $2, $3, $4, $5) RETURNING id',
        [product.id, kind, url, maxOrder + 1 + created.length, f.originalname]
      );
      created.push({ id: Number(inserted.id), kind, url, originalName: f.originalname });
    } catch (err) {
      await discardPersistedFile(url, f);
      failed.push({ originalName: f.originalname, error: 'Failed to save this file. Please try again.' });
      continue;
    }
    // Small hover-preview clip for product cards (best effort, ~1s).
    if (kind === 'video') await createAndStorePreview(f.path, url);
  }
  if (created.length) {
    await writeAudit({ actor: req.adminUser.full_name, action: 'Uploaded media', target: product.sku, module: 'Products' });
  }
  if (!created.length) throw new ApiError(502, 'Failed to upload media. Please try again.');
  res.status(201).json({ data: created, errors: failed.length ? failed : undefined });
}));

router.put('/:id/media/reorder', asyncRoute(async (req, res) => {
  const product = await db.get('SELECT * FROM products WHERE id = $1', [productId(req.params.id)]);
  if (!product) throw new ApiError(404, 'Product not found.');
  const order = Array.isArray((req.body || {}).order) ? req.body.order : null;
  if (!order || !order.length) throw new ApiError(400, 'order must be a non-empty array of media ids.');
  const existing = await mediaFor(product.id);
  const existingIds = new Set(existing.map((m) => m.id));
  if (order.length !== existing.length || !order.every((id) => existingIds.has(id))) {
    throw new ApiError(400, 'order must contain exactly this product\'s media ids.');
  }
  // Single pooled client for the whole transaction — every statement below
  // runs sequentially against that SAME client, never through db.query()
  // (which could hand different statements to different pool connections
  // and silently lose atomicity).
  await db.transaction(async (client) => {
    for (let i = 0; i < order.length; i++) {
      await client.query('UPDATE product_media SET sort_order = $1 WHERE id = $2 AND product_id = $3', [i, order[i], product.id]);
    }
  });
  await writeAudit({ actor: req.adminUser.full_name, action: 'Reordered media', target: product.sku, module: 'Products' });
  res.json({ data: await mediaFor(product.id) });
}));

router.delete('/:id/media/:mediaId', asyncRoute(async (req, res) => {
  const media = await db.get('SELECT * FROM product_media WHERE id = $1 AND product_id = $2', [productId(req.params.mediaId), productId(req.params.id)]);
  if (!media) throw new ApiError(404, 'Media not found.');
  const product = await db.get('SELECT sku FROM products WHERE id = $1', [productId(req.params.id)]);
  await db.query('DELETE FROM product_media WHERE id = $1', [media.id]); // authoritative — commits first
  await removeMediaFiles([media]); // then its file(s), unless another row still uses them
  await writeAudit({ actor: req.adminUser.full_name, action: 'Removed media', target: product ? product.sku : `#${req.params.id}`, module: 'Products' });
  res.json({ data: { deleted: true } });
}));

router.put('/:id/media/:mediaId', upload.single('file'), convertHeic, asyncRoute(async (req, res) => {
  const product = await db.get('SELECT * FROM products WHERE id = $1', [productId(req.params.id)]);
  if (!product) throw new ApiError(404, 'Product not found.');
  const media = await db.get('SELECT * FROM product_media WHERE id = $1 AND product_id = $2', [productId(req.params.mediaId), product.id]);
  if (!media) throw new ApiError(404, 'Media not found.');
  if (!req.file) throw new ApiError(400, 'No file uploaded.');

  const newKind = kindOf(req.file.mimetype, req.file.originalname);

  // Upload the replacement first — a fresh multer-generated filename means
  // its R2 key can never collide with the old object's key, so the old
  // media is physically safe no matter what happens next.
  let newUrl;
  try {
    // Same processing as create — see prepareVideo above.
    if (newKind === 'video') await prepareVideo(req.file, (req.body || {}).frame || null);
    newUrl = await persistUploadedFile(req.file, 'products');
  } catch (err) {
    throw new ApiError(502, 'Failed to upload the replacement file. The existing media was not changed.');
  }
  try {
    // crop is always cleared on a file replace: any previous framing
    // metadata was computed against the OLD file's dimensions/content and
    // no longer applies to the new one. The destructive video-crop flow
    // (editVideoMedia -> openVideoCropper) relies on this specifically —
    // it bakes the selected framing into the new file's actual pixels, so
    // the old CSS-transform metadata must not linger and get applied a
    // second time on top of an already-cropped video.
    await db.query('UPDATE product_media SET kind = $1, url = $2, original_name = $3, crop = NULL WHERE id = $4', [newKind, newUrl, req.file.originalname, media.id]);
  } catch (err) {
    await discardPersistedFile(newUrl, req.file); // R2 succeeded but DB failed — undo ONLY the new file/object
    throw new ApiError(502, 'Failed to save the replacement. The existing media was not changed.');
  }

  if (newKind === 'video') await createAndStorePreview(req.file.path, newUrl);
  // DB UPDATE committed — only now clean up the superseded OLD media.
  await removeMediaFiles([media]);

  await writeAudit({ actor: req.adminUser.full_name, action: 'Edited media', target: product.sku, module: 'Products' });
  res.json({ data: { id: Number(media.id), kind: newKind, url: newUrl, originalName: req.file.originalname } });
}));

// Re-frames a video that's already saved, from the stored file: the admin
// picks a new window in the framing tool and the server re-cuts it (same
// processing as an upload). The stored file is what gets cropped: a video
// uploaded before this processing existed still has its full 9:16 frame to
// choose from; one that's already square can be zoomed/shifted within it.
router.post('/:id/media/:mediaId/reframe', asyncRoute(async (req, res) => {
  const product = await db.get('SELECT * FROM products WHERE id = $1', [productId(req.params.id)]);
  if (!product) throw new ApiError(404, 'Product not found.');
  const media = await db.get('SELECT * FROM product_media WHERE id = $1 AND product_id = $2', [productId(req.params.mediaId), product.id]);
  if (!media) throw new ApiError(404, 'Media not found.');
  if (media.kind !== 'video') throw new ApiError(400, 'Only videos can be re-framed here.');
  if (!String(media.url).startsWith('/uploads/')) throw new ApiError(400, 'This video is not stored by the site.');

  // The source: this server's local copy if it has one, otherwise R2.
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'oncd-reframe-'));
  const ext = path.extname(media.url) || '.mp4';
  const file = { path: path.join(tmpDir, `source${ext}`), originalname: media.original_name || `video${ext}`, mimetype: 'video/mp4' };
  const cleanupTmp = () => fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  try {
    const localPath = path.join(env.rootDir, media.url.replace(/^\//, ''));
    if (fs.existsSync(localPath)) await fs.promises.copyFile(localPath, file.path);
    else {
      const obj = await r2Storage.getObject(media.url.slice('/uploads/'.length));
      await fs.promises.writeFile(file.path, obj.body);
    }
  } catch (err) {
    await cleanupTmp();
    throw new ApiError(502, 'Could not read the stored video. Please try again.');
  }

  let newUrl;
  try {
    const processed = await prepareVideo(file, (req.body || {}).frame || null);
    if (!processed) throw new Error('not processed');
    // Stored under a fresh upload-style name in the products folder, so
    // the new object's key can never collide with the old one.
    const finalName = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}.mp4`;
    const finalPath = path.join(env.rootDir, 'uploads', 'products', finalName);
    await fs.promises.mkdir(path.dirname(finalPath), { recursive: true });
    await fs.promises.copyFile(file.path, finalPath);
    newUrl = await persistUploadedFile({ ...file, path: finalPath, filename: finalName }, 'products');
  } catch (err) {
    await cleanupTmp();
    throw new ApiError(502, 'Could not process the video. The existing video was not changed.');
  }
  await cleanupTmp();

  await db.query('UPDATE product_media SET url = $1, crop = NULL WHERE id = $2', [newUrl, media.id]);
  await createAndStorePreview(path.join(env.rootDir, newUrl.replace(/^\//, '')), newUrl);
  // Only after the database points at the new file is the old one removed.
  await removeMediaFiles([media]);
  await writeAudit({ actor: req.adminUser.full_name, action: 'Re-framed video', target: product.sku, module: 'Products' });
  res.json({ data: { id: Number(media.id), kind: 'video', url: toPublicMediaUrl(newUrl), originalName: media.original_name } });
}));

// Video framing (pan/zoom crop) is stored as metadata, not re-encoded — see
// utils/videoCropper.js. { x, y } are percentage pan offsets, { scale } is
// the zoom factor, { aspect } is one of imageCropper's aspect keys, matching
// the shape the client already draws for image cropping. `crop: null`
// clears it back to an uncropped, natural-aspect display.
router.put('/:id/media/:mediaId/crop', asyncRoute(async (req, res) => {
  const product = await db.get('SELECT * FROM products WHERE id = $1', [productId(req.params.id)]);
  if (!product) throw new ApiError(404, 'Product not found.');
  const media = await db.get('SELECT * FROM product_media WHERE id = $1 AND product_id = $2', [productId(req.params.mediaId), product.id]);
  if (!media) throw new ApiError(404, 'Media not found.');
  if (media.kind !== 'video') throw new ApiError(400, 'Crop framing only applies to video media.');

  const { crop } = req.body || {};
  let stored = null;
  if (crop !== null && crop !== undefined) {
    const { x, y, scale, aspect } = crop;
    if (typeof x !== 'number' || typeof y !== 'number' || typeof scale !== 'number' || typeof aspect !== 'string') {
      throw new ApiError(400, 'crop must be { x, y, scale, aspect } or null.');
    }
    stored = JSON.stringify({
      x: Math.max(-100, Math.min(100, x)),
      y: Math.max(-100, Math.min(100, y)),
      scale: Math.max(1, Math.min(4, scale)),
      aspect,
    });
  }
  await db.query('UPDATE product_media SET crop = $1 WHERE id = $2', [stored, media.id]);
  await writeAudit({ actor: req.adminUser.full_name, action: 'Reframed video', target: product.sku, module: 'Products' });
  res.json({ data: { id: Number(media.id), crop: stored ? JSON.parse(stored) : null } });
}));

// Replaces this product's WHOLE set of metal variations in one call — the
// admin form always sends the complete desired list (same "send the whole
// state, let the server reconcile" pattern as media reorder above), rather
// than separate add/update/remove calls per row.
router.put('/:id/variants', asyncRoute(async (req, res) => {
  const product = await db.get('SELECT * FROM products WHERE id = $1', [productId(req.params.id)]);
  if (!product) throw new ApiError(404, 'Product not found.');
  const variants = Array.isArray((req.body || {}).variants) ? req.body.variants : [];

  const seenMetals = new Set();
  for (const v of variants) {
    if (!METAL_OPTIONS.includes(v.metal)) throw new ApiError(400, `metal must be one of: ${METAL_OPTIONS.join(', ')}.`);
    if (seenMetals.has(v.metal)) throw new ApiError(400, `Duplicate metal: ${v.metal}.`);
    seenMetals.add(v.metal);
    if (typeof v.price !== 'number' || !Number.isFinite(v.price) || v.price < 0) throw new ApiError(400, `${v.metal} needs a valid price.`);
    if (v.coverMediaId !== null && v.coverMediaId !== undefined) {
      const media = await db.get('SELECT id FROM product_media WHERE id = $1 AND product_id = $2', [v.coverMediaId, product.id]);
      if (!media) throw new ApiError(400, `${v.metal}'s selected photo doesn't belong to this product.`);
    }
  }

  await db.transaction(async (client) => {
    await client.query('DELETE FROM product_variants WHERE product_id = $1', [product.id]);
    for (const v of variants) {
      await client.query(
        'INSERT INTO product_variants (product_id, metal, price, cover_media_id) VALUES ($1, $2, $3, $4)',
        [product.id, v.metal, v.price, v.coverMediaId || null]
      );
    }
  });

  await writeAudit({ actor: req.adminUser.full_name, action: 'Updated metal variations', target: product.sku, module: 'Products' });
  res.json({ data: await fullProduct(await db.get('SELECT * FROM products WHERE id = $1', [product.id])) });
}));

router.get('/import/:type/template', asyncRoute(async (req, res) => {
  const { type } = req.params;
  if (!IMPORT_COLUMN_DEFS[type]) throw new ApiError(404, 'Unknown product type.');
  const buffer = await buildTemplate(type);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="oncd-${type}-stock-template.xlsx"`);
  res.send(buffer);
}));

router.get('/export/:type', asyncRoute(async (req, res) => {
  const { type } = req.params;
  if (!IMPORT_COLUMN_DEFS[type]) throw new ApiError(404, 'Unknown product type.');

  const idsParam = String(req.query.ids || '').trim();
  let rows;
  let selectedOnly = false;
  if (idsParam) {
    const ids = idsParam.split(',').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0);
    if (!ids.length) throw new ApiError(400, 'No valid product ids were provided.');
    selectedOnly = true;
    const placeholders = ids.map((_, i) => `$${i + 2}`).join(', ');
    rows = await db.all(`SELECT * FROM products WHERE type = $1 AND id IN (${placeholders}) ORDER BY created_at DESC, id DESC`, [type, ...ids]);
  } else {
    rows = await db.all('SELECT * FROM products WHERE type = $1 ORDER BY created_at DESC, id DESC', [type]);
  }
  if (!rows.length) throw new ApiError(400, 'No products to export.');

  const buffer = await buildStockExport(type, rows);
  await writeAudit({
    actor: req.adminUser.full_name,
    action: `Exported ${rows.length} ${type} product(s) to Excel${selectedOnly ? ' (selected)' : ''}`,
    target: `${rows.length} product(s)`,
    module: 'Products',
  });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="oncd-${type}-stock-export${selectedOnly ? '-selected' : ''}.xlsx"`);
  res.send(buffer);
}));

router.post('/import/:type', (req, res, next) => {
  importUpload.single('file')(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: 'File is too large (10MB max).' });
    res.status(400).json({ error: err.message || 'Upload failed.' });
  });
}, asyncRoute(async (req, res) => {
  const { type } = req.params;
  if (!IMPORT_COLUMN_DEFS[type]) throw new ApiError(404, 'Unknown product type.');
  if (!req.file) throw new ApiError(400, 'No file uploaded.');
  const name = (req.file.originalname || '').toLowerCase();
  if (!name.endsWith('.xlsx') && !name.endsWith('.xls')) {
    throw new ApiError(400, 'Please upload an Excel file (.xlsx or .xls).');
  }

  // ?dryRun=1 only validates and reports what WOULD happen (the preview the
  // admin confirms); without it the same file is re-validated and the valid
  // rows are written in ONE transaction — all of them or none.
  const dryRun = req.query.dryRun === '1' || req.query.dryRun === 'true';
  const { topLevelError, results, unknownHeaders, columns } = await importWorkbook(type, req.file.buffer);
  if (topLevelError) throw new ApiError(400, topLevelError);

  const pick = (action) => results.filter((r) => r.ok && r.action === action);
  const creates = pick('create');
  const updates = pick('update');
  const errorRows = results.filter((r) => !r.ok);
  if (!dryRun && (creates.length || updates.length)) {
    await db.transaction((client) => applyImport(type, results, client));
    const rejected = errorRows.length ? `, ${errorRows.length} row(s) rejected` : '';
    await writeAudit({
      actor: req.adminUser.full_name,
      action: `Excel import: ${creates.length} new, ${updates.length} updated ${type} product(s)${rejected}`,
      target: req.file.originalname || 'import.xlsx',
      module: 'Products',
    });
  }

  const brief = (r) => ({ row: r.row, sku: r.sku || '' });
  res.json({
    data: {
      dryRun,
      totalRows: results.length,
      columns,
      unknownHeaders,
      created: creates.length,
      updated: updates.length,
      unchanged: pick('unchanged').length,
      skipped: pick('skip').length,
      rejected: errorRows.length,
      creates: creates.map(brief),
      updates: updates.map((r) => ({ ...brief(r), changed: r.changed, changedText: r.changed.join(', ') })),
      errors: errorRows.map((r) => ({ ...brief(r), messages: r.errors, messageText: r.errors.join(' ') })),
      warnings: results.filter((r) => r.ok && r.warnings && r.warnings.length).map((r) => ({ ...brief(r), messageText: r.warnings.join(' ') })),
    },
  });
}));

// Multer errors (bad file type, too large) land here instead of the generic error handler
// because they're thrown synchronously inside the upload middleware before res is touched.
router.use((err, req, res, next) => {
  if (err && (err.message || '').startsWith('Unsupported file type')) {
    return res.status(400).json({ error: err.message });
  }
  if (err && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({ error: 'File is too large (200MB max).' });
  }
  next(err);
});

module.exports = router;
