const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const ffmpegPath = require('ffmpeg-static');

// Every product video goes through here once, on upload (or when the admin
// re-frames it): ONE ffmpeg pass that
//   - crops to the chosen frame — by default a centered square, which for a
//     9:16 phone clip is the middle of the video vertically, where the stone
//     is filmed;
//   - scales down to at most 1080px (plenty for a product card or gallery);
//   - drops the audio track entirely;
//   - re-encodes to H.264 MP4 (plays on every browser, iPhone included) with
//     +faststart so playback starts before the whole file has downloaded.
// A 10s 1080x1920 clip with sound (~13 MB) comes out as a ~1-3 MB square in
// about 3 seconds. Phone rotation metadata is applied by ffmpeg before the
// crop, so the frame always refers to the video as it's actually seen.

const MAX_SIDE = 1080;          // output edge for square/portrait frames
const MAX_ORIGINAL_SIDE = 1920; // longest edge when keeping the full frame
const MAX_SECONDS = 60;         // product clips are short; caps server work
const ASPECTS = ['square', 'portrait', 'landscape', 'wide', 'original'];

// A frame from the admin's framing tool: the visible window as fractions
// (0..1) of the video's width/height, plus which aspect preset it was.
// Missing/invalid -> null, which means "default centered square".
function normalizeFrame(raw) {
  let f = raw;
  if (typeof f === 'string') { try { f = JSON.parse(f); } catch { return null; } }
  if (!f || typeof f !== 'object') return null;
  const aspect = ASPECTS.includes(f.aspect) ? f.aspect : 'square';
  if (aspect === 'original') return { aspect };
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : NaN);
  let [left, top, width, height] = [num(f.left), num(f.top), num(f.width), num(f.height)];
  if (![left, top, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null;
  width = Math.min(1, width); height = Math.min(1, height);
  left = Math.max(0, Math.min(1 - width, left));
  top = Math.max(0, Math.min(1 - height, top));
  const r = (v) => Math.round(v * 1e6) / 1e6;
  return { aspect, left: r(left), top: r(top), width: r(width), height: r(height) };
}

// ffmpeg filter expressions; commas inside functions are escaped (\,)
// because a bare comma separates filters in a filtergraph.
const EVEN = (expr) => `2*trunc((${expr})/2)`;
function filterFor(frame) {
  if (frame && frame.aspect === 'original') {
    const k = `min(1\\,${MAX_ORIGINAL_SIDE}/max(iw\\,ih))`;
    return `scale=${EVEN(`iw*${k}`)}:${EVEN(`ih*${k}`)},setsar=1`;
  }
  const crop = frame
    ? `crop=w=${EVEN(`iw*${frame.width}`)}:h=${EVEN(`ih*${frame.height}`)}:x=iw*${frame.left}:y=ih*${frame.top}`
    // default: the largest centered square (x/y default to centered)
    : `crop=w=${EVEN('min(iw\\,ih)')}:h=${EVEN('min(iw\\,ih)')}`;
  const side = EVEN(`min(${MAX_SIDE}\\,iw)`);
  const isSquare = !frame || frame.aspect === 'square';
  // A square frame is forced to an exact square (rounding can leave the crop
  // a pixel off); other frames keep their proportions.
  const scale = isSquare ? `scale=${side}:${side}` : `scale=${side}:-2`;
  return `${crop},${scale},setsar=1`;
}

function runFfmpeg(args, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(ffmpegPath, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(String(stderr || err.message).split('\n').filter(Boolean).slice(-3).join(' | ')));
      else resolve();
    });
  });
}

// Returns the path of a NEW .mp4 next to the input. Never touches the input.
async function processVideo(inputPath, rawFrame) {
  const frame = normalizeFrame(rawFrame);
  const base = path.basename(inputPath, path.extname(inputPath));
  const outputPath = path.join(path.dirname(inputPath), `${base}-v${crypto.randomBytes(4).toString('hex')}.mp4`);
  try {
    await runFfmpeg([
      '-hide_banner', '-loglevel', 'error', '-y',
      '-i', inputPath,
      '-t', String(MAX_SECONDS),
      '-map', '0:v:0',
      '-vf', filterFor(frame),
      '-an',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26',
      '-pix_fmt', 'yuv420p', '-profile:v', 'high',
      '-movflags', '+faststart',
      outputPath,
    ], 5 * 60 * 1000);
    if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size === 0) throw new Error('no output produced');
    return outputPath;
  } catch (err) {
    fs.unlink(outputPath, () => {});
    throw new Error(`Video processing failed: ${err.message}`);
  }
}

module.exports = { processVideo, normalizeFrame, filterFor, MAX_SIDE, MAX_SECONDS };
