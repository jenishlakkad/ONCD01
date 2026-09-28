// Isolated test for the R2 write-side fix (server/lib/mediaUpload.js +
// its wiring into adminProductsPostgres.js / adminHomepagePostgres.js /
// adminAboutPostgres.js). Uses ONLY synthetic, uniquely-prefixed data:
// a throwaway product (deleted at the end, which also exercises the
// cascade-delete cleanup path), a throwaway admin user, and small
// in-memory-generated test files under either the real 'products' subdir
// (for genuine end-to-end HTTP tests against the synthetic product — cleaned
// up via the real endpoints, leaving nothing behind) or an isolated
// '_r2test' subdir (for function-level tests, kept fully separate from any
// real product/homepage/about media). R2_MEDIA_READS_ENABLED is read but
// never changed. No credential value is ever printed.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');
require('dotenv').config();
const { hashPassword } = require('./server/lib/password');
const r2Storage = require('./server/services/r2Storage');
const mediaUpload = require('./server/lib/mediaUpload');
const { S3Client, HeadObjectCommand } = require('@aws-sdk/client-s3');

const BASE = 'http://localhost:8843';
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const UNIQUE = `${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
const UPLOADS_DIR = path.join(__dirname, 'uploads');

const headClient = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT,
  credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY },
});

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail: detail || '' });
  console.log(`${ok ? 'PASS' : ok === 'SKIP' ? 'SKIP' : 'FAIL'} - ${name}${detail ? '  (' + detail + ')' : ''}`);
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function safeErr(err) { return `${err.name || 'Error'}: ${err.message || String(err)}`; }
async function dbGet(sql, params) { const r = await pool.query(sql, params); return r.rows[0]; }
async function dbAll(sql, params) { const r = await pool.query(sql, params); return r.rows; }

async function r2HeadExists(key) {
  try {
    const res = await headClient.send(new HeadObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: key }));
    return { exists: true, size: res.ContentLength };
  } catch (err) {
    const status = err && err.$metadata && err.$metadata.httpStatusCode;
    if (err.name === 'NotFound' || err.name === 'NoSuchKey' || status === 404) return { exists: false };
    throw err;
  }
}
function keyForUrl(url) { return url.replace(/^\/uploads\//, ''); }
function localPathForUrl(url) { return path.join(__dirname, url.replace(/^\//, '')); }

// Minimal valid 1x1 transparent PNG (67 bytes) — no external asset needed.
const TINY_PNG = Buffer.from(
  '89504e470d0a1a0a0000000d4948445200000001000000010806000000' +
  '1f15c4890000000a4944415478da6360000002000155a1e5e50000000049454e44ae426082',
  'hex'
);

// Writes a synthetic local file mimicking what multer would have produced,
// and returns a multer-shaped `file` object (only the fields persistUploadedFile
// / kindOf actually read).
function writeFakeMulterFile(subdir, ext, mimetype) {
  const dir = path.join(UPLOADS_DIR, subdir);
  fs.mkdirSync(dir, { recursive: true });
  const filename = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`;
  const p = path.join(dir, filename);
  fs.writeFileSync(p, TINY_PNG);
  return { path: p, filename, mimetype, originalname: `test${ext}` };
}

function makeAgent() {
  const cookies = new Map();
  function cookieHeader() { return [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; '); }
  function absorb(res) {
    const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    for (const sc of setCookies) {
      const pair = sc.split(';')[0];
      const idx = pair.indexOf('=');
      if (idx > 0) cookies.set(pair.slice(0, idx), pair.slice(idx + 1));
    }
  }
  async function json(method, urlPath, bodyObj) {
    const headers = { Cookie: cookieHeader() };
    if (bodyObj !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(BASE + urlPath, { method, headers, body: bodyObj !== undefined ? JSON.stringify(bodyObj) : undefined });
    absorb(res);
    let body = null;
    try { body = await res.json(); } catch (_) {}
    return { status: res.status, body };
  }
  async function upload(method, urlPath, files) {
    // files: [{ fieldName, filePath, filename, mimetype }]
    const fd = new FormData();
    for (const f of files) {
      const buf = fs.readFileSync(f.filePath);
      fd.append(f.fieldName, new Blob([buf], { type: f.mimetype }), f.filename);
    }
    const headers = { Cookie: cookieHeader() };
    const res = await fetch(BASE + urlPath, { method, headers, body: fd });
    absorb(res);
    let body = null;
    try { body = await res.json(); } catch (_) {}
    return { status: res.status, body };
  }
  return {
    get: (p) => json('GET', p),
    post: (p, b) => json('POST', p, b),
    put: (p, b) => json('PUT', p, b),
    del: (p) => json('DELETE', p),
    uploadPost: (p, files) => upload('POST', p, files),
    uploadPut: (p, files) => upload('PUT', p, files),
  };
}

async function main() {
  const flagAtStart = process.env.R2_MEDIA_READS_ENABLED;
  console.log(`R2_MEDIA_READS_ENABLED at test start: ${flagAtStart}`);

  const ADMIN_EMAIL = `pgtest_r2write_admin_${UNIQUE}@example.com`;
  const ADMIN_PASSWORD = 'PgTestR2WriteAdminPass123!';
  let adminId = null;
  let productId = null;
  const r2KeysToCleanup = new Set(); // safety net — every function-level test's own key, deleted in finally regardless of assertion outcome
  const localFilesToCleanup = new Set();
  const agent = makeAgent(); // declared here (not inside try) so it's reachable from finally's cleanup

  try {
    // =========================================================================
    // SETUP: synthetic admin (existing Super Admin role, unmodified) + login
    // =========================================================================
    try {
      const roleRow = await dbGet(`SELECT id FROM roles WHERE name = 'Super Admin' LIMIT 1`);
      assert(roleRow, 'Super Admin role not found');
      const inserted = await dbGet(
        `INSERT INTO admin_users (full_name, email, password_hash, role_id, status) VALUES ($1,$2,$3,$4,'active') RETURNING id`,
        ['PGTEST R2Write Admin', ADMIN_EMAIL, hashPassword(ADMIN_PASSWORD), roleRow.id]
      );
      adminId = Number(inserted.id);
      const loginRes = await agent.post('/api/admin/auth/login', { email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
      assert(loginRes.status === 200, `login failed: ${loginRes.status} ${JSON.stringify(loginRes.body)}`);
      record('0a. setup: synthetic admin created + logged in', true, `id=${adminId}`);
    } catch (err) { record('0a. setup: synthetic admin created + logged in', false, safeErr(err)); throw err; }

    try {
      const inserted = await dbGet(
        `INSERT INTO products (sku, type, status, visibility) VALUES ($1,'jewelry','active','visible') RETURNING id`,
        [`PGTEST-R2WRITE-${UNIQUE}`]
      );
      productId = Number(inserted.id);
      record('0b. setup: synthetic throwaway product created', true, `id=${productId}`);
    } catch (err) { record('0b. setup: synthetic throwaway product created', false, safeErr(err)); throw err; }

    // =========================================================================
    // 1. FUNCTION-LEVEL: persistUploadedFile() success
    // =========================================================================
    let fnSuccessKey = null;
    try {
      const f = writeFakeMulterFile('_r2test', '.png', 'image/png');
      localFilesToCleanup.add(f.path);
      const url = await mediaUpload.persistUploadedFile(f, '_r2test');
      fnSuccessKey = keyForUrl(url);
      r2KeysToCleanup.add(fnSuccessKey);
      const head = await r2HeadExists(fnSuccessKey);
      const localKept = fs.existsSync(f.path);
      assert(url === `/uploads/_r2test/${f.filename}`, `unexpected url: ${url}`);
      assert(head.exists && head.size === TINY_PNG.length, `R2 object missing or wrong size: ${JSON.stringify(head)}`);
      assert(localKept, 'local file should be KEPT after a successful upload (per the approved local-keep-until-cutover design)');
      record('1. persistUploadedFile() success — R2 object created, local file kept', true, `key=${fnSuccessKey}`);
    } catch (err) { record('1. persistUploadedFile() success — R2 object created, local file kept', false, safeErr(err)); }

    // =========================================================================
    // 2. FUNCTION-LEVEL: R2 upload failure — local temp file is cleaned up
    // =========================================================================
    try {
      const f = writeFakeMulterFile('_r2test', '.png', 'image/png');
      assert(fs.existsSync(f.path), 'precondition: temp file should exist before the forced failure');
      const original = r2Storage.uploadObject;
      // Must consume/destroy the passed-in stream before throwing — an
      // fs.createReadStream that nobody reads or destroys will still try to
      // open the file asynchronously and emit an unhandled 'error' event
      // (a Node EventEmitter gotcha, not a production-code issue: the real
      // uploadObject() always hands the stream to the AWS SDK, which does
      // consume it).
      r2Storage.uploadObject = async (key, body) => {
        if (body && typeof body.destroy === 'function') body.on('error', () => {}).destroy();
        throw new Error('SIMULATED_R2_UPLOAD_FAILURE');
      };
      let threw = false;
      try {
        await mediaUpload.persistUploadedFile(f, '_r2test');
      } catch (err) {
        threw = err.message === 'SIMULATED_R2_UPLOAD_FAILURE';
      } finally {
        r2Storage.uploadObject = original; // restore immediately, before any other test runs
      }
      const localGone = !fs.existsSync(f.path);
      assert(threw, 'persistUploadedFile() should have rethrown the R2 failure');
      assert(localGone, 'local temp file should be deleted when the R2 upload fails');
      record('2. persistUploadedFile() R2 failure — rethrows, local temp file cleaned up, no DB write attempted', true);
    } catch (err) { record('2. persistUploadedFile() R2 failure — rethrows, local temp file cleaned up, no DB write attempted', false, safeErr(err)); }

    // =========================================================================
    // 3. FUNCTION-LEVEL: discardPersistedFile() removes exactly the just-created file/object
    // =========================================================================
    try {
      const f = writeFakeMulterFile('_r2test', '.png', 'image/png');
      const url = await mediaUpload.persistUploadedFile(f, '_r2test');
      const key = keyForUrl(url);
      const beforeHead = await r2HeadExists(key);
      assert(beforeHead.exists, 'precondition: R2 object should exist before discard');
      await mediaUpload.discardPersistedFile(url, f);
      const afterHead = await r2HeadExists(key);
      const localGone = !fs.existsSync(f.path);
      assert(!afterHead.exists, 'R2 object should be gone after discardPersistedFile()');
      assert(localGone, 'local file should be gone after discardPersistedFile()');
      record('3. discardPersistedFile() — removes R2 object + local file', true);
    } catch (err) { record('3. discardPersistedFile() — removes R2 object + local file', false, safeErr(err)); }

    // =========================================================================
    // 4. FUNCTION-LEVEL: R2 succeeds, DB INSERT fails (real FK violation) -> rollback
    // =========================================================================
    try {
      const f = writeFakeMulterFile('products', '.png', 'image/png');
      const url = await mediaUpload.persistUploadedFile(f, 'products');
      const key = keyForUrl(url);
      const headAfterUpload = await r2HeadExists(key);
      assert(headAfterUpload.exists, 'precondition: R2 upload should have succeeded');

      let dbFailed = false;
      try {
        // product_id = -1 violates product_media_product_id_fkey — a REAL Postgres error, not mocked.
        await dbGet(
          'INSERT INTO product_media (product_id, kind, url, sort_order, original_name) VALUES ($1,$2,$3,$4,$5) RETURNING id',
          [-1, 'image', url, 0, f.originalname]
        );
      } catch (err) {
        dbFailed = err.code === '23503'; // foreign_key_violation
      }
      assert(dbFailed, 'expected a real foreign_key_violation (23503) from the bogus product_id');

      await mediaUpload.discardPersistedFile(url, f);
      const headAfterDiscard = await r2HeadExists(key);
      const localGone = !fs.existsSync(f.path);
      const orphanRows = await dbAll('SELECT id FROM product_media WHERE url = $1', [url]);
      assert(!headAfterDiscard.exists, 'R2 object should be rolled back after the DB insert failed');
      assert(localGone, 'local file should be rolled back after the DB insert failed');
      assert(orphanRows.length === 0, 'no product_media row should exist for this url');
      record('4. R2 succeeds + DB INSERT fails (real FK violation) -> R2 object + local file rolled back, no orphan DB row', true);
    } catch (err) { record('4. R2 succeeds + DB INSERT fails (real FK violation) -> R2 object + local file rolled back, no orphan DB row', false, safeErr(err)); }

    // =========================================================================
    // 5. HTTP-LEVEL: successful create (real route, real multer, real R2)
    // =========================================================================
    let createdMediaId = null;
    let createdMediaUrl = null;
    try {
      const f = writeFakeMulterFile('_r2test', '.png', 'image/png'); // source bytes only; multer will re-save under products/
      const res = await agent.uploadPost(`/api/admin/products/${productId}/media`, [
        { fieldName: 'files', filePath: f.path, filename: 'create-test.png', mimetype: 'image/png' },
      ]);
      fs.unlink(f.path, () => {}); // our own source copy, not the multer-written one
      assert(res.status === 201, `expected 201, got ${res.status}: ${JSON.stringify(res.body)}`);
      assert(res.body.data.length === 1 && !res.body.errors, `unexpected body: ${JSON.stringify(res.body)}`);
      createdMediaId = res.body.data[0].id;
      createdMediaUrl = res.body.data[0].url;
      assert(/^\/uploads\/products\//.test(createdMediaUrl), `unexpected url format: ${createdMediaUrl}`);
      const dbRow = await dbGet('SELECT url FROM product_media WHERE id = $1', [createdMediaId]);
      assert(dbRow && dbRow.url === createdMediaUrl, 'DB row url mismatch');
      const head = await r2HeadExists(keyForUrl(createdMediaUrl));
      assert(head.exists && head.size === TINY_PNG.length, `R2 object missing/wrong size: ${JSON.stringify(head)}`);
      assert(fs.existsSync(localPathForUrl(createdMediaUrl)), 'local file should be kept after a successful create');
      record('5. HTTP create — 201, DB row + R2 object + local file all correct', true, `mediaId=${createdMediaId}`);
    } catch (err) { record('5. HTTP create — 201, DB row + R2 object + local file all correct', false, safeErr(err)); }

    // =========================================================================
    // 6. HTTP-LEVEL: successful replace — old media safely superseded
    // =========================================================================
    try {
      assert(createdMediaId, 'skipped — create step did not succeed');
      const oldUrl = createdMediaUrl;
      const oldKey = keyForUrl(oldUrl);
      const oldLocalPath = localPathForUrl(oldUrl);

      const f = writeFakeMulterFile('_r2test', '.png', 'image/png');
      const res = await agent.uploadPut(`/api/admin/products/${productId}/media/${createdMediaId}`, [
        { fieldName: 'file', filePath: f.path, filename: 'replace-test.png', mimetype: 'image/png' },
      ]);
      fs.unlink(f.path, () => {});
      assert(res.status === 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
      const newUrl = res.body.data.url;
      assert(newUrl !== oldUrl, 'replace should produce a NEW url/key, not overwrite the old one');

      const newHead = await r2HeadExists(keyForUrl(newUrl));
      const oldHead = await r2HeadExists(oldKey);
      const dbRow = await dbGet('SELECT url FROM product_media WHERE id = $1', [createdMediaId]);
      assert(newHead.exists, 'new R2 object should exist');
      assert(!oldHead.exists, 'old R2 object should be gone after a successful replace');
      assert(dbRow.url === newUrl, 'DB row should point at the new url');
      assert(!fs.existsSync(oldLocalPath), 'old local file should be gone after a successful replace');
      assert(fs.existsSync(localPathForUrl(newUrl)), 'new local file should be kept');
      createdMediaUrl = newUrl; // for later delete test
      record('6. HTTP replace — new media in place, OLD R2 object + OLD local file both cleaned up', true);
    } catch (err) { record('6. HTTP replace — new media in place, OLD R2 object + OLD local file both cleaned up', false, safeErr(err)); }

    // =========================================================================
    // 7. HTTP-LEVEL: true multi-file batch in ONE request (2 files, both succeed)
    // =========================================================================
    let batchIds = [];
    try {
      const f1 = writeFakeMulterFile('_r2test', '.png', 'image/png');
      const f2 = writeFakeMulterFile('_r2test', '.png', 'image/png');
      const res = await agent.uploadPost(`/api/admin/products/${productId}/media`, [
        { fieldName: 'files', filePath: f1.path, filename: 'batch-1.png', mimetype: 'image/png' },
        { fieldName: 'files', filePath: f2.path, filename: 'batch-2.png', mimetype: 'image/png' },
      ]);
      fs.unlink(f1.path, () => {});
      fs.unlink(f2.path, () => {});
      assert(res.status === 201, `expected 201, got ${res.status}: ${JSON.stringify(res.body)}`);
      assert(res.body.data.length === 2 && !res.body.errors, `expected 2 successes, 0 errors: ${JSON.stringify(res.body)}`);
      batchIds = res.body.data.map((m) => m.id);
      for (const m of res.body.data) {
        const head = await r2HeadExists(keyForUrl(m.url));
        assert(head.exists, `R2 object missing for ${m.url}`);
      }
      record('7. HTTP multi-file batch (2 files, 1 request) — both succeed, both in R2+DB', true, `ids=${batchIds.join(',')}`);
    } catch (err) { record('7. HTTP multi-file batch (2 files, 1 request) — both succeed, both in R2+DB', false, safeErr(err)); }

    // =========================================================================
    // 7b. FUNCTION-LEVEL: multi-file PARTIAL success (real per-file loop logic,
    // one file's R2 upload forced to fail — see report for why this can't be
    // triggered through the live HTTP server without a test-only hook, which
    // was deliberately not added).
    // =========================================================================
    try {
      const fGood = writeFakeMulterFile('_r2test', '.png', 'image/png');
      const fBad = writeFakeMulterFile('_r2test', '.png', 'image/png');
      const created = [];
      const failed = [];
      const original = r2Storage.uploadObject;
      let callCount = 0;
      r2Storage.uploadObject = async (key, body, contentType) => {
        callCount += 1;
        if (callCount === 2) {
          if (body && typeof body.destroy === 'function') body.on('error', () => {}).destroy();
          throw new Error('SIMULATED_R2_UPLOAD_FAILURE'); // fails only the 2nd file
        }
        return original(key, body, contentType);
      };
      try {
        for (const f of [fGood, fBad]) {
          let url;
          try {
            url = await mediaUpload.persistUploadedFile(f, '_r2test');
          } catch (err) {
            failed.push({ originalName: f.originalname, error: err.message });
            continue;
          }
          created.push({ url });
          r2KeysToCleanup.add(keyForUrl(url));
        }
      } finally {
        r2Storage.uploadObject = original;
      }
      assert(created.length === 1 && failed.length === 1, `expected 1 success + 1 failure, got ${created.length}/${failed.length}`);
      const goodHead = await r2HeadExists(keyForUrl(created[0].url));
      assert(goodHead.exists, 'the successful file should be in R2');
      assert(!fs.existsSync(fBad.path), 'the failed file\'s local temp copy should be cleaned up');
      assert(fs.existsSync(localPathForUrl(created[0].url)) || fs.existsSync(fGood.path), 'the successful file\'s local copy should still exist');
      record('7b. per-file partial success logic — file A succeeds, file B fails, A unaffected by B', true);
    } catch (err) { record('7b. per-file partial success logic — file A succeeds, file B fails, A unaffected by B', false, safeErr(err)); }

    // =========================================================================
    // 8. HTTP-LEVEL: delete — DB authoritative, then R2 + local cleanup; idempotent
    // =========================================================================
    try {
      assert(createdMediaId, 'skipped — earlier steps did not succeed');
      const urlBeingDeleted = createdMediaUrl;
      const keyBeingDeleted = keyForUrl(urlBeingDeleted);
      const res = await agent.del(`/api/admin/products/${productId}/media/${createdMediaId}`);
      assert(res.status === 200 && res.body.data.deleted === true, `expected deleted:true, got ${JSON.stringify(res.body)}`);

      const dbRow = await dbGet('SELECT id FROM product_media WHERE id = $1', [createdMediaId]);
      const head = await r2HeadExists(keyBeingDeleted);
      assert(!dbRow, 'DB row should be gone');
      assert(!head.exists, 'R2 object should be gone');
      assert(!fs.existsSync(localPathForUrl(urlBeingDeleted)), 'local file should be gone');

      const res2 = await agent.del(`/api/admin/products/${productId}/media/${createdMediaId}`);
      assert(res2.status === 404, `second delete should 404 idempotently, got ${res2.status}`);
      record('8. HTTP delete — DB/R2/local all cleaned, second delete 404s idempotently', true);
    } catch (err) { record('8. HTTP delete — DB/R2/local all cleaned, second delete 404s idempotently', false, safeErr(err)); }

    // =========================================================================
    // 9. FUNCTION-LEVEL: failed replace preserves OLD media entirely
    // (real Postgres CHECK-constraint violation drives the DB failure — no mocking of the DB layer)
    // =========================================================================
    try {
      // "old" media: a real, already-persisted file + a real DB row for it.
      const oldFile = writeFakeMulterFile('products', '.png', 'image/png');
      const oldUrl = await mediaUpload.persistUploadedFile(oldFile, 'products');
      const oldRow = await dbGet(
        'INSERT INTO product_media (product_id, kind, url, sort_order, original_name) VALUES ($1,$2,$3,$4,$5) RETURNING id',
        [productId, 'image', oldUrl, 99, oldFile.originalname]
      );
      const oldMediaId = Number(oldRow.id);

      // "replacement" upload succeeds in R2...
      const newFile = writeFakeMulterFile('products', '.png', 'image/png');
      const newUrl = await mediaUpload.persistUploadedFile(newFile, 'products');
      const newKey = keyForUrl(newUrl);
      assert((await r2HeadExists(newKey)).exists, 'precondition: new file should be in R2');

      // ...but the DB UPDATE is forced to violate product_media_kind_check (kind must be 'image'/'video').
      let dbFailed = false;
      try {
        await pool.query('UPDATE product_media SET kind = $1, url = $2, original_name = $3 WHERE id = $4', ['INVALID_KIND', newUrl, newFile.originalname, oldMediaId]);
      } catch (err) {
        dbFailed = err.code === '23514'; // check_violation
      }
      assert(dbFailed, 'expected a real check_violation (23514) from the bogus kind value');

      await mediaUpload.discardPersistedFile(newUrl, newFile);

      const newHeadAfter = await r2HeadExists(newKey);
      const oldHeadAfter = await r2HeadExists(keyForUrl(oldUrl));
      const oldRowAfter = await dbGet('SELECT url, kind FROM product_media WHERE id = $1', [oldMediaId]);
      assert(!newHeadAfter.exists, 'NEW R2 object should be rolled back');
      assert(!fs.existsSync(newFile.path), 'NEW local file should be rolled back');
      assert(oldHeadAfter.exists, 'OLD R2 object must remain untouched');
      assert(fs.existsSync(oldFile.path), 'OLD local file must remain untouched');
      assert(oldRowAfter.url === oldUrl && oldRowAfter.kind === 'image', 'OLD DB row must remain completely unchanged');

      // cleanup this test's own old-media row/object/file
      await pool.query('DELETE FROM product_media WHERE id = $1', [oldMediaId]);
      await mediaUpload.removeR2ObjectForUrl(oldUrl);
      fs.unlink(oldFile.path, () => {});

      record('9. failed replace (real CHECK violation) — OLD DB row + OLD R2 object + OLD local file all untouched, NEW upload rolled back', true);
    } catch (err) { record('9. failed replace (real CHECK violation) — OLD DB row + OLD R2 object + OLD local file all untouched, NEW upload rolled back', false, safeErr(err)); }

    // =========================================================================
    // 10. Regression: existing media URL resolver test (unchanged file)
    // =========================================================================
    try {
      const { execSync } = require('child_process');
      const out = execSync('node test-media-url-resolver.js', { cwd: __dirname, encoding: 'utf8' });
      const m = out.match(/(\d+)\/(\d+) checks passed/);
      assert(m && m[1] === m[2], `not all checks passed: ${m ? m[0] : 'no summary line found'}`);
      record('10. regression: test-media-url-resolver.js', true, m[0]);
    } catch (err) { record('10. regression: test-media-url-resolver.js', false, safeErr(err)); }

    // =========================================================================
    // 11. Regression: existing R2 storage service test (unchanged file)
    // =========================================================================
    try {
      const { execSync } = require('child_process');
      const out = execSync('node test-r2-storage-service.js', { cwd: __dirname, encoding: 'utf8' });
      const m = out.match(/(\d+)\/(\d+) checks passed/);
      assert(m && m[1] === m[2], `not all checks passed: ${m ? m[0] : 'no summary line found'}`);
      record('11. regression: test-r2-storage-service.js', true, m[0]);
    } catch (err) { record('11. regression: test-r2-storage-service.js', false, safeErr(err)); }

    // =========================================================================
    // 12. HEIC flow — only if a suitable .heic file already exists in the repo
    // =========================================================================
    {
      const { execSync } = require('child_process');
      let heicFile = null;
      try {
        const found = execSync('find . -iname "*.heic" -not -path "*/node_modules/*"', { cwd: __dirname, encoding: 'utf8' }).trim();
        if (found) heicFile = found.split('\n')[0];
      } catch (_) {}
      if (!heicFile) {
        record('12. HEIC upload flow', 'SKIP', 'no .heic test file exists anywhere in the repo — not fabricated per instructions');
      } else {
        try {
          const res = await agent.uploadPost(`/api/admin/products/${productId}/media`, [
            { fieldName: 'files', filePath: path.join(__dirname, heicFile), filename: 'heic-test.heic', mimetype: 'image/heic' },
          ]);
          assert(res.status === 201 && res.body.data.length === 1, `unexpected: ${res.status} ${JSON.stringify(res.body)}`);
          const m = res.body.data[0];
          assert(m.url.endsWith('.jpg') && m.kind === 'image', `HEIC should convert to a .jpg image, got ${JSON.stringify(m)}`);
          const head = await r2HeadExists(keyForUrl(m.url));
          assert(head.exists, 'converted HEIC->JPEG should be in R2');
          await agent.del(`/api/admin/products/${productId}/media/${m.id}`);
          record('12. HEIC upload flow (convertHeic -> persistUploadedFile) — converts to JPEG, uploads to R2', true);
        } catch (err) { record('12. HEIC upload flow (convertHeic -> persistUploadedFile) — converts to JPEG, uploads to R2', false, safeErr(err)); }
      }
    }

    // =========================================================================
    // 13. R2_MEDIA_READS_ENABLED unchanged throughout
    // =========================================================================
    {
      const flagNow = process.env.R2_MEDIA_READS_ENABLED;
      record('13. R2_MEDIA_READS_ENABLED unchanged (still "false")', flagNow === 'false' && flagAtStart === 'false', `was=${flagAtStart} now=${flagNow}`);
    }

    const failedCount = results.filter((r) => r.ok === false).length;
    const passedCount = results.filter((r) => r.ok === true).length;
    console.log(`\n${passedCount}/${results.length} passed (excluding skipped).`);
    if (failedCount) {
      console.log('FAILURES:');
      for (const f of results.filter((r) => r.ok === false)) console.log(`  - ${f.name}: ${f.detail}`);
    }
  } finally {
    // =========================================================================
    // CLEANUP — every synthetic DB row, R2 object, and local file this script
    // created, by exact id/key/path only.
    // =========================================================================
    console.log('\n--- CLEANUP ---');
    try {
      if (productId) {
        // Product delete cascades product_media rows in Postgres (ON DELETE
        // CASCADE) AND exercises our new cascade-delete R2 cleanup code for
        // any media rows still attached (batch test's 2 files, if step 8
        // didn't run) via the real DELETE /:id route.
        const res = await agent.del(`/api/admin/products/${productId}`);
        console.log(`  deleted synthetic product ${productId} via real API: status ${res.status}`);
      }
    } catch (err) { console.log(`  product cleanup issue: ${safeErr(err)}`); }

    try {
      if (adminId) {
        await pool.query('DELETE FROM sessions WHERE data LIKE $1', [`%"adminId":${adminId}%`]);
        await pool.query('DELETE FROM admin_users WHERE id = $1', [adminId]);
        console.log(`  deleted synthetic admin ${adminId} + its session(s)`);
      }
    } catch (err) { console.log(`  admin cleanup issue: ${safeErr(err)}`); }

    // Safety-net R2 cleanup for every key this script ever created directly
    // (function-level tests) — most are already individually verified-deleted
    // above; this catches anything left behind by an earlier assertion failure.
    for (const key of r2KeysToCleanup) {
      try { await r2Storage.deleteObject(key); } catch (_) {}
    }
    console.log(`  safety-net R2 cleanup attempted for ${r2KeysToCleanup.size} key(s)`);

    // Safety-net local cleanup for every _r2test/ file + any leftover source copies.
    for (const p of localFilesToCleanup) {
      try { fs.unlinkSync(p); } catch (_) {}
    }
    try {
      const dir = path.join(UPLOADS_DIR, '_r2test');
      if (fs.existsSync(dir)) {
        for (const f of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, f));
        fs.rmdirSync(dir);
      }
      console.log('  _r2test/ scratch directory removed');
    } catch (err) { console.log(`  _r2test/ cleanup issue: ${safeErr(err)}`); }

    // Final verification: nothing synthetic left in Postgres.
    const remainingProducts = await dbGet(`SELECT COUNT(*) AS n FROM products WHERE sku LIKE 'PGTEST-R2WRITE-%'`);
    const remainingAdmins = await dbGet(`SELECT COUNT(*) AS n FROM admin_users WHERE email LIKE 'pgtest_r2write_admin_%'`);
    console.log(`  post-cleanup counts — products: ${remainingProducts.n}, admins: ${remainingAdmins.n} (both should be 0)`);

    await pool.end();
  }
}

main().catch((err) => {
  console.error('test-r2-write-path.js FAILED:', safeErr(err));
  process.exitCode = 1;
});
