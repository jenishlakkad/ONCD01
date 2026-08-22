// Maps a DB products row (snake_case) to the camelCase shape the frontend/API consumes.
// Price masking (if any) must already have been applied to `row` before calling this
// (see lib/priceVisibility.js) — this function only reshapes keys, it never decides visibility.
function serializeProduct(row, { category, subcategory, media } = {}) {
  return {
    id: row.id,
    sku: row.sku,
    type: row.type,
    status: row.status,
    visibility: row.visibility,
    featured: !!row.featured,
    category: category ? { id: category.id, name: category.name } : null,
    subcategory: subcategory ? { id: subcategory.id, name: subcategory.name } : null,
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
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

module.exports = { serializeProduct };
