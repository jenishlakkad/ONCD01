// Isolated end-to-end test for the "no video with audio" requirement.
// Uses ONLY synthetic data: a throwaway admin, a throwaway product, and two
// synthetic test videos generated entirely offline via ffmpeg's own lavfi
// test sources (no external asset). Uploads through the REAL HTTP create and
// replace endpoints, then downloads the resulting R2 object to verify it has
// no audio stream. Everything synthetic is deleted in `finally`.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');
const { execFile } = require('child_process');
require('dotenv').config();
const { hashPassword } = require('./server/lib/password');
const r2Storage = require('./server/services/r2Storage');
const ffmpegPath = require('ffmpeg-static');

const BASE = 'http://localhost:8843';
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const UNIQUE = `${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
const TMP_DIR = path.join(__dirname, '_audiostrip-e2e-test');

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail: detail || '' });
  console.log(`${ok ? 'PASS' : 'FAIL'} - ${name}${detail ? '  (' + detail + ')' : ''}`);
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function safeErr(err) { return `${err.name || 'Error'}: ${err.message || String(err)}`; }
async function dbGet(sql, params) { const r = await pool.query(sql, params); return r.rows[0]; }

function generateTestVideo(outPath, { withAudio, colorSeed }) {
  return new Promise((resolve, reject) => {
    const args = ['-y', '-f', 'lavfi', '-i', `testsrc=duration=1:size=320x240:rate=10:decimals=2`];
    if (withAudio) args.push('-f', 'lavfi', '-i', `sine=frequency=${colorSeed || 440}:duration=1`);
    args.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p');
    if (withAudio) args.push('-c:a', 'aac', '-shortest');
    args.push(outPath);
    execFile(ffmpegPath, args, (err, stdout, stderr) => {
      if (err) { reject(new Error(`generateTestVideo failed: ${err.message}\n${stderr}`)); return; }
      resolve();
    });
  });
}

function hasAudioStream(filePath) {
  return new Promise((resolve) => {
    execFile(ffmpegPath, ['-i', filePath], (err, stdout, stderr) => {
      resolve(/Stream.*Audio/.test(stderr)); // ffmpeg -i with no output always exits non-zero; stderr still has stream info
    });
  });
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
    post: (p, b) => json('POST', p, b),
    del: (p) => json('DELETE', p),
    uploadPost: (p, files) => upload('POST', p, files),
    uploadPut: (p, files) => upload('PUT', p, files),
  };
}

async function main() {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  const ADMIN_EMAIL = `pgtest_audiostrip_admin_${UNIQUE}@example.com`;
  const ADMIN_PASSWORD = 'PgTestAudioStripAdminPass123!';
  let adminId = null;
  let productId = null;
  const agent = makeAgent();

  try {
    // Setup
    try {
      const roleRow = await dbGet(`SELECT id FROM roles WHERE name = 'Super Admin' LIMIT 1`);
      assert(roleRow, 'Super Admin role not found');
      const inserted = await dbGet(
        `INSERT INTO admin_users (full_name, email, password_hash, role_id, status) VALUES ($1,$2,$3,$4,'active') RETURNING id`,
        ['PGTEST AudioStrip Admin', ADMIN_EMAIL, hashPassword(ADMIN_PASSWORD), roleRow.id]
      );
      adminId = Number(inserted.id);
      const loginRes = await agent.post('/api/admin/auth/login', { email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
      assert(loginRes.status === 200, `login failed: ${loginRes.status}`);
      record('0a. setup: synthetic admin created + logged in', true, `id=${adminId}`);
    } catch (err) { record('0a. setup: synthetic admin created + logged in', false, safeErr(err)); throw err; }

    try {
      const inserted = await dbGet(
        `INSERT INTO products (sku, type, status, visibility) VALUES ($1,'jewelry','active','visible') RETURNING id`,
        [`PGTEST-AUDIOSTRIP-${UNIQUE}`]
      );
      productId = Number(inserted.id);
      record('0b. setup: synthetic throwaway product created', true, `id=${productId}`);
    } catch (err) { record('0b. setup: synthetic throwaway product created', false, safeErr(err)); throw err; }

    // Generate two synthetic test videos WITH audio (offline, no external asset)
    const videoA = path.join(TMP_DIR, 'a-with-audio.mp4');
    const videoB = path.join(TMP_DIR, 'b-with-audio.mp4');
    await generateTestVideo(videoA, { withAudio: true, colorSeed: 440 });
    await generateTestVideo(videoB, { withAudio: true, colorSeed: 880 });
    const aHadAudio = await hasAudioStream(videoA);
    const bHadAudio = await hasAudioStream(videoB);
    record('0c. setup: two synthetic source videos generated, both WITH audio', aHadAudio && bHadAudio, `A=${aHadAudio} B=${bHadAudio}`);

    // 1. CREATE — upload video A via the real endpoint
    let mediaId = null;
    let mediaUrl = null;
    try {
      const res = await agent.uploadPost(`/api/admin/products/${productId}/media`, [
        { fieldName: 'files', filePath: videoA, filename: 'clip-a.mp4', mimetype: 'video/mp4' },
      ]);
      assert(res.status === 201, `expected 201, got ${res.status}: ${JSON.stringify(res.body)}`);
      assert(res.body.data.length === 1 && !res.body.errors, `unexpected body: ${JSON.stringify(res.body)}`);
      mediaId = res.body.data[0].id;
      mediaUrl = res.body.data[0].url;
      assert(res.body.data[0].kind === 'video', 'expected kind=video');
      record('1. HTTP create — video with audio uploaded successfully (201)', true, `mediaId=${mediaId}`);
    } catch (err) { record('1. HTTP create — video with audio uploaded successfully (201)', false, safeErr(err)); }

    // 2. Verify the R2 object (the actual stored file) has NO audio
    try {
      assert(mediaUrl, 'skipped — create did not succeed');
      const key = mediaUrl.replace(/^\/uploads\//, '');
      const { body } = await r2Storage.getObject(key);
      const downloadedPath = path.join(TMP_DIR, 'downloaded-from-r2.mp4');
      fs.writeFileSync(downloadedPath, body);
      const stillHasAudio = await hasAudioStream(downloadedPath);
      assert(!stillHasAudio, 'the R2-stored file still has an audio stream — strip failed');
      record('2. R2-stored file (create path) has NO audio stream', true);
    } catch (err) { record('2. R2-stored file (create path) has NO audio stream', false, safeErr(err)); }

    // 3. Verify the local kept copy also has NO audio (same file, but confirms local-disk path too)
    try {
      assert(mediaUrl, 'skipped — create did not succeed');
      const localPath = path.join(__dirname, mediaUrl.replace(/^\//, ''));
      assert(fs.existsSync(localPath), 'local file should exist (kept after successful upload)');
      const stillHasAudio = await hasAudioStream(localPath);
      assert(!stillHasAudio, 'the local kept file still has an audio stream');
      record('3. Local kept file (create path) has NO audio stream', true);
    } catch (err) { record('3. Local kept file (create path) has NO audio stream', false, safeErr(err)); }

    // 4. REPLACE — upload video B (also with audio) as a replacement
    let newMediaUrl = null;
    try {
      assert(mediaId, 'skipped — create did not succeed');
      const res = await agent.uploadPut(`/api/admin/products/${productId}/media/${mediaId}`, [
        { fieldName: 'file', filePath: videoB, filename: 'clip-b.mp4', mimetype: 'video/mp4' },
      ]);
      assert(res.status === 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
      newMediaUrl = res.body.data.url;
      record('4. HTTP replace — new video with audio uploaded successfully (200)', true);
    } catch (err) { record('4. HTTP replace — new video with audio uploaded successfully (200)', false, safeErr(err)); }

    // 5. Verify the REPLACED R2 object also has no audio
    try {
      assert(newMediaUrl, 'skipped — replace did not succeed');
      const key = newMediaUrl.replace(/^\/uploads\//, '');
      const { body } = await r2Storage.getObject(key);
      const downloadedPath = path.join(TMP_DIR, 'downloaded-replacement.mp4');
      fs.writeFileSync(downloadedPath, body);
      const stillHasAudio = await hasAudioStream(downloadedPath);
      assert(!stillHasAudio, 'the replaced R2-stored file still has an audio stream');
      record('5. R2-stored file (replace path) has NO audio stream', true);
    } catch (err) { record('5. R2-stored file (replace path) has NO audio stream', false, safeErr(err)); }

    // 6. Video content is preserved (not corrupted) — the stripped file should still be a playable video with a video stream
    try {
      assert(newMediaUrl, 'skipped — replace did not succeed');
      const localPath = path.join(__dirname, newMediaUrl.replace(/^\//, ''));
      const hasVideo = await new Promise((resolve) => {
        execFile(ffmpegPath, ['-i', localPath], (err, stdout, stderr) => resolve(/Stream.*Video/.test(stderr)));
      });
      assert(hasVideo, 'the stripped file should still have its video stream intact');
      record('6. Video stream intact after audio-strip (not corrupted)', true);
    } catch (err) { record('6. Video stream intact after audio-strip (not corrupted)', false, safeErr(err)); }

    const failedCount = results.filter((r) => r.ok === false).length;
    console.log(`\n${results.length - failedCount}/${results.length} passed.`);
    if (failedCount) {
      console.log('FAILURES:');
      for (const f of results.filter((r) => !r.ok)) console.log(`  - ${f.name}: ${f.detail}`);
    }
  } finally {
    console.log('\n--- CLEANUP ---');
    try {
      if (productId) {
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
    try {
      fs.rmSync(TMP_DIR, { recursive: true, force: true });
      console.log('  removed local test-video scratch directory');
    } catch (err) { console.log(`  scratch cleanup issue: ${safeErr(err)}`); }

    const remainingProducts = await dbGet(`SELECT COUNT(*) AS n FROM products WHERE sku LIKE 'PGTEST-AUDIOSTRIP-%'`);
    const remainingAdmins = await dbGet(`SELECT COUNT(*) AS n FROM admin_users WHERE email LIKE 'pgtest_audiostrip_admin_%'`);
    console.log(`  post-cleanup counts — products: ${remainingProducts.n}, admins: ${remainingAdmins.n} (both should be 0)`);
    await pool.end();
  }
}

main().catch((err) => {
  console.error('test-video-audio-strip.js FAILED:', safeErr(err));
  process.exitCode = 1;
});
