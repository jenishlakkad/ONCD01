// Excel (.xlsx) bulk-import support for the admin Products screen: builds a
// downloadable per-type template and validates/maps uploaded rows onto the
// exact same `products` columns the manual Add/Edit form writes.
const XLSX = require('xlsx');
const db = require('../db/connection');

const STATUS_VALUES = ['active', 'hidden'];
const VISIBILITY_VALUES = ['visible', 'draft'];
const ORIGIN_VALUES = ['Natural', 'Lab Created'];

const COLUMN_DEFS = {
  diamond: [
    { key: 'sku', header: 'SKU', kind: 'sku' },
    { key: 'category_id', header: 'Category', kind: 'category' },
    { key: 'weight_carat', header: 'Weight (Carat)', kind: 'text' },
    { key: 'shape', header: 'Shape', kind: 'text' },
    { key: 'color', header: 'Color', kind: 'text' },
    { key: 'clarity', header: 'Clarity', kind: 'text' },
    { key: 'measurements', header: 'Measurements', kind: 'text' },
    { key: 'certificate_authority', header: 'Certificate Authority', kind: 'text' },
    { key: 'certificate_number', header: 'Certificate Number', kind: 'text' },
    { key: 'certificate_website', header: 'Certificate Website', kind: 'text' },
    { key: 'price_per_carat', header: 'Price Per Carat', kind: 'number' },
    { key: 'total_price', header: 'Total Price', kind: 'number' },
    { key: 'status', header: 'Status', kind: 'enum', values: STATUS_VALUES, default: 'active' },
    { key: 'visibility', header: 'Visibility', kind: 'enum', values: VISIBILITY_VALUES, default: 'visible' },
  ],
  jewelry: [
    { key: 'sku', header: 'SKU', kind: 'sku' },
    { key: 'category_id', header: 'Category', kind: 'category' },
    { key: 'subcategory_id', header: 'Subcategory', kind: 'subcategory' },
    { key: 'metal', header: 'Metal', kind: 'text' },
    { key: 'gold_purity', header: 'Gold Purity', kind: 'text' },
    { key: 'gold_color', header: 'Gold Color', kind: 'text' },
    { key: 'gold_weight_grams', header: 'Gold Weight (g)', kind: 'text' },
    { key: 'certificate_authority', header: 'Certificate Authority', kind: 'text' },
    { key: 'certificate_number', header: 'Certificate Number', kind: 'text' },
    { key: 'weight_carat', header: 'Stone Weight (ct)', kind: 'text' },
    { key: 'color', header: 'Stone Color', kind: 'text' },
    { key: 'shape', header: 'Stone Shape', kind: 'text' },
    { key: 'clarity', header: 'Stone Clarity', kind: 'text' },
    { key: 'measurements', header: 'Stone Measurements', kind: 'text' },
    { key: 'certificate_website', header: 'Stone Certificate Website', kind: 'text' },
    { key: 'total_price', header: 'Total Price', kind: 'number' },
    { key: 'status', header: 'Status', kind: 'enum', values: STATUS_VALUES, default: 'active' },
    { key: 'visibility', header: 'Visibility', kind: 'enum', values: VISIBILITY_VALUES, default: 'visible' },
  ],
  gemstone: [
    { key: 'sku', header: 'SKU', kind: 'sku' },
    { key: 'category_id', header: 'Category', kind: 'category' },
    { key: 'stone_name', header: 'Stone Name', kind: 'text' },
    { key: 'origin', header: 'Origin', kind: 'enum', values: ORIGIN_VALUES, default: 'Natural' },
    { key: 'weight_carat', header: 'Weight (ct)', kind: 'text' },
    { key: 'color', header: 'Color', kind: 'text' },
    { key: 'shape', header: 'Shape / Cut', kind: 'text' },
    { key: 'clarity', header: 'Clarity', kind: 'text' },
    { key: 'measurements', header: 'Measurements', kind: 'text' },
    { key: 'certificate_authority', header: 'Certificate Authority', kind: 'text' },
    { key: 'certificate_number', header: 'Certificate Number', kind: 'text' },
    { key: 'certificate_website', header: 'Certificate Website', kind: 'text' },
    { key: 'price_per_carat', header: 'Price Per Carat', kind: 'number' },
    { key: 'total_price', header: 'Total Price', kind: 'number' },
    { key: 'status', header: 'Status', kind: 'enum', values: STATUS_VALUES, default: 'active' },
    { key: 'visibility', header: 'Visibility', kind: 'enum', values: VISIBILITY_VALUES, default: 'visible' },
  ],
};

const EXAMPLE_ROWS = {
  diamond: {
    SKU: 'EXAMPLE-DELETE-ME', Category: 'Certified Diamonds', 'Weight (Carat)': '1.20', Shape: 'Round', Color: 'F', Clarity: 'VS1',
    Measurements: '6.80 x 6.85 x 4.20 mm', 'Certificate Authority': 'GIA', 'Certificate Number': '2201456789',
    'Certificate Website': 'https://www.gia.edu/report-check', 'Price Per Carat': '4800', 'Total Price': '5760',
    Status: 'active', Visibility: 'visible',
  },
  jewelry: {
    SKU: 'EXAMPLE-DELETE-ME', Category: 'Gold Jewelry', Subcategory: 'Rings', Metal: '18K Gold', 'Gold Purity': '18K',
    'Gold Color': 'Yellow', 'Gold Weight (g)': '4.2', 'Certificate Authority': 'GIA', 'Certificate Number': '2201456789',
    'Stone Weight (ct)': '0.50', 'Stone Color': 'F', 'Stone Shape': 'Round', 'Stone Clarity': 'VS1',
    'Stone Measurements': '5.10 x 5.12 x 3.10 mm', 'Stone Certificate Website': 'https://www.gia.edu/report-check',
    'Total Price': '3200', Status: 'active', Visibility: 'visible',
  },
  gemstone: {
    SKU: 'EXAMPLE-DELETE-ME', Category: 'Ruby', 'Stone Name': 'Ruby', Origin: 'Natural', 'Weight (ct)': '2.10',
    Color: 'Pigeon Blood Red', 'Shape / Cut': 'Oval', Clarity: 'Eye Clean', Measurements: '8.10 x 6.20 x 4.10 mm',
    'Certificate Authority': 'GRS', 'Certificate Number': 'GRS2024-1234', 'Certificate Website': 'https://www.grs-gemresearch.ch',
    'Price Per Carat': '900', 'Total Price': '1890', Status: 'active', Visibility: 'visible',
  },
};

function normalizeHeader(h) {
  return String(h == null ? '' : h).trim().toLowerCase().replace(/\s+/g, ' ');
}

function typeCategories(type) {
  return db.prepare(
    `SELECT c.id, c.name FROM categories c JOIN product_types pt ON pt.id = c.product_type_id
     WHERE pt.key = ? AND c.enabled = 1 ORDER BY c.sort_order, c.name`
  ).all(type);
}

function allSubcategories() {
  return db.prepare('SELECT id, name FROM subcategories WHERE enabled = 1 ORDER BY sort_order, name').all();
}

// Fixed, deterministic column list for INSERTs — same shape validateRow() always produces for `type`.
function productColumns(type) {
  const cols = ['type', 'sku', 'category_id'];
  if (type === 'jewelry') cols.push('subcategory_id');
  for (const c of COLUMN_DEFS[type]) {
    if (['sku', 'category_id', 'subcategory_id'].includes(c.key)) continue;
    cols.push(c.key);
  }
  return cols;
}

function buildTemplate(type) {
  const cols = COLUMN_DEFS[type];
  const headers = cols.map((c) => c.header);
  const example = EXAMPLE_ROWS[type];
  const exampleRow = headers.map((h) => (example[h] !== undefined ? example[h] : ''));

  const ws = XLSX.utils.aoa_to_sheet([headers, exampleRow]);
  ws['!cols'] = headers.map((h) => ({ wch: Math.max(16, h.length + 2) }));

  const cats = typeCategories(type);
  const label = type.charAt(0).toUpperCase() + type.slice(1);
  const info = [
    [`Aurum & Co. — ${label} Stock Import`],
    [''],
    ['Row 2 on the "Stock Data" sheet is an EXAMPLE — delete it before importing your real data.'],
    ['Do not rename, remove, or reorder the header row (row 1) on the "Stock Data" sheet.'],
    ['Only "SKU" is required; every other column may be left blank.'],
    [''],
    ['Column', 'Notes'],
    ['SKU', 'Required. Must be unique — rows that reuse an existing SKU are rejected.'],
    ['Category', 'Optional. Must exactly match one of the category names listed below (not case-sensitive).'],
  ];
  if (type === 'jewelry') {
    info.push(['Subcategory', 'Optional. One of: ' + allSubcategories().map((s) => s.name).join(', ')]);
  }
  if (type === 'gemstone') {
    info.push(['Origin', `Optional, defaults to "Natural". One of: ${ORIGIN_VALUES.join(', ')}`]);
  }
  info.push(['Status', `Optional, defaults to "active". One of: ${STATUS_VALUES.join(', ')}`]);
  info.push(['Visibility', `Optional, defaults to "visible". One of: ${VISIBILITY_VALUES.join(', ')}`]);
  const priceCols = cols.filter((c) => c.kind === 'number').map((c) => c.header);
  if (priceCols.length) info.push([priceCols.join(' / '), 'Must be a plain number if provided, e.g. 4800 or 4800.50 (no currency symbols needed, they are stripped automatically).']);
  info.push(['']);
  info.push([`Valid category names for ${label}:`]);
  cats.forEach((c) => info.push([c.name]));

  const wsInfo = XLSX.utils.aoa_to_sheet(info);
  wsInfo['!cols'] = [{ wch: 42 }, { wch: 80 }];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Stock Data');
  XLSX.utils.book_append_sheet(wb, wsInfo, 'Instructions');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

function parseWorkbook(buffer) {
  let wb;
  try {
    wb = XLSX.read(buffer, { type: 'buffer' });
  } catch (e) {
    return { error: 'This file could not be read as an Excel spreadsheet. Please use the downloaded template.' };
  }
  const sheetName = wb.SheetNames[0];
  if (!sheetName) return { error: 'The uploaded file has no sheets.' };
  const sheet = wb.Sheets[sheetName];
  const headerRow = (XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false })[0]) || [];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '', raw: false });
  return { headers: headerRow, rows };
}

function headerMap(type) {
  const map = {};
  COLUMN_DEFS[type].forEach((c) => { map[normalizeHeader(c.header)] = c; });
  return map;
}

function remapRow(type, rawRow) {
  const map = headerMap(type);
  const out = {};
  for (const [k, v] of Object.entries(rawRow)) {
    const col = map[normalizeHeader(k)];
    if (col) out[col.key] = v;
  }
  return out;
}

function toNumber(v) {
  const cleaned = String(v == null ? '' : v).replace(/[$,]/g, '').trim();
  if (cleaned === '') return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : NaN;
}

function validateRow(type, rawRow, ctx) {
  const row = remapRow(type, rawRow);
  const errors = [];
  const product = { type };

  const sku = String(row.sku || '').trim();
  if (!sku) {
    errors.push('SKU is required.');
  } else if (ctx.existingSkus.has(sku)) {
    errors.push(`SKU "${sku}" already exists in the catalog.`);
  } else if (ctx.seenSkus.has(sku)) {
    errors.push(`SKU "${sku}" appears more than once in this file (also on an earlier row).`);
  }
  product.sku = sku;

  const categoryText = String(row.category_id || '').trim();
  if (categoryText) {
    const match = ctx.categories.find((c) => c.name.toLowerCase() === categoryText.toLowerCase());
    if (!match) {
      errors.push(`Category "${categoryText}" was not found for ${type}. Valid categories: ${ctx.categories.map((c) => c.name).join(', ')}.`);
    } else {
      product.category_id = match.id;
    }
  } else {
    product.category_id = null;
  }

  if (type === 'jewelry') {
    const subText = String(row.subcategory_id || '').trim();
    if (subText) {
      const match = ctx.subcategories.find((s) => s.name.toLowerCase() === subText.toLowerCase());
      if (!match) {
        errors.push(`Subcategory "${subText}" was not found. Valid subcategories: ${ctx.subcategories.map((s) => s.name).join(', ')}.`);
      } else {
        product.subcategory_id = match.id;
      }
    } else {
      product.subcategory_id = null;
    }
  }

  for (const col of COLUMN_DEFS[type].filter((c) => c.kind === 'enum')) {
    const raw = String(row[col.key] || '').trim();
    if (!raw) { product[col.key] = col.default; continue; }
    const match = col.values.find((v) => v.toLowerCase() === raw.toLowerCase());
    if (!match) {
      errors.push(`${col.header} "${raw}" is not valid. Use one of: ${col.values.join(', ')}.`);
    } else {
      product[col.key] = match;
    }
  }

  for (const col of COLUMN_DEFS[type].filter((c) => c.kind === 'number')) {
    const raw = row[col.key];
    if (raw === undefined || String(raw).trim() === '') { product[col.key] = null; continue; }
    const n = toNumber(raw);
    if (n === null || Number.isNaN(n)) {
      errors.push(`${col.header} "${raw}" is not a valid number.`);
    } else {
      product[col.key] = n;
    }
  }

  for (const col of COLUMN_DEFS[type].filter((c) => c.kind === 'text')) {
    const raw = String(row[col.key] || '').trim();
    product[col.key] = raw === '' ? null : raw;
  }

  if (errors.length) return { ok: false, errors, sku };
  return { ok: true, product, sku };
}

// Parses + validates every row of `buffer` for `type`. Never writes to the DB —
// callers insert the returned `ok:true` rows themselves inside their own transaction.
function importWorkbook(type, buffer) {
  if (!COLUMN_DEFS[type]) return { topLevelError: 'Unknown product type.' };

  const parsed = parseWorkbook(buffer);
  if (parsed.error) return { topLevelError: parsed.error };

  const skuHeaderPresent = parsed.headers.some((h) => normalizeHeader(h) === 'sku');
  if (!skuHeaderPresent) {
    return { topLevelError: 'Could not find a "SKU" column in the uploaded file\'s header row. Please use the downloaded template for this product type and don\'t rename the header row.' };
  }
  if (!parsed.rows.length) {
    return { topLevelError: 'The uploaded file has no data rows to import.' };
  }

  const ctx = {
    categories: typeCategories(type),
    subcategories: allSubcategories(),
    existingSkus: new Set(db.prepare('SELECT sku FROM products').all().map((r) => r.sku)),
    seenSkus: new Set(),
  };

  const results = parsed.rows.map((rawRow, i) => {
    const result = validateRow(type, rawRow, ctx);
    if (result.sku) ctx.seenSkus.add(result.sku);
    return { row: i + 2, ...result }; // +2: header is row 1, data starts at row 2
  });

  return { results };
}

module.exports = { COLUMN_DEFS, buildTemplate, importWorkbook, productColumns };
