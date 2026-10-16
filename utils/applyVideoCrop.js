// Shows a video framed by saved {x, y, scale} metadata (old-style framing
// stored on product_media.crop) using CSS positioning, resolved against the
// CONTAINER's size so one framing looks right in a card, a gallery or a
// thumbnail. Videos processed on upload (server/lib/processVideo.js) are
// already cut to their frame and have no crop metadata — for those this
// just restores normal sizing (crop = null).
//
// Measuring the container matters: inside <product-media>/<video-frame> the
// video sits directly in a shadow root, so it has no parentElement. Falling
// back to measuring the video itself (as this used to) meant every repeat
// hover measured the video it had already enlarged and enlarged it again,
// pushing the stone off-centre a little more each time.
//
// Returns a cleanup function.
export function applyVideoCrop(videoEl, crop, container) {
  if (!videoEl) return () => {};
  const root = videoEl.getRootNode && videoEl.getRootNode();
  const box = container || videoEl.parentElement || (root && root.host) || null;

  if (!crop || !box) {
    videoEl.style.position = '';
    videoEl.style.width = '';
    videoEl.style.height = '';
    videoEl.style.left = '';
    videoEl.style.top = '';
    return () => {};
  }

  if (videoEl.parentElement && getComputedStyle(videoEl.parentElement).position === 'static') {
    videoEl.parentElement.style.position = 'relative';
  }
  videoEl.style.position = 'absolute';

  function place() {
    const vw = videoEl.videoWidth, vh = videoEl.videoHeight;
    const cw = box.clientWidth, ch = box.clientHeight;
    if (!vw || !vh || !cw || !ch) return;
    const base = Math.max(cw / vw, ch / vh);
    const k = base * (crop.scale || 1);
    const w = vw * k, h = vh * k;
    // Same limits as the framing tool: never pan past the video's edge.
    const mx = Math.max(0, (w / cw - 1) * 50), my = Math.max(0, (h / ch - 1) * 50);
    const x = Math.max(-mx, Math.min(mx, crop.x || 0));
    const y = Math.max(-my, Math.min(my, crop.y || 0));
    videoEl.style.width = w + 'px';
    videoEl.style.height = h + 'px';
    videoEl.style.left = (cw / 2 + (x / 100) * cw - w / 2) + 'px';
    videoEl.style.top = (ch / 2 + (y / 100) * ch - h / 2) + 'px';
  }

  if (videoEl.readyState >= 1) place();
  videoEl.addEventListener('loadedmetadata', place);
  const ro = new ResizeObserver(place);
  ro.observe(box);

  return () => {
    ro.disconnect();
    videoEl.removeEventListener('loadedmetadata', place);
  };
}
