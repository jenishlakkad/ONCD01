// The Inquiry Cart drawer — ONE implementation shared by every storefront
// page (Home, catalogs, product pages, About, policies, Dashboard). Pages
// only call openCartDrawer() from utils/cart.js; this module renders the
// drawer straight into <body>, outside each page's own template, so every
// page gets the same layout, the same channel rules and the same sending
// flow. Cart data still lives in utils/cart.js (localStorage + the
// 'aurum-cart-change' event every page listens to for its badge).
//
// Sending: the customer picks a channel and presses one button. The
// inquiry is recorded for the sales desk (submitInquiry — same reference
// as in the message) and WhatsApp / Email / LINE / Skype opens with the
// message ready. WhatsApp, LINE and Skype are for approved trade accounts;
// Email is always open. Channels without a contact set in Admin > Settings
// are not offered.
import {
  getCart, removeFromCart, restoreItem, setQty, clearCart,
  buildMessage, channelLink, submitInquiry,
} from './cart.js';
import { inquiryTitle, inquirySpecRows, inquiryPriceLabel } from './inquiryItem.js';
import { pendingFor } from './inquiryRef.js';
import { hasSessionHint, fetchCustomerSession } from './customerAuth.js';
import { fetchPublicSettings } from './settings.js';
import { readCachedTypeVisibility } from './productTypes.js';

const NOTE_KEY = 'oncd_cart_note';
const CHANNEL_KEY = 'oncd_cart_channel';
// Last known account level for this visit ('approved' | 'pending' | 'guest'),
// so channel locks are right on the very first frame instead of flashing
// while /api/auth/me loads.
const STATUS_KEY = 'oncd_cart_status';
const PRODUCT_PAGE = { diamond: 'DiamondProduct.dc.html', jewelry: 'JewelryProduct.dc.html', gemstone: 'GemstoneProduct.dc.html' };
const TYPE_NAME = { diamond: 'Diamond', jewelry: 'Jewelry', gemstone: 'Gemstone' };
const CATALOGS = [
  { type: 'diamond', label: 'Diamonds', href: 'Diamonds.dc.html' },
  { type: 'jewelry', label: 'Jewelry', href: 'Jewelry.dc.html' },
  { type: 'gemstone', label: 'Gemstones', href: 'Gemstones.dc.html' },
];
const CHANNELS = [
  { key: 'whatsapp', label: 'WhatsApp', gated: true },
  { key: 'email', label: 'Email', gated: false },
  { key: 'line', label: 'LINE', gated: true },
  { key: 'skype', label: 'Skype', gated: true },
];

const ICON = {
  close: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  bag: '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4Z"/><path d="M3 6h18"/><path d="M16 10a4 4 0 0 1-8 0"/></svg>',
  trash: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6"/></svg>',
  gem: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M6 3h12l4 6-10 12L2 9Z"/><path d="M2 9h20"/></svg>',
  lock: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>',
  check: '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>',
  arrow: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
  whatsapp: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M3.5 20.5 5 16a8.5 8.5 0 1 1 3.2 3.1Z"/><path d="M9 9.5c0 3 2.5 5.5 5.5 5.5l1.2-1.4-2-1-1 .8a4 4 0 0 1-2.1-2.1l.8-1-1-2Z"/></svg>',
  email: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/></svg>',
  line: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M12 4C6.5 4 2.5 7.4 2.5 11.6c0 3.7 3.2 6.8 7.6 7.5l-.4 2.4 3.5-2.4c4.9-.4 8.3-3.6 8.3-7.5C21.5 7.4 17.5 4 12 4Z"/></svg>',
  skype: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><circle cx="12" cy="12" r="8"/><path d="M14.8 9.6c-.4-.9-1.5-1.4-2.8-1.4-1.6 0-2.7.8-2.7 1.9 0 2.6 5.6 1.4 5.6 4 0 1.2-1.2 2-2.9 2-1.4 0-2.6-.6-3-1.6"/></svg>',
  copy: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>',
};

const CSS = `
.icd-root{position:fixed;inset:0;z-index:100;display:flex;justify-content:flex-end;}
.icd-root [hidden]{display:none !important;}
.icd-dyn{display:contents;}
.icd-scrim{position:absolute;inset:0;background:rgba(32,30,28,.48);opacity:0;transition:opacity .25s ease;}
.icd-panel{position:relative;background:var(--color-bg);color:var(--color-text);width:min(440px,100%);height:100%;display:flex;flex-direction:column;box-shadow:var(--shadow-lg);transform:translateX(100%);transition:transform .3s cubic-bezier(.2,.8,.2,1);outline:none;}
.icd-root.is-open .icd-scrim{opacity:1;}
.icd-root.is-open .icd-panel{transform:none;}
@media (prefers-reduced-motion:reduce){.icd-scrim,.icd-panel{transition:none;}}
.icd-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:22px 24px 16px;border-bottom:1px solid var(--color-divider);}
.icd-title{font-family:var(--font-heading);font-size:22px;font-weight:400;margin:0;line-height:1.2;}
.icd-sub{font-size:12.5px;opacity:.65;margin:4px 0 0;}
.icd-x{flex:none;width:40px;height:40px;margin:-6px -8px 0 0;border-radius:50%;border:none;background:none;color:var(--color-text);cursor:pointer;display:flex;align-items:center;justify-content:center;transition:background .15s;}
.icd-x:hover{background:var(--color-surface);}
.icd-body{flex:1;min-height:0;overflow-y:auto;overscroll-behavior:contain;padding:6px 24px 12px;scrollbar-width:thin;scrollbar-color:var(--color-divider) transparent;}
.icd-body::-webkit-scrollbar{width:6px;}
.icd-body::-webkit-scrollbar-thumb{background:var(--color-divider);border-radius:3px;}
.icd-listhead{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:10px 0 4px;font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:var(--color-accent-700);font-weight:600;}
.icd-link{background:none;border:none;padding:4px 0;font:inherit;font-size:12.5px;letter-spacing:0;text-transform:none;color:var(--color-text);opacity:.7;cursor:pointer;text-decoration:underline;text-underline-offset:3px;}
.icd-link:hover{opacity:1;color:var(--color-accent-800);}
.icd-confirm{display:flex;align-items:center;gap:10px;font-size:12.5px;letter-spacing:0;text-transform:none;color:var(--color-text);font-weight:400;}
.icd-confirm .icd-danger{color:#a3302f;opacity:1;font-weight:600;}
.icd-list{list-style:none;margin:0;padding:0;}
.icd-item{display:grid;grid-template-columns:72px minmax(0,1fr) auto;gap:14px;align-items:start;padding:14px 0;border-bottom:1px solid var(--color-divider);}
.icd-item:last-child{border-bottom:none;}
.icd-thumb{width:72px;height:72px;border-radius:10px;overflow:hidden;background:var(--color-surface);display:flex;align-items:center;justify-content:center;color:var(--color-accent-700);}
.icd-thumb product-media{width:100%;height:100%;}
.icd-info{min-width:0;display:flex;flex-direction:column;gap:3px;}
.icd-meta{display:flex;align-items:center;gap:6px;font-size:10.5px;letter-spacing:.06em;color:var(--color-text);opacity:.7;}
.icd-type{font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:var(--color-accent-700);opacity:1;}
.icd-name{font-family:var(--font-heading);font-size:15px;font-weight:600;line-height:1.3;color:var(--color-text);text-decoration:none;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;}
a.icd-name:hover{color:var(--color-accent-800);}
.icd-specs{font-size:12px;opacity:.7;line-height:1.45;}
.icd-price{font-size:13px;font-weight:600;color:var(--color-accent-700);margin-top:2px;}
.icd-qty{display:inline-flex;align-items:center;border:1px solid var(--color-divider);border-radius:999px;margin-top:8px;width:fit-content;}
.icd-qty button{width:30px;height:30px;border:none;background:none;cursor:pointer;color:var(--color-text);font-size:16px;line-height:1;border-radius:50%;}
.icd-qty button:hover:not(:disabled){background:var(--color-surface);}
.icd-qty button:disabled{opacity:.3;cursor:default;}
.icd-qty span{min-width:26px;text-align:center;font-size:13px;font-weight:600;}
.icd-rm{width:34px;height:34px;border-radius:50%;border:none;background:none;color:var(--color-text);opacity:.55;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:opacity .15s,background .15s,color .15s;}
.icd-rm:hover{opacity:1;background:#fbecea;color:#a3302f;}
.icd-undo{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:0 24px;padding:10px 14px;border-radius:var(--radius-md);background:var(--color-neutral-900);color:#f3efe6;font-size:12.5px;}
.icd-undo button{background:none;border:none;color:var(--color-accent-300);font:inherit;font-weight:700;cursor:pointer;padding:2px 4px;}
.icd-undo span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.icd-foot{border-top:1px solid var(--color-divider);padding:14px 24px calc(18px + env(safe-area-inset-bottom,0px));display:flex;flex-direction:column;gap:12px;background:var(--color-bg);}
.icd-note-toggle{align-self:flex-start;background:none;border:none;padding:0;font:inherit;font-size:13px;color:var(--color-accent-800);font-weight:600;cursor:pointer;}
.icd-note label{display:flex;justify-content:space-between;font-size:12px;font-weight:600;margin-bottom:6px;}
.icd-note label span{font-weight:400;opacity:.6;}
.icd-note textarea{width:100%;box-sizing:border-box;min-height:72px;resize:vertical;font:inherit;font-size:13.5px;}
.icd-label{font-size:12px;font-weight:600;margin:0;}
.icd-channels{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;}
.icd-channels.n-3{grid-template-columns:repeat(3,minmax(0,1fr));}
.icd-channels.n-2{grid-template-columns:repeat(2,minmax(0,1fr));}
.icd-channels.n-1{grid-template-columns:1fr;}
@media (max-width:380px){.icd-channels.n-4{grid-template-columns:repeat(2,minmax(0,1fr));}}
.icd-ch{position:relative;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:5px;min-height:58px;padding:8px 4px;border:1px solid var(--color-divider);border-radius:var(--radius-md);background:#fff;color:var(--color-text);font:inherit;font-size:12px;font-weight:600;cursor:pointer;transition:border-color .15s,background .15s,box-shadow .15s;}
.icd-ch:hover{border-color:var(--color-accent);}
.icd-ch[aria-checked="true"]{border-color:var(--color-accent);background:var(--color-accent-100);color:var(--color-accent-900);box-shadow:inset 0 0 0 1px var(--color-accent);}
.icd-ch.is-locked{color:var(--color-text);opacity:.62;background:var(--color-surface);}
.icd-ch.is-locked[aria-checked="true"]{opacity:1;background:var(--color-surface);color:var(--color-text);box-shadow:inset 0 0 0 1px var(--color-divider);border-color:var(--color-neutral-400,#bdb5a6);}
.icd-ch-lock{position:absolute;top:6px;right:6px;opacity:.7;display:flex;}
.icd-gate{font-size:12px;line-height:1.5;margin:0;padding:10px 12px;border-radius:var(--radius-md);background:var(--color-accent-100);color:var(--color-accent-900);}
.icd-gate a{color:var(--color-accent-800);font-weight:700;text-decoration:underline;text-underline-offset:2px;}
.icd-send{width:100%;justify-content:center;gap:8px;min-height:48px;font-size:14px;}
.icd-send.is-disabled{opacity:.45;pointer-events:none;}
.icd-fine{font-size:11.5px;opacity:.6;text-align:center;margin:-2px 0 0;line-height:1.45;}
.icd-empty{display:flex;flex-direction:column;align-items:center;text-align:center;gap:10px;padding:56px 12px 24px;}
.icd-empty-icon{width:64px;height:64px;border-radius:50%;background:var(--color-accent-100);color:var(--color-accent-700);display:flex;align-items:center;justify-content:center;}
.icd-empty h3{font-family:var(--font-heading);font-weight:400;font-size:19px;margin:6px 0 0;}
.icd-empty p{font-size:13px;opacity:.7;margin:0;max-width:300px;line-height:1.55;}
.icd-chips{display:flex;flex-wrap:wrap;justify-content:center;gap:8px;margin-top:10px;}
.icd-chips a{padding:8px 16px;border:1px solid var(--color-divider);border-radius:999px;font-size:13px;color:var(--color-text);text-decoration:none;}
.icd-chips a:hover{border-color:var(--color-accent);background:var(--color-accent-100);}
.icd-sent{flex:1;overflow-y:auto;padding:36px 24px calc(24px + env(safe-area-inset-bottom,0px));display:flex;flex-direction:column;align-items:center;text-align:center;gap:12px;}
.icd-sent-icon{width:64px;height:64px;border-radius:50%;background:#e6f2e8;color:#2c6a3c;display:flex;align-items:center;justify-content:center;}
.icd-sent h3{font-family:var(--font-heading);font-weight:400;font-size:21px;margin:4px 0 0;}
.icd-sent p{font-size:13.5px;opacity:.75;margin:0;line-height:1.55;max-width:330px;}
.icd-ref{display:inline-flex;flex-direction:column;gap:2px;padding:10px 18px;border:1px dashed var(--color-accent);border-radius:var(--radius-md);background:#fff;}
.icd-ref small{font-size:10.5px;letter-spacing:.12em;text-transform:uppercase;opacity:.6;}
.icd-ref strong{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:16px;letter-spacing:.06em;color:var(--color-accent-800);}
.icd-sent-actions{display:flex;flex-direction:column;gap:10px;width:100%;max-width:330px;margin-top:10px;}
.icd-sent-actions .btn{width:100%;justify-content:center;}
.icd-inline{display:inline-flex;align-items:center;gap:6px;}
.icd-status{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0);}
`;

// ── state ────────────────────────────────────────────────────────────────
let root = null, panel = null, lastFocus = null, undoTimer = null;
let customer = null, customerLoadedAt = 0, settings = null;
let confirmClear = false, noteOpen = false, removed = null, sent = null;
let channel = null, ready = false, userPicked = false;

const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const readNote = () => { try { return sessionStorage.getItem(NOTE_KEY) || ''; } catch { return ''; } };
const writeNote = (v) => { try { sessionStorage.setItem(NOTE_KEY, v); } catch {} };
function cachedStatus() {
  if (!hasSessionHint()) return 'guest';
  try { return sessionStorage.getItem(STATUS_KEY) || ''; } catch { return ''; }
}
// Before the session check returns, the cached level decides the locks.
const approved = () => (customer ? customer.status === 'approved' : !ready && cachedStatus() === 'approved');

function contactOf(key) {
  const s = settings || {};
  if (key === 'whatsapp') return s.whatsapp;
  if (key === 'email') return s.inquiryEmail || s.supportEmail;
  if (key === 'line') return s.lineId;
  if (key === 'skype') return s.skypeId;
  return '';
}
// Until settings arrive every channel is shown; afterwards only the ones the
// admin has filled in (Email always — it falls back to the support address).
function availableChannels() {
  if (!settings) return CHANNELS;
  const list = CHANNELS.filter((c) => c.key === 'email' || String(contactOf(c.key) || '').trim());
  return list.length ? list : CHANNELS.filter((c) => c.key === 'email');
}
function pickDefaultChannel() {
  const avail = availableChannels();
  const usable = (k) => avail.some((c) => c.key === k && (!c.gated || approved()));
  let saved = '';
  try { saved = localStorage.getItem(CHANNEL_KEY) || ''; } catch {}
  if (saved && usable(saved)) return saved;
  if (usable('whatsapp')) return 'whatsapp';
  return 'email';
}

function ensureStyle() {
  if (document.getElementById('icd-style')) return;
  const st = document.createElement('style');
  st.id = 'icd-style';
  st.textContent = CSS;
  document.head.appendChild(st);
}
function ensureProductMedia() {
  if (window.customElements && customElements.get('product-media')) return;
  if (document.querySelector('script[data-icd-media]')) return;
  const s = document.createElement('script');
  s.src = './product-media.js';
  s.dataset.icdMedia = '1';
  document.head.appendChild(s);
}

async function loadContext() {
  const jobs = [];
  ready = !!settings && Date.now() - customerLoadedAt <= 60000;
  if (!settings) jobs.push(fetchPublicSettings().then((s) => { settings = s || {}; }));
  if (Date.now() - customerLoadedAt > 60000) {
    customerLoadedAt = Date.now();
    jobs.push((hasSessionHint() ? fetchCustomerSession() : Promise.resolve(null)).then((c) => {
      customer = c && c.id ? c : null;
      try { sessionStorage.setItem(STATUS_KEY, customer ? (customer.status || 'pending') : 'guest'); } catch {}
    }));
  }
  if (!jobs.length) { ready = true; return; }
  await Promise.all(jobs).catch(() => {});
  ready = true;
  if (!userPicked || !availableChannels().some((c) => c.key === channel)) channel = pickDefaultChannel();
  else if (CHANNELS.find((c) => c.key === channel).gated && !approved()) channel = pickDefaultChannel();
  if (root) render();
}

// ── item presentation ────────────────────────────────────────────────────
function specLine(p) {
  if (!p) return '';
  const rows = inquirySpecRows(p).filter((r) => r.label !== 'Measurements');
  return rows.slice(0, 4).map((r) => r.value).join(' · ');
}
function itemView(it) {
  const p = it.product || null;
  const type = p && p.type;
  const title = p ? (it.name || inquiryTitle(p)) : it.name;
  const price = it.priceLabel || (p ? inquiryPriceLabel(p) : '') || 'Price on request';
  const href = type && PRODUCT_PAGE[type] ? `${PRODUCT_PAGE[type]}?sku=${encodeURIComponent(it.sku)}` : '';
  const media = p && Array.isArray(p.media) && p.media.length ? p.media : null;
  const qtyEditable = type === 'jewelry' || (Number(it.qty) || 1) > 1;
  return { sku: it.sku, title: title || it.sku, typeName: TYPE_NAME[type] || '', specs: specLine(p), price, href, media, qty: Number(it.qty) || 1, qtyEditable };
}

// ── rendering ────────────────────────────────────────────────────────────
function countLabel(items) {
  const n = items.reduce((s, i) => s + (Number(i.qty) || 1), 0);
  return n === 1 ? '1 piece' : `${n} pieces`;
}

function render() {
  if (!root) return;
  const items = getCart();
  panel.querySelector('.icd-sub').textContent = sent ? 'Inquiry sent' : items.length ? `${countLabel(items)} · our desk replies within one business day` : 'Nothing added yet';
  const body = panel.querySelector('.icd-body');
  const foot = panel.querySelector('.icd-foot');
  const sentBox = panel.querySelector('.icd-sent');
  if (sent) {
    body.hidden = true; foot.hidden = true; sentBox.hidden = false;
    renderSent();
    return;
  }
  sentBox.hidden = true; body.hidden = false;
  if (!items.length) {
    foot.hidden = true;
    renderEmpty(body);
    renderUndo();
    return;
  }
  foot.hidden = false;
  renderList(body, items);
  renderUndo();
  renderFoot();
}

function renderEmpty(body) {
  const vis = readCachedTypeVisibility();
  const chips = CATALOGS.filter((c) => vis[c.type] !== false).map((c) => `<a href="${c.href}">${esc(c.label)}</a>`).join('');
  body.innerHTML = `
    <div class="icd-empty">
      <div class="icd-empty-icon">${ICON.bag}</div>
      <h3>Your inquiry cart is empty</h3>
      <p>Add pieces with <strong>+ Cart</strong> and ask our sales desk about all of them in one message.</p>
      ${chips ? `<div class="icd-chips">${chips}</div>` : ''}
      ${customer ? '<a class="icd-link" href="Dashboard.dc.html?tab=saved" style="margin-top:6px;">View your saved items</a>' : ''}
    </div>`;
}

function renderList(body, items) {
  const views = items.map(itemView);
  const head = confirmClear
    ? `<span class="icd-confirm">Remove all ${views.length}?<button type="button" class="icd-link icd-danger" data-act="clear-yes">Yes, clear</button><button type="button" class="icd-link" data-act="clear-no">Cancel</button></span>`
    : `<button type="button" class="icd-link" data-act="clear">Clear all</button>`;
  body.innerHTML = `
    <div class="icd-listhead"><span>Pieces to inquire about</span>${head}</div>
    <ul class="icd-list">
      ${views.map((v) => `
        <li class="icd-item">
          <div class="icd-thumb">${v.media ? `<product-media media="${esc(JSON.stringify(v.media))}" shape="rect" fit="cover" placeholder="${esc(v.title)}"></product-media>` : ICON.gem}</div>
          <div class="icd-info">
            <div class="icd-meta">${v.typeName ? `<span class="icd-type">${esc(v.typeName)}</span><span aria-hidden="true">·</span>` : ''}<span>${esc(v.sku)}</span></div>
            ${v.href ? `<a class="icd-name" href="${esc(v.href)}">${esc(v.title)}</a>` : `<span class="icd-name">${esc(v.title)}</span>`}
            ${v.specs ? `<div class="icd-specs">${esc(v.specs)}</div>` : ''}
            <div class="icd-price">${esc(v.price)}</div>
            ${v.qtyEditable ? `
              <div class="icd-qty" role="group" aria-label="Quantity for ${esc(v.title)}">
                <button type="button" data-act="dec" data-sku="${esc(v.sku)}" aria-label="Decrease quantity" ${v.qty <= 1 ? 'disabled' : ''}>−</button>
                <span aria-live="polite">${v.qty}</span>
                <button type="button" data-act="inc" data-sku="${esc(v.sku)}" aria-label="Increase quantity" ${v.qty >= 99 ? 'disabled' : ''}>+</button>
              </div>` : ''}
          </div>
          <button type="button" class="icd-rm" data-act="remove" data-sku="${esc(v.sku)}" aria-label="Remove ${esc(v.title)}" title="Remove">${ICON.trash}</button>
        </li>`).join('')}
    </ul>`;
}

function renderUndo() {
  const slot = panel.querySelector('.icd-undo-slot');
  if (!removed) { slot.innerHTML = ''; return; }
  slot.innerHTML = `<div class="icd-undo" role="status"><span>Removed ${esc(removed.title)}</span><button type="button" data-act="undo">Undo</button></div>`;
}

function renderFoot() {
  const foot = panel.querySelector('.icd-foot');
  if (foot.hidden) return;
  const avail = availableChannels();
  if (!channel || !avail.some((c) => c.key === channel)) channel = pickDefaultChannel();
  const ch = CHANNELS.find((c) => c.key === channel);
  const locked = ch.gated && !approved();
  const note = readNote();
  const showNote = noteOpen || !!note;

  // The note box is built once and never re-rendered, so typing is never
  // interrupted by a cart/settings update redrawing the rest of the footer.
  const slot = foot.querySelector('.icd-note-slot');
  if (showNote && !slot.querySelector('.icd-note')) {
    slot.innerHTML = '<div class="icd-note"><label for="icd-note-input">Message for our sales desk <span>optional</span></label><textarea id="icd-note-input" class="input" rows="3" maxlength="1000" placeholder="E.g. certificates needed, delivery city, budget, setting ideas…"></textarea></div>';
    const ta = slot.querySelector('textarea');
    ta.value = note;
    ta.addEventListener('input', (e) => writeNote(e.target.value));
  } else if (!showNote) {
    slot.innerHTML = '<button type="button" class="icd-note-toggle" data-act="note">+ Add a message for our sales desk</button>';
  }

  let gate = '';
  if (locked) {
    gate = customer
      ? `<p class="icd-gate">${esc(ch.label)} opens once your trade account is approved — you’ll get an email. <strong>Email</strong> works right now.</p>`
      : `<p class="icd-gate">WhatsApp, LINE and Skype are for approved trade accounts. <a href="Login.dc.html">Sign in</a> or <a href="Register.dc.html">register</a> — or send by <strong>Email</strong>, open to everyone.</p>`;
  }
  const waiting = !locked && !ready;
  const sendLabel = locked ? `${ch.label} needs an approved account` : waiting ? 'Preparing…' : `Send inquiry via ${ch.label}`;
  const fine = channel === 'line'
    ? 'LINE can’t pre-fill text: we copy your message so you can paste it into the chat.'
    : channel === 'email' ? 'Opens your email app with the message ready to send.' : `Opens ${ch.label} with your message ready to send.`;

  foot.querySelector('.icd-dyn').innerHTML = `
    <p class="icd-label" id="icd-ch-label">Send to our sales desk via</p>
    <div class="icd-channels n-${avail.length}" role="radiogroup" aria-labelledby="icd-ch-label">
      ${avail.map((c) => {
        const lk = c.gated && !approved();
        return `<button type="button" role="radio" aria-checked="${c.key === channel}" tabindex="${c.key === channel ? 0 : -1}" class="icd-ch ${lk ? 'is-locked' : ''}" data-act="channel" data-ch="${c.key}" ${lk ? `title="${esc(c.label)} needs an approved trade account"` : ''}>
          ${lk ? `<span class="icd-ch-lock">${ICON.lock}</span>` : ''}${ICON[c.key]}<span>${esc(c.label)}</span></button>`;
      }).join('')}
    </div>
    ${gate}
    <button type="button" class="btn btn-primary icd-send ${locked || waiting ? 'is-disabled' : ''}" data-act="send" ${locked || waiting ? 'aria-disabled="true"' : ''}><span>${esc(sendLabel)}</span>${locked || waiting ? '' : ICON.arrow}</button>
    <p class="icd-fine">${esc(fine)}</p>`;
}

function renderSent() {
  const box = panel.querySelector('.icd-sent');
  const ch = CHANNELS.find((c) => c.key === sent.channel);
  const lead = sent.channel === 'line'
    ? 'Your message is copied — paste it into the LINE chat that just opened and press send.'
    : sent.channel === 'email'
      ? 'Your email app opened with the message ready — press send there to reach our desk.'
      : `${ch.label} opened with your message ready — press send there to reach our desk.`;
  const track = customer
    ? `<a class="btn btn-secondary" href="Dashboard.dc.html?tab=inquiries${sent.id ? `&inquiry=${encodeURIComponent(sent.id)}` : ''}">Track it in Inquiry History</a>`
    : '';
  box.innerHTML = `
    <div class="icd-sent-icon">${ICON.check}</div>
    <h3>Inquiry ready to send</h3>
    <p>${esc(lead)}</p>
    ${sent.ref ? `<div class="icd-ref"><small>Your reference</small><strong>${esc(sent.ref)}</strong></div>` : ''}
    <p style="font-size:12.5px;">Our sales desk replies within one business day${customer ? ', and the reply also appears in your account.' : '.'}</p>
    <div class="icd-sent-actions">
      ${track}
      <button type="button" class="btn btn-primary" data-act="done-clear">Done — empty the cart</button>
      <button type="button" class="btn btn-ghost" data-act="done-keep">Keep these pieces in the cart</button>
      <div style="display:flex;justify-content:center;gap:18px;flex-wrap:wrap;">
        <button type="button" class="icd-link icd-inline" data-act="resend">Didn’t open? Try again</button>
        <button type="button" class="icd-link icd-inline" data-act="copy">${ICON.copy}<span>Copy message</span></button>
      </div>
    </div>`;
}

function announce(text) {
  const s = panel && panel.querySelector('.icd-status');
  if (s) { s.textContent = ''; setTimeout(() => { s.textContent = text; }, 30); }
}

// ── actions ──────────────────────────────────────────────────────────────
function currentMessage(items) {
  return buildMessage(items, { customer, note: readNote() });
}
function linkFor(key, message) {
  return channelLink(key, message, { ...(settings || {}), inquiryEmail: contactOf('email') || undefined });
}
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch {}
  try {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    const ok = document.execCommand('copy'); ta.remove(); return ok;
  } catch { return false; }
}
function openChannel(key, message) {
  const url = linkFor(key, message);
  if (key === 'line') copyText(message);
  if (key === 'whatsapp' || key === 'line') {
    // Not window.open(..., 'noopener'): that always returns null, which would
    // look like a blocked pop-up and send this page away to WhatsApp.
    const w = window.open(url, '_blank');
    if (w) { try { w.opener = null; } catch {} } else window.location.href = url;
  } else {
    window.location.href = url;
  }
}
function send() {
  const items = getCart();
  if (!items.length) return;
  const ch = CHANNELS.find((c) => c.key === channel);
  if (!ready || !ch || (ch.gated && !approved())) return;
  const message = currentMessage(items);
  const { ref } = pendingFor(items);
  submitInquiry(items, channel);
  try { localStorage.setItem(CHANNEL_KEY, channel); } catch {}
  sent = { channel, ref, message, id: null, items };
  openChannel(channel, message);
  render();
  announce('Inquiry ready. Reference ' + ref);
}

function onClick(e) {
  if (e.target.classList && e.target.classList.contains('icd-scrim')) { close(); return; }
  const btn = e.target.closest('[data-act]');
  if (!btn || !panel.contains(btn)) return;
  const act = btn.dataset.act, sku = btn.dataset.sku;
  if (act === 'close') close();
  else if (act === 'remove') {
    const items = getCart();
    const index = items.findIndex((i) => i.sku === sku);
    if (index < 0) return;
    const item = items[index];
    removed = { item, index, title: itemView(item).title };
    removeFromCart(sku);
    clearTimeout(undoTimer);
    undoTimer = setTimeout(() => { removed = null; renderUndo(); }, 6000);
    announce(`Removed ${removed.title}`);
  } else if (act === 'undo') {
    if (removed) restoreItem(removed.item, removed.index);
    removed = null; clearTimeout(undoTimer);
  } else if (act === 'inc' || act === 'dec') {
    const it = getCart().find((i) => i.sku === sku);
    if (it) setQty(sku, (Number(it.qty) || 1) + (act === 'inc' ? 1 : -1));
  } else if (act === 'clear') { confirmClear = true; render(); }
  else if (act === 'clear-no') { confirmClear = false; render(); }
  else if (act === 'clear-yes') { confirmClear = false; removed = null; clearCart(); writeNote(''); }
  else if (act === 'note') { noteOpen = true; renderFoot(); const t = panel.querySelector('#icd-note-input'); if (t) t.focus(); }
  else if (act === 'channel') { channel = btn.dataset.ch; userPicked = true; renderFoot(); const b = panel.querySelector(`[data-ch="${channel}"]`); if (b) b.focus(); }
  else if (act === 'send') send();
  else if (act === 'resend' && sent) openChannel(sent.channel, sent.message);
  else if (act === 'copy' && sent) {
    copyText(sent.message).then((ok) => { const s = btn.querySelector('span'); if (s) s.textContent = ok ? 'Copied' : 'Copy failed'; });
  } else if (act === 'done-clear') { sent = null; clearCart(); writeNote(''); noteOpen = false; render(); }
  else if (act === 'done-keep') { sent = null; render(); }
}

// Arrow keys move between channels (radiogroup); Tab stays inside the drawer.
function onKey(e) {
  if (!root) return;
  if (e.key === 'Escape') { e.preventDefault(); close(); return; }
  if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft' || e.key === 'ArrowDown' || e.key === 'ArrowUp') && e.target.dataset && e.target.dataset.act === 'channel') {
    const avail = availableChannels();
    const i = avail.findIndex((c) => c.key === channel);
    const d = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1;
    channel = avail[(i + d + avail.length) % avail.length].key;
    userPicked = true;
    renderFoot();
    const b = panel.querySelector(`[data-ch="${channel}"]`); if (b) b.focus();
    e.preventDefault();
    return;
  }
  if (e.key === 'Tab') {
    const f = [...panel.querySelectorAll('a[href],button:not([disabled]),textarea,[tabindex]:not([tabindex="-1"])')].filter((el) => el.offsetParent !== null);
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
}

function onCartChange() { if (root) render(); }
function onInquirySent(e) {
  const d = e.detail || {};
  if (sent && d.ref && d.ref === sent.ref) { sent.id = d.id; if (root) renderSent(); }
}

// ── open / close ─────────────────────────────────────────────────────────
let savedOverflow = null;
export function openCart() {
  if (root) { panel.focus(); return; }
  ensureStyle();
  ensureProductMedia();
  lastFocus = document.activeElement;
  confirmClear = false; sent = null; userPicked = false;
  root = document.createElement('div');
  root.className = 'icd-root';
  root.innerHTML = `
    <div class="icd-scrim"></div>
    <aside class="icd-panel" role="dialog" aria-modal="true" aria-labelledby="icd-title" tabindex="-1">
      <header class="icd-head">
        <div><h2 class="icd-title" id="icd-title">Inquiry Cart</h2><p class="icd-sub"></p></div>
        <button type="button" class="icd-x" data-act="close" aria-label="Close inquiry cart">${ICON.close}</button>
      </header>
      <div class="icd-body"></div>
      <div class="icd-undo-slot"></div>
      <div class="icd-foot"><div class="icd-note-slot" style="display:contents"></div><div class="icd-dyn"></div></div>
      <div class="icd-sent" hidden></div>
      <div class="icd-status" aria-live="polite"></div>
    </aside>`;
  panel = root.querySelector('.icd-panel');
  document.body.appendChild(root);
  root.addEventListener('click', onClick);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('aurum-cart-change', onCartChange);
  window.addEventListener('storage', onCartChange);
  window.addEventListener('oncd-inquiry-sent', onInquirySent);
  // <body> is this site's scroll container — lock it behind the drawer.
  savedOverflow = document.body.style.overflow;
  document.body.style.overflow = 'hidden';
  channel = pickDefaultChannel();
  render();
  requestAnimationFrame(() => requestAnimationFrame(() => { if (root) root.classList.add('is-open'); }));
  panel.querySelector('.icd-x').focus({ preventScroll: true });
  loadContext();
}

export function closeCart() { close(); }
export function isCartOpen() { return !!root; }

function close() {
  if (!root) return;
  const el = root;
  root = null;
  document.removeEventListener('keydown', onKey, true);
  window.removeEventListener('aurum-cart-change', onCartChange);
  window.removeEventListener('storage', onCartChange);
  window.removeEventListener('oncd-inquiry-sent', onInquirySent);
  document.body.style.overflow = savedOverflow || '';
  el.classList.remove('is-open');
  const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  setTimeout(() => el.remove(), reduce ? 0 : 300);
  removed = null; clearTimeout(undoTimer);
  if (lastFocus && lastFocus.focus) { try { lastFocus.focus({ preventScroll: true }); } catch {} }
  try { window.dispatchEvent(new CustomEvent('oncd-cart-closed')); } catch {}
}
