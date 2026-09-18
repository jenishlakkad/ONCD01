// <video-frame> — displays one video with optional non-destructive crop
// framing (see utils/videoCropper.js / utils/applyVideoCrop.js) and a
// centered play-icon affordance so it reads as a video at a glance next to
// photo tiles.
//
// Used wherever a single video needs to render inside markup the page's own
// DC template already controls — the admin media grid, the product-detail
// thumbnail strip — contexts where, unlike <product-media>, sibling buttons
// (Edit, remove, Set Cover…) are laid out by that same template around it.
// This element only owns the video layer itself, not the whole tile.
//
// Usage: <video-frame src="{{ m.url }}" crop="{{ m.cropJson }}" style="width:100%;height:100%;"></video-frame>
//   src        video URL.
//   crop       JSON string {x,y,scale} (falsy/absent/"null" = no framing,
//              shown at its natural aspect via object-fit:contain).
//   play-icon  boolean attribute — omit to hide the centered play affordance
//              (shown by default).

(() => {
  const HOST_STYLE =
    ':host{display:block;position:relative;width:100%;height:100%;overflow:hidden;background:#000}' +
    'video{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;display:block;border:0}' +
    '.play{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:none}' +
    '.play span{width:30%;min-width:26px;max-width:40px;aspect-ratio:1;border-radius:50%;' +
    '  background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center}' +
    '.play svg{width:42%;height:42%;margin-left:8%}';
  const PLAY_ICON = '<svg viewBox="0 0 24 24" fill="#fff"><path d="M8 5v14l11-7Z"/></svg>';

  class VideoFrame extends HTMLElement {
    static get observedAttributes() { return ['src', 'crop', 'play-icon']; }

    constructor() {
      super();
      const root = this.attachShadow({ mode: 'open' });
      root.innerHTML =
        '<style>' + HOST_STYLE + '</style>' +
        '<video muted playsinline preload="metadata"></video>' +
        '<div class="play"><span>' + PLAY_ICON + '</span></div>';
      this._video = root.querySelector('video');
      this._playIcon = root.querySelector('.play');
      this._cleanupCrop = null;
    }

    connectedCallback() { this._render(); }
    disconnectedCallback() { if (this._cleanupCrop) this._cleanupCrop(); }
    attributeChangedCallback() { this._render(); }

    _render() {
      const src = this.getAttribute('src') || '';
      if (this._video.getAttribute('src') !== src) {
        this._video.src = src;
        // preload="metadata" guarantees duration/dimensions but not that a
        // frame has actually been decoded and painted — without forcing
        // one, this sits blank/white until played. Seeking to a tiny
        // nonzero offset reliably forces a real frame decode+paint in every
        // major browser (play-then-pause is not reliable here: the pause
        // can land before the first frame actually paints, leaving
        // currentTime at 0 with nothing drawn).
        this._video.addEventListener('loadeddata', () => { this._video.currentTime = 0.1; }, { once: true });
      }
      this._playIcon.style.display = this.hasAttribute('play-icon') && this.getAttribute('play-icon') === '0' ? 'none' : 'flex';

      if (this._cleanupCrop) { this._cleanupCrop(); this._cleanupCrop = null; }
      const cropRaw = this.getAttribute('crop');
      let crop = null;
      if (cropRaw && cropRaw !== 'null') {
        try { crop = JSON.parse(cropRaw); } catch { crop = null; }
      }
      import('./utils/applyVideoCrop.js').then(({ applyVideoCrop }) => {
        this._cleanupCrop = applyVideoCrop(this._video, crop);
      });
    }
  }

  if (!customElements.get('video-frame')) {
    customElements.define('video-frame', VideoFrame);
  }
})();
