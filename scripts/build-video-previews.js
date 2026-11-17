// Builds the small hover-preview clip (see server/lib/videoPreview.js) for
// every product video that doesn't have one yet, and stores it in R2 next to
// the video. Safe to run again at any time: videos that already have a
// preview are skipped. Only ADDS files to R2 — never changes or deletes a
// video, and never writes to the database.
//
//   node scripts/build-video-previews.js            (all missing previews)
//   node scripts/build-video-previews.js --force    (rebuild every preview)
const fs = require('fs');
const os = require('os');
const path = require('path');
const db = require('../server/db/postgres');
const r2 = require('../server/services/r2Storage');
const { previewPathFor, makePreview } = require('../server/lib/videoPreview');

const FORCE = process.argv.includes('--force');
const CONCURRENCY = 3;
const keyOf = (u) => u.slice('/uploads/'.length);

async function one(url) {
  const previewKey = keyOf(previewPathFor(url));
  if (!FORCE && await r2.objectExists(previewKey)) return { url, status: 'exists' };
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'oncd-pv-'));
  const src = path.join(tmpDir, 'source' + (path.extname(url) || '.mp4'));
  let preview = null;
  try {
    const obj = await r2.getObject(keyOf(url));
    await fs.promises.writeFile(src, obj.body);
    preview = await makePreview(src);
    const bytes = fs.statSync(preview).size;
    await r2.uploadObject(previewKey, fs.createReadStream(preview), 'video/mp4');
    return { url, status: 'created', srcMB: fs.statSync(src).size / 1e6, kb: Math.round(bytes / 1024) };
  } catch (err) {
    return { url, status: 'failed', error: err.message };
  } finally {
    if (preview) fs.unlink(preview, () => {});
    fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

(async () => {
  const rows = await db.all(`SELECT DISTINCT url FROM product_media WHERE kind = 'video' AND url LIKE '/uploads/%' ORDER BY url`);
  const urls = rows.map((r) => r.url);
  console.log(`${urls.length} product videos${FORCE ? ' (rebuilding all previews)' : ''}`);
  const results = [];
  let next = 0;
  async function worker() {
    while (next < urls.length) {
      const url = urls[next++];
      const r = await one(url);
      results.push(r);
      const tag = r.status === 'created' ? `created ${r.kb} KB (from ${r.srcMB.toFixed(1)} MB)` : r.status === 'failed' ? `FAILED: ${r.error}` : 'already has a preview';
      console.log(`[${results.length}/${urls.length}] ${path.basename(url)} — ${tag}`);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  const made = results.filter((r) => r.status === 'created');
  const failed = results.filter((r) => r.status === 'failed');
  const avgKb = made.length ? Math.round(made.reduce((a, r) => a + r.kb, 0) / made.length) : 0;
  console.log(`\nDone: ${made.length} created (avg ${avgKb} KB), ${results.length - made.length - failed.length} already existed, ${failed.length} failed.`);
  if (failed.length) failed.forEach((r) => console.log('  failed:', r.url, '-', r.error));
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
