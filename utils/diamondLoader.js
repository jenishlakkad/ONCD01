/* ONCD diamond loader.
 *
 * Loaded as a plain <script> in every page's <head>, BEFORE support.js, so
 * it is on screen from the very first paint. It provides two things:
 *
 * 1. The page-start overlay. Pages render in the browser (React + the
 *    template compiler download first), so until now the screen sat blank
 *    for a second or two on every visit. The overlay covers that time, and
 *    stays until the page has rendered AND its first /api/ requests have
 *    finished, so visitors never see "No products" / "No users yet" flash
 *    before the real data arrives. Details:
 *      - the diamond only fades in after 250ms, so fast loads show no
 *        loader at all (no flicker);
 *      - it never waits more than 6s once the page has rendered (in-page
 *        loaders take over from there);
 *      - if the page hasn't rendered after 12s (e.g. a blocked script or
 *        a dead connection) it offers a Reload button instead of spinning
 *        forever.
 *
 * 2. <oncd-loader>, the same diamond as a reusable element for in-page
 *    loading states:
 *      <oncd-loader label="Loading diamonds"></oncd-loader>
 *      <oncd-loader size="16" layout="inline"></oncd-loader>  (in a line of text)
 *      <oncd-loader static size="44"></oncd-loader>           (no motion: error / empty states)
 *    Attributes: size (px, default 48), label (text under the diamond,
 *    also read out to screen readers), layout ("block" default | "inline"),
 *    static (no animation), tone="light" (white cut lines, for use on
 *    a gold/dark button).
 *
 * Respects prefers-reduced-motion: the diamond then only glows softly.
 */
(function () {
  'use strict';

  var GOLD = '#9c7a2e';      // --color-accent
  var GOLD_LIGHT = '#e0c583'; // --color-accent-300
  var BG = '#faf8f4';        // --color-bg
  var INK = '#221f1c';       // --color-text

  // ── The diamond ───────────────────────────────────────────────────────
  // A brilliant cut seen from the side: table on top, crown, girdle, and
  // the pavilion narrowing to the culet. Eight facets light up one after
  // another (left to right, like light moving through the stone), a soft
  // highlight sweeps across, and two small glints twinkle.
  var OUTLINE = 'M18 12H46L58 26L32 54L6 26Z';
  var LINES = 'M6 26H58M18 12L25 26L32 12L39 26L46 12M15 26L32 54L25 26M39 26L32 54L49 26';
  // Every facet, with its resting tone (t: light crown, deeper pavilion,
  // alternating so the stone reads as cut, not flat) and its place in the
  // shimmer (o: light travels left to right through the stone).
  var FACETS = [
    { p: '6,26 18,12 25,26', t: 1, o: 0 },
    { p: '18,12 32,12 25,26', t: 0, o: 2 },
    { p: '25,26 32,12 39,26', t: 1, o: 4 },
    { p: '32,12 46,12 39,26', t: 0, o: 6 },
    { p: '39,26 46,12 58,26', t: 1, o: 8 },
    { p: '6,26 15,26 32,54', t: 2, o: 1 },
    { p: '15,26 25,26 32,54', t: 3, o: 3 },
    { p: '25,26 39,26 32,54', t: 2, o: 5 },
    { p: '39,26 49,26 32,54', t: 3, o: 7 },
    { p: '49,26 58,26 32,54', t: 2, o: 9 },
  ];
  var TONES = ['#f8f0dd', '#efdcb0', '#e6cd93', '#d6b672'];
  var SPARKLE = 'M0-5C.4-1.4 1.4-.4 5 0 1.4.4.4 1.4 0 5-.4 1.4-1.4.4-5 0-1.4-.4-.4-1.4 0-5Z';

  var uid = 0;
  function diamondSvg(size) {
    var id = 'oncdDia' + (++uid);
    var tones = '';
    var flashes = '';
    for (var i = 0; i < FACETS.length; i++) {
      var f = FACETS[i];
      tones += '<polygon points="' + f.p + '" fill="' + TONES[f.t] + '"/>';
      flashes += '<polygon class="dl-facet" points="' + f.p + '" style="animation-delay:' + (f.o * 0.09).toFixed(2) + 's"/>';
    }
    var facets = tones + flashes;
    return (
      '<svg class="dl-svg" width="' + size + '" height="' + size + '" viewBox="0 0 64 64" aria-hidden="true" focusable="false">' +
        '<defs>' +
          '<clipPath id="' + id + 'c"><path d="' + OUTLINE + '"/></clipPath>' +
          '<linearGradient id="' + id + 'g" x1="0" y1="0" x2="1" y2="0">' +
            '<stop offset="0" stop-color="#fff" stop-opacity="0"/>' +
            '<stop offset=".5" stop-color="#fff" stop-opacity=".85"/>' +
            '<stop offset="1" stop-color="#fff" stop-opacity="0"/>' +
          '</linearGradient>' +
        '</defs>' +
        '<g class="dl-float">' +
          '<path class="dl-body" d="' + OUTLINE + '"/>' +
          facets +
          '<g clip-path="url(#' + id + 'c)"><rect class="dl-sweep" x="-30" y="0" width="22" height="64" fill="url(#' + id + 'g)" transform="skewX(-18)"/></g>' +
          '<path class="dl-lines" d="' + LINES + '"/>' +
          '<path class="dl-edge" d="' + OUTLINE + '"/>' +
          // Position on the <g>; the animation scales/rotates the <path>
          // inside (a CSS transform would replace an SVG transform attribute).
          '<g transform="translate(47 10)"><path class="dl-spark dl-spark-a" d="' + SPARKLE + '"/></g>' +
          '<g transform="translate(11 20) scale(.7)"><path class="dl-spark dl-spark-b" d="' + SPARKLE + '"/></g>' +
        '</g>' +
        '<ellipse class="dl-shadow" cx="32" cy="60" rx="13" ry="1.8"/>' +
      '</svg>'
    );
  }

  // Shared by the overlay (document) and the element (shadow DOM).
  // Colors read the site's tokens when present, with the brand values as
  // fallback (the overlay is on screen before the stylesheet loads).
  var DIAMOND_CSS =
    '.dl-svg{display:block;overflow:visible}' +
    '.dl-body{fill:' + GOLD_LIGHT + '}' +
    '.dl-facet{fill:#fff;opacity:0;animation:dl-facet 2.2s ease-in-out infinite}' +
    '.dl-lines{fill:none;stroke:var(--color-accent,' + GOLD + ');stroke-width:.7;stroke-linejoin:round;stroke-linecap:round;opacity:.75}' +
    '.dl-edge{fill:none;stroke:var(--color-accent,' + GOLD + ');stroke-width:1.35;stroke-linejoin:round}' +
    '.dl-sweep{animation:dl-sweep 2.6s cubic-bezier(.45,.05,.35,1) infinite}' +
    '.dl-spark{fill:var(--color-accent,' + GOLD + ');opacity:0;transform-box:fill-box;transform-origin:center}' +
    '.dl-spark-a{animation:dl-spark 2.6s ease-in-out .9s infinite}' +
    '.dl-spark-b{animation:dl-spark 2.6s ease-in-out 2.1s infinite}' +
    '.dl-float{animation:dl-float 2.6s ease-in-out infinite}' +
    '.dl-shadow{fill:var(--color-accent-900,#3c2f13);opacity:.12;transform-box:fill-box;transform-origin:center;animation:dl-shadow 2.6s ease-in-out infinite}' +
    '@keyframes dl-facet{0%,100%{opacity:0}28%{opacity:.78}52%{opacity:0}}' +
    '@keyframes dl-sweep{0%{transform:skewX(-18deg) translateX(0)}60%,100%{transform:skewX(-18deg) translateX(118px)}}' +
    '@keyframes dl-spark{0%,100%{opacity:0;transform:scale(.3) rotate(0)}12%{opacity:1;transform:scale(1) rotate(45deg)}26%{opacity:0;transform:scale(.3) rotate(90deg)}}' +
    '@keyframes dl-float{0%,100%{transform:translateY(0)}50%{transform:translateY(-3px)}}' +
    '@keyframes dl-shadow{0%,100%{transform:scaleX(1);opacity:.12}50%{transform:scaleX(.82);opacity:.07}}' +
    '.is-static .dl-facet,.is-static .dl-sweep,.is-static .dl-spark,.is-static .dl-float,.is-static .dl-shadow{animation:none}' +
    '.is-static .dl-facet{opacity:0}.is-static .dl-sweep{display:none}' +
    '@media (prefers-reduced-motion:reduce){' +
      '.dl-sweep,.dl-spark{display:none}.dl-float,.dl-shadow{animation:none}' +
      '.dl-facet{animation:dl-glow 2.4s ease-in-out infinite;animation-delay:0s!important}' +
      '@keyframes dl-glow{0%,100%{opacity:0}50%{opacity:.35}}' +
    '}';

  // ── 1. Page-start overlay ─────────────────────────────────────────────
  function startOverlay() {
    if (window.__oncdBootLoader) return;
    window.__oncdBootLoader = true;

    var style = document.createElement('style');
    style.textContent =
      '#oncd-boot{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;' +
        'background:' + BG + ';transition:opacity .35s ease,visibility .35s;font-family:Georgia,"Times New Roman",serif}' +
      '#oncd-boot.is-done{opacity:0;visibility:hidden;pointer-events:none}' +
      '#oncd-boot .ob-inner{display:flex;flex-direction:column;align-items:center;gap:18px;opacity:0;' +
        'animation:ob-in .5s ease .25s forwards}' +
      '#oncd-boot .ob-word{font-size:13px;letter-spacing:.42em;margin-right:-.42em;color:' + INK + ';opacity:.78}' +
      '#oncd-boot .ob-slow{display:none;flex-direction:column;align-items:center;gap:12px;margin-top:6px;' +
        'font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;color:' + INK + ';text-align:center;padding:0 24px}' +
      '#oncd-boot.is-slow .ob-slow{display:flex}' +
      '#oncd-boot .ob-slow span{opacity:.7}' +
      '#oncd-boot .ob-slow button{font:600 13px system-ui,-apple-system,"Segoe UI",sans-serif;letter-spacing:.04em;' +
        'padding:10px 22px;border-radius:999px;border:1px solid ' + GOLD + ';background:' + GOLD + ';color:#fff;cursor:pointer}' +
      '#oncd-boot .ob-slow button:hover{background:#7c5f22}' +
      '#oncd-boot .ob-slow button:focus-visible{outline:2px solid ' + GOLD + ';outline-offset:3px}' +
      '@keyframes ob-in{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}' +
      '@media (prefers-reduced-motion:reduce){#oncd-boot .ob-inner{animation:none;opacity:1}}' +
      DIAMOND_CSS; // dl-* class names are unique to the loader, so no scoping needed
    (document.head || document.documentElement).appendChild(style);

    var el = document.createElement('div');
    el.id = 'oncd-boot';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    el.setAttribute('aria-label', 'Loading');
    el.innerHTML =
      '<div class="ob-inner">' + diamondSvg(64) +
        '<div class="ob-word">ONCD</div>' +
        '<div class="ob-slow"><span>This is taking longer than usual.</span>' +
        '<button type="button">Reload page</button></div>' +
      '</div>';
    el.querySelector('button').addEventListener('click', function () { location.reload(); });
    // <body> doesn't exist yet while <head> is parsing: show it straight
    // away on <html>, then move it into <body> once that exists.
    document.documentElement.appendChild(el);
    document.addEventListener('DOMContentLoaded', function () {
      if (el.parentNode && document.body) document.body.appendChild(el);
    });

    // Count the page's first /api/ requests so the overlay can wait for them.
    var pending = 0;
    var lastActivity = Date.now();
    var finished = false;
    var renderedAt = 0;
    var apiAfterRender = false;
    var nativeFetch = window.fetch;
    if (typeof nativeFetch === 'function') {
      window.fetch = function (input) {
        var p = nativeFetch.apply(window, arguments);
        if (finished) return p;
        var url = typeof input === 'string' ? input : (input && input.url) || String(input || '');
        if (url.indexOf('/api/') === -1) return p;
        pending++;
        lastActivity = Date.now();
        if (renderedAt) apiAfterRender = true;
        var done = function () { pending--; lastActivity = Date.now(); };
        p.then(done, done);
        return p;
      };
    }

    var startedAt = Date.now();
    var QUIET_MS = 220;     // no /api/ activity for this long = data is in
    var NO_API_GRACE_MS = 800;
    var MAX_AFTER_RENDER = 6000;
    var SLOW_MS = 12000;

    function hasRendered() {
      var root = document.getElementById('dc-root');
      return !!(root && root.firstElementChild);
    }

    function finish() {
      if (finished) return;
      finished = true;
      clearInterval(timer);
      el.classList.add('is-done');
      setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 450);
    }

    var timer = setInterval(function () {
      var now = Date.now();
      if (!renderedAt) {
        if (hasRendered()) { renderedAt = now; lastActivity = Math.max(lastActivity, now); }
        else if (now - startedAt > SLOW_MS) el.classList.add('is-slow');
        return;
      }
      if (now - renderedAt > MAX_AFTER_RENDER) return finish();
      // Pages load their helper modules first and only then ask for data,
      // so right after the first render there is a short gap with no
      // request yet. Wait for the data requests to begin (or ~0.8s if the
      // page makes none) before treating silence as "done".
      if (!apiAfterRender && now - renderedAt < NO_API_GRACE_MS) return;
      if (pending <= 0 && now - lastActivity >= QUIET_MS) finish();
    }, 50);

    // Coming back with the browser's Back button can restore a page from
    // memory without running scripts again: never leave the overlay up.
    window.addEventListener('pageshow', function (e) { if (e.persisted) finish(); });
  }

  // ── 2. <oncd-loader> element ──────────────────────────────────────────
  function defineElement() {
    if (!window.customElements || customElements.get('oncd-loader')) return;

    var ELEMENT_CSS =
      ':host{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;' +
        'padding:48px 16px;text-align:center;color:var(--color-text,' + INK + ')}' +
      ':host([layout="inline"]){display:inline-flex;vertical-align:-0.2em;padding:0;gap:6px;flex-direction:row}' +
      ':host([hidden]){display:none}' +
      '.label{font-size:11px;letter-spacing:.24em;text-transform:uppercase;opacity:.62;margin-right:-.24em}' +
      ':host([layout="inline"]) .label{font-size:inherit;letter-spacing:normal;text-transform:none;margin:0}' +
      '.label:empty{display:none}' +
      // On a gold button: white cut lines so the stone stays readable.
      ':host([tone="light"]) .dl-edge,:host([tone="light"]) .dl-lines{stroke:#fff}' +
      ':host([tone="light"]) .dl-shadow{display:none}' +
      DIAMOND_CSS;

    class OncdLoader extends HTMLElement {
      static get observedAttributes() { return ['size', 'label', 'static']; }
      connectedCallback() {
        if (!this.shadowRoot) this.attachShadow({ mode: 'open' });
        this._render();
      }
      attributeChangedCallback() {
        if (this.shadowRoot) this._render();
      }
      _render() {
        var size = parseInt(this.getAttribute('size'), 10);
        if (!(size > 0)) size = 48;
        var label = this.getAttribute('label') || '';
        var isStatic = this.hasAttribute('static') && this.getAttribute('static') !== 'false';
        if (isStatic) {
          // Decorative (error / empty states): the text next to it says it all.
          this.removeAttribute('role');
          this.removeAttribute('aria-live');
          this.removeAttribute('aria-label');
          this.setAttribute('aria-hidden', 'true');
        } else {
          this.removeAttribute('aria-hidden');
          this.setAttribute('role', 'status');
          this.setAttribute('aria-live', 'polite');
          this.setAttribute('aria-label', label || 'Loading');
        }
        var key = size + '|' + label + '|' + isStatic;
        if (this._key === key) return; // nothing visible changed
        this._key = key;
        var safe = document.createElement('div');
        safe.textContent = label;
        this.shadowRoot.innerHTML =
          '<style>' + ELEMENT_CSS + '</style>' +
          '<div class="' + (isStatic ? 'is-static' : '') + '">' + diamondSvg(size) + '</div>' +
          '<div class="label">' + safe.innerHTML + '</div>';
      }
    }
    customElements.define('oncd-loader', OncdLoader);
  }

  startOverlay();
  defineElement();
})();
