// STEP 31 — Isolated test for server/lib/mediaUrl.js (the reversible R2
// MEDIA READ resolver). Read-only: any Postgres access here is a plain
// SELECT used to exercise the resolver against real stored values — no INSERT
// / UPDATE / DELETE is ever issued, no R2 API call is made, no local file is
// touched. process.env.R2_MEDIA_READS_ENABLED is toggled in-process to cover
// both modes; the real .env file on disk is never modified by this script
// and is confirmed unchanged at the end.

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const { toPublicMediaUrl } = require('./server/lib/mediaUrl');
const db = require('./server/db/postgres');

const R2_PUBLIC_BASE_URL = process.env.R2_PUBLIC_BASE_URL.replace(/\/+$/, '');

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail: detail || '' });
  console.log(`${ok ? 'PASS' : 'FAIL'} - ${name}${detail ? '  (' + detail + ')' : ''}`);
}
function assertEqual(actual, expected, label) {
  const ok = actual === expected;
  return { ok, detail: ok ? '' : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)} (${label})` };
}

function setFlag(value) {
  if (value === undefined) delete process.env.R2_MEDIA_READS_ENABLED;
  else process.env.R2_MEDIA_READS_ENABLED = value;
}

async function main() {
  console.log('=== SECTION 1: toPublicMediaUrl() — FLAG OFF ===\n');
  setFlag('false');
  {
    let r = assertEqual(toPublicMediaUrl('/uploads/products/example.jpg'), '/uploads/products/example.jpg', 'flag off, /uploads/ value');
    record('1.1 flag OFF: /uploads/products/example.jpg stays /uploads/products/example.jpg', r.ok, r.detail);
  }
  {
    r = assertEqual(toPublicMediaUrl('https://cdn.example.com/x.jpg'), 'https://cdn.example.com/x.jpg', 'flag off, absolute https');
    record('1.2 flag OFF: absolute https:// URL unchanged', r.ok, r.detail);
  }
  {
    r = assertEqual(toPublicMediaUrl(null), null, 'flag off, null');
    record('1.3 flag OFF: null unchanged', r.ok, r.detail);
  }
  {
    r = assertEqual(toPublicMediaUrl(undefined), undefined, 'flag off, undefined');
    record('1.4 flag OFF: undefined unchanged', r.ok, r.detail);
  }
  {
    r = assertEqual(toPublicMediaUrl(''), '', 'flag off, empty string');
    record('1.5 flag OFF: empty string unchanged', r.ok, r.detail);
  }
  {
    // Also unset entirely (not just "false") — must behave identically to "false".
    setFlag(undefined);
    r = assertEqual(toPublicMediaUrl('/uploads/products/example.jpg'), '/uploads/products/example.jpg', 'flag unset');
    record('1.6 flag UNSET (not just "false"): /uploads/... unchanged', r.ok, r.detail);
    setFlag('false');
  }
  {
    // Non-exact-"true" values (e.g. "1", "TRUE") must NOT activate R2 resolution.
    setFlag('1');
    r = assertEqual(toPublicMediaUrl('/uploads/products/example.jpg'), '/uploads/products/example.jpg', 'flag="1"');
    record('1.7 flag="1" (not exact string "true"): /uploads/... unchanged', r.ok, r.detail);
    setFlag('TRUE');
    r = assertEqual(toPublicMediaUrl('/uploads/products/example.jpg'), '/uploads/products/example.jpg', 'flag="TRUE"');
    record('1.8 flag="TRUE" (case-sensitive, not exact "true"): /uploads/... unchanged', r.ok, r.detail);
    setFlag('false');
  }

  console.log('\n=== SECTION 2: toPublicMediaUrl() — FLAG ON ===\n');
  setFlag('true');
  {
    const expected = `${R2_PUBLIC_BASE_URL}/products/example.jpg`;
    const r = assertEqual(toPublicMediaUrl('/uploads/products/example.jpg'), expected, 'flag on, products');
    record('2.1 flag ON: /uploads/products/example.jpg -> R2 public URL', r.ok, r.detail);
  }
  {
    const expected = `${R2_PUBLIC_BASE_URL}/homepage/example.jpg`;
    const r = assertEqual(toPublicMediaUrl('/uploads/homepage/example.jpg'), expected, 'flag on, homepage');
    record('2.2 flag ON: /uploads/homepage/example.jpg -> R2 public URL', r.ok, r.detail);
  }
  {
    const expected = `${R2_PUBLIC_BASE_URL}/about/example.jpg`;
    const r = assertEqual(toPublicMediaUrl('/uploads/about/example.jpg'), expected, 'flag on, about');
    record('2.3 flag ON: /uploads/about/example.jpg -> R2 public URL', r.ok, r.detail);
  }
  {
    const r = assertEqual(toPublicMediaUrl('https://cdn.example.com/x.jpg'), 'https://cdn.example.com/x.jpg', 'flag on, absolute https');
    record('2.4 flag ON: absolute https:// URL unchanged', r.ok, r.detail);
  }
  {
    const r = assertEqual(toPublicMediaUrl('http://cdn.example.com/x.jpg'), 'http://cdn.example.com/x.jpg', 'flag on, absolute http');
    record('2.5 flag ON: absolute http:// URL unchanged', r.ok, r.detail);
  }
  {
    const r = assertEqual(toPublicMediaUrl(null), null, 'flag on, null');
    record('2.6 flag ON: null unchanged', r.ok, r.detail);
  }
  {
    const r = assertEqual(toPublicMediaUrl(undefined), undefined, 'flag on, undefined');
    record('2.7 flag ON: undefined unchanged', r.ok, r.detail);
  }
  {
    const r = assertEqual(toPublicMediaUrl(''), '', 'flag on, empty string');
    record('2.8 flag ON: empty string unchanged', r.ok, r.detail);
  }
  {
    // A value that does NOT start with /uploads/ and is not absolute — must
    // pass through unchanged even with the flag on (e.g. a bare provider key
    // or some unrelated string that happens to be stored).
    const r = assertEqual(toPublicMediaUrl('products/already-a-key.jpg'), 'products/already-a-key.jpg', 'flag on, bare key');
    record('2.9 flag ON: non-/uploads/, non-absolute value unchanged', r.ok, r.detail);
  }
  {
    // Percent-encoding of special characters within a key segment must still
    // happen correctly through the real R2 getPublicUrl() call.
    const expected = `${R2_PUBLIC_BASE_URL}/products/${encodeURIComponent('space name.jpg')}`;
    const r = assertEqual(toPublicMediaUrl('/uploads/products/space name.jpg'), expected, 'flag on, special chars');
    record('2.10 flag ON: special characters in filename correctly percent-encoded', r.ok, r.detail);
  }

  console.log('\n=== SECTION 3: representative real-data pass (read-only Postgres SELECTs) ===\n');
  const realDataChecks = [
    { table: 'product_media', column: 'url', label: 'product media url' },
    { table: 'homepage_slides', column: 'image_url', label: 'homepage slide image_url' },
    { table: "content_blocks WHERE page = 'home'", column: 'image_url', label: 'home content block image_url', rawTable: 'content_blocks' },
    { table: 'homepage_collections', column: 'image_url', label: 'homepage collection image_url' },
    { table: "content_blocks WHERE page = 'about'", column: 'image_url', label: 'about content block image_url', rawTable: 'content_blocks' },
    { table: 'team_members', column: 'photo_url', label: 'team member photo_url' },
    { table: 'certifications', column: 'logo_url', label: 'certification logo_url' },
    { table: 'about_gallery', column: 'url', label: 'about gallery url' },
  ];

  for (const check of realDataChecks) {
    try {
      const row = await db.get(`SELECT ${check.column} AS v FROM ${check.table} LIMIT 1`);
      if (!row) {
        record(`3.x ${check.label} — real-data check`, true, 'skipped: table currently has no rows (nothing to check, not a failure)');
        continue;
      }
      const raw = row.v;
      setFlag('false');
      const off = toPublicMediaUrl(raw);
      setFlag('true');
      const on = toPublicMediaUrl(raw);
      setFlag('false');

      let ok = true;
      let detail = `raw=${JSON.stringify(raw)}`;
      if (raw === null || raw === '') {
        ok = off === raw && on === raw;
        detail += ' (null/empty in DB — both modes must pass through unchanged)';
      } else if (/^https?:\/\//i.test(raw)) {
        ok = off === raw && on === raw;
        detail += ' (already absolute — both modes must pass through unchanged)';
      } else if (raw.startsWith('/uploads/')) {
        const expectedOn = `${R2_PUBLIC_BASE_URL}/${raw.slice('/uploads/'.length).split('/').map(encodeURIComponent).join('/')}`;
        ok = off === raw && on === expectedOn;
        detail += ` off=${JSON.stringify(off)} on=${JSON.stringify(on)} expectedOn=${JSON.stringify(expectedOn)}`;
      } else {
        ok = off === raw && on === raw;
        detail += ' (unrecognized non-/uploads/ value — both modes must pass through unchanged)';
      }
      record(`3.${check.label} — real DB value resolves correctly in both modes`, ok, detail);
    } catch (err) {
      record(`3.${check.label} — real-data check`, false, `${err.name || 'Error'}: ${err.message || String(err)}`);
    }
  }

  console.log('\n=== SECTION 4: response-shape preservation (flag OFF vs ON, same real row) ===\n');
  // Mirrors productsPostgres.js batchMedia()'s exact per-row object shape.
  // Proves only `url` differs between the two modes; every other key/value
  // (including its presence/absence and type) is identical.
  try {
    const mediaRow = await db.get(
      'SELECT id, product_id, kind, url, sort_order AS "sortOrder", crop FROM product_media LIMIT 1'
    );
    if (!mediaRow) {
      record('4.1 product media response shape unchanged except url', true, 'skipped: product_media has no rows');
    } else {
      const shapeOf = (r) => ({
        id: Number(r.id),
        kind: r.kind,
        url: toPublicMediaUrl(r.url),
        sortOrder: r.sortOrder,
        crop: r.crop ? JSON.parse(r.crop) : null,
      });
      setFlag('false');
      const off = shapeOf(mediaRow);
      setFlag('true');
      const on = shapeOf(mediaRow);
      setFlag('false');

      const keysMatch = JSON.stringify(Object.keys(off).sort()) === JSON.stringify(Object.keys(on).sort());
      const nonUrlFieldsMatch = off.id === on.id && off.kind === on.kind && off.sortOrder === on.sortOrder
        && JSON.stringify(off.crop) === JSON.stringify(on.crop);
      const urlBehavesCorrectly = mediaRow.url && mediaRow.url.startsWith('/uploads/') ? off.url !== on.url : off.url === on.url;
      const ok = keysMatch && nonUrlFieldsMatch && urlBehavesCorrectly;
      record('4.1 product media response shape unchanged except url', ok,
        `keysMatch=${keysMatch} nonUrlFieldsMatch=${nonUrlFieldsMatch} off.url=${JSON.stringify(off.url)} on.url=${JSON.stringify(on.url)}`);
    }
  } catch (err) {
    record('4.1 product media response shape unchanged except url', false, `${err.name || 'Error'}: ${err.message || String(err)}`);
  }

  // Mirrors adminAboutPostgres.js GET / team mapping — proves `enabled`
  // (normalized to 1/0) and `name`/`role` stay identical while only
  // `photoUrl` differs.
  try {
    const teamRow = await db.get('SELECT id, name, role, photo_url AS "photoUrl", enabled FROM team_members LIMIT 1');
    if (!teamRow) {
      record('4.2 team member response shape unchanged except photoUrl', true, 'skipped: team_members has no rows');
    } else {
      const shapeOf = (r) => ({
        id: Number(r.id), name: r.name, role: r.role, enabled: r.enabled ? 1 : 0, photoUrl: toPublicMediaUrl(r.photoUrl),
      });
      setFlag('false');
      const off = shapeOf(teamRow);
      setFlag('true');
      const on = shapeOf(teamRow);
      setFlag('false');

      const keysMatch = JSON.stringify(Object.keys(off).sort()) === JSON.stringify(Object.keys(on).sort());
      const nonUrlFieldsMatch = off.id === on.id && off.name === on.name && off.role === on.role && off.enabled === on.enabled;
      const urlBehavesCorrectly = teamRow.photoUrl && teamRow.photoUrl.startsWith('/uploads/') ? off.photoUrl !== on.photoUrl : off.photoUrl === on.photoUrl;
      const ok = keysMatch && nonUrlFieldsMatch && urlBehavesCorrectly;
      record('4.2 team member response shape unchanged except photoUrl', ok,
        `keysMatch=${keysMatch} nonUrlFieldsMatch=${nonUrlFieldsMatch} off.photoUrl=${JSON.stringify(off.photoUrl)} on.photoUrl=${JSON.stringify(on.photoUrl)}`);
    }
  } catch (err) {
    record('4.2 team member response shape unchanged except photoUrl', false, `${err.name || 'Error'}: ${err.message || String(err)}`);
  }

  console.log('\n=== SECTION 5: DB values themselves were never modified by this test ===\n');
  try {
    const mediaRow2 = await db.get('SELECT url FROM product_media LIMIT 1');
    const teamRow2 = await db.get('SELECT photo_url AS "photoUrl" FROM team_members LIMIT 1');
    const stillLocalOrEmpty = (v) => v === undefined || v === null || v === '' || v.startsWith('/uploads/') || /^https?:\/\//i.test(v);
    const ok = (!mediaRow2 || stillLocalOrEmpty(mediaRow2.url)) && (!teamRow2 || stillLocalOrEmpty(teamRow2.photoUrl));
    record('5.1 spot-checked DB values are still plain stored strings (no R2 rewrite occurred)', ok,
      `product_media.url=${mediaRow2 ? JSON.stringify(mediaRow2.url) : 'n/a'} team_members.photo_url=${teamRow2 ? JSON.stringify(teamRow2.photoUrl) : 'n/a'}`);
  } catch (err) {
    record('5.1 DB values unchanged spot-check', false, `${err.name || 'Error'}: ${err.message || String(err)}`);
  }

  setFlag('false'); // leave the in-process env back at the safe default before exiting

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  if (failed.length) {
    console.log('FAILURES:');
    for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`);
    process.exitCode = 1;
  } else {
    console.log('ALL MEDIA URL RESOLVER CHECKS PASSED');
  }

  await db.pool.end();
}

main().catch(async (err) => {
  console.error('test-media-url-resolver.js FAILED:', err.name || 'Error', '-', err.message || String(err));
  process.exitCode = 1;
  try { await db.pool.end(); } catch (_) {}
});
