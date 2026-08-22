// Single source of truth for what pricing data a public-facing (non-admin) API
// response is allowed to include. Admin CRUD routes never call this — admins
// always see/edit raw numeric prices when managing the catalog.

const PRICE_FIELDS = ['price_per_carat', 'total_price'];

function maskedLabel(mode) {
  switch (mode) {
    case 'hide': return null;
    case 'contact': return 'Contact for Price';
    case 'request': return 'Price on Request';
    case 'approved': return 'Login to view price';
    default: return null;
  }
}

// viewer: null (guest), or { type: 'customer', status }
function canSeeRealPrice(mode, viewer) {
  if (mode === 'show') return true;
  if (mode === 'approved' && viewer && viewer.type === 'customer' && viewer.status === 'approved') return true;
  return false;
}

// What (if anything) the client should prompt the viewer to do about the
// masked price. Distinct from maskedLabel: a logged-in-but-not-yet-approved
// customer and a guest both get mode 'approved', but need different copy
// ("log in" makes no sense once already logged in) — so this needs `viewer`,
// which maskedLabel(mode) alone doesn't have.
function priceCtaFor(mode, viewer) {
  if (mode === 'approved') {
    if (!viewer || viewer.type !== 'customer') return 'login';
    if (viewer.status !== 'approved') return 'pending';
    return null;
  }
  if (mode === 'contact' || mode === 'request') return 'contact';
  return null;
}

// Precedence: the `prices` feature flag is a master kill-switch (overrides
// everything when off) > each product's own `price_visibility` override (if
// set) > the site-wide `mode` from Settings.
function applyPriceVisibility(product, mode, viewer, pricesEnabled = true) {
  if (!pricesEnabled) {
    const masked = { ...product };
    for (const f of PRICE_FIELDS) delete masked[f];
    return { ...masked, priceVisible: false, priceLabel: null, priceCta: null };
  }
  const effectiveMode = product.price_visibility || mode;
  if (canSeeRealPrice(effectiveMode, viewer)) {
    return { ...product, priceVisible: true, priceLabel: null, priceCta: null };
  }
  const masked = { ...product };
  for (const f of PRICE_FIELDS) delete masked[f];
  return { ...masked, priceVisible: false, priceLabel: maskedLabel(effectiveMode), priceCta: priceCtaFor(effectiveMode, viewer) };
}

module.exports = { applyPriceVisibility, canSeeRealPrice, maskedLabel };
