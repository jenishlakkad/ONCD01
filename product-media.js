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
//   fit           cover | contain                   (default 'contain' — shows the
//                 whole uploaded photo, never crops it; pass fit="cover" to fill
//                 the box edge-to-edge instead, cropping non-matching aspect ratios)
//   placeholder   Empty-state caption.
//   hover-video   Boolean attribute — hovering swaps the cover to the
//                 product's first video (muted/looping) if it has one.
//   zoom          Boolean attribute — clicking opens a full-screen lightbox
//                 over the full `media` array, starting at active-index.

(() => {
  function firstImage(media) { return media.find((m) => m && m.kind === 'image' && m.url) || null; }
  function firstVideo(media) { return media.find((m) => m && m.kind === 'video' && m.url) || null; }

  // Shared across every <product-media> on the page — at most ONE card's
  // hover/touch preview video may be active at a time. Desktop mouse hover
  // is naturally exclusive already (only one element can be :hover'd), but
  // touch has no such guarantee: pointerleave for a touch pointer that just
  // lifts off (rather than dragging away) is not reliably fired by every
  // mobile browser, so without this, tapping card B would leave card A's
  // video playing/paused-mid-clip in the background. Centralizing it here
  // (rather than a per-card boolean) is what makes "only one active video"
  // an invariant instead of something each card has to get right on its own.
  let activeMedia = null;

  // Hover previews start instantly because each card loads its small
  // preview clip (see server/lib/videoPreview.js) while it's on screen —
  // but only on devices that can hover (mouse/trackpad) and when the
  // visitor hasn't asked to save data. Phones load on tap instead.
  const canPreload = (() => {
    try {
      const conn = navigator.connection || {};
      if (conn.saveData || /(^|-)2g$/.test(conn.effectiveType || '')) return false;
      return window.matchMedia('(hover: hover) and (pointer: fine)').matches;
    } catch { return false; }
  })();
  // Cards start loading when they come within ~1.5 screens of view. On this
  // site the page scrolls inside <body> (not the window), and an observer
  // rooted at the window is clipped to what's visible — its margin would be
  // ignored — so it's rooted at whichever element actually scrolls.
  let observer = null;
  const preloadObserver = canPreload && 'IntersectionObserver' in window ? {
    observe(el) {
      if (!observer) {
        let root = null;
        try {
          const b = document.body;
          if (b && /(auto|scroll)/.test(getComputedStyle(b).overflowY)) root = b;
        } catch {}
        observer = new IntersectionObserver((entries) => {
          for (const e of entries) {
            if (!e.isIntersecting) continue;
            observer.unobserve(e.target);
            e.target._preloadHoverVideo();
          }
        }, { root, rootMargin: '1200px 0px' });
      }
      observer.observe(el);
    },
    unobserve(el) { if (observer) observer.unobserve(el); },
  } : null;
  // The URL a card should play on hover: the small preview when there is one.
  function hoverSrc(v) { return (v && (v.previewUrl || v.url)) || ''; }

  // Tapping/clicking ANYWHERE that isn't the currently active card (not just
  // tapping a different card, which _startHoverVideo() already handles, but
  // e.g. tapping blank page area) also deactivates it. Registered once, at
  // module load, on the bubble phase — pointerdown bubbles to document from
  // every card's shadow-DOM content (retargeted to the <product-media> host
  // itself per standard shadow-DOM event retargeting), so this one listener
  // covers every card without each instance adding its own.
  document.addEventListener('pointerdown', (e) => {
    if (activeMedia && e.target !== activeMedia) activeMedia._stopHoverVideo();
  });

  const HOST_STYLE =
    ':host{display:block;position:relative;width:100%;height:100%;aspect-ratio:3/2;' +
    '  overflow:hidden;background:rgba(127,127,127,.08);' +
    '  font:13px/1.3 system-ui,-apple-system,sans-serif;color:inherit}' +
    '.cover,.hover-vid,.poster-vid{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;' +
    '  display:block;border:0}' +
    '.cover{transition:opacity .18s ease}' +
    '.hover-vid{opacity:0;pointer-events:none;transition:opacity .18s ease;background:#000}' +
    '.poster-vid{background:#000}' +
    // The photo stays up until the video is actually playing (data-vid-ready),
    // so hovering never flashes black while the clip loads.
    ':host([data-hovering][data-vid-ready]) .hover-vid{opacity:1}' +
    ':host([data-hovering][data-vid-ready]) .cover{opacity:0}' +
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
    ':host([data-zoomable]){cursor:zoom-in}' +
    // ── Main product view (gallery / autoplay-video) ──
    // The playing video: preview clip first (starts instantly), the full
    // file fades in over it once it is actually playing.
    '.main-vid,.main-vid-hd{position:absolute;inset:0;width:100%;height:100%;display:none;border:0;' +
    '  pointer-events:none;background:transparent}' +
    '.main-vid-hd{opacity:0;transition:opacity .35s ease}' +
    ':host([data-main-video]) .main-vid,:host([data-main-video]) .main-vid-hd{display:block}' +
    ':host([data-hd]) .main-vid-hd{opacity:1}' +
    '.vid-wait{position:absolute;inset:0;display:none;align-items:center;justify-content:center;' +
    '  pointer-events:none;opacity:0;animation:pm-in .3s ease .35s forwards}' +
    ':host([data-vid-wait]) .vid-wait{display:flex}' +
    '@keyframes pm-in{to{opacity:1}}' +
    // Previous / next arrows and the "3 / 8" counter.
    ':host([gallery]){touch-action:pan-y}' +
    '.nav{position:absolute;top:50%;z-index:3;width:44px;height:44px;margin-top:-22px;padding:0;border:0;' +
    '  border-radius:50%;display:none;align-items:center;justify-content:center;cursor:pointer;' +
    '  background:rgba(255,255,255,.9);color:#221f1c;box-shadow:0 2px 12px rgba(0,0,0,.16);' +
    '  -webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px);' +
    '  transition:transform .15s ease,background .15s ease,box-shadow .15s ease}' +
    '.nav:hover{background:#fff;transform:scale(1.07);box-shadow:0 4px 16px rgba(0,0,0,.2)}' +
    '.nav:active{transform:scale(.96)}' +
    '.nav:focus-visible{outline:2px solid #9c7a2e;outline-offset:2px}' +
    '.nav svg{width:20px;height:20px}' +
    '.prev{left:14px}.next{right:14px}' +
    '.counter{position:absolute;left:14px;bottom:14px;z-index:3;display:none;padding:4px 10px;' +
    '  border-radius:999px;background:rgba(32,29,24,.62);color:#fff;pointer-events:none;' +
    '  font:600 11.5px/1.4 system-ui,-apple-system,sans-serif;letter-spacing:.04em}' +
    ':host([data-multi]) .nav,:host([data-multi]) .counter{display:flex}' +
    '@media (max-width:600px){.nav{width:38px;height:38px;margin-top:-19px}.prev{left:8px}.next{right:8px}' +
    '  .counter{left:10px;bottom:10px}}';

  const CHEVRON_LEFT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg>';
  const CHEVRON_RIGHT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 5l7 7-7 7"/></svg>';

  // Visitors who asked to save data get the light preview clip only.
  const saveData = (() => { try { return !!(navigator.connection && navigator.connection.saveData); } catch { return false; } })();

  function isTypingTarget(t) {
    if (!t) return false;
    const tag = (t.tagName || '').toLowerCase();
    return tag === 'input' || tag === 'textarea' || tag === 'select' || t.isContentEditable;
  }
  // Images already requested, so moving to the next one is instant.
  const preloaded = new Set();
  function preloadImage(url) {
    if (!url || preloaded.has(url)) return;
    preloaded.add(url);
    const i = new Image();
    i.decoding = 'async';
    i.src = url;
  }

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
    static get observedAttributes() { return ['shape', 'radius', 'fit', 'placeholder', 'active-index', 'media', 'gallery', 'autoplay-video']; }

    constructor() {
      super();
      const root = this.attachShadow({ mode: 'open' });
      root.innerHTML =
        '<style>' + HOST_STYLE + '</style>' +
        '<img class="cover" alt="" draggable="false" style="display:none">' +
        '<video class="poster-vid" muted playsinline preload="metadata" style="display:none"></video>' +
        '<video class="hover-vid" muted loop playsinline preload="none"></video>' +
        '<video class="main-vid" muted loop playsinline disablepictureinpicture></video>' +
        '<video class="main-vid-hd" muted loop playsinline disablepictureinpicture></video>' +
        '<div class="vid-wait"><oncd-loader size="40"></oncd-loader></div>' +
        '<div class="play-big"><span>' + PLAY_ICON_BIG + '</span></div>' +
        '<div class="badge" style="display:none">' + PLAY_ICON + '</div>' +
        '<div class="empty">' + IMG_ICON + '<div class="cap"></div></div>' +
        '<button type="button" class="nav prev" aria-label="Previous image">' + CHEVRON_LEFT + '</button>' +
        '<button type="button" class="nav next" aria-label="Next image">' + CHEVRON_RIGHT + '</button>' +
        '<div class="counter" aria-live="polite"></div>';
      this._img = root.querySelector('.cover');
      this._posterVid = root.querySelector('.poster-vid');
      this._hoverVid = root.querySelector('.hover-vid');
      this._playBig = root.querySelector('.play-big');
      this._badge = root.querySelector('.badge');
      this._empty = root.querySelector('.empty');
      this._cap = root.querySelector('.cap');
      this._mainVid = root.querySelector('.main-vid');
      this._mainHd = root.querySelector('.main-vid-hd');
      this._counter = root.querySelector('.counter');
      this._mainGen = 0;
      this._mainItem = null;
      this._mainCrop = [];
      this._inView = true;
      root.querySelector('.prev').addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); this.go(-1); });
      root.querySelector('.next').addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); this.go(1); });
      // Swipe left/right on touch screens (vertical drags still scroll the page).
      this._onPointerDown = (e) => {
        if (!this.hasAttribute('gallery') || e.pointerType === 'mouse') return;
        this._swipe = { x: e.clientX, y: e.clientY, t: Date.now() };
      };
      this._onPointerUp = (e) => {
        const s = this._swipe;
        this._swipe = null;
        if (!s) return;
        const dx = e.clientX - s.x, dy = e.clientY - s.y;
        if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy) * 1.3 && Date.now() - s.t < 800) {
          this._suppressClick = Date.now();
          this.go(dx < 0 ? 1 : -1);
        }
      };
      this._onPointerCancel = () => { this._swipe = null; };
      // ← / → on the keyboard, unless the visitor is typing or a dialog is open.
      this._onKey = (e) => {
        if (!this.hasAttribute('gallery') || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
        if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
        if (Lightbox.isOpen() || isTypingTarget(e.target) || document.querySelector('.dialog-backdrop')) return;
        const r = this.getBoundingClientRect();
        if (r.bottom < 0 || r.top > (window.innerHeight || 0)) return; // gallery not on screen
        e.preventDefault();
        this.go(e.key === 'ArrowLeft' ? -1 : 1);
      };
      // Pause the main video while it's scrolled away or the tab is hidden.
      this._onVisibility = () => this._syncMainPlayback();
      this._posterCropCleanup = null;
      this._hoverCropCleanup = null;
      this._onEnter = () => this._startHoverVideo();
      this._onLeave = () => this._stopHoverVideo();
      this._onClick = (e) => this._handleClick(e);
      this._onPlaying = () => { if (this.hasAttribute('data-hovering')) this.setAttribute('data-vid-ready', ''); };
      this._hoverVid.addEventListener('playing', this._onPlaying);
      // A missing/broken preview clip falls back to the full video.
      this._onVidError = () => {
        const v = firstVideo(this._media);
        if (!v || !v.previewUrl || this._hoverVid.getAttribute('src') !== v.previewUrl) return;
        this._previewFailed = true;
        this._hoverVid.setAttribute('src', v.url);
        if (this.hasAttribute('data-hovering')) {
          const p = this._hoverVid.play();
          if (p && p.catch) p.catch(() => {});
        }
      };
      this._hoverVid.addEventListener('error', this._onVidError);
      // Same fallback for a thumbnail's still frame.
      this._posterVid.addEventListener('error', () => {
        const a = this._posterActive;
        if (a && a.previewUrl && this._posterVid.getAttribute('src') === a.previewUrl) this._posterVid.src = a.url;
      });
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
      if (preloadObserver && this.hasAttribute('hover-video')) preloadObserver.observe(this);
      this.addEventListener('pointerenter', this._onEnter);
      this.addEventListener('pointerleave', this._onLeave);
      this.addEventListener('click', this._onClick);
      this.addEventListener('pointerdown', this._onPointerDown);
      this.addEventListener('pointerup', this._onPointerUp);
      this.addEventListener('pointercancel', this._onPointerCancel);
      document.addEventListener('keydown', this._onKey);
      document.addEventListener('visibilitychange', this._onVisibility);
      if (this.hasAttribute('autoplay-video') && 'IntersectionObserver' in window && !this._viewObserver) {
        let root = null;
        try { if (/(auto|scroll)/.test(getComputedStyle(document.body).overflowY)) root = document.body; } catch {}
        this._viewObserver = new IntersectionObserver((entries) => {
          for (const e of entries) this._inView = e.isIntersecting;
          this._syncMainPlayback();
        }, { root, threshold: 0.15 });
        this._viewObserver.observe(this);
      }
      this._render();
    }
    disconnectedCallback() {
      if (preloadObserver) preloadObserver.unobserve(this);
      this.removeEventListener('pointerenter', this._onEnter);
      this.removeEventListener('pointerleave', this._onLeave);
      this.removeEventListener('click', this._onClick);
      this.removeEventListener('pointerdown', this._onPointerDown);
      this.removeEventListener('pointerup', this._onPointerUp);
      this.removeEventListener('pointercancel', this._onPointerCancel);
      document.removeEventListener('keydown', this._onKey);
      document.removeEventListener('visibilitychange', this._onVisibility);
      if (this._viewObserver) { this._viewObserver.disconnect(); this._viewObserver = null; }
      this._stopMainVideo();
      this._stopHoverVideo();
      if (this._posterCropCleanup) this._posterCropCleanup();
      if (this._hoverCropCleanup) this._hoverCropCleanup();
    }
    attributeChangedCallback(name, oldVal, newVal) {
      if (name === 'media' && oldVal !== newVal) {
        this._media = safeParseJson(newVal || '[]');
        this._previewFailed = false;
        if (preloadObserver && this.isConnected && this.hasAttribute('hover-video')) preloadObserver.observe(this);
      }
      this._render();
    }

    _activeIndex() {
      const n = parseInt(this.getAttribute('active-index'), 10);
      return Number.isFinite(n) ? n : 0;
    }

    // Points the hover video at its clip and lets the browser buffer it, so
    // a later hover plays at once. Called when the card nears the screen.
    _preloadHoverVideo() {
      if (!this.hasAttribute('hover-video')) return;
      const v = firstVideo(this._media);
      if (!v) return;
      const src = this._previewFailed ? v.url : hoverSrc(v);
      if (this._hoverVid.getAttribute('src') !== src) this._hoverVid.setAttribute('src', src);
      this._hoverVid.preload = 'auto';
    }

    _startHoverVideo() {
      if (!this.hasAttribute('hover-video')) return;
      const v = firstVideo(this._media);
      if (!v) return;
      // Only one card's video may be active at a time — stop whichever card
      // (if any) held that spot before this one takes it. A no-op when this
      // card is already the active one (e.g. a stray extra pointerenter).
      if (activeMedia && activeMedia !== this) activeMedia._stopHoverVideo();
      activeMedia = this;
      // Compare the attribute, not the .src property: the property is
      // always absolute while stored URLs are usually relative, so comparing
      // the property re-assigned (and re-downloaded) the video on every hover.
      const src = this._previewFailed ? v.url : hoverSrc(v);
      if (this._hoverVid.getAttribute('src') !== src) this._hoverVid.setAttribute('src', src);
      this._hoverVid.preload = 'auto';
      if (this._hoverCropCleanup) this._hoverCropCleanup();
      this._hoverCropCleanup = null;
      // Framing is measured against this element (the card), never the video
      // itself — see utils/applyVideoCrop.js for why that matters.
      import('./utils/applyVideoCrop.js').then(({ applyVideoCrop }) => {
        if (this._hoverCropCleanup) this._hoverCropCleanup();
        this._hoverCropCleanup = applyVideoCrop(this._hoverVid, v.crop || null, this);
      });
      this.setAttribute('data-hovering', '');
      // Always restart from the beginning — without this, a video paused
      // mid-playback (on a previous hover) resumes from that same stale
      // position instead of the start, which is the exact "diamond appears
      // lower in the frame on the second hover" bug this fixes.
      if (this._hoverVid.currentTime > 0) this._hoverVid.currentTime = 0;
      const p = this._hoverVid.play();
      if (p && p.catch) p.catch(() => {});
    }
    _stopHoverVideo() {
      if (activeMedia === this) activeMedia = null;
      this.removeAttribute('data-hovering');
      this.removeAttribute('data-vid-ready');
      this._hoverVid.pause();
      if (this._hoverVid.currentTime > 0) this._hoverVid.currentTime = 0;
    }

    // Moves the main view to the previous (-1) / next (+1) item, wrapping
    // around, and tells the page (which highlights the matching thumbnail)
    // through a bubbling "media-change" event.
    go(delta) {
      const n = (this._media || []).length;
      if (n < 2) return;
      const cur = Math.max(0, Math.min(this._activeIndex(), n - 1));
      const next = (cur + delta + n) % n;
      this.setAttribute('active-index', String(next));
      this.dispatchEvent(new CustomEvent('media-change', { detail: { index: next }, bubbles: true, composed: true }));
    }

    // ── Autoplaying video in the main view ────────────────────────────
    // Starts with the light preview clip (plays almost at once), and on a
    // large screen also loads the full-quality file underneath; once that
    // is actually playing it fades in at the same moment of the clip. If
    // the full file can't play in this browser, the preview simply stays.
    _showMainVideo(item) {
      if (this._mainItem && this._mainItem.url === item.url) { this._syncMainPlayback(); return; }
      this._stopMainVideo();
      this._mainItem = item;
      const gen = ++this._mainGen;
      const preview = item.previewUrl || '';
      const firstSrc = preview || item.url;
      const wantHd = !!preview && !saveData && this.clientWidth * (window.devicePixelRatio || 1) > 560;
      this.setAttribute('data-main-video', '');
      this.setAttribute('data-vid-wait', '');

      const main = this._mainVid, hd = this._mainHd;
      main.style.objectFit = hd.style.objectFit = this._img.style.objectFit;
      const alive = () => gen === this._mainGen;
      main.onplaying = () => { if (alive()) this.removeAttribute('data-vid-wait'); };
      main.onerror = () => {
        if (!alive()) return;
        // Preview missing/broken: play the full file directly instead.
        if (main.getAttribute('src') === preview && item.url && preview) {
          main.setAttribute('src', item.url);
          this._playEl(main);
        } else {
          this.removeAttribute('data-vid-wait');
        }
      };
      main.setAttribute('src', firstSrc);
      main.preload = 'auto';
      this._playEl(main);

      if (wantHd) {
        hd.oncanplay = () => {
          if (!alive() || !hd.videoWidth) return;
          // Pick up where the preview is, so the switch is seamless.
          if (main.currentTime && hd.duration && main.currentTime < hd.duration) hd.currentTime = main.currentTime;
          hd.oncanplay = null;
          this._playEl(hd);
        };
        hd.onplaying = () => {
          if (!alive() || !hd.videoWidth) return;
          this.setAttribute('data-hd', '');
          this.removeAttribute('data-vid-wait');
          setTimeout(() => { if (alive() && this.hasAttribute('data-hd')) main.pause(); }, 400);
        };
        hd.onerror = () => {}; // can't play here (e.g. HEVC .mov) — keep the preview
        hd.setAttribute('src', item.url);
        hd.preload = 'auto';
      }

      import('./utils/applyVideoCrop.js').then(({ applyVideoCrop }) => {
        if (!alive()) return;
        this._mainCrop.forEach((c) => c());
        this._mainCrop = [applyVideoCrop(main, item.crop || null, this), applyVideoCrop(hd, item.crop || null, this)];
      });
    }
    _stopMainVideo() {
      this._mainGen++;
      this._mainItem = null;
      this.removeAttribute('data-main-video');
      this.removeAttribute('data-vid-wait');
      this.removeAttribute('data-hd');
      this._mainCrop.forEach((c) => c());
      this._mainCrop = [];
      for (const v of [this._mainVid, this._mainHd]) {
        v.onplaying = v.onerror = v.oncanplay = null;
        v.pause();
        if (v.hasAttribute('src')) { v.removeAttribute('src'); v.load(); } // stop the download too
      }
    }
    _canPlayMain() { return this._inView && !document.hidden && !Lightbox.isOpen(); }
    _playEl(v) {
      if (!this._canPlayMain()) return;
      const p = v.play();
      if (p && p.catch) p.catch(() => {});
    }
    // Plays the visible main video only while it's on screen and the tab is
    // showing; pauses it otherwise (saves battery and data).
    _syncMainPlayback() {
      if (!this._mainItem) return;
      const shown = this.hasAttribute('data-hd') ? this._mainHd : this._mainVid;
      if (this._canPlayMain()) {
        if (shown.paused && shown.hasAttribute('src')) this._playEl(shown);
        // The full file may still be getting ready underneath.
        if (shown === this._mainVid && this._mainHd.hasAttribute('src') && this._mainHd.paused && this._mainHd.readyState >= 3) this._playEl(this._mainHd);
      } else {
        this._mainVid.pause();
        this._mainHd.pause();
      }
    }

    _handleClick(e) {
      // A swipe on a touch screen ends with a click: that's not a "zoom" tap.
      if (this._suppressClick && Date.now() - this._suppressClick < 500) { e.preventDefault(); return; }
      if (!this.hasAttribute('zoom') || !this._media.length) return;
      e.preventDefault();
      e.stopPropagation();
      // Paging inside the lightbox moves this view along too, so closing it
      // leaves the shopper on the photo they were looking at.
      const onChange = this.hasAttribute('gallery') ? (i) => {
        if (i === this._activeIndex()) return;
        this.setAttribute('active-index', String(i));
        this.dispatchEvent(new CustomEvent('media-change', { detail: { index: i }, bubbles: true, composed: true }));
      } : null;
      Lightbox.open(this._media, this._activeIndex(), onChange, this);
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
      const fit = (this.getAttribute('fit') || 'contain').toLowerCase() === 'cover' ? 'cover' : 'contain';
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
      const isVideo = !!(active && active.kind === 'video' && active.url);
      // Main product view: a selected video plays by itself (muted, looping).
      const autoplay = isVideo && this.hasAttribute('autoplay-video');
      const showVideoPoster = isVideo && !autoplay;
      if (autoplay) this._showMainVideo(active);
      else if (this._mainItem) this._stopMainVideo();

      // Gallery: arrows + counter when there's more than one item, and the
      // neighbouring photos fetched ahead so the arrows feel instant.
      const multi = this.hasAttribute('gallery') && media.length > 1;
      this.toggleAttribute('data-multi', multi);
      if (multi) {
        const i = media.indexOf(active);
        this._counter.textContent = `${i + 1} / ${media.length}`;
        for (const d of [1, -1]) {
          const nb = media[(i + d + media.length) % media.length];
          if (nb && nb.kind === 'image') preloadImage(nb.url);
        }
      }

      this._img.style.display = showImage ? 'block' : 'none';
      if (showImage) this._img.src = active.url;

      // The active item being a video (explicitly selected via a thumbnail) shows
      // its own paused first frame with a big play affordance — it must NOT
      // autoplay here; only hover-video (cards) or the zoom lightbox actually play.
      if (showVideoPoster) {
        // A small box (gallery thumbnail, card) shows its still frame from
        // the light preview clip instead of pulling in the full video —
        // some older originals are 10–50 MB. Large displays keep the
        // full-quality file.
        const small = this.clientWidth > 0 && this.clientWidth <= 360;
        const posterSrc = small && active.previewUrl ? active.previewUrl : active.url;
        this._posterActive = active;
        if (this._posterVid.getAttribute('src') !== posterSrc) {
          this._posterVid.src = posterSrc;
          // preload="metadata" doesn't guarantee a frame has been decoded
          // and painted — without forcing one, this sits blank/white
          // instead of showing the video at all until played. Seeking to a
          // tiny nonzero offset reliably forces a real frame decode+paint
          // without any perceptible playback, which is what "must NOT
          // autoplay" above actually means — a play/pause is not reliable
          // here since pause can land before the first frame paints.
          this._posterVid.addEventListener('loadeddata', () => { this._posterVid.currentTime = 0.1; }, { once: true });
        }
        this._posterVid.style.display = 'block';
        if (this._posterCropCleanup) this._posterCropCleanup();
        this._posterCropCleanup = null;
        import('./utils/applyVideoCrop.js').then(({ applyVideoCrop }) => {
          if (this._posterCropCleanup) this._posterCropCleanup();
          this._posterCropCleanup = applyVideoCrop(this._posterVid, active.crop || null, this);
        });
      } else {
        this._posterVid.style.display = 'none';
        this._posterVid.removeAttribute('src');
        if (this._posterCropCleanup) { this._posterCropCleanup(); this._posterCropCleanup = null; }
      }
      this._playBig.style.display = showVideoPoster ? 'flex' : 'none';
      this._empty.style.display = (!showImage && !isVideo) ? 'flex' : 'none';

      // The small corner "this product has a video" badge only makes sense on
      // hover-video cards, and only while the video isn't already the thing shown.
      this._badge.style.display = (vid && this.hasAttribute('hover-video') && !isVideo) ? 'flex' : 'none';
      // 'auto' once the card has asked for its clip (preload/hover); until
      // then only the tiny header so an off-screen grid costs nothing.
      if (this._hoverVid.preload !== 'auto') this._hoverVid.preload = vid ? 'metadata' : 'none';
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
    let onChange = null, owner = null, isOpenNow = false, swipe = null;

    function ensure() {
      if (root) return;
      root = document.createElement('div');
      root.setAttribute('data-product-media-lightbox', '');
      root.style.cssText =
        'position:fixed;inset:0;z-index:99999;display:none;align-items:center;justify-content:center;' +
        'background:rgba(20,19,18,.96);';
      root.innerHTML =
        '<button data-act="close" aria-label="Close" style="position:absolute;top:16px;right:20px;' +
        '  background:rgba(255,255,255,.12);border:0;color:#fff;width:40px;height:40px;border-radius:50%;' +
        '  cursor:pointer;font-size:20px;line-height:1;">&times;</button>' +
        '<button data-act="prev" aria-label="Previous" style="position:absolute;left:16px;top:50%;' +
        '  transform:translateY(-50%);background:rgba(255,255,255,.12);border:0;color:#fff;width:44px;' +
        '  height:44px;border-radius:50%;cursor:pointer;padding:11px;">' + CHEVRON_LEFT.replace('<svg ', '<svg width="22" height="22" ') + '</button>' +
        '<button data-act="next" aria-label="Next" style="position:absolute;right:16px;top:50%;' +
        '  transform:translateY(-50%);background:rgba(255,255,255,.12);border:0;color:#fff;width:44px;' +
        '  height:44px;border-radius:50%;cursor:pointer;padding:11px;">' + CHEVRON_RIGHT.replace('<svg ', '<svg width="22" height="22" ') + '</button>' +
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
      // Swipe between items on touch screens (not while zoomed in — then a
      // drag pans the photo).
      stage.addEventListener('pointerdown', (e) => {
        if (e.pointerType === 'mouse' || view.s > 1) return;
        swipe = { x: e.clientX, y: e.clientY, t: Date.now() };
      });
      stage.addEventListener('pointerup', (e) => {
        const s = swipe; swipe = null;
        if (!s || view.s > 1) return;
        const dx = e.clientX - s.x, dy = e.clientY - s.y;
        if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.3 && Date.now() - s.t < 800) go(dx < 0 ? 1 : -1);
      });
      stage.addEventListener('pointercancel', () => { swipe = null; });
      // A full video this browser can't play (e.g. an old HEVC .mov): fall
      // back to its preview clip rather than a black box.
      videoEl.addEventListener('error', () => {
        const item = items[idx];
        if (item && item.kind === 'video' && item.previewUrl && videoEl.getAttribute('src') !== item.previewUrl) {
          videoEl.setAttribute('src', item.previewUrl);
          const p = videoEl.play();
          if (p && p.catch) p.catch(() => {});
        }
      });
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
        videoEl.setAttribute('src', item.url);
        videoEl.muted = true; // allowed to autoplay everywhere; uploads carry no sound anyway
        videoEl.loop = true;
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
      if (items.length < 2) return;
      idx = (idx + delta + items.length) % items.length;
      render();
      if (onChange) onChange(idx);
    }

    function onKey(e) {
      if (e.key === 'Escape') close();
      else if (e.key === 'ArrowLeft') go(-1);
      else if (e.key === 'ArrowRight') go(1);
    }

    function open(media, startIndex, changeCb, ownerEl) {
      const all = media || [];
      items = all.filter((m) => m && m.url);
      if (!items.length) return;
      // startIndex counts over the full list; map it onto the playable items.
      const start = all[startIndex];
      idx = Math.max(0, items.indexOf(start));
      // Report positions back in the owner's (full-list) numbering.
      onChange = changeCb ? (i) => changeCb(all.indexOf(items[i])) : null;
      owner = ownerEl || null;
      isOpenNow = true;
      ensure();
      root.style.display = 'flex';
      document.documentElement.style.overflow = 'hidden';
      document.addEventListener('keydown', onKey);
      if (owner) owner._syncMainPlayback(); // pauses the video behind the overlay
      render();
    }
    function close() {
      if (!root || !isOpenNow) return;
      isOpenNow = false;
      root.style.display = 'none';
      videoEl.pause();
      videoEl.removeAttribute('src');
      videoEl.load();
      document.documentElement.style.overflow = '';
      document.removeEventListener('keydown', onKey);
      const o = owner;
      owner = null; onChange = null;
      if (o) o._syncMainPlayback(); // resume the main view's video
    }

    return { open, isOpen: () => isOpenNow };
  })();

  if (!customElements.get('product-media')) {
    customElements.define('product-media', ProductMedia);
  }
})();
