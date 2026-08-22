// Shared admin-only crop modal used before uploading a product photo.
// Interaction model mirrors image-slot.js's reframe mode (pan/zoom the
// image behind a FIXED window) rather than a movable crop box over a fixed
// image — that guarantees the result is always a true pixel crop of the
// source (never a stretch), because the output canvas is drawn at exactly
// the window's aspect ratio.

const ASPECTS = [
  { key: 'square', label: 'Square', ratio: 1 },
  { key: 'portrait', label: 'Portrait', ratio: 4 / 5 },
  { key: 'landscape', label: 'Landscape', ratio: 4 / 3 },
  { key: 'wide', label: 'Wide', ratio: 16 / 9 },
  { key: 'original', label: 'Original', ratio: null },
];
const MAX_OUT = 1600;
const S_MAX = 4;

let styleInjected = false;
function injectStyle() {
  if (styleInjected) return;
  styleInjected = true;
  const s = document.createElement('style');
  s.textContent = `
    .aic-backdrop{position:fixed;inset:0;z-index:99999;background:rgba(20,19,18,.75);
      display:flex;align-items:center;justify-content:center;font:13px/1.4 system-ui,-apple-system,sans-serif}
    .aic-dialog{background:#fff;color:#201f1d;border-radius:12px;padding:20px;width:min(460px,92vw);
      box-shadow:0 24px 64px rgba(0,0,0,.35)}
    .aic-title{font-size:15px;font-weight:600;margin-bottom:4px}
    .aic-sub{opacity:.6;font-size:12px;margin-bottom:14px}
    .aic-presets{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:14px}
    .aic-preset{border:1px solid #ddd9d3;background:#fff;border-radius:999px;padding:6px 12px;
      font-size:12px;cursor:pointer}
    .aic-preset[data-active]{background:#201f1d;color:#fff;border-color:#201f1d}
    .aic-window{position:relative;overflow:hidden;background:#111;border-radius:8px;margin:0 auto;cursor:grab}
    .aic-window[data-panning]{cursor:grabbing}
    .aic-window img{position:absolute;max-width:none;transform-origin:0 0;user-select:none;
      -webkit-user-drag:none;pointer-events:none}
    .aic-hint{font-size:11px;opacity:.55;margin-top:10px;text-align:center}
    .aic-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:16px}
    .aic-btn{border:1px solid #ddd9d3;background:#fff;border-radius:8px;padding:8px 16px;
      font-size:13px;cursor:pointer}
    .aic-btn.primary{background:#201f1d;color:#fff;border-color:#201f1d}
  `;
  document.head.appendChild(s);
}

const clampS = (s) => Math.max(1, Math.min(S_MAX, s));

/**
 * @param {File} file - image file to crop.
 * @param {{ title?: string, subtitle?: string }} [opts]
 * @returns {Promise<Blob|File|null>} cropped blob, the original file ("Original" preset),
 *   or null if the user cancelled / the file failed to load as an image.
 */
export function openCropper(file, opts) {
  opts = opts || {};
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => mount(file, img, url, opts, resolve);
    img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
    img.src = url;
  });
}

function mount(file, img, url, opts, resolve) {
  injectStyle();
  const backdrop = document.createElement('div');
  backdrop.className = 'aic-backdrop';
  backdrop.innerHTML =
    '<div class="aic-dialog">' +
    '  <div class="aic-title">' + (opts.title || 'Crop Photo') + '</div>' +
    '  <div class="aic-sub">' + (opts.subtitle || (file.name || '')) + '</div>' +
    '  <div class="aic-presets"></div>' +
    '  <div class="aic-window"></div>' +
    '  <div class="aic-hint">Drag to reposition &middot; scroll or pinch to zoom</div>' +
    '  <div class="aic-actions">' +
    '    <button type="button" class="aic-btn" data-act="cancel">Cancel</button>' +
    '    <button type="button" class="aic-btn primary" data-act="apply">Apply Crop</button>' +
    '  </div>' +
    '</div>';
  document.body.appendChild(backdrop);

  const presetsEl = backdrop.querySelector('.aic-presets');
  const windowEl = backdrop.querySelector('.aic-window');
  windowEl.appendChild(img);

  let aspect = ASPECTS[0];
  let view = { s: 1, x: 0, y: 0 };
  let ww = 0, wh = 0, base = 1;

  function layoutWindow() {
    const maxBox = 380;
    if (!aspect.ratio) {
      // "Original": show the image at its own aspect, no crop window semantics.
      const r = img.naturalWidth / img.naturalHeight;
      ww = r >= 1 ? maxBox : Math.round(maxBox * r);
      wh = r >= 1 ? Math.round(maxBox / r) : maxBox;
    } else if (aspect.ratio >= 1) {
      ww = maxBox; wh = Math.round(maxBox / aspect.ratio);
    } else {
      wh = maxBox; ww = Math.round(maxBox * aspect.ratio);
    }
    windowEl.style.width = ww + 'px';
    windowEl.style.height = wh + 'px';
    base = Math.max(ww / img.naturalWidth, wh / img.naturalHeight);
    view = { s: 1, x: 0, y: 0 };
    apply();
  }

  function clamp() {
    const dispW = img.naturalWidth * base * view.s;
    const dispH = img.naturalHeight * base * view.s;
    const mx = Math.max(0, (dispW / ww - 1) * 50);
    const my = Math.max(0, (dispH / wh - 1) * 50);
    view.x = Math.max(-mx, Math.min(mx, view.x));
    view.y = Math.max(-my, Math.min(my, view.y));
  }

  function apply() {
    clamp();
    const k = base * view.s;
    const w = img.naturalWidth * k, h = img.naturalHeight * k;
    const left = ww / 2 + (view.x / 100) * ww - w / 2;
    const top = wh / 2 + (view.y / 100) * wh - h / 2;
    img.style.width = w + 'px';
    img.style.height = h + 'px';
    img.style.left = left + 'px';
    img.style.top = top + 'px';
  }

  presetsEl.innerHTML = ASPECTS.map((a) =>
    `<button type="button" class="aic-preset" data-key="${a.key}"${a === aspect ? ' data-active' : ''}>${a.label}</button>`
  ).join('');
  presetsEl.addEventListener('click', (e) => {
    const btn = e.target.closest('.aic-preset');
    if (!btn) return;
    aspect = ASPECTS.find((a) => a.key === btn.getAttribute('data-key')) || ASPECTS[0];
    [...presetsEl.children].forEach((c) => c.toggleAttribute('data-active', c === btn));
    layoutWindow();
  });

  let drag = null;
  windowEl.addEventListener('pointerdown', (e) => {
    if (!aspect.ratio) return;
    drag = { px: e.clientX, py: e.clientY, x: view.x, y: view.y };
    windowEl.setPointerCapture(e.pointerId);
    windowEl.setAttribute('data-panning', '');
  });
  windowEl.addEventListener('pointermove', (e) => {
    if (!drag) return;
    view.x = drag.x + (e.clientX - drag.px) / ww * 100;
    view.y = drag.y + (e.clientY - drag.py) / wh * 100;
    apply();
  });
  const endDrag = () => { drag = null; windowEl.removeAttribute('data-panning'); };
  windowEl.addEventListener('pointerup', endDrag);
  windowEl.addEventListener('pointercancel', endDrag);
  windowEl.addEventListener('wheel', (e) => {
    if (!aspect.ratio) return;
    e.preventDefault();
    view.s = clampS(view.s * Math.pow(1.0015, -e.deltaY));
    apply();
  }, { passive: false });

  function cleanup() {
    URL.revokeObjectURL(url);
    backdrop.remove();
  }

  function finish(result) { cleanup(); resolve(result); }

  backdrop.querySelector('[data-act="cancel"]').addEventListener('click', () => finish(null));
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) finish(null); });
  backdrop.querySelector('[data-act="apply"]').addEventListener('click', () => {
    if (!aspect.ratio) { finish(file); return; }
    const k = base * view.s;
    const sw = ww / k, sh = wh / k;
    const left = ww / 2 + (view.x / 100) * ww - (img.naturalWidth * k) / 2;
    const top = wh / 2 + (view.y / 100) * wh - (img.naturalHeight * k) / 2;
    const sx = Math.max(0, Math.min(img.naturalWidth - sw, -left / k));
    const sy = Math.max(0, Math.min(img.naturalHeight - sh, -top / k));
    const scale = Math.min(1, MAX_OUT / Math.max(sw, sh));
    const outW = Math.max(1, Math.round(sw * scale));
    const outH = Math.max(1, Math.round(sh * scale));
    const canvas = document.createElement('canvas');
    canvas.width = outW;
    canvas.height = outH;
    canvas.getContext('2d').drawImage(img, sx, sy, sw, sh, 0, 0, outW, outH);
    canvas.toBlob((blob) => finish(blob), 'image/webp', 0.9);
  });

  layoutWindow();
}
