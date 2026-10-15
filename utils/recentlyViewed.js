// Per-device browsing memory behind the homepage's "Recently Viewed" and
// "Recommended for You" sections, plus the visit timestamps behind the
// welcome bar's "new since your last visit" count. Only SKUs and times are
// stored; product details are always fetched fresh from the server, so a
// remembered item can never show a stale price or photo.

const VIEWED_KEY = 'oncd_recently_viewed_v1';
const VISIT_KEY = 'oncd_visits_v1';
const MAX_VIEWED = 20;
// A gap longer than this starts a new visit, so "since your last visit"
// means the previous browsing session, not the previous page load.
const VISIT_GAP_MS = 30 * 60 * 1000;

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function write(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
}

export function recordView(sku) {
  if (!sku) return;
  const list = read(VIEWED_KEY, []).filter((s) => typeof s === 'string' && s !== sku);
  list.unshift(sku);
  write(VIEWED_KEY, list.slice(0, MAX_VIEWED));
}

export function getRecentlyViewed() {
  const list = read(VIEWED_KEY, []);
  return Array.isArray(list) ? list.filter((s) => typeof s === 'string') : [];
}

export function clearRecentlyViewed() {
  write(VIEWED_KEY, []);
}

// Call once per homepage load. Returns the end of the previous visit as an
// ISO string, or null on a first visit.
export function touchVisit() {
  const now = Date.now();
  const stored = read(VISIT_KEY, {});
  const current = Number(stored.current) || 0;
  const next = !current || now - current > VISIT_GAP_MS
    ? { prev: current || null, current: now }
    : { prev: Number(stored.prev) || null, current: now };
  write(VISIT_KEY, next);
  return next.prev ? new Date(next.prev).toISOString() : null;
}
