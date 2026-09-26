// Isolated test for server/services/r2Storage.js. Exercises ONLY the new
// helper module — never touches PostgreSQL, SQLite, app.js, any route
// file, or the local uploads/ directory. The one object this script
// creates lives under `_integration-test/` and is deleted in `finally`,
// even if an earlier check fails. No credential/secret value is ever
// printed — only the safe, standard AWS SDK error name/message fields.

const crypto = require('crypto');
const r2 = require('./server/services/r2Storage');

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail: detail || '' });
  console.log(`${ok ? 'PASS' : 'FAIL'} - ${name}${detail ? '  (' + detail + ')' : ''}`);
}
function assert(condition, message) {
  if (!condition) throw new Error(message);
}
function safeErr(err) {
  return `${err.name || 'Error'}: ${err.message || String(err)}`;
}

async function main() {
  const UNIQUE = `${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  const KEY = `_integration-test/pgtest-r2service-${UNIQUE}.txt`;
  const BODY = `PGTEST_R2_STORAGE_SERVICE_${UNIQUE} — safe to delete, created by test-r2-storage-service.js`;
  const CONTENT_TYPE = 'text/plain';

  let uploaded = false;

  try {
    // =========================================================================
    // 1. uploadObject() — create the synthetic object under _integration-test/
    // =========================================================================
    let uploadResult;
    try {
      uploadResult = await r2.uploadObject(KEY, BODY, CONTENT_TYPE);
      uploaded = true;
      assert(uploadResult.key === KEY, `returned key mismatch: ${uploadResult.key}`);
      assert(typeof uploadResult.url === 'string' && uploadResult.url.length > 0, 'uploadObject did not return a url');
      record('1. uploadObject() — object created, returns {key, url}', true, `key=${uploadResult.key}`);
    } catch (err) { record('1. uploadObject() — object created, returns {key, url}', false, safeErr(err)); }

    // =========================================================================
    // 2. objectExists() — true for the object just created
    // =========================================================================
    try {
      assert(uploaded, 'skipped — upload did not succeed');
      const exists = await r2.objectExists(KEY);
      assert(exists === true, `expected true, got ${exists}`);
      record('2. objectExists() — returns true for the uploaded object', true);
    } catch (err) { record('2. objectExists() — returns true for the uploaded object', false, safeErr(err)); }

    // =========================================================================
    // objectExists() — false for a key that was never created (no side effects)
    // =========================================================================
    try {
      const bogusKey = `_integration-test/pgtest-r2service-NEVER-CREATED-${UNIQUE}.txt`;
      const exists = await r2.objectExists(bogusKey);
      assert(exists === false, `expected false for a nonexistent key, got ${exists}`);
      record('2b. objectExists() — returns false for a key that was never created', true);
    } catch (err) { record('2b. objectExists() — returns false for a key that was never created', false, safeErr(err)); }

    // =========================================================================
    // 3. getObject() — read back and verify exact contents + content type
    // =========================================================================
    try {
      assert(uploaded, 'skipped — upload did not succeed');
      const got = await r2.getObject(KEY);
      assert(Buffer.isBuffer(got.body), `expected body to be a Buffer, got ${typeof got.body}`);
      assert(got.body.toString('utf-8') === BODY, 'downloaded content does not match what was uploaded');
      assert(got.contentType === CONTENT_TYPE, `expected contentType "${CONTENT_TYPE}", got "${got.contentType}"`);
      record('3. getObject() — content and contentType match exactly', true, `${got.body.length} bytes`);
    } catch (err) { record('3. getObject() — content and contentType match exactly', false, safeErr(err)); }

    // =========================================================================
    // 4. getPublicUrl() — structure check (base URL + correctly encoded key)
    // =========================================================================
    try {
      const url = r2.getPublicUrl(KEY);
      const base = process.env.R2_PUBLIC_BASE_URL.replace(/\/+$/, '');
      assert(url.startsWith(base + '/'), `url does not start with the configured public base: ${url}`);
      const expectedPath = KEY.split('/').map(encodeURIComponent).join('/');
      assert(url === `${base}/${expectedPath}`, `unexpected url structure: ${url}`);
      // Slashes must remain real path separators, not encoded as %2F.
      assert(!url.includes('%2F') && !url.includes('%2f'), `slash was incorrectly encoded in the URL: ${url}`);
      assert((url.match(/\//g) || []).length === (base.match(/\//g) || []).length + KEY.split('/').length, 'unexpected slash count in generated URL');
      record('4. getPublicUrl() — correct base + correctly encoded key, "/" preserved as path separator', true, url);
    } catch (err) { record('4. getPublicUrl() — correct base + correctly encoded key, "/" preserved as path separator', false, err.message); }

    // =========================================================================
    // getPublicUrl() — a key with special characters is percent-encoded
    // per-segment without mangling the "/" separators.
    // =========================================================================
    try {
      const trickyKey = '_integration-test/space name & special.txt';
      const url = r2.getPublicUrl(trickyKey);
      const base = process.env.R2_PUBLIC_BASE_URL.replace(/\/+$/, '');
      assert(url === `${base}/_integration-test/${encodeURIComponent('space name & special.txt')}`, `unexpected encoding: ${url}`);
      record('4b. getPublicUrl() — special characters within a segment are percent-encoded correctly', true, url);
    } catch (err) { record('4b. getPublicUrl() — special characters within a segment are percent-encoded correctly', false, err.message); }

    // =========================================================================
    // 5. deleteObject() — remove the object
    // =========================================================================
    try {
      assert(uploaded, 'skipped — upload did not succeed');
      await r2.deleteObject(KEY);
      uploaded = false; // deleted via the normal flow — finally's defensive cleanup becomes a no-op
      record('5. deleteObject() — object deleted', true);
    } catch (err) { record('5. deleteObject() — object deleted', false, safeErr(err)); }

    // =========================================================================
    // 6. Verify deletion via objectExists()
    // =========================================================================
    try {
      const exists = await r2.objectExists(KEY);
      assert(exists === false, `expected false after deletion, got ${exists}`);
      record('6. objectExists() — returns false after deletion (confirms cleanup)', true);
    } catch (err) { record('6. objectExists() — returns false after deletion (confirms cleanup)', false, safeErr(err)); }

    // =========================================================================
    // Input validation: reject unsafe/malformed keys, no network call made.
    // =========================================================================
    try {
      const badKeys = ['/leading-slash.jpg', 'a/../b.jpg', 'a//b.jpg', '', 'a/./b.jpg'];
      for (const bad of badKeys) {
        let threw = false;
        try { r2.getPublicUrl(bad); } catch (_) { threw = true; }
        assert(threw, `expected getPublicUrl to reject invalid key: ${JSON.stringify(bad)}`);
      }
      record('7. key validation — rejects leading "/", empty, "." and ".." segments', true);
    } catch (err) { record('7. key validation — rejects leading "/", empty, "." and ".." segments', false, err.message); }

    const failed = results.filter((r) => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
    if (failed.length) {
      console.log('FAILURES:');
      for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`);
      process.exitCode = 1;
    } else {
      console.log('ALL R2 STORAGE SERVICE CHECKS PASSED');
    }
  } finally {
    if (uploaded) {
      try {
        await r2.deleteObject(KEY);
        console.log(`\n--- CLEANUP ---\nDefensive delete of ${KEY} succeeded (a check above had failed before the normal delete step ran).`);
      } catch (err) {
        console.log(`\n--- CLEANUP ---\nDefensive delete of ${KEY} FAILED: ${safeErr(err)} — manual cleanup of this one object may be required.`);
      }
    } else {
      console.log('\n--- CLEANUP ---\nNo defensive cleanup needed — the temporary object was already deleted via the normal flow (or was never successfully created).');
    }
  }
}

main().catch((err) => {
  console.error('test-r2-storage-service.js FAILED:', err.name || 'Error', '-', err.message || String(err));
  process.exitCode = 1;
});
