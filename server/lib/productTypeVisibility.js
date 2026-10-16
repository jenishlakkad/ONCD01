const db = require('../db/postgres');

// Admin > Product Types switches a whole catalog (diamond / jewelry /
// gemstone) on or off for the storefront. Product queries already enforce it
// (PUBLIC_WHERE in lib/publicProducts.js); this covers everything else that
// can point INTO a catalog — admin-written links on hero slides, content
// blocks, collection cards and section buttons — so a disabled catalog
// leaves no way in from the storefront.

const TYPE_PAGES = {
  diamond: ['diamonds', 'diamondproduct'],
  jewelry: ['jewelry', 'jewelryproduct'],
  gemstone: ['gemstones', 'gemstoneproduct'],
};

// "Gemstones.dc.html", "./GemstoneProduct.dc.html?sku=X",
// "/Diamonds.dc.html?shape=Round", "https://site/Jewelry.dc.html" -> type.
function typeOfHref(href) {
  const m = /^(?:[a-z]+:\/\/[^/]+)?\/?(?:\.\/)?([a-z]+)\.dc\.html(?:[?#]|$)/i.exec(String(href || '').trim());
  if (!m) return null;
  const page = m[1].toLowerCase();
  for (const [type, pages] of Object.entries(TYPE_PAGES)) if (pages.includes(page)) return type;
  return null;
}

// { diamond: true, jewelry: true, gemstone: false } — a type missing from
// the table counts as enabled, matching utils/productTypes.js.
async function loadTypeVisibility() {
  const rows = await db.all('SELECT key, enabled FROM product_types');
  const vis = { diamond: true, jewelry: true, gemstone: true };
  for (const r of rows) vis[r.key] = !!r.enabled;
  return vis;
}

function hrefAllowed(href, vis) {
  const type = typeOfHref(href);
  return !type || vis[type] !== false;
}

module.exports = { TYPE_PAGES, typeOfHref, loadTypeVisibility, hrefAllowed };
