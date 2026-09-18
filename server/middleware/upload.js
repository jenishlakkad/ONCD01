const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const sharp = require('sharp');
const heicConvert = require('heic-convert');
const env = require('../config/env');
const { ApiError } = require('./errorHandler');

// Extension is the reliable signal here — browsers are wildly inconsistent
// about what `file.mimetype` they report for less-common formats (HEIC in
// particular routinely arrives as "", "application/octet-stream", or some
// vendor string depending on OS/browser), which is why HEIC/MOV uploads were
// being rejected even though they're perfectly normal photo/video files.
// Mimetype is only consulted as a fallback for an extension we don't know.
const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif', '.heic', '.heif', '.bmp', '.tif', '.tiff', '.svg'];
const VIDEO_EXTENSIONS = ['.mp4', '.mov', '.webm', '.avi', '.mkv', '.m4v', '.3gp', '.3gpp', '.wmv', '.mpeg', '.mpg'];
const HEIC_EXTENSIONS = new Set(['.heic', '.heif']);

function destFor(subdir) {
  const dir = path.join(env.uploadsDir, subdir);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function storageFor(subdir) {
  return multer.diskStorage({
    destination: (req, file, cb) => cb(null, destFor(subdir)),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`);
    },
  });
}

function fileFilter(req, file, cb) {
  const ext = path.extname(file.originalname || '').toLowerCase();
  const mime = (file.mimetype || '').toLowerCase();
  const looksLikeImage = IMAGE_EXTENSIONS.includes(ext) || mime.startsWith('image/');
  const looksLikeVideo = VIDEO_EXTENSIONS.includes(ext) || mime.startsWith('video/');
  if (looksLikeImage || looksLikeVideo) return cb(null, true);
  cb(new Error(`Unsupported file type: "${file.originalname}". Please upload a photo (JPG, PNG, WEBP, HEIC, GIF…) or a video (MP4, MOV, WEBM…).`));
}

// Same extension-first, mimetype-fallback logic as fileFilter, so a video
// with an unreliable/blank mimetype (MOV again being the classic case)
// still gets correctly stored as kind="video" and rendered with <video>
// instead of silently ending up as kind="image".
function kindOf(mimetype, filename) {
  const ext = path.extname(filename || '').toLowerCase();
  if (VIDEO_EXTENSIONS.includes(ext)) return 'video';
  if (IMAGE_EXTENSIONS.includes(ext)) return 'image';
  return (mimetype || '').toLowerCase().startsWith('video/') ? 'video' : 'image';
}

function makeUploader(subdir) {
  return multer({
    storage: storageFor(subdir),
    fileFilter,
    limits: { fileSize: 50 * 1024 * 1024 },
  });
}

// Every browser except Safari fails to render HEIC/HEIF in an <img> tag —
// saved as-is, a HEIC photo would look broken to nearly every site visitor
// (and to the admin's own preview thumbnail). Converts it to JPEG right
// after upload so what's actually stored is always viewable everywhere;
// every other format passes through untouched.
//
// sharp/libvips CANNOT do this decode on its own: sharp's prebuilt binaries
// deliberately ship without the HEVC codec (the compression real iPhone
// photos use) over patent-licensing concerns, and fail with "Support for
// this compression format has not been built in" — confirmed by testing
// against a genuine HEVC-coded .heic sample, not assumed. heic-convert
// bundles its own self-contained WASM build of libheif (including the
// open-source de265 HEVC decoder) instead of relying on the host's native
// codec libraries, which is exactly why it succeeds where sharp can't.
// sharp is still used for the final pass — auto-applying EXIF orientation
// (iPhones commonly store photos "as sensed" with a rotation tag rather
// than pre-rotated pixels) and a consistent JPEG re-encode.
async function convertHeicIfNeeded(file) {
  const ext = path.extname(file.originalname || file.path || '').toLowerCase();
  if (!HEIC_EXTENSIONS.has(ext)) return file;
  const jpegPath = file.path.replace(/\.[^.]+$/, '.jpg');
  try {
    const heicBuffer = await fs.promises.readFile(file.path);
    const decoded = await heicConvert({ buffer: heicBuffer, format: 'JPEG', quality: 0.92 });
    await sharp(decoded).rotate().jpeg({ quality: 90 }).toFile(jpegPath);
  } catch (e) {
    fs.unlink(jpegPath, () => {});
    fs.unlink(file.path, () => {});
    throw new ApiError(400, `"${file.originalname}" couldn't be converted from HEIC — the file may be corrupted or from an unsupported camera app. Please re-export it as JPEG from your phone/photo app and try again.`);
  }
  fs.unlink(file.path, () => {});
  file.path = jpegPath;
  file.filename = path.basename(jpegPath);
  file.originalname = file.originalname.replace(/\.[^.]+$/, '.jpg');
  file.mimetype = 'image/jpeg';
  return file;
}

// Express middleware, chained after upload.single(...)/upload.array(...) and
// before the route handler: converts any HEIC file(s) in req.file/req.files
// in place. A conversion failure reaches the client as a normal 400 (via
// the shared ApiError -> errorHandler path) instead of an unusable upload
// silently sitting on disk.
function convertHeic(req, res, next) {
  Promise.resolve()
    .then(async () => {
      if (req.file) req.file = await convertHeicIfNeeded(req.file);
      if (req.files && req.files.length) req.files = await Promise.all(req.files.map(convertHeicIfNeeded));
    })
    .then(() => next())
    .catch(next);
}

module.exports = { makeUploader, kindOf, convertHeic, IMAGE_EXTENSIONS, VIDEO_EXTENSIONS };
