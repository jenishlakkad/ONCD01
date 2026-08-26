-- ONCD schema. SQLite, foreign keys enforced by connection.js (PRAGMA foreign_keys = ON).

CREATE TABLE IF NOT EXISTS roles (
  id INTEGER PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  description TEXT
);

CREATE TABLE IF NOT EXISTS role_permissions (
  role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  module  TEXT NOT NULL,
  access  TEXT NOT NULL CHECK(access IN ('none','view','manage')),
  PRIMARY KEY (role_id, module)
);

CREATE TABLE IF NOT EXISTS admin_users (
  id INTEGER PRIMARY KEY,
  full_name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role_id INTEGER NOT NULL REFERENCES roles(id),
  status TEXT NOT NULL CHECK(status IN ('active','suspended')) DEFAULT 'active',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY,
  full_name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  mobile TEXT, country TEXT, state TEXT, city TEXT,
  company_name TEXT, business_type TEXT, website TEXT, message TEXT,
  status TEXT NOT NULL CHECK(status IN ('pending','approved','rejected','suspended')) DEFAULT 'pending',
  email_verified_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS otp_tokens (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK(purpose IN ('register','reset','admin_reset')),
  code_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_otp_email_purpose ON otp_tokens(email, purpose);

CREATE TABLE IF NOT EXISTS sessions (
  sid TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  expires INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS product_types (
  id INTEGER PRIMARY KEY,
  key TEXT UNIQUE NOT NULL,
  label TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS feature_flags (
  key TEXT PRIMARY KEY,
  label TEXT,
  description TEXT,
  enabled INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY,
  product_type_id INTEGER NOT NULL REFERENCES product_types(id) ON DELETE CASCADE,
  group_key TEXT,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  UNIQUE(product_type_id, group_key, name)
);

CREATE TABLE IF NOT EXISTS subcategories (
  id INTEGER PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1
);

-- Admin-managed Shape / Color / Certification picklists shared across all
-- product types, driving both AdminProducts.dc.html's dropdowns and the
-- storefront filter pills (Diamonds/Gemstones) — see server/routes/attributes.js.
CREATE TABLE IF NOT EXISTS product_attributes (
  id INTEGER PRIMARY KEY,
  attribute_type TEXT NOT NULL CHECK(attribute_type IN ('shape','color','certification')),
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  UNIQUE(attribute_type, name COLLATE NOCASE)
);
CREATE INDEX IF NOT EXISTS idx_product_attributes_type ON product_attributes(attribute_type);

CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY,
  sku TEXT UNIQUE NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('diamond','jewelry','gemstone')),
  category_id INTEGER REFERENCES categories(id),
  subcategory_id INTEGER REFERENCES subcategories(id),
  status TEXT NOT NULL CHECK(status IN ('active','hidden')) DEFAULT 'active',
  visibility TEXT NOT NULL CHECK(visibility IN ('visible','draft')) DEFAULT 'visible',
  featured INTEGER NOT NULL DEFAULT 0,

  title TEXT,
  weight_carat TEXT, shape TEXT, color TEXT, clarity TEXT, measurements TEXT,
  certificate_authority TEXT, certificate_number TEXT, certificate_website TEXT,

  metal TEXT, gold_purity TEXT, gold_color TEXT, gold_weight_grams TEXT,

  stone_name TEXT, origin TEXT CHECK(origin IS NULL OR origin IN ('Natural','Lab Created')),

  price_per_carat REAL,
  total_price REAL,
  -- NULL = inherit the site-wide price_mode from site_settings. Non-null overrides it for this product only.
  price_visibility TEXT CHECK(price_visibility IS NULL OR price_visibility IN ('show','hide','contact','approved')),

  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_products_type_status ON products(type, status);

CREATE TABLE IF NOT EXISTS product_media (
  id INTEGER PRIMARY KEY,
  product_id INTEGER REFERENCES products(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('image','video')),
  url TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  original_name TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_media_product ON product_media(product_id);

-- Server-side mirror of a logged-in customer's cart (admin visibility only —
-- the storefront's actual source of truth stays localStorage; see utils/cart.js).
CREATE TABLE IF NOT EXISTS cart_items (
  id INTEGER PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  sku TEXT NOT NULL, name TEXT, price_label TEXT, qty INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(customer_id, sku)
);
CREATE INDEX IF NOT EXISTS idx_cart_items_customer ON cart_items(customer_id);

CREATE TABLE IF NOT EXISTS saved_items (
  id INTEGER PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  sku TEXT NOT NULL, name TEXT, price_label TEXT, product_type TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(customer_id, sku)
);
CREATE INDEX IF NOT EXISTS idx_saved_items_customer ON saved_items(customer_id);

CREATE TABLE IF NOT EXISTS inquiries (
  id INTEGER PRIMARY KEY,
  customer_id INTEGER REFERENCES customers(id),
  guest_name TEXT, guest_email TEXT,
  channel TEXT NOT NULL CHECK(channel IN ('whatsapp','email','line','skype')),
  status TEXT NOT NULL CHECK(status IN ('pending','replied','closed')) DEFAULT 'pending',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS inquiry_items (
  id INTEGER PRIMARY KEY,
  inquiry_id INTEGER NOT NULL REFERENCES inquiries(id) ON DELETE CASCADE,
  product_id INTEGER REFERENCES products(id),
  sku TEXT NOT NULL, name TEXT NOT NULL, qty INTEGER NOT NULL, price_label TEXT
);

CREATE TABLE IF NOT EXISTS homepage_slides (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL, kicker TEXT, sub TEXT, cta TEXT, href TEXT,
  image_url TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS homepage_sections (
  key TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1
);

-- Single-instance text+image blocks, reused by both Home and About.
-- Home keys: 'promo', 'spotlight', 'storyTeaser'. About keys: 'hero', 'story', 'mission', 'vision'.
CREATE TABLE IF NOT EXISTS content_blocks (
  key TEXT PRIMARY KEY,
  page TEXT NOT NULL CHECK(page IN ('home','about')),
  kicker TEXT, title TEXT, body TEXT, cta TEXT, href TEXT, image_url TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS homepage_collections (
  id INTEGER PRIMARY KEY,
  key TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL, description TEXT, href TEXT, image_url TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0
);

-- `page` keeps Home's and About's "Why Choose Us" lists independently editable.
CREATE TABLE IF NOT EXISTS why_us_bullets (
  id INTEGER PRIMARY KEY,
  page TEXT NOT NULL CHECK(page IN ('home','about')),
  title TEXT NOT NULL, description TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0, enabled INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS team_members (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL, role TEXT, photo_url TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0, enabled INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS company_timeline (
  id INTEGER PRIMARY KEY,
  year TEXT NOT NULL, title TEXT, description TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0, enabled INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS certifications (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL, logo_url TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0, enabled INTEGER NOT NULL DEFAULT 1
);

-- About page's factory photo/video grid.
CREATE TABLE IF NOT EXISTS about_gallery (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('image','video')),
  url TEXT NOT NULL, caption TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS contact_messages (
  id INTEGER PRIMARY KEY,
  customer_id INTEGER REFERENCES customers(id),
  full_name TEXT NOT NULL, email TEXT NOT NULL, phone TEXT NOT NULL,
  subject TEXT NOT NULL, message TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('new','in_progress','replied','closed')) DEFAULT 'new',
  admin_notes TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_contact_messages_status ON contact_messages(status);

CREATE TABLE IF NOT EXISTS contact_message_replies (
  id INTEGER PRIMARY KEY,
  message_id INTEGER NOT NULL REFERENCES contact_messages(id) ON DELETE CASCADE,
  admin_name TEXT NOT NULL, body TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS seo_pages (
  page_key TEXT PRIMARY KEY,
  meta_title TEXT,
  meta_description TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS site_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  site_name TEXT,
  support_email TEXT,
  whatsapp_number TEXT,
  inquiry_email TEXT,
  line_id TEXT,
  skype_id TEXT,
  price_mode TEXT NOT NULL CHECK(price_mode IN ('show','hide','contact','request','approved')) DEFAULT 'approved',
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY,
  date TEXT NOT NULL,
  time TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT NOT NULL,
  module TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_date ON audit_log(date);
