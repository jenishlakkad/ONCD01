// Shared inquiry-cart store for the storefront pages. Persists to
// localStorage so the cart survives reloads and stays in sync across tabs
// (the 'storage' event) and within a tab (the 'aurum-cart-change' event
// every page triggers after a mutation).

import { inquiryTitle, inquirySpecRows, inquiryPriceLabel } from './inquiryItem.js';
import { refFor, rememberNote, pendingFor } from './inquiryRef.js';

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

// item.product (optional) is the full raw serialized product row (see
// server/lib/serializeProduct.js) - when present it's what buildMessage()
// below uses to render full per-item specs and group items by product type.
// Without it (older stored carts, or callers that don't have it) the
// message falls back to just sku/name/priceLabel.
export function addToCart(item) {
  const items = readCart();
  const existing = items.find(i => i.sku === item.sku);
  if (existing) {
    existing.qty = (existing.qty || 1) + (item.qty || 1);
    if (item.product) existing.product = item.product;
  } else {
    items.push({
      sku: item.sku,
      name: item.name,
      priceLabel: item.priceLabel || '',
      qty: item.qty || 1,
      product: item.product || null,
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

// *word* is the shared bold convention on WhatsApp and Skype (their compose
// boxes render single-asterisk-wrapped text as bold). LINE and plain-text
// email don't render it, but it still reads fine there as plain emphasis
// markers - matches utils/inquiryItem.js's single-item message format.
function bold(text) {
  return `*${text}*`;
}

const TYPE_LABEL = { diamond: 'DIAMOND', jewelry: 'JEWELRY', gemstone: 'GEMSTONE' };
const TYPE_ORDER = ['diamond', 'jewelry', 'gemstone', 'other'];

// opts: { header, customer, note } - customer is the shape returned by
// GET /api/auth/me (id, full_name, email, mobile, company_name, ...), or
// omitted/null for a guest. Groups items by product type (diamond/jewelry/
// gemstone) so a mixed cart reads as clearly separated inquiries instead of
// one flat list, and mirrors the single-item popup's Product/Customer/
// Message section layout (see utils/inquiryItem.js inquiryMessage()).
export function buildMessage(items, opts) {
  opts = opts || {};
  if (!items || !items.length) return '';
  const header = opts.header || "Hello, I'd like to inquire about the following items:";
  // The reference ties this message to the inquiry stored for the sales
  // desk (see utils/inquiryRef.js); the note is remembered for submitInquiry.
  rememberNote(items, opts.note);
  const lines = [header, '', `Reference: ${bold(refFor(items))}`];

  const groups = new Map();
  for (const it of items) {
    const type = (it.product && it.product.type) || 'other';
    if (!groups.has(type)) groups.set(type, []);
    groups.get(type).push(it);
  }
  const orderedTypes = [...groups.keys()].sort((a, b) => TYPE_ORDER.indexOf(a) - TYPE_ORDER.indexOf(b));

  for (const type of orderedTypes) {
    const groupItems = groups.get(type);
    const label = TYPE_LABEL[type] || 'OTHER';
    lines.push('', bold(`${label} INQUIRY (${groupItems.length} item${groupItems.length > 1 ? 's' : ''})`));
    groupItems.forEach((it, idx) => {
      const p = it.product;
      const title = p ? inquiryTitle(p) : it.name;
      const priceLabel = p ? inquiryPriceLabel(p) : (it.priceLabel || 'Price on request');
      lines.push('', `${idx + 1}. SKU: ${it.sku}`, `   Item: ${bold(title)}`);
      if (p) {
        for (const row of inquirySpecRows(p)) lines.push(`   ${row.label}: ${row.value}`);
      }
      lines.push(`   Qty: ${it.qty}`, `   Price: ${bold(priceLabel)}`);
    });
  }

  if (opts.customer && opts.customer.id) {
    const c = opts.customer;
    lines.push('', bold('CUSTOMER DETAILS'), `Customer ID: ${c.id}`, `Name: ${bold(c.full_name || '')}`, `Email: ${c.email || ''}`);
    if (c.mobile) lines.push(`Phone: ${c.mobile}`);
    if (c.company_name) lines.push(`Company: ${c.company_name}`);
  }

  if (opts.note && opts.note.trim()) {
    lines.push('', bold('MESSAGE'), opts.note.trim());
  }

  return lines.join('\n');
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
        'mailto:' + (c.inquiryEmail || 'sales@oncd.com') + '?subject=' +
        encodeURIComponent('Product Inquiry') +
        '&body=' +
        encodeURIComponent(text)
      );
    // Unlike wa.me/mailto, LINE's own add-friend/open-chat link
    // (https://line.me/R/ti/p/{id} — same pattern already used correctly
    // in Contact.dc.html) has no official query param to prefill message
    // text, so `text` is intentionally unused here; this just opens a
    // chat with the configured account directly instead of LINE's generic
    // "share to any contact" sheet (line.me/R/msg/text/), which never
    // routed to the business's own LINE ID at all — the customer would
    // have to already have that ID as a friend and pick it manually, so
    // in practice the inquiry never reached the configured LINE account.
    case 'line':
      return 'https://line.me/R/ti/p/' + (c.lineId || '@oncd');
    case 'skype':
      return 'skype:' + (c.skypeId || 'live:.cid.oncd') + '?chat&text=' + encodeURIComponent(text);
    default:
      return '#';
  }
}

// Fire-and-forget: records the inquiry server-side so admin can see it,
// without blocking the WhatsApp/Email/LINE/Skype deep link the button also opens.
// Sends the same reference that's printed in the message, plus the note the
// customer typed, so the stored inquiry matches what the desk receives.
// Fires 'oncd-inquiry-sent' with {id, ref} once it's stored.
export function submitInquiry(items, channel) {
  if (!items || !items.length) return;
  const { ref, note } = pendingFor(items);
  try {
    fetch('/api/inquiries', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      keepalive: true,
      body: JSON.stringify({
        items: items.map((i) => ({ sku: i.sku, name: i.name, qty: i.qty, priceLabel: i.priceLabel })),
        channel, ref, note,
      }),
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((json) => {
        if (json && json.data) {
          try { window.dispatchEvent(new CustomEvent('oncd-inquiry-sent', { detail: json.data })); } catch {}
        }
      })
      .catch((err) => console.error('[cart] failed to record inquiry', err));
  } catch (err) {
    console.error('[cart] failed to record inquiry', err);
  }
}
