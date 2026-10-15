const db = require('../db/postgres');

// Single registry of every homepage section the storefront knows how to
// render, with its default text and settings. The homepage_sections table
// only stores what an admin has changed: a key with no row (or a NULL
// text column, or a settings key missing from the JSON) falls back to the
// defaults here. That means new sections ship working without any data
// migration, and a single ALTER TABLE (see HOMEPAGE_MIGRATION_SQL) unlocks
// per-section text/settings editing.

const HOMEPAGE_MIGRATION_SQL = `ALTER TABLE homepage_sections
  ADD COLUMN IF NOT EXISTS kicker TEXT,
  ADD COLUMN IF NOT EXISTS title TEXT,
  ADD COLUMN IF NOT EXISTS subtitle TEXT,
  ADD COLUMN IF NOT EXISTS cta_label TEXT,
  ADD COLUMN IF NOT EXISTS cta_href TEXT,
  ADD COLUMN IF NOT EXISTS settings JSONB NOT NULL DEFAULT '{}'::jsonb;`;

const TYPE_OPTIONS = [
  { value: 'all', label: 'All product types' },
  { value: 'diamond', label: 'Diamonds only' },
  { value: 'jewelry', label: 'Jewelry only' },
  { value: 'gemstone', label: 'Gemstones only' },
];

// Icon keys the storefront knows how to draw (Home.dc.html maps each to an
// inline SVG); anything else is rejected by the sanitizer.
const BADGE_ICON_OPTIONS = [
  { value: 'shield', label: 'Shield (certified)' },
  { value: 'gem', label: 'Gem' },
  { value: 'globe', label: 'Globe (worldwide)' },
  { value: 'truck', label: 'Truck (delivery)' },
  { value: 'lock', label: 'Lock (secure)' },
  { value: 'factory', label: 'Factory (sourcing)' },
  { value: 'award', label: 'Award (quality)' },
  { value: 'handshake', label: 'Handshake (trade)' },
  { value: 'refresh', label: 'Returns' },
  { value: 'headset', label: 'Support' },
  { value: 'star', label: 'Star' },
  { value: 'check', label: 'Check mark' },
];

const rowsOption = (n) => ({ value: n, label: n === 1 ? '1 row' : `${n} rows` });

// text: which heading fields the section uses, with labels/defaults.
// settings: typed descriptors — the admin UI renders its form from these
// and sanitizeSettings() validates against them, so the two can't drift.
const SECTIONS = [
  {
    key: 'announcement', pinned: true, label: 'Announcement Bar', defaultEnabled: false,
    description: 'Slim message bar above the navigation — offers, shipping notices, new parcel alerts.',
    text: {
      title: { label: 'Message', default: '', maxLength: 160 },
      ctaLabel: { label: 'Link text (optional)', default: '', maxLength: 40 },
      ctaHref: { label: 'Link URL (optional)', default: '', maxLength: 300 },
    },
    settings: [
      { name: 'tone', type: 'select', label: 'Style', default: 'dark', options: [{ value: 'dark', label: 'Dark' }, { value: 'gold', label: 'Gold' }] },
    ],
  },
  {
    key: 'hero', pinned: true, togglable: false, label: 'Hero Slider', defaultEnabled: true,
    description: 'Slide photos and text are managed in the Hero Slides tab — these options control how the slider behaves.',
    text: {
      ctaLabel: { label: 'Second button text (guests)', default: 'Register for Trade Pricing', maxLength: 40 },
      ctaHref: { label: 'Second button link (guests)', default: 'Register.dc.html', maxLength: 300 },
    },
    settings: [
      { name: 'autoplay', type: 'toggle', label: 'Auto-advance slides', default: true },
      { name: 'intervalSeconds', type: 'number', label: 'Seconds per slide', default: 6, min: 3, max: 20 },
      { name: 'memberCta', type: 'toggle', label: 'Show a "My Account" button to signed-in customers instead', default: true },
    ],
  },
  {
    key: 'welcomeBar', label: 'Welcome Back Bar', audience: 'Signed-in customers only', defaultEnabled: true,
    description: 'Greets signed-in customers with their account status, shortcuts and how many pieces arrived since their last visit.',
    text: {
      title: { label: 'Greeting', default: 'Welcome back', maxLength: 60 },
      subtitle: { label: 'Subtext', default: "Here's what's new since your last visit.", maxLength: 140 },
    },
    settings: [
      { name: 'showNewSince', type: 'toggle', label: 'Show the "new since your last visit" count', default: true },
    ],
  },
  {
    key: 'trustBar', label: 'Trust Badges', defaultEnabled: true,
    description: 'A strip of short trust signals with icons.',
    text: {},
    settings: [
      {
        name: 'items', type: 'items', label: 'Badges', itemLabel: 'badge', max: 8,
        fields: [
          { name: 'icon', type: 'select', label: 'Icon', options: BADGE_ICON_OPTIONS, default: 'check' },
          { name: 'label', type: 'text', label: 'Text', maxLength: 60, required: true },
        ],
        default: [
          { icon: 'shield', label: 'GIA & IGI Certified' },
          { icon: 'factory', label: 'Direct Factory Sourcing' },
          { icon: 'lock', label: 'Trade & Retail Inquiries' },
          { icon: 'globe', label: 'Worldwide Shipping' },
        ],
      },
    ],
  },
  {
    key: 'shapePicker', label: 'Shop by Shape', defaultEnabled: true,
    description: 'Round photo tiles for each diamond shape in stock — each opens the Diamonds page already filtered to that shape.',
    text: {
      kicker: { label: 'Small heading', default: 'Start Your Search', maxLength: 60 },
      title: { label: 'Heading', default: 'Shop Diamonds by Shape', maxLength: 90 },
    },
    settings: [
      { name: 'showCounts', type: 'toggle', label: 'Show stock count under each shape', default: true },
    ],
  },
  {
    key: 'promoBanner', label: 'Promo Banner', blockKey: 'promo', defaultEnabled: true,
    description: 'Dark split banner with an offer and photo. Edit its text and photo in the Content Blocks tab.',
    text: {}, settings: [],
  },
  {
    key: 'collections', label: 'Collections', defaultEnabled: true,
    description: 'Large photo cards for Diamonds, Jewelry and Gemstones. Edit each card in the Collections tab.',
    text: {
      kicker: { label: 'Small heading', default: 'Our Collections', maxLength: 60 },
      title: { label: 'Heading', default: 'Three Houses, One Standard', maxLength: 90 },
    },
    settings: [
      { name: 'showCounts', type: 'toggle', label: 'Show item count on each card', default: true },
    ],
  },
  {
    key: 'featured', label: 'Featured Pieces', defaultEnabled: true,
    description: 'Editorial mosaic of the products you star as Featured on the Products page. The most recently starred piece gets the large tile.',
    text: {
      kicker: { label: 'Small heading', default: 'Curated Selection', maxLength: 60 },
      title: { label: 'Heading', default: 'Featured Pieces', maxLength: 90 },
      subtitle: { label: 'Intro text', default: 'Hand-picked by our specialists this week.', maxLength: 200 },
    },
    settings: [
      { name: 'type', type: 'select', label: 'Product type', default: 'all', options: TYPE_OPTIONS },
      { name: 'limit', type: 'select', label: 'Pieces to show', default: 5, options: [2, 3, 4, 5].map((n) => ({ value: n, label: `${n} pieces` })) },
      { name: 'photosOnly', type: 'toggle', label: 'Skip products without a photo', default: true },
    ],
  },
  {
    key: 'newArrivals', label: 'New Arrivals', defaultEnabled: true,
    description: 'Latest additions with NEW badges. Visitors can switch between product types with tabs.',
    text: {
      kicker: { label: 'Small heading', default: 'Fresh to the House', maxLength: 60 },
      title: { label: 'Heading', default: 'New Arrivals', maxLength: 90 },
      ctaLabel: { label: '"See all" link text', default: 'See all', maxLength: 40 },
    },
    settings: [
      { name: 'tabs', type: 'toggle', label: 'Show product-type tabs', default: true },
      { name: 'type', type: 'select', label: 'Tab selected by default', default: 'all', options: TYPE_OPTIONS },
      { name: 'rows', type: 'select', label: 'Rows of products', default: 2, options: [1, 2, 3].map(rowsOption) },
      { name: 'newBadgeDays', type: 'number', label: 'Show a NEW badge on products added within (days)', default: 14, min: 1, max: 90 },
      { name: 'photosOnly', type: 'toggle', label: 'Skip products without a photo', default: true },
    ],
  },
  {
    key: 'recentlyViewed', label: 'Recently Viewed', audience: 'Visitors with browsing history', defaultEnabled: true,
    description: "Each visitor's own recently opened products, remembered on their device. Hidden until they've viewed something.",
    text: {
      kicker: { label: 'Small heading', default: 'Pick Up Where You Left Off', maxLength: 60 },
      title: { label: 'Heading', default: 'Recently Viewed', maxLength: 90 },
    },
    settings: [
      { name: 'limit', type: 'select', label: 'Products to remember', default: 10, options: [6, 8, 10, 12].map((n) => ({ value: n, label: `${n} products` })) },
    ],
  },
  {
    key: 'spotlight', label: "Editor's Pick Spotlight", blockKey: 'spotlight', defaultEnabled: true,
    description: 'Wide photo banner with a story or highlight. Edit its text and photo in the Content Blocks tab.',
    text: {}, settings: [],
  },
  {
    key: 'favorites', label: 'Most Requested', defaultEnabled: true,
    description: 'Ranked carousel of the products buyers actually inquire about most, from real inquiry data. Hidden when there are too few inquiries to rank.',
    text: {
      kicker: { label: 'Small heading', default: 'Client Favorites', maxLength: 60 },
      title: { label: 'Heading', default: 'Most Requested This Season', maxLength: 90 },
    },
    settings: [
      { name: 'days', type: 'select', label: 'Count inquiries from the last', default: 90, options: [30, 60, 90, 180, 365].map((n) => ({ value: n, label: `${n} days` })) },
      { name: 'type', type: 'select', label: 'Product type', default: 'all', options: TYPE_OPTIONS },
      { name: 'limit', type: 'select', label: 'Products to rank', default: 8, options: [4, 6, 8, 10, 12].map((n) => ({ value: n, label: `Top ${n}` })) },
      { name: 'photosOnly', type: 'toggle', label: 'Skip products without a photo', default: true },
    ],
  },
  {
    key: 'recommended', label: 'Recommended for You', audience: 'Visitors with browsing history', defaultEnabled: true,
    description: "Similar pieces to what each visitor viewed, saved or added to their cart (same shape, category or stone). Hidden for first-time visitors.",
    text: {
      kicker: { label: 'Small heading', default: 'Picked for You', maxLength: 60 },
      title: { label: 'Heading', default: 'Recommended for You', maxLength: 90 },
      subtitle: { label: 'Intro text', default: "Based on the pieces you've viewed, saved and added to your cart.", maxLength: 200 },
    },
    settings: [
      { name: 'rows', type: 'select', label: 'Rows of products', default: 1, options: [1, 2].map(rowsOption) },
    ],
  },
  {
    key: 'gemHighlights', label: 'Gemstone Highlights', defaultEnabled: true,
    description: 'The newest gemstones. Hidden automatically while Gemstones are switched off in Product Types.',
    text: {
      kicker: { label: 'Small heading', default: 'Rare Color', maxLength: 60 },
      title: { label: 'Heading', default: 'Gemstone Highlights', maxLength: 90 },
      ctaLabel: { label: '"See all" link text', default: 'See all gemstones', maxLength: 40 },
    },
    settings: [
      { name: 'rows', type: 'select', label: 'Rows of products', default: 1, options: [1, 2].map(rowsOption) },
      { name: 'photosOnly', type: 'toggle', label: 'Skip products without a photo', default: true },
    ],
  },
  {
    key: 'whyUs', label: 'Why Choose Us', defaultEnabled: true,
    description: 'Your key selling points. Edit the points themselves in the Why Choose Us tab.',
    text: {
      kicker: { label: 'Small heading', default: 'Why ONCD', maxLength: 60 },
      title: { label: 'Heading', default: 'Trusted by Trade, Loved by Collectors', maxLength: 90 },
    },
    settings: [],
  },
  {
    key: 'testimonials', label: 'Client Testimonials', defaultEnabled: true,
    description: 'Quotes from real clients. Stays hidden until you add at least one.',
    text: {
      kicker: { label: 'Small heading', default: 'In Their Words', maxLength: 60 },
      title: { label: 'Heading', default: 'What Our Clients Say', maxLength: 90 },
    },
    settings: [
      {
        name: 'items', type: 'items', label: 'Testimonials', itemLabel: 'testimonial', max: 9,
        fields: [
          { name: 'quote', type: 'textarea', label: 'Quote', maxLength: 400, required: true },
          { name: 'name', type: 'text', label: 'Client name', maxLength: 60, required: true },
          { name: 'role', type: 'text', label: 'Company / country (optional)', maxLength: 80 },
        ],
        default: [],
      },
    ],
  },
  {
    key: 'storyTeaser', label: 'Our Story Teaser', blockKey: 'storyTeaser', defaultEnabled: true,
    description: 'Photo and short brand story. Edit its text and photo in the Content Blocks tab.',
    text: {}, settings: [],
  },
  {
    key: 'tradeCta', label: 'Trade Account Banner', defaultEnabled: true,
    description: 'Dark call-to-action inviting businesses to register.',
    text: {
      title: { label: 'Heading', default: 'Trade Accounts Unlock Full Pricing', maxLength: 90 },
      subtitle: { label: 'Text', default: 'Register your business to view carat pricing, download certificates and send inquiries directly to our sales desk.', maxLength: 240 },
      ctaLabel: { label: 'Button text', default: 'Create a Trade Account', maxLength: 40 },
      ctaHref: { label: 'Button link', default: 'Register.dc.html', maxLength: 300 },
    },
    settings: [
      { name: 'audience', type: 'select', label: 'Show to', default: 'guests', options: [{ value: 'guests', label: 'Guests only (hide for signed-in customers)' }, { value: 'everyone', label: 'Everyone' }] },
    ],
  },
  {
    key: 'newsletter', label: 'Newsletter Signup', defaultEnabled: true,
    description: 'Email signup. New subscribers appear in Contact Messages with the subject "Newsletter subscription".',
    text: {
      kicker: { label: 'Small heading', default: 'Stay Informed', maxLength: 60 },
      title: { label: 'Heading', default: 'Join the Trade Circle', maxLength: 90 },
      subtitle: { label: 'Text', default: 'New arrivals, certified parcels and private sale notices — straight to your inbox.', maxLength: 240 },
      ctaLabel: { label: 'Button text', default: 'Subscribe', maxLength: 30 },
    },
    settings: [],
  },
];

const SECTION_BY_KEY = new Map(SECTIONS.map((d) => [d.key, d]));
const FLOW_KEYS = SECTIONS.filter((d) => !d.pinned).map((d) => d.key);
const TEXT_FIELDS = [
  ['kicker', 'kicker'], ['title', 'title'], ['subtitle', 'subtitle'], ['ctaLabel', 'cta_label'], ['ctaHref', 'cta_href'],
];

function settingDefaults(def) {
  const out = {};
  for (const s of def.settings) out[s.name] = Array.isArray(s.default) ? s.default.map((it) => ({ ...it })) : s.default;
  return out;
}

function cleanString(value, maxLength) {
  return String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, maxLength || 300);
}

// Whitelists and type-checks an admin's settings payload against the
// section's descriptors. Unknown keys are dropped; out-of-range or invalid
// values fall back to the default rather than erroring, so a stale admin
// tab can never write something the storefront can't render.
function sanitizeSettings(def, input) {
  const src = input && typeof input === 'object' ? input : {};
  const out = {};
  for (const s of def.settings) {
    const raw = src[s.name];
    if (raw === undefined) continue;
    if (s.type === 'toggle') out[s.name] = raw === true || raw === 'true' || raw === 1;
    else if (s.type === 'number') {
      const n = Math.round(Number(raw));
      out[s.name] = Number.isFinite(n) ? Math.min(s.max, Math.max(s.min, n)) : s.default;
    } else if (s.type === 'select') {
      const match = s.options.find((o) => String(o.value) === String(raw));
      out[s.name] = match ? match.value : s.default;
    } else if (s.type === 'items') {
      const list = Array.isArray(raw) ? raw : [];
      out[s.name] = list.slice(0, s.max).map((item) => {
        const clean = {};
        for (const f of s.fields) {
          if (f.type === 'select') {
            const match = f.options.find((o) => o.value === (item && item[f.name]));
            clean[f.name] = match ? match.value : f.default;
          } else {
            clean[f.name] = cleanString(item && item[f.name], f.maxLength);
          }
        }
        return clean;
      }).filter((clean) => s.fields.every((f) => !f.required || clean[f.name]));
    }
  }
  return out;
}

function sanitizeText(def, input) {
  const src = input && typeof input === 'object' ? input : {};
  const out = {};
  for (const [field] of TEXT_FIELDS) {
    if (!def.text[field] || src[field] === undefined) continue;
    out[field] = cleanString(src[field], def.text[field].maxLength);
  }
  return out;
}

// Reads every homepage_sections row. Before the one-time migration has run
// the extra columns don't exist yet (Postgres 42703 undefined_column) — fall
// back to the original four columns so the storefront keeps working on
// defaults, and report schemaReady:false so the admin can be prompted.
// A "not migrated" result is remembered for 30s so storefront requests
// don't each pay for a failed query first; admin calls pass fresh:true.
let legacyUntil = 0;
async function loadSectionRows({ fresh = false } = {}) {
  const legacy = async () => {
    const rows = await db.all('SELECT key, enabled, sort_order FROM homepage_sections');
    return { rows: new Map(rows.map((r) => [r.key, r])), schemaReady: false };
  };
  if (!fresh && Date.now() < legacyUntil) return legacy();
  try {
    const rows = await db.all(
      `SELECT key, enabled, sort_order, kicker, title, subtitle, cta_label, cta_href, settings FROM homepage_sections`
    );
    legacyUntil = 0;
    return { rows: new Map(rows.map((r) => [r.key, r])), schemaReady: true };
  } catch (err) {
    if (!err || err.code !== '42703') throw err;
    legacyUntil = Date.now() + 30 * 1000;
    return legacy();
  }
}

// The flow order only comes from the database once every flow section has
// a row (i.e. after an admin has saved an order, which writes all of them).
// Until then the registry order above is used as-is: the legacy rows'
// sort_order values were never applied to the page, so honoring them now
// would silently reshuffle what visitors are used to seeing.
function flowOrder(rows) {
  if (!FLOW_KEYS.every((k) => rows.has(k))) return FLOW_KEYS.slice();
  return FLOW_KEYS.slice().sort((a, b) => (rows.get(a).sort_order - rows.get(b).sort_order) || (FLOW_KEYS.indexOf(a) - FLOW_KEYS.indexOf(b)));
}

function mergeSection(def, row) {
  const settings = { ...settingDefaults(def), ...sanitizeSettings(def, row && row.settings) };
  const merged = {
    key: def.key,
    enabled: def.togglable === false ? true : (row ? !!row.enabled : def.defaultEnabled),
    settings,
  };
  for (const [field, column] of TEXT_FIELDS) {
    if (!def.text[field]) continue;
    const stored = row ? row[column] : null;
    merged[field] = stored === null || stored === undefined ? def.text[field].default : stored;
  }
  return merged;
}

// Every section (pinned first, then flow sections in display order), merged
// with whatever the admin has saved.
async function getMergedSections(options) {
  const { rows, schemaReady } = await loadSectionRows(options);
  const pinned = SECTIONS.filter((d) => d.pinned).map((d) => mergeSection(d, rows.get(d.key)));
  const flow = flowOrder(rows).map((key) => mergeSection(SECTION_BY_KEY.get(key), rows.get(key)));
  return { sections: [...pinned, ...flow], schemaReady, rows };
}

// Admin-facing description of each section: the merged values plus the
// field descriptors the editor form is built from.
function describeForAdmin(def, merged) {
  return {
    ...merged,
    label: def.label,
    description: def.description,
    audience: def.audience || '',
    pinned: !!def.pinned,
    togglable: def.togglable !== false,
    blockKey: def.blockKey || '',
    textFields: TEXT_FIELDS.filter(([field]) => def.text[field]).map(([field]) => ({
      name: field, label: def.text[field].label, default: def.text[field].default, maxLength: def.text[field].maxLength,
    })),
    settingsFields: def.settings,
  };
}

module.exports = {
  HOMEPAGE_MIGRATION_SQL,
  SECTIONS,
  SECTION_BY_KEY,
  FLOW_KEYS,
  TEXT_FIELDS,
  sanitizeSettings,
  sanitizeText,
  settingDefaults,
  loadSectionRows,
  flowOrder,
  mergeSection,
  getMergedSections,
  describeForAdmin,
};
