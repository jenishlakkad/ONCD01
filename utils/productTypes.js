// Shared helper: which catalogs are enabled site-wide (admin-controlled), used to
// hide nav links / catalog sections for disabled product types. The server is the
// real enforcement point (disabled catalogs 404/empty via the API regardless of
// this) — this is UI-polish so the nav doesn't link to something the API refuses.
//
// The last answer is kept in localStorage so pages can start from it
// synchronously (see the state initializer on every storefront page) instead
// of briefly showing a disabled catalog in the nav/footer until this fetch
// returns. Other modules read it with readCachedTypeVisibility().

export const TYPE_VISIBILITY_KEY = 'oncd_type_visibility_v1';
const ALL_ON = { diamond: true, jewelry: true, gemstone: true };

export function readCachedTypeVisibility() {
  try {
    const v = JSON.parse(localStorage.getItem(TYPE_VISIBILITY_KEY) || 'null');
    return v && typeof v === 'object' ? { ...ALL_ON, ...v } : { ...ALL_ON };
  } catch {
    return { ...ALL_ON };
  }
}

export async function fetchProductTypeVisibility() {
  try {
    const res = await fetch('/api/product-types', { credentials: 'same-origin' });
    const json = await res.json();
    const out = { ...ALL_ON };
    if (res.ok && Array.isArray(json.data)) {
      for (const t of json.data) out[t.key] = !!t.enabled;
      try {
        const before = localStorage.getItem(TYPE_VISIBILITY_KEY);
        const after = JSON.stringify(out);
        localStorage.setItem(TYPE_VISIBILITY_KEY, after);
        // Lets other parts of the page (the inquiry cart) re-check right away.
        if (before !== after) window.dispatchEvent(new CustomEvent('oncd-type-visibility-change', { detail: out }));
      } catch {}
      return out;
    }
    return readCachedTypeVisibility();
  } catch {
    return readCachedTypeVisibility();
  }
}
