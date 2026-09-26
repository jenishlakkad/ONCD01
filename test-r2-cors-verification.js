// STEP 30 — Read-only verification of the Cloudflare R2 bucket's CORS policy.
// Sends 3 minimal GET requests (one per Origin header) against a SINGLE
// already-migrated public image URL. Response headers only are inspected;
// each response body is aborted immediately after headers arrive — no file
// is downloaded. Makes NO R2 API (S3) calls, NO uploads/deletes, and never
// touches PostgreSQL, SQLite, app.js, routes, uploads/, the manifest, or the
// checkpoint. No credential value is ever printed.

const fs = require('fs');
const path = require('path');
const https = require('https');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const r2 = require('./server/services/r2Storage');

const MANIFEST_PATH = path.join(__dirname, 'migration', 'media-migration-manifest.json');

const ORIGINS = [
  { origin: 'http://localhost:8843', expectAllowed: true, label: 'local dev' },
  { origin: 'https://oncd01.onrender.com', expectAllowed: true, label: 'production' },
  { origin: 'https://example.com', expectAllowed: false, label: 'untrusted third party' },
];

function loadManifest() {
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
}

// Same eligibility rule used by the uploader/Step 27 verification: unique,
// existing, non-orphan — i.e. an entry that was actually migrated to R2.
function pickOneImage(manifest) {
  const orphanKeys = new Set((manifest.orphanLocalFiles || []).map((o) => o.proposedR2Key));
  const orphanPaths = new Set((manifest.orphanLocalFiles || []).map((o) => o.relativePath));
  for (const entry of manifest.entries) {
    if (!entry.fileExists) continue;
    if (entry.mediaType !== 'image') continue;
    if (orphanKeys.has(entry.proposedR2Key) || orphanPaths.has(entry.dbValue)) continue;
    return entry;
  }
  throw new Error('No eligible migrated image found in the manifest.');
}

function requestWithOrigin(url, origin) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method: 'GET', headers: { Origin: origin } }, (res) => {
      const headers = res.headers;
      res.destroy(); // abort the body immediately — headers are all we need
      resolve({
        status: res.statusCode,
        accessControlAllowOrigin: headers['access-control-allow-origin'] ?? null,
        accessControlAllowMethods: headers['access-control-allow-methods'] ?? null,
        accessControlAllowHeaders: headers['access-control-allow-headers'] ?? null,
        accessControlExposeHeaders: headers['access-control-expose-headers'] ?? null,
        vary: headers['vary'] ?? null,
        contentType: headers['content-type'] ?? null,
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function main() {
  const manifest = loadManifest();
  const entry = pickOneImage(manifest);
  const url = r2.getPublicUrl(entry.proposedR2Key);

  console.log('=== STEP 30 — R2 CORS POLICY VERIFICATION (read-only) ===');
  console.log(`Testing single migrated image key: ${entry.proposedR2Key}`);
  console.log('(Public URL used for requests below is not a secret; no credential is printed.)\n');

  const results = [];
  for (const { origin, expectAllowed, label } of ORIGINS) {
    console.log(`--- Origin: ${origin} (${label}) ---`);
    try {
      const r = await requestWithOrigin(url, origin);
      const acao = r.accessControlAllowOrigin;
      const originIsExactlyAllowed = acao === origin;
      const originIsWildcardAllowed = acao === '*';
      const originAuthorized = originIsExactlyAllowed || originIsWildcardAllowed;

      console.log(`  HTTP status: ${r.status}`);
      console.log(`  Access-Control-Allow-Origin: ${acao === null ? '(not present)' : acao}`);
      console.log(`  Access-Control-Allow-Methods: ${r.accessControlAllowMethods === null ? '(not present)' : r.accessControlAllowMethods}`);
      console.log(`  Access-Control-Allow-Headers: ${r.accessControlAllowHeaders === null ? '(not present)' : r.accessControlAllowHeaders}`);
      console.log(`  Access-Control-Expose-Headers: ${r.accessControlExposeHeaders === null ? '(not present)' : r.accessControlExposeHeaders}`);
      console.log(`  Vary: ${r.vary === null ? '(not present)' : r.vary}`);
      console.log(`  Content-Type: ${r.contentType}`);

      let ok;
      let note;
      if (expectAllowed) {
        ok = r.status === 200 && originAuthorized;
        note = originIsWildcardAllowed
          ? 'ACAO is a wildcard ("*") — technically authorizes this origin, but also authorizes every other origin (see the untrusted-origin test below).'
          : (originIsExactlyAllowed ? 'ACAO exactly echoes this Origin — correctly scoped.' : 'ACAO does not match this origin — GET would be blocked by CORS in a real browser for cross-origin script/fetch access.');
      } else {
        ok = r.status === 200 && !originAuthorized;
        note = originAuthorized
          ? 'CORS FAILURE RISK: this untrusted origin IS authorized by Access-Control-Allow-Origin.'
          : 'Correctly NOT authorized for cross-origin script access (the object may still be publicly fetchable as a plain resource — that is expected and unrelated to CORS).';
      }
      console.log(`  -> ${ok ? 'PASS' : 'FAIL'}: ${note}\n`);
      results.push({ origin, label, expectAllowed, ok, ...r });
    } catch (err) {
      console.log(`  ERROR: ${err.name || 'Error'}: ${err.message || String(err)}\n`);
      results.push({ origin, label, expectAllowed, ok: false, error: `${err.name || 'Error'}: ${err.message || String(err)}` });
    }
  }

  const failed = results.filter((r) => !r.ok);
  console.log('=== SUMMARY ===');
  for (const r of results) {
    console.log(`  ${r.origin}: ${r.ok ? 'PASS' : 'FAIL'} (ACAO=${r.accessControlAllowOrigin === undefined ? 'n/a' : r.accessControlAllowOrigin})`);
  }
  if (failed.length) {
    console.log(`\n${failed.length}/${results.length} checks FAILED.`);
    process.exitCode = 1;
  } else {
    console.log('\nALL CORS CHECKS PASSED.');
  }
}

main().catch((err) => {
  console.error('test-r2-cors-verification.js FAILED:', err.name || 'Error', '-', err.message || String(err));
  process.exitCode = 1;
});
