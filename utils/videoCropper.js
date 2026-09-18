// Shared admin-only video framing modal — pan/zoom a video within a fixed
// aspect-ratio window, using the exact same interaction model as
// utils/imageCropper.js (drag to pan, scroll/pinch to zoom, aspect presets).
//
// Unlike the image cropper, this can't cheaply re-encode a new video file in
// the browser, so instead of resolving a Blob it resolves a small
// { x, y, scale, aspect } framing descriptor. The caller PUTs that to the
// media's /crop endpoint; every place the video is displayed then applies it
// via a CSS transform (see product-media.js and the product-detail thumbnail
// strips). The original file and its audio are never touched or re-uploaded
// — this is a non-destructive "how it's framed on screen" setting, not a
// permanent crop of the source video.
const ASPECTS = [
  { key: 'original', label: 'Original', ratio: null },
  { key: 'square', label: 'Square', ratio: 1 },
  { key: 'portrait', label: 'Portrait', ratio: 4 / 5 },
  { key: 'landscape', label: 'Landscape', ratio: 4 / 3 },
  { key: 'wide', label: 'Wide', ratio: 16 / 9 },
];
const S_MAX = 4;

let styleInjected = false;
function injectStyle() {
  if (styleInjected) return;
  styleInjected = true;
  const s = document.createElement('style');
  s.textContent = `
    .vic-backdrop{position:fixed;inset:0;z-index:99999;background:rgba(20,19,18,.75);
      display:flex;align-items:center;justify-content:center;font:13px/1.4 system-ui,-apple-system,sans-serif}
    .vic-dialog{background:#fff;color:#201f1d;border-radius:12px;padding:20px;width:min(460px,92vw);
      box-shadow:0 24px 64px rgba(0,0,0,.35)}
    .vic-title{font-size:15px;font-weight:600;margin-bottom:4px}
    .vic-sub{opacity:.6;font-size:12px;margin-bottom:14px}
    .vic-presets{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:14px}
    .vic-preset{border:1px solid #ddd9d3;background:#fff;border-radius:999px;padding:6px 12px;
      font-size:12px;cursor:pointer}
    .vic-preset[data-active]{background:#201f1d;color:#fff;border-color:#201f1d}
    .vic-window{position:relative;overflow:hidden;background:#111;border-radius:8px;margin:0 auto;cursor:grab}
    .vic-window[data-panning]{cursor:grabbing}
    .vic-window video{position:absolute;max-width:none;transform-origin:0 0;user-select:none;
      -webkit-user-drag:none;pointer-events:none}
    .vic-hint{font-size:11px;opacity:.55;margin-top:10px;text-align:center}
    .vic-actions{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-top:16px}
    .vic-actions-right{display:flex;gap:8px}
    .vic-btn{border:1px solid #ddd9d3;background:#fff;border-radius:8px;padding:8px 16px;
      font-size:13px;cursor:pointer}
    .vic-btn.primary{background:#201f1d;color:#fff;border-color:#201f1d}
    .vic-btn.ghost{border-color:transparent;color:#8a6a1f}
  `;
  document.head.appendChild(s);
}

const clampS = (s) => Math.max(1, Math.min(S_MAX, s));

/**
 * @param {string} url - the video's current URL.
 * @param {{ title?: string, subtitle?: string, initialCrop?: {x:number,y:number,scale:number,aspect:string}, defaultAspect?: string }} [opts]
 *   defaultAspect picks the preset shown when there's no initialCrop yet (a
 *   video being framed for the first time) — falls back to "original" (the
 *   first ASPECTS entry) when omitted. Ignored once initialCrop is present;
 *   re-opening an already-framed video always shows what was actually saved.
 * @returns {Promise<{x:number,y:number,scale:number,aspect:string}|null|undefined>}
 *   the new framing to save, `null` if the admin cleared it back to Original,
 *   or `undefined` if the admin cancelled (caller should make no API call).
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
    video.onloadedmetadata = () => {
      mount(video, opts, resolve);
      const p = video.play();
      if (p && p.catch) p.catch(() => {});
    };
    video.src = url;
  });
}

function mount(video, opts, resolve) {
  injectStyle();
  const initial = opts.initialCrop || null;
  const backdrop = document.createElement('div');
  backdrop.className = 'vic-backdrop';
  backdrop.innerHTML =
    '<div class="vic-dialog">' +
    '  <div class="vic-title">' + (opts.title || 'Frame Video') + '</div>' +
    '  <div class="vic-sub">' + (opts.subtitle || '') + '</div>' +
    '  <div class="vic-presets"></div>' +
    '  <div class="vic-window"></div>' +
    '  <div class="vic-hint">Drag to reposition &middot; scroll or pinch to zoom &middot; plays on loop while you frame it</div>' +
    '  <div class="vic-actions">' +
    '    <button type="button" class="vic-btn ghost" data-act="reset">Reset to Original</button>' +
    '    <div class="vic-actions-right">' +
    '      <button type="button" class="vic-btn" data-act="cancel">Cancel</button>' +
    '      <button type="button" class="vic-btn primary" data-act="apply">Apply</button>' +
    '    </div>' +
    '  </div>' +
    '</div>';
  document.body.appendChild(backdrop);

  const presetsEl = backdrop.querySelector('.vic-presets');
  const windowEl = backdrop.querySelector('.vic-window');
  windowEl.appendChild(video);

  let aspect = (initial && ASPECTS.find((a) => a.key === initial.aspect))
    || (opts.defaultAspect && ASPECTS.find((a) => a.key === opts.defaultAspect))
    || ASPECTS[0];
  let view = initial ? { s: initial.scale, x: initial.x, y: initial.y } : { s: 1, x: 0, y: 0 };
  let ww = 0, wh = 0, base = 1;

  function layoutWindow(preserveView) {
    const maxBox = 380;
    if (!aspect.ratio) {
      const r = video.videoWidth / video.videoHeight;
      ww = r >= 1 ? maxBox : Math.round(maxBox * r);
      wh = r >= 1 ? Math.round(maxBox / r) : maxBox;
    } else if (aspect.ratio >= 1) {
      ww = maxBox; wh = Math.round(maxBox / aspect.ratio);
    } else {
      wh = maxBox; ww = Math.round(maxBox * aspect.ratio);
    }
    windowEl.style.width = ww + 'px';
    windowEl.style.height = wh + 'px';
    base = Math.max(ww / video.videoWidth, wh / video.videoHeight);
    if (!preserveView) view = { s: 1, x: 0, y: 0 };
    apply();
  }

  function clamp() {
    const dispW = video.videoWidth * base * view.s;
    const dispH = video.videoHeight * base * view.s;
    const mx = Math.max(0, (dispW / ww - 1) * 50);
    const my = Math.max(0, (dispH / wh - 1) * 50);
    view.x = Math.max(-mx, Math.min(mx, view.x));
    view.y = Math.max(-my, Math.min(my, view.y));
  }

  function apply() {
    clamp();
    const k = base * view.s;
    const w = video.videoWidth * k, h = video.videoHeight * k;
    const left = ww / 2 + (view.x / 100) * ww - w / 2;
    const top = wh / 2 + (view.y / 100) * wh - h / 2;
    video.style.width = w + 'px';
    video.style.height = h + 'px';
    video.style.left = left + 'px';
    video.style.top = top + 'px';
  }

  presetsEl.innerHTML = ASPECTS.map((a) =>
    `<button type="button" class="vic-preset" data-key="${a.key}"${a === aspect ? ' data-active' : ''}>${a.label}</button>`
  ).join('');
  presetsEl.addEventListener('click', (e) => {
    const btn = e.target.closest('.vic-preset');
    if (!btn) return;
    aspect = ASPECTS.find((a) => a.key === btn.getAttribute('data-key')) || ASPECTS[0];
    [...presetsEl.children].forEach((c) => c.toggleAttribute('data-active', c === btn));
    layoutWindow(false);
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
    video.pause();
    video.removeAttribute('src');
    video.load();
    backdrop.remove();
  }

  function finish(result) { cleanup(); resolve(result); }

  backdrop.querySelector('[data-act="cancel"]').addEventListener('click', () => finish(undefined));
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) finish(undefined); });
  backdrop.querySelector('[data-act="reset"]').addEventListener('click', () => finish(null));
  backdrop.querySelector('[data-act="apply"]').addEventListener('click', () => {
    if (!aspect.ratio) { finish(null); return; }
    finish({ x: view.x, y: view.y, scale: view.s, aspect: aspect.key });
  });

  layoutWindow(!!initial);
}
