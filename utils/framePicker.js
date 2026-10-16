// Shared framing tool behind both croppers (utils/imageCropper.js for
// photos, utils/videoCropper.js for videos), so photos and videos are
// framed with exactly the same controls:
//   - the photo/video moves behind a FIXED window of the chosen shape
//     (always a true crop, never a stretch);
//   - drag (or one finger) to move, scroll / two-finger pinch / the slider /
//     the − + buttons to zoom, arrow keys to nudge;
//   - a centre guide (circle + thirds) to line the stone up, and "Center"
//     to snap back to the middle;
//   - Enter applies, Esc cancels.
// It only CHOOSES a frame; each caller decides what to do with it (draw a
// canvas for photos, send the frame to the server for videos).

export const ASPECTS = [
  { key: 'original', label: 'Original', ratio: null },
  { key: 'square', label: 'Square', ratio: 1 },
  { key: 'portrait', label: 'Portrait 4:5', ratio: 4 / 5 },
  { key: 'landscape', label: 'Landscape 4:3', ratio: 4 / 3 },
  { key: 'wide', label: 'Wide 16:9', ratio: 16 / 9 },
];
const S_MAX = 4;
const clampS = (s) => Math.max(1, Math.min(S_MAX, s));

let styleInjected = false;
function injectStyle() {
  if (styleInjected) return;
  styleInjected = true;
  const s = document.createElement('style');
  s.textContent = `
    .fpk-backdrop{position:fixed;inset:0;z-index:99999;background:rgba(20,19,18,.78);
      display:flex;align-items:center;justify-content:center;padding:12px;box-sizing:border-box;
      font:13px/1.4 system-ui,-apple-system,sans-serif}
    .fpk-dialog{background:#fff;color:#201f1d;border-radius:14px;padding:18px 20px;width:min(480px,100%);
      max-height:100%;overflow:auto;box-sizing:border-box;box-shadow:0 24px 64px rgba(0,0,0,.35)}
    .fpk-title{font-size:15px;font-weight:600}
    .fpk-sub{opacity:.6;font-size:12px;margin:2px 0 12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .fpk-presets{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px}
    .fpk-preset{border:1px solid #ddd9d3;background:#fff;border-radius:999px;padding:6px 12px;font-size:12px;cursor:pointer;color:#201f1d}
    .fpk-preset[data-active]{background:#201f1d;color:#fff;border-color:#201f1d}
    .fpk-window{position:relative;overflow:hidden;background:#111;border-radius:8px;margin:0 auto;
      cursor:grab;touch-action:none;outline:none}
    .fpk-window:focus-visible{box-shadow:0 0 0 3px rgba(160,124,46,.5)}
    .fpk-window[data-panning]{cursor:grabbing}
    .fpk-window[data-fixed]{cursor:default}
    .fpk-window > img,.fpk-window > video{position:absolute;max-width:none;max-height:none;user-select:none;
      -webkit-user-drag:none;pointer-events:none}
    .fpk-guide{position:absolute;inset:0;pointer-events:none}
    .fpk-guide{--fpk-line:rgba(255,255,255,.28)}
    .fpk-guide::before,.fpk-guide::after{content:"";position:absolute;inset:0}
    .fpk-guide::before{background:linear-gradient(to right,transparent calc(33.333% - .5px),var(--fpk-line) 0,
      var(--fpk-line) calc(33.333% + .5px),transparent 0,transparent calc(66.666% - .5px),var(--fpk-line) 0,
      var(--fpk-line) calc(66.666% + .5px),transparent 0)}
    .fpk-guide::after{background:linear-gradient(to bottom,transparent calc(33.333% - .5px),var(--fpk-line) 0,
      var(--fpk-line) calc(33.333% + .5px),transparent 0,transparent calc(66.666% - .5px),var(--fpk-line) 0,
      var(--fpk-line) calc(66.666% + .5px),transparent 0)}
    .fpk-ring{position:absolute;left:50%;top:50%;width:46%;aspect-ratio:1;transform:translate(-50%,-50%);
      border:1.5px dashed rgba(255,255,255,.7);border-radius:50%;pointer-events:none}
    .fpk-cross{position:absolute;left:50%;top:50%;width:14px;height:14px;transform:translate(-50%,-50%);pointer-events:none}
    .fpk-cross::before,.fpk-cross::after{content:"";position:absolute;background:rgba(255,255,255,.85)}
    .fpk-cross::before{left:6px;top:0;width:2px;height:14px}
    .fpk-cross::after{top:6px;left:0;height:2px;width:14px}
    .fpk-window[data-fixed] .fpk-guide,.fpk-window[data-fixed] .fpk-ring,.fpk-window[data-fixed] .fpk-cross{display:none}
    .fpk-zoom{display:flex;align-items:center;gap:10px;margin-top:12px}
    .fpk-zoom input{flex:1;accent-color:#201f1d}
    .fpk-zbtn{width:30px;height:30px;border-radius:50%;border:1px solid #ddd9d3;background:#fff;cursor:pointer;
      font-size:16px;line-height:1;color:#201f1d;flex:none}
    .fpk-hint{font-size:11.5px;opacity:.6;margin-top:8px;text-align:center}
    .fpk-note{font-size:12px;margin-top:10px;padding:8px 10px;border-radius:8px;background:#f5efe2;color:#5c4a1e}
    .fpk-actions{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-top:14px;flex-wrap:wrap}
    .fpk-actions-right{display:flex;gap:8px;margin-left:auto}
    .fpk-btn{border:1px solid #ddd9d3;background:#fff;border-radius:8px;padding:8px 16px;font-size:13px;cursor:pointer;color:#201f1d}
    .fpk-btn.primary{background:#201f1d;color:#fff;border-color:#201f1d}
    .fpk-btn.ghost{border-color:transparent;color:#8a6a1f;padding:8px 10px}
    .fpk-btn:disabled{opacity:.45;cursor:default}
  `;
  document.head.appendChild(s);
}

/**
 * @param {HTMLImageElement|HTMLVideoElement} mediaEl - already loaded (has natural size).
 * @param {number} naturalW
 * @param {number} naturalH
 * @param {{ title?:string, subtitle?:string, aspects?:string[], defaultAspect?:string,
 *           initialView?:{aspect:string,x:number,y:number,s:number}, applyLabel?:string,
 *           hint?:string, note?:string }} [opts]
 * @returns {Promise<null|{aspect:string, view:{aspect:string,x:number,y:number,s:number},
 *           rect:{sx:number,sy:number,sw:number,sh:number}}>}
 *   rect is in the media's own pixels (the whole thing for "original").
 */
export function openFramePicker(mediaEl, naturalW, naturalH, opts) {
  opts = opts || {};
  injectStyle();
  // In the caller's order when given (videos list Square first).
  const aspects = opts.aspects ? opts.aspects.map((k) => ASPECTS.find((a) => a.key === k)).filter(Boolean) : ASPECTS;
  return new Promise((resolve) => {
    const backdrop = document.createElement('div');
    backdrop.className = 'fpk-backdrop';
    backdrop.innerHTML =
      '<div class="fpk-dialog" role="dialog" aria-modal="true">' +
      '  <div class="fpk-title"></div><div class="fpk-sub"></div>' +
      '  <div class="fpk-presets" role="group" aria-label="Shape"></div>' +
      '  <div class="fpk-window" tabindex="0" aria-label="Framing area — drag to move, arrow keys to nudge">' +
      '    <div class="fpk-guide"></div><div class="fpk-ring"></div><div class="fpk-cross"></div>' +
      '  </div>' +
      '  <div class="fpk-zoom"><button type="button" class="fpk-zbtn" data-act="out" aria-label="Zoom out">−</button>' +
      '    <input type="range" min="1" max="' + S_MAX + '" step="0.01" value="1" aria-label="Zoom">' +
      '    <button type="button" class="fpk-zbtn" data-act="in" aria-label="Zoom in">+</button></div>' +
      '  <div class="fpk-hint"></div>' +
      (opts.note ? '  <div class="fpk-note"></div>' : '') +
      '  <div class="fpk-actions">' +
      '    <button type="button" class="fpk-btn ghost" data-act="center">Center</button>' +
      '    <button type="button" class="fpk-btn ghost" data-act="reset">Reset</button>' +
      '    <div class="fpk-actions-right">' +
      '      <button type="button" class="fpk-btn" data-act="cancel">Cancel</button>' +
      '      <button type="button" class="fpk-btn primary" data-act="apply"></button>' +
      '    </div>' +
      '  </div>' +
      '</div>';
    backdrop.querySelector('.fpk-title').textContent = opts.title || 'Frame';
    backdrop.querySelector('.fpk-sub').textContent = opts.subtitle || '';
    backdrop.querySelector('.fpk-hint').textContent = opts.hint || 'Drag to move · scroll, pinch or use the slider to zoom · line the stone up with the circle';
    if (opts.note) backdrop.querySelector('.fpk-note').textContent = opts.note;
    backdrop.querySelector('[data-act="apply"]').textContent = opts.applyLabel || 'Apply';
    document.body.appendChild(backdrop);

    const presetsEl = backdrop.querySelector('.fpk-presets');
    const win = backdrop.querySelector('.fpk-window');
    const slider = backdrop.querySelector('input[type=range]');
    win.insertBefore(mediaEl, win.firstChild);

    const byKey = (k) => aspects.find((a) => a.key === k);
    const init = opts.initialView && byKey(opts.initialView.aspect) ? opts.initialView : null;
    let aspect = (init && byKey(init.aspect)) || byKey(opts.defaultAspect) || aspects[0];
    let view = init ? { s: clampS(init.s || 1), x: init.x || 0, y: init.y || 0 } : { s: 1, x: 0, y: 0 };
    let ww = 0, wh = 0, base = 1;

    function layout(keepView) {
      const maxBox = Math.max(200, Math.min(400, window.innerWidth - 72, window.innerHeight - 330));
      if (!aspect.ratio) {
        const r = naturalW / naturalH;
        ww = r >= 1 ? maxBox : Math.round(maxBox * r);
        wh = r >= 1 ? Math.round(maxBox / r) : maxBox;
      } else if (aspect.ratio >= 1) {
        ww = maxBox; wh = Math.round(maxBox / aspect.ratio);
      } else {
        wh = maxBox; ww = Math.round(maxBox * aspect.ratio);
      }
      win.style.width = ww + 'px';
      win.style.height = wh + 'px';
      win.toggleAttribute('data-fixed', !aspect.ratio);
      base = Math.max(ww / naturalW, wh / naturalH);
      if (!keepView || !aspect.ratio) view = { s: 1, x: 0, y: 0 };
      [...backdrop.querySelectorAll('.fpk-zoom button, .fpk-zoom input, [data-act="center"]')].forEach((el) => { el.disabled = !aspect.ratio; });
      draw();
    }

    function clamp() {
      const mx = Math.max(0, ((naturalW * base * view.s) / ww - 1) * 50);
      const my = Math.max(0, ((naturalH * base * view.s) / wh - 1) * 50);
      view.x = Math.max(-mx, Math.min(mx, view.x));
      view.y = Math.max(-my, Math.min(my, view.y));
    }

    function geometry() {
      const k = base * view.s;
      const w = naturalW * k, h = naturalH * k;
      const left = ww / 2 + (view.x / 100) * ww - w / 2;
      const top = wh / 2 + (view.y / 100) * wh - h / 2;
      return { k, w, h, left, top };
    }

    function draw() {
      clamp();
      const g = geometry();
      mediaEl.style.width = g.w + 'px';
      mediaEl.style.height = g.h + 'px';
      mediaEl.style.left = g.left + 'px';
      mediaEl.style.top = g.top + 'px';
      slider.value = String(view.s);
    }

    // Zoom keeps the point under the centre of the window fixed.
    function zoomTo(s) {
      const next = clampS(s);
      const r = next / view.s;
      view = { s: next, x: view.x * r, y: view.y * r };
      draw();
    }

    presetsEl.innerHTML = aspects.map((a) =>
      `<button type="button" class="fpk-preset" data-key="${a.key}"${a === aspect ? ' data-active' : ''}>${a.label}</button>`).join('');
    presetsEl.addEventListener('click', (e) => {
      const btn = e.target.closest('.fpk-preset');
      if (!btn) return;
      aspect = byKey(btn.getAttribute('data-key')) || aspects[0];
      [...presetsEl.children].forEach((c) => c.toggleAttribute('data-active', c === btn));
      layout(false);
    });

    // Pointer: one pointer pans, two pointers pinch-zoom.
    const pointers = new Map();
    let pan = null, pinch = null;
    win.addEventListener('pointerdown', (e) => {
      if (!aspect.ratio) return;
      win.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 1) {
        pan = { px: e.clientX, py: e.clientY, x: view.x, y: view.y };
        win.setAttribute('data-panning', '');
      } else if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, s: view.s };
        pan = null;
      }
    });
    win.addEventListener('pointermove', (e) => {
      if (!pointers.has(e.pointerId)) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pinch && pointers.size >= 2) {
        const [a, b] = [...pointers.values()];
        zoomTo(pinch.s * (Math.hypot(a.x - b.x, a.y - b.y) / pinch.d));
      } else if (pan) {
        view.x = pan.x + ((e.clientX - pan.px) / ww) * 100;
        view.y = pan.y + ((e.clientY - pan.py) / wh) * 100;
        draw();
      }
    });
    const endPointer = (e) => {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinch = null;
      if (!pointers.size) { pan = null; win.removeAttribute('data-panning'); }
    };
    win.addEventListener('pointerup', endPointer);
    win.addEventListener('pointercancel', endPointer);
    win.addEventListener('wheel', (e) => {
      if (!aspect.ratio) return;
      e.preventDefault();
      zoomTo(view.s * Math.pow(1.0015, -e.deltaY));
    }, { passive: false });
    slider.addEventListener('input', () => zoomTo(Number(slider.value)));
    backdrop.querySelector('[data-act="in"]').addEventListener('click', () => zoomTo(view.s * 1.15));
    backdrop.querySelector('[data-act="out"]').addEventListener('click', () => zoomTo(view.s / 1.15));
    backdrop.querySelector('[data-act="center"]').addEventListener('click', () => { view.x = 0; view.y = 0; draw(); });
    backdrop.querySelector('[data-act="reset"]').addEventListener('click', () => {
      aspect = byKey(opts.defaultAspect) || aspects[0];
      [...presetsEl.children].forEach((c) => c.toggleAttribute('data-active', c.getAttribute('data-key') === aspect.key));
      layout(false);
    });

    function result() {
      if (!aspect.ratio) return { aspect: aspect.key, view: { aspect: aspect.key, x: 0, y: 0, s: 1 }, rect: { sx: 0, sy: 0, sw: naturalW, sh: naturalH } };
      const g = geometry();
      const sw = Math.min(naturalW, ww / g.k), sh = Math.min(naturalH, wh / g.k);
      const sx = Math.max(0, Math.min(naturalW - sw, -g.left / g.k));
      const sy = Math.max(0, Math.min(naturalH - sh, -g.top / g.k));
      return { aspect: aspect.key, view: { aspect: aspect.key, x: view.x, y: view.y, s: view.s }, rect: { sx, sy, sw, sh } };
    }

    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); finish(null); return; }
      if (e.key === 'Enter') { e.preventDefault(); finish(result()); return; }
      if (!aspect.ratio) return;
      const step = e.shiftKey ? 5 : 1;
      const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
      if (moves[e.key]) { e.preventDefault(); view.x += moves[e.key][0]; view.y += moves[e.key][1]; draw(); }
      else if (e.key === '+' || e.key === '=') { e.preventDefault(); zoomTo(view.s * 1.1); }
      else if (e.key === '-') { e.preventDefault(); zoomTo(view.s / 1.1); }
    }
    const onResize = () => layout(true);

    function finish(value) {
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onResize);
      mediaEl.remove();
      backdrop.remove();
      resolve(value);
    }
    backdrop.querySelector('[data-act="cancel"]').addEventListener('click', () => finish(null));
    backdrop.querySelector('[data-act="apply"]').addEventListener('click', () => finish(result()));
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) finish(null); });
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', onResize);

    layout(!!init);
    win.focus({ preventScroll: true });
  });
}
