// <product-media> — read-only product photo/video display for the storefront.
// Unlike <image-slot> (a design-time authoring widget with a click-to-browse
// file picker), this element only ever displays what its `media` property is
// given. No file input, no drag-drop-to-upload, no persistence.
//
// Usage:
//   <product-media media="{{ p.media }}" shape="rect" hover-video
//                   placeholder="Diamond photo" style="width:100%;height:100%;"></product-media>
//
// Properties/attributes:
//   media         Array of {id, kind:'image'|'video', url, sortOrder}. Set as a
//                 JS property (the DC template runtime passes live arrays to
//                 custom-element props, same as it does with onClick handlers).
//   active-index  Which item to display as the "cover" (default 0 among images,
//                 falling back to the first video if there is no image).
//   shape         rect | rounded | circle | pill   (default 'rounded')
//   radius        Corner radius in px for 'rounded'. (default 12)
//   fit           cover | contain                   (default 'cover')
//   placeholder   Empty-state caption.
//   hover-video   Boolean attribute — hovering swaps the cover to the
//                 product's first video (muted/looping) if it has one.
//   zoom          Boolean attribute — clicking opens a full-screen lightbox
//                 over the full `media` array, starting at active-index.

(() => {
  function firstImage(media) { return media.find((m) => m && m.kind === 'image' && m.url) || null; }
  function firstVideo(media) { return media.find((m) => m && m.kind === 'video' && m.url) || null; }

  const HOST_STYLE =
    ':host{display:block;position:relative;width:100%;height:100%;aspect-ratio:3/2;' +
    '  overflow:hidden;background:rgba(127,127,127,.08);' +
    '  font:13px/1.3 system-ui,-apple-system,sans-serif;color:inherit}' +
    '.cover,.hover-vid,.poster-vid{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;' +
    '  display:block;border:0}' +
    '.cover{transition:opacity .18s ease}' +
    '.hover-vid{opacity:0;pointer-events:none;transition:opacity .18s ease;background:#000}' +
    '.poster-vid{background:#000}' +
    ':host([data-hovering]) .hover-vid{opacity:1}' +
    ':host([data-hovering]) .cover{opacity:0}' +
    '.badge{position:absolute;right:8px;bottom:8px;width:24px;height:24px;border-radius:50%;' +
    '  background:rgba(0,0,0,.55);color:#fff;display:flex;align-items:center;justify-content:center;' +
    '  pointer-events:none;transition:opacity .18s ease}' +
    ':host([data-hovering]) .badge{opacity:0}' +
    '.play-big{position:absolute;inset:0;display:none;align-items:center;justify-content:center;' +
    '  pointer-events:none}' +
    '.play-big span{width:15%;min-width:36px;max-width:64px;aspect-ratio:1;border-radius:50%;' +
    '  background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center}' +
    '.play-big svg{width:42%;height:42%;margin-left:8%}' +
    '.empty{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;' +
    '  justify-content:center;gap:6px;text-align:center;padding:12px;box-sizing:border-box;opacity:.5}' +
    '.empty .cap{font-size:11px;max-width:90%}' +
    ':host([data-zoomable]){cursor:zoom-in}';

  const IMG_ICON =
    '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" ' +
    'stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/>' +
    '<circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/></svg>';

  const PLAY_ICON = '<svg width="12" height="12" viewBox="0 0 24 24" fill="#fff"><path d="M8 5v14l11-7Z"/></svg>';
  const PLAY_ICON_BIG = '<svg viewBox="0 0 24 24" fill="#fff"><path d="M8 5v14l11-7Z"/></svg>';

  class ProductMedia extends HTMLElement {
    // 'media' is observed too: this app's DC template runtime renders through
    // React 18, which — unlike React 19 — always stringifies non-string props
    // into attributes for custom (hyphenated) elements rather than assigning
    // them as JS properties. So media="{{ p.media }}" arrives here as a JSON
    // *attribute string*, not a live array; the `media` property setter below
    // is kept only for direct JS/console use.
    static get observedAttributes() { return ['shape', 'radius', 'fit', 'placeholder', 'active-index', 'media']; }

    constructor() {
      super();
      const root = this.attachShadow({ mode: 'open' });
      root.innerHTML =
        '<style>' + HOST_STYLE + '</style>' +
        '<img class="cover" alt="" draggable="false" style="display:none">' +
        '<video class="poster-vid" muted playsinline preload="metadata" style="display:none"></video>' +
        '<video class="hover-vid" muted loop playsinline preload="none"></video>' +
        '<div class="play-big"><span>' + PLAY_ICON_BIG + '</span></div>' +
        '<div class="badge" style="display:none">' + PLAY_ICON + '</div>' +
        '<div class="empty">' + IMG_ICON + '<div class="cap"></div></div>';
      this._img = root.querySelector('.cover');
      this._posterVid = root.querySelector('.poster-vid');
      this._hoverVid = root.querySelector('.hover-vid');
      this._playBig = root.querySelector('.play-big');
      this._badge = root.querySelector('.badge');
      this._empty = root.querySelector('.empty');
      this._cap = root.querySelector('.cap');
      this._media = [];
      this._onEnter = () => this._startHoverVideo();
      this._onLeave = () => this._stopHoverVideo();
      this._onClick = (e) => this._handleClick(e);
      this._upgradeProperty('media');
    }

    // Custom-elements-v1 gotcha: a property set before this class's accessor
    // existed (e.g. React assigning .media on a not-yet-upgraded element)
    // would otherwise sit as a plain instance property shadowing the
    // prototype's getter/setter forever. Re-assign through the accessor.
    _upgradeProperty(prop) {
      if (Object.prototype.hasOwnProperty.call(this, prop)) {
        const value = this[prop];
        delete this[prop];
        this[prop] = value;
      }
    }

    get media() { return this._media; }
    set media(v) {
      this._media = Array.isArray(v) ? v : (typeof v === 'string' ? safeParseJson(v) : []);
      this._render();
    }

    connectedCallback() {
      this.addEventListener('pointerenter', this._onEnter);
      this.addEventListener('pointerleave', this._onLeave);
      this.addEventListener('click', this._onClick);
      this._render();
    }
    disconnectedCallback() {
      this.removeEventListener('pointerenter', this._onEnter);
      this.removeEventListener('pointerleave', this._onLeave);
      this.removeEventListener('click', this._onClick);
      this._stopHoverVideo();
    }
    attributeChangedCallback(name, oldVal, newVal) {
      if (name === 'media' && oldVal !== newVal) this._media = safeParseJson(newVal || '[]');
      this._render();
    }

    _activeIndex() {
      const n = parseInt(this.getAttribute('active-index'), 10);
      return Number.isFinite(n) ? n : 0;
    }

    _startHoverVideo() {
      if (!this.hasAttribute('hover-video')) return;
      const v = firstVideo(this._media);
      if (!v) return;
      if (this._hoverVid.src !== v.url) this._hoverVid.src = v.url;
      this.setAttribute('data-hovering', '');
      const p = this._hoverVid.play();
      if (p && p.catch) p.catch(() => {});
    }
    _stopHoverVideo() {
      this.removeAttribute('data-hovering');
      this._hoverVid.pause();
    }

    _handleClick(e) {
      if (!this.hasAttribute('zoom') || !this._media.length) return;
      e.preventDefault();
      e.stopPropagation();
      Lightbox.open(this._media, this._activeIndex());
    }

    _render() {
      const shape = (this.getAttribute('shape') || 'rounded').toLowerCase();
      let radius = '';
      if (shape === 'circle') radius = '50%';
      else if (shape === 'pill') radius = '9999px';
      else if (shape === 'rounded') {
        const n = parseFloat(this.getAttribute('radius'));
        radius = (Number.isFinite(n) ? n : 12) + 'px';
      }
      this.shadowRoot.host.style.borderRadius = radius;
      const fit = (this.getAttribute('fit') || 'cover').toLowerCase() === 'contain' ? 'contain' : 'cover';
      this._img.style.objectFit = fit;
      this._hoverVid.style.objectFit = fit;

      const media = this._media || [];
      const vid = firstVideo(media);
      const activeIdx = this._activeIndex();
      // The active item is whatever active-index points at; fall back to the
      // first image, then the first item at all, only when active-index is
      // out of range (e.g. the array just changed size).
      const active = media[activeIdx] || firstImage(media) || media[0] || null;

      this._cap.textContent = this.getAttribute('placeholder') || 'No photo yet';
      this.toggleAttribute('data-zoomable', this.hasAttribute('zoom') && media.length > 0);
      this.toggleAttribute('data-editable', false);

      const showImage = !!(active && active.kind === 'image' && active.url);
      const showVideoPoster = !!(active && active.kind === 'video' && active.url);

      this._img.style.display = showImage ? 'block' : 'none';
      if (showImage) this._img.src = active.url;

      // The active item being a video (explicitly selected via a thumbnail) shows
      // its own paused first frame with a big play affordance — it must NOT
      // autoplay here; only hover-video (cards) or the zoom lightbox actually play.
      if (showVideoPoster) {
        if (this._posterVid.getAttribute('src') !== active.url) this._posterVid.src = active.url;
        this._posterVid.style.display = 'block';
      } else {
        this._posterVid.style.display = 'none';
        this._posterVid.removeAttribute('src');
      }
      this._playBig.style.display = showVideoPoster ? 'flex' : 'none';
      this._empty.style.display = (!showImage && !showVideoPoster) ? 'flex' : 'none';

      // The small corner "this product has a video" badge only makes sense on
      // hover-video cards, and only while the video isn't already the thing shown.
      this._badge.style.display = (vid && this.hasAttribute('hover-video') && !showVideoPoster) ? 'flex' : 'none';
      this._hoverVid.preload = vid ? 'metadata' : 'none';
    }
  }

  function safeParseJson(s) {
    try { const v = JSON.parse(s); return Array.isArray(v) ? v : []; } catch { return []; }
  }

  // ── Shared lightbox (one overlay reused by every <product-media> on the page) ──
  const Lightbox = (() => {
    let root = null, stage = null, imgEl = null, videoEl = null, counterEl = null;
    let prevBtn = null, nextBtn = null;
    let items = [], idx = 0;
    let view = { s: 1, x: 0, y: 0 };
    let drag = null;

    function ensure() {
      if (root) return;
      root = document.createElement('div');
      root.setAttribute('data-product-media-lightbox', '');
      root.style.cssText =
        'position:fixed;inset:0;z-index:99999;display:none;align-items:center;justify-content:center;' +
        'background:rgba(20,19,18,.92);';
      root.innerHTML =
        '<button data-act="close" aria-label="Close" style="position:absolute;top:16px;right:20px;' +
        '  background:rgba(255,255,255,.12);border:0;color:#fff;width:40px;height:40px;border-radius:50%;' +
        '  cursor:pointer;font-size:20px;line-height:1;">&times;</button>' +
        '<button data-act="prev" aria-label="Previous" style="position:absolute;left:16px;top:50%;' +
        '  transform:translateY(-50%);background:rgba(255,255,255,.12);border:0;color:#fff;width:44px;' +
        '  height:44px;border-radius:50%;cursor:pointer;font-size:22px;">&#8249;</button>' +
        '<button data-act="next" aria-label="Next" style="position:absolute;right:16px;top:50%;' +
        '  transform:translateY(-50%);background:rgba(255,255,255,.12);border:0;color:#fff;width:44px;' +
        '  height:44px;border-radius:50%;cursor:pointer;font-size:22px;">&#8250;</button>' +
        '<div data-stage style="width:min(92vw,1100px);height:min(86vh,900px);display:flex;' +
        '  align-items:center;justify-content:center;overflow:hidden;position:relative;touch-action:none;">' +
        '  <img data-img draggable="false" style="max-width:100%;max-height:100%;display:none;' +
        '    user-select:none;-webkit-user-drag:none;cursor:grab;">' +
        '  <video data-video controls playsinline style="max-width:100%;max-height:100%;display:none;"></video>' +
        '</div>' +
        '<div data-counter style="position:absolute;bottom:18px;left:50%;transform:translateX(-50%);' +
        '  color:rgba(255,255,255,.75);font:12px/1 system-ui,-apple-system,sans-serif;"></div>';
      document.body.appendChild(root);
      stage = root.querySelector('[data-stage]');
      imgEl = root.querySelector('[data-img]');
      videoEl = root.querySelector('[data-video]');
      counterEl = root.querySelector('[data-counter]');
      prevBtn = root.querySelector('[data-act="prev"]');
      nextBtn = root.querySelector('[data-act="next"]');

      root.querySelector('[data-act="close"]').addEventListener('click', close);
      prevBtn.addEventListener('click', () => go(-1));
      nextBtn.addEventListener('click', () => go(1));
      root.addEventListener('click', (e) => { if (e.target === root) close(); });
      imgEl.addEventListener('dblclick', () => {
        view = view.s > 1 ? { s: 1, x: 0, y: 0 } : { s: 2, x: 0, y: 0 };
        applyView();
      });
      imgEl.addEventListener('wheel', (e) => {
        e.preventDefault();
        const next = Math.max(1, Math.min(4, view.s * Math.pow(1.0015, -e.deltaY)));
        view.s = next;
        if (next === 1) { view.x = 0; view.y = 0; }
        applyView();
      }, { passive: false });
      imgEl.addEventListener('pointerdown', (e) => {
        if (view.s <= 1) return;
        drag = { px: e.clientX, py: e.clientY, x: view.x, y: view.y };
        imgEl.setPointerCapture(e.pointerId);
        imgEl.style.cursor = 'grabbing';
      });
      imgEl.addEventListener('pointermove', (e) => {
        if (!drag) return;
        view.x = drag.x + (e.clientX - drag.px);
        view.y = drag.y + (e.clientY - drag.py);
        applyView();
      });
      const endDrag = () => { drag = null; imgEl.style.cursor = 'grab'; };
      imgEl.addEventListener('pointerup', endDrag);
      imgEl.addEventListener('pointercancel', endDrag);
    }

    function applyView() {
      imgEl.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.s})`;
    }

    function render() {
      const item = items[idx];
      view = { s: 1, x: 0, y: 0 };
      applyView();
      videoEl.pause();
      videoEl.removeAttribute('src');
      videoEl.style.display = 'none';
      imgEl.style.display = 'none';
      if (item && item.kind === 'video') {
        videoEl.src = item.url;
        videoEl.style.display = 'block';
        const p = videoEl.play();
        if (p && p.catch) p.catch(() => {});
      } else if (item) {
        imgEl.src = item.url;
        imgEl.style.display = 'block';
      }
      const multi = items.length > 1;
      prevBtn.style.display = multi ? 'flex' : 'none';
      nextBtn.style.display = multi ? 'flex' : 'none';
      prevBtn.style.alignItems = 'center'; prevBtn.style.justifyContent = 'center';
      nextBtn.style.alignItems = 'center'; nextBtn.style.justifyContent = 'center';
      counterEl.textContent = multi ? `${idx + 1} / ${items.length}` : '';
    }

    function go(delta) {
      if (!items.length) return;
      idx = (idx + delta + items.length) % items.length;
      render();
    }

    function onKey(e) {
      if (e.key === 'Escape') close();
      else if (e.key === 'ArrowLeft') go(-1);
      else if (e.key === 'ArrowRight') go(1);
    }

    function open(media, startIndex) {
      items = (media || []).filter((m) => m && m.url);
      if (!items.length) return;
      idx = Math.max(0, Math.min(startIndex || 0, items.length - 1));
      ensure();
      root.style.display = 'flex';
      document.documentElement.style.overflow = 'hidden';
      document.addEventListener('keydown', onKey);
      render();
    }
    function close() {
      if (!root) return;
      root.style.display = 'none';
      videoEl.pause();
      document.documentElement.style.overflow = '';
      document.removeEventListener('keydown', onKey);
    }

    return { open };
  })();

  if (!customElements.get('product-media')) {
    customElements.define('product-media', ProductMedia);
  }
})();
