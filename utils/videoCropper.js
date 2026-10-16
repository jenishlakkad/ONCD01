// Admin video framing. Uses the shared framing tool (utils/framePicker.js,
// same controls as photo cropping) with the video playing on a loop, and
// returns the chosen FRAME — it never re-encodes anything in the browser.
// The server does the actual cut (server/lib/processVideo.js): crop to the
// frame, compress, remove sound, H.264 MP4 that plays everywhere.
//
// Frame = the visible window as fractions (0..1) of the video's width and
// height + the shape preset, e.g. { aspect:'square', left:0, top:0.21,
// width:1, height:0.5625 } — the middle square of a 9:16 phone clip.
import { openFramePicker } from './framePicker.js';

/**
 * @param {string} url - the video to frame (a blob: URL for a file not yet
 *   uploaded, or the stored video's URL).
 * @param {{ title?: string, subtitle?: string, initialView?: object, note?: string }} [opts]
 * @returns {Promise<{frame:object, view:object}|undefined>} undefined when
 *   cancelled or the video can't be loaded.
 */
export function openVideoCropper(url, opts) {
  opts = opts || {};
  return new Promise((resolve) => {
    const video = document.createElement('video');
    video.muted = true;
    video.loop = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.onerror = () => resolve(undefined);
    video.onloadedmetadata = async () => {
      video.onerror = null;
      const p = video.play();
      if (p && p.catch) p.catch(() => {});
      const vw = video.videoWidth, vh = video.videoHeight;
      const picked = await openFramePicker(video, vw, vh, {
        title: opts.title || 'Frame Video',
        subtitle: opts.subtitle || '',
        aspects: ['square', 'portrait', 'original'],
        defaultAspect: 'square',
        initialView: opts.initialView,
        applyLabel: 'Use this framing',
        note: opts.note || 'When you save, the video is cut to this frame, compressed and its sound removed.',
      });
      video.pause();
      video.removeAttribute('src');
      video.load();
      if (!picked) { resolve(undefined); return; }
      const r = picked.rect;
      const frame = picked.aspect === 'original'
        ? { aspect: 'original' }
        : { aspect: picked.aspect, left: r.sx / vw, top: r.sy / vh, width: r.sw / vw, height: r.sh / vh };
      resolve({ frame, view: picked.view });
    };
    video.src = url;
  });
}
