const db = require('../db/postgres');

// The fixed set of metal options a jewelry product's variations can offer.
// Hardcoded (not an admin-managed table) — keeps this feature to exactly one
// new table, nothing else. A 5th metal later is a one-line change here, not
// a migration.
const METAL_OPTIONS = ['Yellow Gold', 'Rose Gold', 'White Gold', 'Silver'];

// Every variation row for one product, in a FIXED canonical order (not
// creation order) — so the swatch row on the storefront never visually
// reshuffles depending on which metal the admin added first.
async function getVariants(productId) {
  let rows;
  try {
    rows = await db.all('SELECT * FROM product_variants WHERE product_id = $1', [productId]);
  } catch (err) {
    // 42P01 = undefined_table (Postgres SQLSTATE). This function is called
    // from fullProduct() for EVERY product of every type on every
    // create/update/fetch — not gating it on the table's existence would
    // mean a migration that hasn't run yet breaks saving anything at all,
    // not just jewelry variants. Degrade to "no variants exist anywhere"
    // instead, so the rest of the product system is never dependent on
    // this one table being present.
    if (err && err.code === '42P01') return [];
    throw err;
  }
  return rows.slice().sort((a, b) => METAL_OPTIONS.indexOf(a.metal) - METAL_OPTIONS.indexOf(b.metal));
}

module.exports = { METAL_OPTIONS, getVariants };
