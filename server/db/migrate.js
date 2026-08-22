const fs = require('fs');
const path = require('path');
const db = require('./connection');

const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
db.exec(schema);

// `CREATE TABLE IF NOT EXISTS` (above) only helps brand-new databases — an
// already-existing `products` table needs its new column added explicitly.
const productsCols = db.prepare('PRAGMA table_info(products)').all().map((c) => c.name);
if (!productsCols.includes('price_visibility')) {
  db.exec("ALTER TABLE products ADD COLUMN price_visibility TEXT CHECK(price_visibility IS NULL OR price_visibility IN ('show','hide','contact','approved'))");
  console.log('Migration: added products.price_visibility column.');
}

console.log('Migration complete: schema applied to', require('../config/env').dbFile);
