// Shared client-side search/filter helpers for the product listing pages
// (Diamonds/Jewelry/Gemstones) and the admin product table. Filtering stays
// client-side over the already-fetched catalog, matching how these pages
// already work (fetch once, filter in renderVals) rather than round-tripping
// to the server per keystroke.

// Distinct, sorted, non-empty values for a (possibly dotted) field across a
// list of items — used to build filter option lists straight from real data
// instead of a hardcoded list that can drift out of sync with the catalog.
export function distinctValues(items, path) {
  const parts = path.split('.');
  const set = new Set();
  for (const item of items) {
    let v = item;
    for (const p of parts) v = v == null ? v : v[p];
    if (v !== null && v !== undefined && v !== '') set.add(v);
  }
  return [...set].sort((a, b) => String(a).localeCompare(String(b)));
}

// True if `query` is empty, or if any of `getters(item)` contains it
// (case-insensitive substring match).
export function searchMatch(item, query, getters) {
  const q = (query || '').trim().toLowerCase();
  if (!q) return true;
  return getters.some((get) => String(get(item) || '').toLowerCase().includes(q));
}
