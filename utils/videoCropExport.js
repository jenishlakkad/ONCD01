// Destructively crops a <video> element's currently-loaded source down to
// exactly what utils/videoCropper.js's pan/zoom/aspect selection shows,
// producing a REAL, smaller video file — not a CSS framing overlay. Only
// the selected region (and a sane delivery resolution) is ever encoded;
// everything outside it is never written anywhere. This mirrors
// utils/imageCropper.js's existing canvas-based approach, extended to video
// via canvas.captureStream() + MediaRecorder, since re-encoding a video's
// FRAME CONTENT (the crop itself) client-side is still the only option here
// — there's no server-side transcoding pipeline for that. Audio is a
// separate, simpler story: it's captured NOT AT ALL here (see below) because
// server/lib/stripVideoAudio.js unconditionally strips it from every video
// this form uploads via a fast ffmpeg stream-copy, so there's nothing for
// this module to preserve in the first place.
//
// Re-encoding happens in REAL TIME (MediaRecorder records as the source
// plays through once), so export takes roughly as long as the clip's own
// duration — callers should surface progress via onProgress(fraction).

const MAX_OUTPUT_DIMENSION = 1080; // caps output resolution regardless of source size — bounds export time and file size
const TARGET_FPS = 30;
const VIDEO_BITS_PER_SECOND = 2_500_000; // ~2.5 Mbps — reasonable quality for a short product preview clip

const PREFERRED_MIME_TYPES = [
  'video/mp4;codecs=avc1,mp4a.40.2', // best cross-browser playback compatibility when the browser can record it
  'video/mp4',
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
];

export function isVideoCropExportSupported() {
  return typeof HTMLCanvasElement !== 'undefined'
    && typeof HTMLCanvasElement.prototype.captureStream === 'function'
    && typeof window.MediaRecorder === 'function';
}

function pickMimeType() {
  const isTypeSupported = window.MediaRecorder && window.MediaRecorder.isTypeSupported;
  if (!isTypeSupported) return '';
  for (const t of PREFERRED_MIME_TYPES) {
    if (window.MediaRecorder.isTypeSupported(t)) return t;
  }
  return '';
}

function extensionFor(mimeType) {
  return (mimeType || '').startsWith('video/webm') ? '.webm' : '.mp4';
}

function canvasDimsFor(ratio, maxDim) {
  if (!ratio || ratio >= 1) return { outW: maxDim, outH: Math.round(maxDim / (ratio || 1)) };
  return { outH: maxDim, outW: Math.round(maxDim * ratio) };
}

// Inverse of the exact same "cover + pan + zoom" math already used by the
// cropper's live preview (videoCropper.js apply()) and the read-side
// display transform (applyVideoCrop.js) — kept in lockstep on purpose so
// the exported frame matches exactly what was previewed. Given the output
// canvas size, returns the rectangle (in SOURCE video pixels) that's
// visible inside it.
function computeSourceRect(video, crop, outW, outH) {
  const vw = video.videoWidth, vh = video.videoHeight;
  const windowBase = Math.max(outW / vw, outH / vh);
  const k = windowBase * (crop.scale || 1);
  const dispW = vw * k, dispH = vh * k;
  const left = outW / 2 + ((crop.x || 0) / 100) * outW - dispW / 2;
  const top = outH / 2 + ((crop.y || 0) / 100) * outH - dispH / 2;
  let sx = -left / k;
  let sy = -top / k;
  let sw = outW / k;
  let sh = outH / k;
  // Defensive clamp only — the cropper's own clamp() already keeps crop.x/
  // crop.y/crop.scale from ever describing an out-of-bounds window, this
  // just guards against float slop at the edges.
  sw = Math.min(sw, vw);
  sh = Math.min(sh, vh);
  sx = Math.max(0, Math.min(vw - sw, sx));
  sy = Math.max(0, Math.min(vh - sh, sy));
  return { sx, sy, sw, sh };
}

/**
 * @param {HTMLVideoElement} video - a loaded (readyState >= 1), same-origin
 *   or blob: video element. Its playback state is taken over for the
 *   duration of the export (paused, seeked to 0, played through once,
 *   loop disabled) and left paused at the end.
 * @param {{x:number,y:number,scale:number,aspect:string}} crop
 * @param {{ratio:number|null}} aspectInfo - the resolved ASPECTS entry for crop.aspect
 * @param {(fraction:number) => void} [onProgress]
 * @returns {Promise<{blob:Blob, mimeType:string, extension:string}>}
 */
export function exportCroppedVideo(video, crop, aspectInfo, onProgress) {
  if (!isVideoCropExportSupported()) {
    return Promise.reject(new Error('Video cropping needs a browser that supports MediaRecorder + canvas.captureStream (try Chrome or Edge).'));
  }
  const ratio = (aspectInfo && aspectInfo.ratio) || (video.videoWidth / video.videoHeight);
  const { outW, outH } = canvasDimsFor(ratio, MAX_OUTPUT_DIMENSION);

  return new Promise((resolve, reject) => {
    const canvas = document.createElement('canvas');
    canvas.width = outW;
    canvas.height = outH;
    const ctx = canvas.getContext('2d');

    // Video-only, deliberately — no audio track is captured here at all.
    // Product preview videos never need sound, and the server strips any
    // audio unconditionally anyway (see server/lib/stripVideoAudio.js), so
    // capturing and encoding it here would only waste time and upload
    // bandwidth on bytes that get thrown away moments later.
    const canvasStream = canvas.captureStream(TARGET_FPS);

    const mimeType = pickMimeType();
    let recorder;
    try {
      recorder = mimeType
        ? new MediaRecorder(canvasStream, { mimeType, videoBitsPerSecond: VIDEO_BITS_PER_SECOND })
        : new MediaRecorder(canvasStream);
    } catch (err) {
      cleanup();
      reject(err);
      return;
    }

    const chunks = [];
    let settled = false;
    let drawHandle = null;
    let safetyTimer = null;
    const wasLoop = video.loop;

    function cleanup() {
      video.loop = wasLoop;
      video.removeEventListener('ended', onEnded);
      if (drawHandle != null) {
        if (video.cancelVideoFrameCallback) video.cancelVideoFrameCallback(drawHandle);
        else cancelAnimationFrame(drawHandle);
      }
      if (safetyTimer) clearTimeout(safetyTimer);
      for (const t of canvasStream.getTracks()) t.stop();
    }

    function finishOnce(fn) {
      if (settled) return;
      settled = true;
      fn();
    }

    function drawFrame() {
      const { sx, sy, sw, sh } = computeSourceRect(video, crop, outW, outH);
      try { ctx.drawImage(video, sx, sy, sw, sh, 0, 0, outW, outH); } catch (_) { /* a transient decode gap — skip this frame */ }
      if (onProgress && video.duration) onProgress(Math.min(1, video.currentTime / video.duration));
      if (video.ended || settled) return;
      if (video.requestVideoFrameCallback) drawHandle = video.requestVideoFrameCallback(drawFrame);
      else drawHandle = requestAnimationFrame(drawFrame);
    }

    function onEnded() {
      finishOnce(() => {
        cleanup();
        try { recorder.stop(); } catch (_) { /* already stopped */ }
      });
    }

    recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    recorder.onstop = () => {
      if (!chunks.length) { reject(new Error('Video export produced no data.')); return; }
      const blob = new Blob(chunks, { type: mimeType || 'video/webm' });
      resolve({ blob, mimeType: blob.type, extension: extensionFor(blob.type) });
    };
    recorder.onerror = (e) => {
      finishOnce(() => { cleanup(); reject(e.error || new Error('Video recording failed.')); });
    };

    video.loop = false;
    video.addEventListener('ended', onEnded);
    video.currentTime = 0;
    recorder.start();
    if (onProgress) onProgress(0);

    const startPlayback = () => {
      const p = video.play();
      const begin = () => { if (video.requestVideoFrameCallback) drawHandle = video.requestVideoFrameCallback(drawFrame); else drawFrame(); };
      if (p && p.then) p.then(begin).catch((err) => finishOnce(() => { cleanup(); reject(err); })); else begin();
    };
    // Safety net: if `ended` never fires for any reason (a decode hiccup on
    // some device/codec combination), force-finish shortly after the clip's
    // expected duration rather than hanging the admin's Apply button forever.
    const armSafetyTimer = () => {
      const durMs = Number.isFinite(video.duration) ? video.duration * 1000 : 60_000;
      safetyTimer = setTimeout(() => { onEnded(); }, durMs + 5000);
    };
    if (video.readyState >= 1) { startPlayback(); armSafetyTimer(); }
    else video.addEventListener('loadedmetadata', () => { startPlayback(); armSafetyTimer(); }, { once: true });
  });
}
