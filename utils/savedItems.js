// Wishlist helper for logged-in customers. Server-backed (saved_items
// table) — unlike utils/cart.js there's no localStorage mirror, since saved
// items only make sense for an identified account (guests are redirected to
// Login.dc.html before they can save anything).

export async function getSavedSkus() {
  try {
    const res = await fetch('/api/saved-items', { credentials: 'same-origin' });
    if (!res.ok) return new Set();
    const json = await res.json();
    return new Set((json.data || []).map((i) => i.sku));
  } catch {
    return new Set();
  }
}

export async function getSavedItems() {
  try {
    const res = await fetch('/api/saved-items', { credentials: 'same-origin' });
    if (!res.ok) return [];
    const json = await res.json();
    return json.data || [];
  } catch {
    return [];
  }
}

export async function saveItem(item) {
  await fetch('/api/saved-items', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({
      sku: item.sku, name: item.name, priceLabel: item.priceLabel || '', productType: item.productType || '',
    }),
  });
}

export async function unsaveItem(sku) {
  await fetch('/api/saved-items/' + encodeURIComponent(sku), { method: 'DELETE', credentials: 'same-origin' });
}
