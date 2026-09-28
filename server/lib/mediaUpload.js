const fs = require('fs');
const path = require('path');
const r2Storage = require('../services/r2Storage');

// Write-side counterpart to server/lib/mediaUrl.js (which only resolves URLs
// at read time). This module is the single place a newly-uploaded local file
// (already written by multer + already HEIC-converted) gets pushed to R2,
// so Cloudflare R2 becomes durable storage for every NEW upload instead of
// Render's ephemeral local disk. R2_MEDIA_READS_ENABLED stays false while
// this ships — this only changes where bytes are WRITTEN, not how URLs are
// read back.
//
// Uploads a local file to R2 under the key matching its intended
// /uploads/<subdir>/<filename> URL. Returns that url string on success.
// Throws on R2 failure — the caller MUST NOT write/update any DB row when
// this throws. On failure the local temp file is removed immediately (it
// never became real media). On SUCCESS the local file is intentionally KEPT
// (not deleted) so express.static('/uploads') keeps serving it exactly as
// today, until R2_MEDIA_READS_ENABLED is separately turned on — at that
// point, and only then, add an fs.unlink() to the success path here too;
// that one-line change is the actual "local disk becomes staging-only"
// cutover, deliberately deferred so this step introduces zero interim
// display regression.
// Awaited (not fire-and-forget) on purpose: "remove the failed temporary
// local file" is a hard requirement for these two failure paths, unlike the
// best-effort local cleanup elsewhere (old media on a successful replace/
// delete), so callers can rely on the file truly being gone by the time
// persistUploadedFile()/discardPersistedFile() returns. Swallows its own
// error (e.g. already gone) so it never masks the real failure being reported.
async function unlinkAwaited(filePath) {
  try {
    await fs.promises.unlink(filePath);
  } catch (_) {
    // already gone / never existed — nothing more to do
  }
}

async function persistUploadedFile(file, subdir) {
  const filename = path.basename(file.path);
  const url = `/uploads/${subdir}/${filename}`;
  const key = `${subdir}/${filename}`;
  try {
    await r2Storage.uploadObject(key, fs.createReadStream(file.path), file.mimetype);
    return url;
  } catch (err) {
    await unlinkAwaited(file.path);
    throw err;
  }
}

// Undoes a just-completed persistUploadedFile() call when the DB write that
// was supposed to follow it fails (R2 succeeded, DB didn't). Removes ONLY
// the file/object that was just created for THIS attempt — never touches any
// other media. The R2 delete is best-effort (never throws — a failure there
// leaves one harmless orphaned object, since no DB row will ever reference
// it either way); the local unlink is awaited, per the hard "delete the new
// local file" requirement.
async function discardPersistedFile(url, file) {
  await removeR2ObjectForUrl(url);
  await unlinkAwaited(file.path);
}

// Best-effort delete of the R2 object behind a stored /uploads/... value.
// Used to clean up superseded media on replace/delete, AFTER the DB write
// that makes the removal authoritative has already committed. Never throws —
// R2 DELETE is idempotent (deleting an already-missing key still succeeds),
// and a failed cleanup just leaves a harmless orphaned object. Logs only
// safe SDK error fields, never a credential.
async function removeR2ObjectForUrl(url) {
  if (!url || typeof url !== 'string' || !url.startsWith('/uploads/')) return;
  try {
    await r2Storage.deleteObject(url.slice('/uploads/'.length));
  } catch (err) {
    console.error(`removeR2ObjectForUrl(${url}):`, err.name || 'Error', '-', err.message || String(err));
  }
}

module.exports = { persistUploadedFile, discardPersistedFile, removeR2ObjectForUrl };
