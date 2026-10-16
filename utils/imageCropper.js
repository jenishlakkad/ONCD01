// Admin photo cropping. The framing UI itself is the shared tool in
// utils/framePicker.js (same controls as video framing); this module turns
// the chosen frame into the actual cropped image: drawn onto a canvas at
// exactly the frame's shape (a true crop, never a stretch), at most 1600px
// on its long edge, saved as WebP.
//
// "Original" is the fallback default for callers that don't ask for a
// specific shape (About page photos, homepage banners keep their own
// proportions); product photos ask for "square" (see AdminProducts.dc.html).
import { openFramePicker } from './framePicker.js';

const MAX_OUT = 1600;

function loadImage(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => resolve({ img, url });
    img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
    img.src = url;
  });
}

function drawToBlob(img, rect) {
  return new Promise((resolve) => {
    const scale = Math.min(1, MAX_OUT / Math.max(rect.sw, rect.sh));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(rect.sw * scale));
    canvas.height = Math.max(1, Math.round(rect.sh * scale));
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, rect.sx, rect.sy, rect.sw, rect.sh, 0, 0, canvas.width, canvas.height);
    canvas.toBlob((blob) => resolve(blob), 'image/webp', 0.9);
  });
}

/**
 * @param {File|Blob} file - image to crop. Pass the ORIGINAL photo when you
 *   have it, so re-editing never crops an already-cropped copy.
 * @param {{ title?: string, subtitle?: string, defaultAspect?: string,
 *           initialView?: object, onView?: (view:object) => void }} [opts]
 *   initialView/onView let a caller re-open the tool exactly where the admin
 *   left it (onView receives the chosen framing).
 * @returns {Promise<Blob|File|null>} cropped blob, the original file for
 *   "Original", or null if cancelled / the file isn't a viewable image.
 */
export async function openCropper(file, opts) {
  opts = opts || {};
  const loaded = await loadImage(file);
  if (!loaded) return null;
  const { img, url } = loaded;
  try {
    const picked = await openFramePicker(img, img.naturalWidth, img.naturalHeight, {
      title: opts.title || 'Crop Photo',
      subtitle: opts.subtitle || file.name || '',
      defaultAspect: opts.defaultAspect || 'original',
      initialView: opts.initialView,
      applyLabel: 'Apply Crop',
    });
    if (!picked) return null;
    if (opts.onView) opts.onView(picked.view);
    if (picked.aspect === 'original') return file;
    return await drawToBlob(img, picked.rect);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * The plain centered square, silently (no dialog) — what every product
 * photo gets the moment it's added, so square framing is automatic. The
 * admin can still open openCropper afterwards to frame a photo differently.
 * @returns {Promise<Blob|null>} null if the file isn't a viewable image
 *   (e.g. HEIC on most browsers) — the caller uploads the original instead.
 */
export async function cropToCenterSquare(file) {
  const loaded = await loadImage(file);
  if (!loaded) return null;
  const { img, url } = loaded;
  try {
    const side = Math.min(img.naturalWidth, img.naturalHeight);
    return await drawToBlob(img, {
      sx: (img.naturalWidth - side) / 2, sy: (img.naturalHeight - side) / 2, sw: side, sh: side,
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}
