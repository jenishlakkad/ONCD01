// Shared helper: which catalogs are enabled site-wide (admin-controlled), used to
// hide nav links / catalog sections for disabled product types. The server is the
// real enforcement point (disabled catalogs 404/empty via the API regardless of
// this) — this is UI-polish so the nav doesn't link to something the API refuses.

export async function fetchProductTypeVisibility() {
  try {
    const res = await fetch('/api/product-types', { credentials: 'same-origin' });
    const json = await res.json();
    const out = { diamond: true, jewelry: true, gemstone: true };
    if (res.ok && Array.isArray(json.data)) {
      for (const t of json.data) out[t.key] = !!t.enabled;
    }
    return out;
  } catch {
    return { diamond: true, jewelry: true, gemstone: true };
  }
}
