// Maps a DB products row (snake_case) to the camelCase shape the frontend/API consumes.
// Price masking (if any) must already have been applied to `row` before calling this
// (see lib/priceVisibility.js) — this function only reshapes keys, it never decides visibility.
//
// `offer` is the already-resolved public offer (lib/offers.js
// buildPublicOffer) or null. `admin: true` adds the product's own discount
// settings, which only the admin screens need (a scheduled discount must
// not leak to the storefront before it starts).
function serializeProduct(row, { category, subcategory, media, variants, offer, admin } = {}) {
  const out = {
    id: row.id,
    sku: row.sku,
    type: row.type,
    status: row.status,
    visibility: row.visibility,
    featured: !!row.featured,
    category: category ? { id: category.id, name: category.name } : null,
    subcategory: subcategory ? { id: subcategory.id, name: subcategory.name } : null,
    // Metal variations of THIS product (Etsy-style: one listing, several
    // price+photo options) — empty unless the admin has configured any.
    // Each entry's price has already been through the same price-visibility
    // masking as the product's own totalPrice by the time it gets here.
    variants: variants || [],
    weightCarat: row.weight_carat,
    shape: row.shape,
    color: row.color,
    clarity: row.clarity,
    measurements: row.measurements,
    certificateAuthority: row.certificate_authority,
    certificateNumber: row.certificate_number,
    certificateWebsite: row.certificate_website,
    metal: row.metal,
    goldPurity: row.gold_purity,
    goldColor: row.gold_color,
    goldWeightGrams: row.gold_weight_grams,
    stoneName: row.stone_name,
    origin: row.origin,
    pricePerCarat: row.price_per_carat === undefined ? null : row.price_per_carat,
    totalPrice: row.total_price === undefined ? null : row.total_price,
    priceVisible: row.priceVisible === undefined ? true : row.priceVisible,
    priceLabel: row.priceLabel === undefined ? null : row.priceLabel,
    priceCta: row.priceCta === undefined ? null : row.priceCta,
    priceVisibilityOverride: row.price_visibility || '',
    media: media || [],
    offer: offer || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (admin) {
    out.discountType = row.discount_type || '';
    out.discountValue = row.discount_value === null || row.discount_value === undefined ? null : Number(row.discount_value);
    out.discountLabel = row.discount_label || '';
    out.discountStartsAt = row.discount_starts_at ? new Date(row.discount_starts_at).toISOString() : null;
    out.discountEndsAt = row.discount_ends_at ? new Date(row.discount_ends_at).toISOString() : null;
  }
  return out;
}

module.exports = { serializeProduct };
