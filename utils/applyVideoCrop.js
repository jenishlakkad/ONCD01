// Applies a non-destructive video framing { x, y, scale } (set via
// utils/videoCropper.js, saved on the product_media row) to a <video>
// element with CSS positioning. Same pan/zoom math the cropper's own
// preview uses, just resolved against the element's actual rendered size
// instead of the cropper's fixed 380px preview box — so one saved framing
// looks right whether it's a 110px admin tile, a full detail-page gallery,
// or a thumbnail strip. No-ops (video keeps native sizing/object-fit) when
// `crop` is falsy, which is the common case (most videos are never framed).
//
// Returns a cleanup function; call it if the video element or its framing
// can change during the component's lifetime (unnecessary for a one-shot
// static render that's about to be torn down anyway).
export function applyVideoCrop(videoEl, crop) {
  if (!videoEl) return () => {};

  if (!crop) {
    videoEl.style.position = '';
    videoEl.style.width = '';
    videoEl.style.height = '';
    videoEl.style.left = '';
    videoEl.style.top = '';
    return () => {};
  }

  const parent = videoEl.parentElement;
  if (parent && getComputedStyle(parent).position === 'static') parent.style.position = 'relative';
  if (parent) parent.style.overflow = 'hidden';
  videoEl.style.position = 'absolute';

  function place() {
    const vw = videoEl.videoWidth, vh = videoEl.videoHeight;
    const box = videoEl.parentElement || videoEl;
    const cw = box.clientWidth, ch = box.clientHeight;
    if (!vw || !vh || !cw || !ch) return;
    const base = Math.max(cw / vw, ch / vh);
    const k = base * (crop.scale || 1);
    const w = vw * k, h = vh * k;
    const left = cw / 2 + ((crop.x || 0) / 100) * cw - w / 2;
    const top = ch / 2 + ((crop.y || 0) / 100) * ch - h / 2;
    videoEl.style.width = w + 'px';
    videoEl.style.height = h + 'px';
    videoEl.style.left = left + 'px';
    videoEl.style.top = top + 'px';
  }

  if (videoEl.readyState >= 1) place();
  videoEl.addEventListener('loadedmetadata', place);
  const ro = new ResizeObserver(place);
  if (videoEl.parentElement) ro.observe(videoEl.parentElement);

  return () => {
    ro.disconnect();
    videoEl.removeEventListener('loadedmetadata', place);
  };
}
