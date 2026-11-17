const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');
const ffmpegPath = require('ffmpeg-static');

// Hover-preview clips for product cards.
//
// A card plays its product's video on hover. The full video is made for the
// product page (up to 1080px, the whole clip), which is far more than a
// 300px card needs — and older uploads (from before processVideo.js) are
// unprocessed phone files of 10–50 MB. Waiting for those made the hover
// video take seconds to start.
//
// So every video also gets a small companion stored right next to it in R2:
//   products/<file>            -> the video itself (unchanged)
//   products/<file>.preview.mp4 -> ≤480px, first 8 s, no audio, H.264,
//                                  +faststart  (typically 150–600 KB)
// The preview keeps the source's proportions (it is only scaled, never
// cropped), so any saved framing on the original still lines up exactly.
// Cards preload this clip while they're on screen, so hover starts instantly;
// if a preview is missing the card simply falls back to the full video.

const PREVIEW_SUFFIX = '.preview.mp4';
const PREVIEW_MAX_SIDE = 480;
const PREVIEW_SECONDS = 8;

// "/uploads/products/x.mp4" -> "/uploads/products/x.mp4.preview.mp4"
function previewPathFor(storedUrl) {
  if (!storedUrl || typeof storedUrl !== 'string' || !storedUrl.startsWith('/uploads/')) return null;
  if (storedUrl.endsWith(PREVIEW_SUFFIX)) return storedUrl;
  return storedUrl + PREVIEW_SUFFIX;
}

function runFfmpeg(args, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(ffmpegPath, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(String(stderr || err.message).split('\n').filter(Boolean).slice(-3).join(' | ')));
      else resolve();
    });
  });
}

// Builds the preview for a local video file. Returns the new file's path
// (in the OS temp folder); never touches the input.
async function makePreview(inputPath) {
  const { probeIsHdr, HDR_TO_SDR, SDR_TAGS } = require('./processVideo');
  const out = path.join(os.tmpdir(), `oncd-preview-${crypto.randomBytes(6).toString('hex')}.mp4`);
  const even = (expr) => `2*trunc((${expr})/2)`;
  const k = `min(1\\,${PREVIEW_MAX_SIDE}/max(iw\\,ih))`;
  // iPhone HDR clips are tone-mapped, or the preview looks grey and flat.
  const hdr = await probeIsHdr(inputPath);
  const scale = `scale=${even(`iw*${k}`)}:${even(`ih*${k}`)},fps=30,setsar=1`;
  try {
    await runFfmpeg([
      '-hide_banner', '-loglevel', 'error', '-y',
      '-i', inputPath,
      '-t', String(PREVIEW_SECONDS),
      '-map', '0:v:0',
      '-vf', hdr ? `${scale},${HDR_TO_SDR}` : scale,
      '-an',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28',
      '-pix_fmt', 'yuv420p', '-profile:v', 'main',
      ...(hdr ? SDR_TAGS : []),
      '-g', '30',
      '-movflags', '+faststart',
      out,
    ], 2 * 60 * 1000);
    if (!fs.existsSync(out) || fs.statSync(out).size === 0) throw new Error('no output produced');
    return out;
  } catch (err) {
    fs.unlink(out, () => {});
    throw new Error(`Preview failed: ${err.message}`);
  }
}

// Best-effort: build the preview for a just-stored video and upload it next
// to the original. Never throws — a missing preview only means that card
// falls back to the full video.
async function createAndStorePreview(localVideoPath, storedUrl) {
  const previewUrl = previewPathFor(storedUrl);
  if (!previewUrl || !localVideoPath || !fs.existsSync(localVideoPath)) return false;
  let tmp = null;
  try {
    const r2Storage = require('../services/r2Storage');
    tmp = await makePreview(localVideoPath);
    await r2Storage.uploadObject(previewUrl.slice('/uploads/'.length), fs.createReadStream(tmp), 'video/mp4');
    return true;
  } catch (err) {
    console.error('[video-preview]', path.basename(storedUrl), '-', err.message);
    return false;
  } finally {
    if (tmp) fs.unlink(tmp, () => {});
  }
}

// Removes a video's preview from R2 (when the video itself is replaced or
// deleted). Never throws.
async function removePreview(storedUrl) {
  const previewUrl = previewPathFor(storedUrl);
  if (!previewUrl || previewUrl === storedUrl) return;
  try {
    await require('../services/r2Storage').deleteObject(previewUrl.slice('/uploads/'.length));
  } catch (_) { /* best effort */ }
}

module.exports = { previewPathFor, makePreview, createAndStorePreview, removePreview, PREVIEW_SUFFIX };
