// Excel stock template / export / import for Admin > Products.
//
// One column list per product type drives all three, so a downloaded
// template, a "Download All Stock" export and an import always agree:
//   * the columns mirror the Add/Edit Product form (same order, same labels),
//     plus the list-level settings (Status, Visibility, Featured) and, for
//     jewelry, one price column per metal variation;
//   * an export can be edited and imported straight back: a row whose SKU
//     already exists UPDATES that product, a new SKU CREATES one;
//   * importing is two-step — a dry run (preview) reports what would be
//     created / updated / left unchanged / rejected, then the admin confirms.
// Photos and videos can't travel in a spreadsheet; they're managed in the form.
const XLSX = require('xlsx');
const db = require('../db/postgres');
const { METAL_OPTIONS } = require('./productVariants');
const {
  PRODUCT_OFFER_COLUMNS, LABEL_MAX, MAX_PERCENT, SITE_TZ_LABEL, getOffersSchema, loadLivePromotions,
  resolveOffer, discountedPrice, parseOfferDate, formatSiteDate, normalizeOwnDiscount,
} = require('./offers');

const STATUS_VALUES = ['active', 'hidden'];
const VISIBILITY_VALUES = ['visible', 'draft'];
const ORIGIN_VALUES = ['Natural', 'Lab Created'];
// Price Visibility: stored code <-> the label the form shows. Blank = inherit
// the site-wide setting.
const PRICE_VIS = [
  { code: 'show', label: 'Show Price' },
  { code: 'hide', label: 'Hide Price' },
  { code: 'contact', label: 'Contact for Price' },
  { code: 'approved', label: 'Approved Customers Only' },
];
const EXAMPLE_SKU = 'EXAMPLE-DELETE-ME';
// The product's own discount: stored code <-> spreadsheet label. Blank = no
// own discount (the product follows any running sale).
const DISCOUNT_TYPES = [
  { code: 'percent', label: 'Percent Off', aliases: ['percent', '%', '% off', 'percentage', 'percent off'] },
  { code: 'amount', label: 'Amount Off', aliases: ['amount', '$', '$ off', 'fixed', 'amount off', 'flat'] },
  { code: 'none', label: 'No Discount', aliases: ['none', 'no', 'no discount', 'exclude', 'excluded', 'never'] },
];

// kind: sku | category | subcategory | text | number | enum | priceVisibility | bool | variant
//       | discountType | discountValue | offerLabel | offerDate | readonly (export-only, ignored on import)
// attr: the Admin > Attributes list the form's dropdown for this field uses.
// aliases: older header spellings still accepted on import.
const col = (key, header, kind, extra = {}) => ({ key, header, kind, ...extra });
const TAIL = [
  col('status', 'Status', 'enum', { values: STATUS_VALUES, default: 'active' }),
  col('visibility', 'Visibility', 'enum', { values: VISIBILITY_VALUES, default: 'visible' }),
  col('featured', 'Featured on Homepage', 'bool', { aliases: ['Featured'] }),
];
// The Offer group — same on every type, right after the prices.
const OFFER = [
  col('discount_type', 'Discount Type', 'discountType'),
  col('discount_value', 'Discount Value', 'discountValue', { aliases: ['Discount'] }),
  col('discount_label', 'Offer Label', 'offerLabel', { aliases: ['Discount Label'] }),
  col('discount_starts_at', 'Offer Starts', 'offerDate', { aliases: ['Discount Starts', 'Offer Start'] }),
  col('discount_ends_at', 'Offer Ends', 'offerDate', { endOfDay: true, aliases: ['Discount Ends', 'Offer End'] }),
];
// Export-only: what customers pay right now (own discount or a running
// sale) — handy for stock checks; ignored when the file is imported back.
const READONLY = [
  col('__final_price', 'Price After Discount (read-only)', 'readonly', { exportOnly: true }),
  col('__current_offer', 'Current Offer (read-only)', 'readonly', { exportOnly: true }),
];
const COLUMN_DEFS = {
  diamond: [
    col('sku', 'SKU', 'sku'),
    col('category_id', 'Category', 'category'),
    col('price_visibility', 'Price Visibility', 'priceVisibility'),
    col('weight_carat', 'Weight (Carat)', 'text'),
    col('shape', 'Shape', 'text', { attr: 'shape' }),
    col('color', 'Color', 'text', { attr: 'color' }),
    col('clarity', 'Clarity', 'text'),
    col('measurements', 'Measurements', 'text'),
    col('certificate_authority', 'Certificate Authority', 'text', { attr: 'certification' }),
    col('certificate_number', 'Certificate Number', 'text', { aliases: ['Certificate #'] }),
    col('certificate_website', 'Certificate Website', 'text'),
    col('price_per_carat', 'Price Per Carat', 'number', { aliases: ['Price / Carat'] }),
    col('total_price', 'Total Price', 'number'),
    ...OFFER,
    ...TAIL,
    ...READONLY,
  ],
  jewelry: [
    col('sku', 'SKU', 'sku'),
    col('category_id', 'Category', 'category'),
    col('subcategory_id', 'Subcategory', 'subcategory'),
    col('price_visibility', 'Price Visibility', 'priceVisibility'),
    col('metal', 'Metal', 'text'),
    col('gold_purity', 'Gold Purity', 'text'),
    col('gold_color', 'Gold Color', 'text'),
    col('gold_weight_grams', 'Gold Weight (g)', 'text'),
    col('certificate_authority', 'Jewelry Certificate Authority', 'text', { attr: 'certification', aliases: ['Certificate Authority'] }),
    col('certificate_number', 'Jewelry Certificate Number', 'text', { aliases: ['Certificate Number', 'Jewelry Certificate #'] }),
    col('certificate_website', 'Certificate Verify URL', 'text', { aliases: ['Stone Certificate Website', 'Certificate Website'] }),
    col('weight_carat', 'Stone Weight (ct)', 'text'),
    col('color', 'Stone Color', 'text', { attr: 'color' }),
    col('shape', 'Stone Shape', 'text', { attr: 'shape' }),
    col('clarity', 'Stone Clarity', 'text'),
    col('measurements', 'Stone Measurements', 'text'),
    col('total_price', 'Total Price', 'number'),
    ...METAL_OPTIONS.map((m) => col(`variant:${m}`, `${m} Price`, 'variant', { metal: m })),
    ...OFFER,
    ...TAIL,
    ...READONLY,
  ],
  gemstone: [
    col('sku', 'SKU', 'sku'),
    col('category_id', 'Category', 'category'),
    col('price_visibility', 'Price Visibility', 'priceVisibility'),
    col('stone_name', 'Stone Name', 'text'),
    col('origin', 'Origin', 'enum', { values: ORIGIN_VALUES, default: 'Natural' }),
    col('weight_carat', 'Weight (ct)', 'text'),
    col('color', 'Color', 'text', { attr: 'color' }),
    col('shape', 'Shape / Cut', 'text', { attr: 'shape' }),
    col('clarity', 'Clarity', 'text'),
    col('measurements', 'Measurements', 'text'),
    col('certificate_authority', 'Certificate Authority', 'text', { attr: 'certification' }),
    col('certificate_number', 'Certificate Number', 'text', { aliases: ['Certificate #'] }),
    col('certificate_website', 'Certificate Website', 'text'),
    col('price_per_carat', 'Price Per Carat', 'number', { aliases: ['Price / Carat'] }),
    col('total_price', 'Total Price', 'number'),
    ...OFFER,
    ...TAIL,
    ...READONLY,
  ],
};
const templateColumns = (type) => COLUMN_DEFS[type].filter((c) => !c.exportOnly);

const NOTES = {
  sku: 'Required. A SKU that already exists UPDATES that product; a new SKU CREATES a product.',
  category_id: 'Optional. Must match one of the category names listed below (not case-sensitive).',
  subcategory_id: 'Optional. Must match one of the subcategory names listed below.',
  price_visibility: `Optional. Blank = use the site-wide setting. Or one of: ${PRICE_VIS.map((p) => p.label).join(', ')}.`,
  status: `Optional. New products default to "active"; blank leaves an existing product as it is. One of: ${STATUS_VALUES.join(', ')}.`,
  visibility: `Optional. New products default to "visible"; blank leaves an existing product as it is. One of: ${VISIBILITY_VALUES.join(', ')} ("draft" keeps it off the storefront).`,
  featured: 'Optional, defaults to No. "Yes" shows the piece in the homepage Featured section.',
  origin: `Optional, defaults to "Natural". One of: ${ORIGIN_VALUES.join(', ')}.`,
  total_price: 'Plain number, e.g. 4800 or 4800.50 — currency symbols and commas are removed automatically.',
  price_per_carat: 'Plain number, e.g. 4800 — currency symbols and commas are removed automatically.',
  certificate_website: "The lab's verify URL ending where the report number goes, e.g. https://www.gia.edu/report-check?reportno=",
  gold_purity: 'e.g. 18K, 14K, 22K',
  metal: 'e.g. 18K Gold, 925 Silver',
  gold_color: 'e.g. Yellow, White, Rose — shown as the colour swatch on the Jewelry page when the piece has no metal variations.',
  discount_type: `Optional. This product's own discount: ${DISCOUNT_TYPES.map((d) => d.label).join(', ')}. Blank = no own discount (the product joins any running sale from Admin > Sales & Discounts). "No Discount" keeps it out of every sale. Its own discount always beats a sale.`,
  discount_value: `With Percent Off: the percentage, e.g. 15 (max ${MAX_PERCENT}). With Amount Off: dollars off, e.g. 500 (must be less than Total Price). Typing "15%" here with Discount Type blank means Percent Off.`,
  discount_label: `Optional, up to ${LABEL_MAX} characters — shown to customers next to the badge, e.g. "Clearance" or "Festive Offer".`,
  discount_starts_at: `Optional. e.g. 2026-12-01 or 2026-12-01 18:00 (${SITE_TZ_LABEL}). Blank = starts straight away.`,
  discount_ends_at: `Optional. e.g. 2026-12-31 (= the end of that day, ${SITE_TZ_LABEL}). Blank = no end date. Customers see a countdown in the last days.`,
};

const EXAMPLE_ROWS = {
  diamond: {
    SKU: EXAMPLE_SKU, Category: 'Certified Diamonds', 'Price Visibility': '', 'Weight (Carat)': '1.20', Shape: 'Round', Color: 'F', Clarity: 'VS1',
    Measurements: '6.80 x 6.85 x 4.20 mm', 'Certificate Authority': 'GIA', 'Certificate Number': '2201456789',
    'Certificate Website': 'https://www.gia.edu/report-check?reportno=', 'Price Per Carat': '4800', 'Total Price': '5760',
    'Discount Type': 'Percent Off', 'Discount Value': '10', 'Offer Label': 'Festive Offer', 'Offer Starts': '', 'Offer Ends': '2026-12-31',
    Status: 'active', Visibility: 'visible', 'Featured on Homepage': 'No',
  },
  jewelry: {
    SKU: EXAMPLE_SKU, Category: 'Gold Jewelry', Subcategory: 'Rings', 'Price Visibility': '', Metal: '18K Gold', 'Gold Purity': '18K',
    'Gold Color': 'Yellow', 'Gold Weight (g)': '4.2', 'Jewelry Certificate Authority': 'IGI', 'Jewelry Certificate Number': 'LG123456789',
    'Certificate Verify URL': 'https://www.igi.org/Verify-Your-Report/?r=', 'Stone Weight (ct)': '0.50', 'Stone Color': 'F', 'Stone Shape': 'Round',
    'Stone Clarity': 'VS1', 'Stone Measurements': '5.10 x 5.12 x 3.10 mm', 'Total Price': '3200',
    'Yellow Gold Price': '3200', 'Rose Gold Price': '3250', 'White Gold Price': '', 'Silver Price': '',
    Status: 'active', Visibility: 'visible', 'Featured on Homepage': 'No',
  },
  gemstone: {
    SKU: EXAMPLE_SKU, Category: 'Ruby', 'Price Visibility': '', 'Stone Name': 'Ruby', Origin: 'Natural', 'Weight (ct)': '2.10',
    Color: 'Red', 'Shape / Cut': 'Oval', Clarity: 'Eye Clean', Measurements: '8.10 x 6.20 x 4.10 mm',
    'Certificate Authority': 'GRS', 'Certificate Number': 'GRS2024-1234', 'Certificate Website': 'https://www.grs-gemresearch.ch',
    'Price Per Carat': '900', 'Total Price': '1890', Status: 'active', Visibility: 'visible', 'Featured on Homepage': 'No',
  },
};

const TYPE_LABEL = { diamond: 'Diamond', jewelry: 'Jewelry', gemstone: 'Gemstone' };
const normalizeHeader = (h) => String(h == null ? '' : h).trim().toLowerCase().replace(/\s+/g, ' ');

async function typeCategories(type) {
  return db.all(
    `SELECT c.id, c.name FROM categories c JOIN product_types pt ON pt.id = c.product_type_id
     WHERE pt.key = $1 AND c.enabled = TRUE ORDER BY c.sort_order, c.name`,
    [type]
  );
}
async function allSubcategories() {
  return db.all('SELECT id, name FROM subcategories WHERE enabled = TRUE ORDER BY sort_order, name');
}
// The same lists the form's Shape / Color / Certificate dropdowns offer.
async function attributeLists() {
  let rows = [];
  try {
    rows = await db.all('SELECT attribute_type, name FROM product_attributes WHERE enabled = TRUE ORDER BY sort_order, name');
  } catch (err) {
    if (!(err && err.code === '42P01')) throw err;
  }
  const out = { shape: [], color: [], certification: [] };
  for (const r of rows) if (out[r.attribute_type]) out[r.attribute_type].push(r.name);
  return out;
}

// ── Cell values ───────────────────────────────────────────────────────────
// "$4,800", "USD 4800", "₹ 4,800.50", "4 800" -> number; "" -> null; junk -> NaN.
function toNumber(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : NaN;
  const s = String(v == null ? '' : v).trim();
  if (s === '' || s === '-' || s === '—') return null;
  const cleaned = s.replace(/[A-Za-z$€£¥₹₩₽¢\s,]/g, '');
  if (cleaned === '' || !/^-?\d*\.?\d+$/.test(cleaned)) return NaN;
  return Number(cleaned);
}
const cellText = (v) => (v === undefined || v === null ? '' : String(v).trim());
function parseBool(v) {
  const s = cellText(v).toLowerCase();
  if (s === '') return null;
  if (['yes', 'y', 'true', '1', 'featured'].includes(s)) return true;
  if (['no', 'n', 'false', '0'].includes(s)) return false;
  return undefined;
}
function parsePriceVis(v) {
  const s = cellText(v).toLowerCase();
  if (s === '' || s === 'inherit' || s.startsWith('inherit')) return null;
  const hit = PRICE_VIS.find((p) => p.code === s || p.label.toLowerCase() === s);
  return hit ? hit.code : undefined;
}
const priceVisLabel = (code) => (PRICE_VIS.find((p) => p.code === code) || {}).label || '';
function parseDiscountType(v) {
  const s = cellText(v).toLowerCase();
  if (s === '' || s === 'follow sales' || s === 'follow sale') return null;
  const hit = DISCOUNT_TYPES.find((d) => d.code === s || d.label.toLowerCase() === s || d.aliases.includes(s));
  return hit ? hit.code : undefined;
}
const discountTypeLabel = (code) => (DISCOUNT_TYPES.find((d) => d.code === code) || {}).label || '';

// ── Template ──────────────────────────────────────────────────────────────
function sheetFromRows(headers, rows) {
  const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);
  ws['!cols'] = headers.map((h, i) => {
    const longest = rows.reduce((m, r) => Math.max(m, String(r[i] == null ? '' : r[i]).length), 0);
    return { wch: Math.min(48, Math.max(14, h.length + 2, longest + 2)) };
  });
  // Excel: keep the header row and SKU column in view while scrolling.
  ws['!freeze'] = { xSplit: 1, ySplit: 1 };
  ws['!views'] = [{ state: 'frozen', xSplit: 1, ySplit: 1, topLeftCell: 'B2' }];
  if (rows.length) ws['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: rows.length, c: headers.length - 1 } }) };
  return ws;
}

async function buildTemplate(type) {
  const cols = templateColumns(type);
  const headers = cols.map((c) => c.header);
  const example = EXAMPLE_ROWS[type];
  const ws = sheetFromRows(headers, [headers.map((h) => (example[h] !== undefined ? example[h] : ''))]);

  const [cats, subs, attrs] = await Promise.all([typeCategories(type), allSubcategories(), attributeLists()]);
  const label = TYPE_LABEL[type];
  const info = [
    [`ONCD — ${label} Stock Import`],
    [''],
    ['How it works'],
    ['• Fill one row per product on the "Stock Data" sheet. Only SKU is required; every other column may be left blank.'],
    ['• A SKU that already exists UPDATES that product; a new SKU CREATES one. "Download All Stock" gives you this same layout to edit and import back.'],
    ['• Row 2 is an EXAMPLE (SKU ' + EXAMPLE_SKU + ') — it is skipped automatically, but you can delete it.'],
    ['• Keep the header row (row 1) as it is. You may remove columns you do not use: a missing column leaves that field untouched on existing products.'],
    ['• A blank cell in a column you kept clears that field on an existing product.'],
    ['• Nothing is saved until you confirm: the import first shows a preview of what will be created, updated and rejected.'],
    ['• Photos and videos are added in the product form (Admin > Products > Edit) — they cannot be imported from Excel.'],
    ['• Discounts: the Discount / Offer columns set a discount on that one product. Store-wide or category-wide sales are set up in Admin > Sales & Discounts and need no columns here.'],
    [''],
    ['Column', 'Notes'],
  ];
  for (const c of cols) {
    let note = NOTES[c.key] || '';
    if (c.kind === 'variant') note = `Jewelry metal variations. A price here offers this piece in ${c.metal} at that price; leave blank if not offered. Each variation's photo is chosen in the product form.`;
    if (c.attr && attrs[c.attr].length) note = `Pick from the form's list: ${attrs[c.attr].join(', ')}. Other values are accepted (flagged in the preview).`;
    info.push([c.header, note]);
  }
  info.push(['']);
  info.push([`Valid categories for ${label}:`, cats.map((c) => c.name).join(', ') || '(none set up yet — Admin > Categories)']);
  if (type === 'jewelry') info.push(['Valid subcategories:', subs.map((s) => s.name).join(', ')]);

  const wsInfo = XLSX.utils.aoa_to_sheet(info);
  wsInfo['!cols'] = [{ wch: 34 }, { wch: 120 }];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Stock Data');
  XLSX.utils.book_append_sheet(wb, wsInfo, 'Instructions');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

// ── Export ────────────────────────────────────────────────────────────────
async function variantsByProduct(ids) {
  const map = new Map();
  if (!ids.length) return map;
  let rows = [];
  try {
    rows = await db.all('SELECT product_id, metal, price, cover_media_id FROM product_variants WHERE product_id = ANY($1::bigint[])', [ids.map(String)]);
  } catch (err) {
    if (!(err && err.code === '42P01')) throw err;
  }
  for (const r of rows) {
    const pid = Number(r.product_id);
    if (!map.has(pid)) map.set(pid, new Map());
    map.get(pid).set(r.metal, { price: r.price == null ? null : Number(r.price), coverMediaId: r.cover_media_id ? Number(r.cover_media_id) : null });
  }
  return map;
}

function exportCell(c, row, ctx) {
  if (c.kind === 'discountType') return discountTypeLabel(row.discount_type);
  if (c.kind === 'offerDate') return formatSiteDate(row[c.key], { endOfDay: !!c.endOfDay });
  if (c.kind === 'discountValue') return row.discount_value == null ? '' : Number(row.discount_value);
  if (c.kind === 'readonly') {
    const offer = ctx.offerFor(row);
    if (c.key === '__final_price') {
      const sale = offer ? discountedPrice(row.total_price, offer) : null;
      return sale != null ? sale : (row.total_price == null ? '' : Number(row.total_price));
    }
    if (!offer) return '';
    const what = offer.type === 'percent' ? `${offer.value}% off` : `$${offer.value} off`;
    const src = offer.source === 'sale' ? `sale "${offer.label}"` : (offer.label ? `own discount "${offer.label}"` : 'own discount');
    return `${what} — ${src}${offer.endsAt ? `, ends ${formatSiteDate(offer.endsAt)}` : ''}`;
  }
  if (c.kind === 'category') return row.category_id != null ? (ctx.categoriesById.get(Number(row.category_id)) || '') : '';
  if (c.kind === 'subcategory') return row.subcategory_id != null ? (ctx.subcategoriesById.get(Number(row.subcategory_id)) || '') : '';
  if (c.kind === 'priceVisibility') return priceVisLabel(row.price_visibility);
  if (c.kind === 'bool') return row[c.key] ? 'Yes' : 'No';
  if (c.kind === 'variant') {
    const v = (ctx.variants.get(Number(row.id)) || new Map()).get(c.metal);
    return v && v.price != null ? v.price : '';
  }
  const v = row[c.key];
  return v === null || v === undefined ? '' : v;
}

async function buildStockExport(type, rows) {
  const cols = COLUMN_DEFS[type];
  const headers = cols.map((c) => c.header);
  // Every category/subcategory, enabled or not, so a product in a disabled
  // one still exports its real category name.
  const [cats, subs, variants, promotions] = await Promise.all([
    db.all('SELECT id, name FROM categories'),
    db.all('SELECT id, name FROM subcategories'),
    type === 'jewelry' ? variantsByProduct(rows.map((r) => r.id)) : Promise.resolve(new Map()),
    loadLivePromotions(),
  ]);
  const now = new Date();
  const ctx = {
    categoriesById: new Map(cats.map((c) => [Number(c.id), c.name])),
    subcategoriesById: new Map(subs.map((s) => [Number(s.id), s.name])),
    variants,
    offerFor: (row) => resolveOffer(row, promotions, now),
  };
  const ws = sheetFromRows(headers, rows.map((row) => cols.map((c) => exportCell(c, row, ctx))));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Stock Data');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

// ── Import ────────────────────────────────────────────────────────────────
function parseWorkbook(buffer) {
  let wb;
  try {
    wb = XLSX.read(buffer, { type: 'buffer' });
  } catch (e) {
    return { error: 'This file could not be read as an Excel spreadsheet. Please use the downloaded template.' };
  }
  // The data sheet by name if present (the template also has "Instructions").
  const sheetName = wb.SheetNames.find((n) => normalizeHeader(n) === 'stock data') || wb.SheetNames[0];
  if (!sheetName) return { error: 'The uploaded file has no sheets.' };
  const sheet = wb.Sheets[sheetName];
  const aoa = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '', blankrows: true });
  // Underlying cell values too: a date typed in Excel is a date serial
  // there, unambiguous — its formatted text ("12/31/26") is not.
  const aoaRaw = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: '', blankrows: true });
  const headers = (aoa[0] || []).map(cellText);
  const rows = [];
  for (let i = 1; i < aoa.length; i++) {
    const cells = aoa[i] || [];
    if (!cells.some((v) => cellText(v) !== '')) continue; // fully blank line
    const obj = {};
    const rawObj = {};
    headers.forEach((h, j) => { if (h) { obj[h] = cells[j]; rawObj[h] = (aoaRaw[i] || [])[j]; } });
    rows.push({ rowNumber: i + 1, raw: obj, rawValues: rawObj });
  }
  return { headers, rows };
}

function headerLookup(type) {
  const map = new Map();
  for (const c of COLUMN_DEFS[type]) {
    map.set(normalizeHeader(c.header), c);
    for (const a of c.aliases || []) if (!map.has(normalizeHeader(a))) map.set(normalizeHeader(a), c);
  }
  return map;
}

// Uploading another type's file on this tab would tag every row with the
// wrong type and silently drop that type's own columns.
function detectHeaderTypeMismatch(headers, type) {
  const normalized = headers.map(normalizeHeader).filter(Boolean);
  const scores = {};
  for (const t of Object.keys(COLUMN_DEFS)) {
    const known = headerLookup(t);
    scores[t] = normalized.filter((h) => known.has(h)).length;
  }
  const bestType = Object.keys(scores).reduce((a, b) => (scores[b] > scores[a] ? b : a));
  if (bestType !== type && scores[bestType] > scores[type] + 1) {
    return `This file's columns look like a ${TYPE_LABEL[bestType]} stock file, not ${TYPE_LABEL[type]}. Switch to the ${TYPE_LABEL[bestType]} tab and import it there, or re-download the ${TYPE_LABEL[type]} template.`;
  }
  return null;
}

const sameValue = (a, b) => {
  const na = a === undefined || a === '' ? null : a;
  const nb = b === undefined || b === '' ? null : b;
  if (na === null || nb === null) return na === nb;
  // Dates travel through Excel at one-second precision.
  if (na instanceof Date || nb instanceof Date) return Math.floor(new Date(na).getTime() / 1000) === Math.floor(new Date(nb).getTime() / 1000);
  if (typeof na === 'number' || typeof nb === 'number') return Number(na) === Number(nb);
  if (typeof na === 'boolean' || typeof nb === 'boolean') return !!na === !!nb;
  return String(na) === String(nb);
};

// Validates one row against `present` (the columns this file actually has).
// Returns { ok, action: 'create'|'update'|'unchanged'|'skip', fields, variants?, errors, warnings }.
function validateRow(type, row, ctx) {
  const errors = [];
  const warnings = [];
  const get = (key) => row.values.get(key);
  const sku = cellText(get('sku'));
  if (!sku) return { ok: false, sku: '', errors: ['SKU is required.'], warnings };
  if (sku.toUpperCase() === EXAMPLE_SKU) return { ok: true, sku, action: 'skip', note: 'Example row — skipped.', errors, warnings };
  const key = sku.toLowerCase();
  if (ctx.seenSkus.has(key)) return { ok: false, sku, errors: [`SKU "${sku}" appears more than once in this file (first on row ${ctx.seenSkus.get(key)}).`], warnings };
  ctx.seenSkus.set(key, row.rowNumber);

  const existing = ctx.existingBySku.get(key) || null;
  if (existing && existing.type !== type) {
    return { ok: false, sku, errors: [`SKU "${sku}" already belongs to a ${TYPE_LABEL[existing.type] || existing.type} product — it can't be imported as ${TYPE_LABEL[type]}.`], warnings };
  }

  const fields = {};
  let percentHint = false; // a Discount Value typed as "15%"
  for (const c of ctx.present) {
    if (c.kind === 'sku' || c.kind === 'variant' || c.kind === 'readonly') continue;
    const raw = get(c.key);
    const text = cellText(raw);
    switch (c.kind) {
      case 'category': {
        if (!text) { fields.category_id = null; break; }
        const m = ctx.categories.find((x) => x.name.toLowerCase() === text.toLowerCase());
        if (m) fields.category_id = Number(m.id);
        else errors.push(`Category "${text}" doesn't exist for ${TYPE_LABEL[type]}. Use one of: ${ctx.categories.map((x) => x.name).join(', ') || '(none set up)'}.`);
        break;
      }
      case 'subcategory': {
        if (!text) { fields.subcategory_id = null; break; }
        const m = ctx.subcategories.find((x) => x.name.toLowerCase() === text.toLowerCase());
        if (m) fields.subcategory_id = Number(m.id);
        else errors.push(`Subcategory "${text}" doesn't exist. Use one of: ${ctx.subcategories.map((x) => x.name).join(', ')}.`);
        break;
      }
      case 'enum': {
        if (!text) { if (!existing) fields[c.key] = c.default; else if (c.key === 'origin') fields[c.key] = null; break; }
        const m = c.values.find((v) => v.toLowerCase() === text.toLowerCase());
        if (m) fields[c.key] = m;
        else errors.push(`${c.header} "${text}" isn't valid. Use one of: ${c.values.join(', ')}.`);
        break;
      }
      case 'priceVisibility': {
        const v = parsePriceVis(raw);
        if (v === undefined) errors.push(`Price Visibility "${text}" isn't valid. Leave blank to use the site setting, or use: ${PRICE_VIS.map((p) => p.label).join(', ')}.`);
        else fields.price_visibility = v;
        break;
      }
      case 'bool': {
        const v = parseBool(raw);
        if (v === undefined) errors.push(`${c.header} "${text}" isn't valid. Use Yes or No.`);
        else fields[c.key] = v === null ? false : v;
        break;
      }
      case 'discountType': {
        const v = parseDiscountType(raw);
        if (v === undefined) errors.push(`Discount Type "${text}" isn't valid. Leave blank, or use: ${DISCOUNT_TYPES.map((d) => d.label).join(', ')}.`);
        else fields.discount_type = v;
        break;
      }
      case 'discountValue': {
        if (!text) { fields.discount_value = null; break; }
        const pct = /%\s*$/.test(text);
        const n = toNumber(text.replace(/%\s*$/, ''));
        if (Number.isNaN(n)) errors.push(`Discount Value "${text}" isn't a number.`);
        else { fields.discount_value = n; if (pct) percentHint = true; }
        break;
      }
      case 'offerLabel': {
        fields.discount_label = text || null;
        break;
      }
      case 'offerDate': {
        const rawValue = row.rawValues ? row.rawValues.get(c.key) : raw;
        const d = parseOfferDate(typeof rawValue === 'number' ? rawValue : text, { endOfDay: !!c.endOfDay });
        if (d === undefined) errors.push(`${c.header} "${text}" isn't a date we can read. Use e.g. 2026-12-31 or 2026-12-31 18:00.`);
        else fields[c.key] = d;
        break;
      }
      case 'number': {
        const n = toNumber(raw);
        if (Number.isNaN(n)) errors.push(`${c.header} "${text}" isn't a number.`);
        else if (n !== null && n < 0) errors.push(`${c.header} can't be negative.`);
        else fields[c.key] = n;
        break;
      }
      default: { // text
        if (!text) { fields[c.key] = null; break; }
        let v = text;
        if (c.attr && ctx.attrs[c.attr].length) {
          const m = ctx.attrs[c.attr].find((a) => a.toLowerCase() === text.toLowerCase());
          if (m) v = m; // canonical spelling from the form's list
          else warnings.push(`${c.header} "${text}" isn't in the form's ${c.attr === 'certification' ? 'certificate' : c.attr} list (Admin > Attributes) — imported as typed.`);
        }
        fields[c.key] = v;
      }
    }
  }

  // The product's own discount — only when the file has any of its columns.
  // Columns left out keep the product's current values.
  const hasOfferCols = ctx.present.some((c) => PRODUCT_OFFER_COLUMNS.includes(c.key));
  if (hasOfferCols && !ctx.offersReady) {
    const filled = PRODUCT_OFFER_COLUMNS.some((k) => fields[k] !== undefined && fields[k] !== null);
    for (const k of PRODUCT_OFFER_COLUMNS) delete fields[k];
    if (filled) warnings.push('Discount columns were ignored: discounts need a one-time database update first (Admin > Sales & Discounts shows the SQL).');
  } else if (hasOfferCols && !errors.length) {
    const merged = {};
    for (const k of PRODUCT_OFFER_COLUMNS) merged[k] = fields[k] !== undefined ? fields[k] : (existing ? existing[k] : null);
    if (merged.discount_type == null && percentHint) merged.discount_type = 'percent';
    if (merged.discount_type == null && fields.discount_value != null) {
      errors.push('Discount Value is filled but Discount Type is blank — set it to Percent Off or Amount Off (or type the value as e.g. 15%).');
    } else {
      if (merged.discount_type == null && (fields.discount_label || fields.discount_starts_at || fields.discount_ends_at)) {
        warnings.push('Offer Label / dates were ignored because Discount Type is blank.');
      }
      const basePrice = fields.total_price !== undefined ? fields.total_price : (existing ? (existing.total_price == null ? null : Number(existing.total_price)) : null);
      const errs = normalizeOwnDiscount(merged, basePrice);
      errors.push(...errs);
      if (!errs.length) {
        for (const k of PRODUCT_OFFER_COLUMNS) fields[k] = merged[k];
        if (merged.discount_ends_at && merged.discount_ends_at < new Date()) warnings.push(`The offer ended on ${formatSiteDate(merged.discount_ends_at)} — saved, but customers won't see it.`);
      }
    }
  }

  // A new Total Price must still leave room for an existing $-off discount
  // the file doesn't mention.
  if (!hasOfferCols && existing && existing.discount_type === 'amount' && fields.total_price !== undefined
      && !(Number(fields.total_price) > Number(existing.discount_value))) {
    errors.push(`Total Price must stay above this product's $${Number(existing.discount_value)} discount — change or remove the discount too.`);
  }

  // Jewelry metal variations — only when the file has those columns.
  let variants;
  const variantCols = ctx.present.filter((c) => c.kind === 'variant');
  if (variantCols.length) {
    const prev = existing ? (ctx.variants.get(Number(existing.id)) || new Map()) : new Map();
    variants = new Map(prev); // metals whose column was removed from the file stay as they are
    for (const c of variantCols) {
      const n = toNumber(get(c.key));
      if (Number.isNaN(n)) errors.push(`${c.header} "${cellText(get(c.key))}" isn't a number.`);
      else if (n !== null && n < 0) errors.push(`${c.header} can't be negative.`);
      else if (n === null) variants.delete(c.metal);
      else variants.set(c.metal, { price: n, coverMediaId: prev.get(c.metal) ? prev.get(c.metal).coverMediaId : null });
    }
  }

  if (errors.length) return { ok: false, sku, errors, warnings };

  if (!existing) {
    for (const c of COLUMN_DEFS[type]) { // defaults for columns the file left out
      if (c.kind === 'enum' && fields[c.key] === undefined) fields[c.key] = c.default;
      if (c.kind === 'bool' && fields[c.key] === undefined) fields[c.key] = false;
    }
    return { ok: true, sku, action: 'create', fields, variants, errors, warnings };
  }

  const changed = Object.keys(fields).filter((k) => !sameValue(fields[k], existing[k]));
  let variantsChanged = false;
  if (variants) {
    const prev = ctx.variants.get(Number(existing.id)) || new Map();
    variantsChanged = prev.size !== variants.size || [...variants].some(([m, v]) => !prev.has(m) || Number(prev.get(m).price) !== Number(v.price));
  }
  const updateFields = {};
  for (const k of changed) updateFields[k] = fields[k];
  const action = changed.length || variantsChanged ? 'update' : 'unchanged';
  const changedLabels = changed.map((k) => (COLUMN_DEFS[type].find((c) => c.key === k) || {}).header || k);
  if (variantsChanged) changedLabels.push('Metal variations');
  return { ok: true, sku, id: Number(existing.id), action, fields: updateFields, variants: variantsChanged ? variants : undefined, changed: changedLabels, errors, warnings };
}

// Parses + validates the whole file. Never writes — see applyImport().
async function importWorkbook(type, buffer) {
  if (!COLUMN_DEFS[type]) return { topLevelError: 'Unknown product type.' };
  const parsed = parseWorkbook(buffer);
  if (parsed.error) return { topLevelError: parsed.error };
  const lookup = headerLookup(type);
  if (!parsed.headers.some((h) => normalizeHeader(h) === 'sku')) {
    return { topLevelError: 'Could not find a "SKU" column in the header row (row 1). Please use the downloaded template and keep its header row.' };
  }
  const mismatch = detectHeaderTypeMismatch(parsed.headers, type);
  if (mismatch) return { topLevelError: mismatch };
  if (!parsed.rows.length) return { topLevelError: 'The file has no data rows to import.' };

  // Which template columns this file has, and any it has that we don't know.
  const present = [];
  const unknownHeaders = [];
  for (const h of parsed.headers) {
    if (!h) continue;
    const c = lookup.get(normalizeHeader(h));
    if (!c) unknownHeaders.push(h);
    else if (!present.includes(c)) present.push(c);
  }

  const [categories, subcategories, attrs, existingRows, offersSchema] = await Promise.all([
    typeCategories(type), allSubcategories(), attributeLists(), db.all('SELECT * FROM products'), getOffersSchema(),
  ]);
  const existingBySku = new Map(existingRows.map((r) => [String(r.sku).toLowerCase(), r]));
  const sameType = existingRows.filter((r) => r.type === type).map((r) => r.id);
  const variants = type === 'jewelry' ? await variantsByProduct(sameType) : new Map();
  const ctx = { present, categories, subcategories, attrs, existingBySku, variants, seenSkus: new Map(), offersReady: offersSchema.productColumns };

  const results = parsed.rows.map((r) => {
    const values = new Map();
    const rawValues = new Map();
    for (const [h, v] of Object.entries(r.raw)) {
      const c = lookup.get(normalizeHeader(h));
      if (c && !values.has(c.key)) { values.set(c.key, v); rawValues.set(c.key, r.rawValues[h]); }
    }
    return { row: r.rowNumber, ...validateRow(type, { rowNumber: r.rowNumber, values, rawValues }, ctx) };
  });
  return { results, unknownHeaders, columns: present.filter((c) => c.kind !== 'readonly').map((c) => c.header) };
}

// Writes the valid rows in ONE transaction (all or nothing).
async function applyImport(type, results, client) {
  for (const r of results) {
    if (!r.ok || r.action === 'skip' || r.action === 'unchanged') continue;
    let id = r.id;
    if (r.action === 'create') {
      const f = { type, sku: r.sku, ...r.fields };
      if (type !== 'jewelry') delete f.subcategory_id;
      const cols = Object.keys(f);
      const ins = await client.query(
        `INSERT INTO products (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
        cols.map((c) => f[c])
      );
      id = ins.rows[0].id;
    } else {
      const cols = Object.keys(r.fields);
      if (cols.length) {
        await client.query(
          `UPDATE products SET ${cols.map((c, i) => `${c} = $${i + 1}`).join(', ')}, updated_at = NOW() WHERE id = $${cols.length + 1}`,
          [...cols.map((c) => r.fields[c]), id]
        );
      }
    }
    if (r.variants) {
      await client.query('DELETE FROM product_variants WHERE product_id = $1', [id]);
      for (const [metal, v] of r.variants) {
        await client.query('INSERT INTO product_variants (product_id, metal, price, cover_media_id) VALUES ($1, $2, $3, $4)', [id, metal, v.price, v.coverMediaId || null]);
      }
    }
  }
}

module.exports = { COLUMN_DEFS, EXAMPLE_SKU, buildTemplate, buildStockExport, importWorkbook, applyImport };
