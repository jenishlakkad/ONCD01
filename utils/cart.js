// Shared inquiry-cart store for the storefront pages. Persists to
// localStorage so the cart survives reloads and stays in sync across tabs
// (the 'storage' event) and within a tab (the 'aurum-cart-change' event
// every page listens for after a mutation).

const KEY = 'aurum_cart_v1';

function readCart() {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeCart(items) {
  try { localStorage.setItem(KEY, JSON.stringify(items)); } catch {}
  try { window.dispatchEvent(new CustomEvent('aurum-cart-change')); } catch {}
  syncCartToServer(items);
}

// Fire-and-forget mirror of the cart to the server, purely so admins can see
// it (AdminUsers.dc.html "Details" view) — localStorage above remains the
// actual source of truth for what the customer sees. No-ops harmlessly (401)
// for guests, same "don't wait, don't surface errors" approach as submitInquiry.
function syncCartToServer(items) {
  try {
    fetch('/api/cart', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({
        items: items.map((i) => ({ sku: i.sku, name: i.name, priceLabel: i.priceLabel || '', qty: i.qty || 1 })),
      }),
    }).catch(() => {});
  } catch {}
}

export function getCart() {
  return readCart();
}

export function addToCart(item) {
  const items = readCart();
  const existing = items.find(i => i.sku === item.sku);
  if (existing) {
    existing.qty = (existing.qty || 1) + (item.qty || 1);
  } else {
    items.push({
      sku: item.sku,
      name: item.name,
      priceLabel: item.priceLabel || '',
      qty: item.qty || 1,
    });
  }
  writeCart(items);
  return items;
}

export function removeFromCart(sku) {
  const items = readCart().filter(i => i.sku !== sku);
  writeCart(items);
  return items;
}

export function clearCart() {
  writeCart([]);
}

export function buildMessage(items, opts) {
  opts = opts || {};
  if (!items || !items.length) return '';
  const header = opts.header || "Hello, I'd like to inquire about the following items:";
  const lines = items.map(
    i => `- ${i.sku} ${i.name} (Qty ${i.qty}) - ${i.priceLabel || 'Price on request'}`
  );
  return [header, '', ...lines].join('\n');
}

// contacts matches the shape returned by GET /api/settings/public:
// { whatsapp, inquiryEmail, lineId, skypeId, ... }
export function channelLink(channel, message, contacts) {
  const text = message || '';
  const c = contacts || {};
  switch (channel) {
    case 'whatsapp':
      return 'https://wa.me/' + (c.whatsapp || '15551234567').replace(/[^\d]/g, '') + '?text=' + encodeURIComponent(text);
    case 'email':
      return (
        'mailto:' + (c.inquiryEmail || 'sales@aurumandco.com') + '?subject=' +
        encodeURIComponent('Product Inquiry') +
        '&body=' +
        encodeURIComponent(text)
      );
    case 'line':
      return 'https://line.me/R/msg/text/?' + encodeURIComponent(text);
    case 'skype':
      return 'skype:' + (c.skypeId || 'live:.cid.aurumandco') + '?chat&text=' + encodeURIComponent(text);
    default:
      return '#';
  }
}

// Fire-and-forget: records the inquiry server-side so admin can see it,
// without blocking the WhatsApp/Email/LINE/Skype deep link the button also opens.
export function submitInquiry(items, channel) {
  if (!items || !items.length) return;
  try {
    fetch('/api/inquiries', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({
        items: items.map((i) => ({ sku: i.sku, name: i.name, qty: i.qty, priceLabel: i.priceLabel })),
        channel,
      }),
    }).catch((err) => console.error('[cart] failed to record inquiry', err));
  } catch (err) {
    console.error('[cart] failed to record inquiry', err);
  }
}
