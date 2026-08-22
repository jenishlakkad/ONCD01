// Idempotent day-one seed: reconciles the previously-inconsistent mock data
// scattered across AdminProducts/AdminUsers/AdminCategories/Diamonds/Jewelry/
// Gemstones/Home/AdminHomepage/AdminSeo/AdminAudit/utils/cart.js into one
// consistent real dataset, so the site looks/behaves the same on first load.

const crypto = require('crypto');
const db = require('../db/connection');
const { hashPassword } = require('../lib/password');

function already(table) {
  return db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n > 0;
}

function randomPassword() {
  return crypto.randomBytes(9).toString('base64url');
}

const run = db.transaction(() => {
  // ---- product_types ----
  if (!already('product_types')) {
    const ins = db.prepare('INSERT INTO product_types (key, label, enabled) VALUES (?, ?, 1)');
    ins.run('diamond', 'Diamonds');
    ins.run('jewelry', 'Jewelry');
    ins.run('gemstone', 'Gemstones');
  }

  // ---- feature_flags ----
  if (!already('feature_flags')) {
    const ins = db.prepare('INSERT INTO feature_flags (key, label, description, enabled) VALUES (?, ?, ?, 1)');
    ins.run('prices', 'Prices', 'Master switch — turn OFF to hide all prices site-wide instantly, overriding the Settings page mode and any per-product overrides.');
    ins.run('videos', 'Videos', 'Allow product video uploads and playback');
    ins.run('certificates', 'Certificates', 'Show certificate numbers and verification links');
  }
  // Keep the 'prices' flag's description current even on already-seeded DBs — it's
  // static copy text nothing else ever edits, and used to read as a no-op toggle.
  db.prepare("UPDATE feature_flags SET description = 'Master switch — turn OFF to hide all prices site-wide instantly, overriding the Settings page mode and any per-product overrides.' WHERE key = 'prices'").run();

  // ---- roles + role_permissions ----
  let roleIds = {};
  if (!already('roles')) {
    const ins = db.prepare('INSERT INTO roles (name, description) VALUES (?, ?)');
    roleIds.superAdmin = ins.run('Super Admin', 'Full access to all modules').lastInsertRowid;
    roleIds.catalogManager = ins.run('Catalog Manager', 'Products, Categories').lastInsertRowid;
    roleIds.salesSupport = ins.run('Sales Support', 'User Approval, Inquiries').lastInsertRowid;
    roleIds.contentEditor = ins.run('Content Editor', 'Homepage, SEO').lastInsertRowid;

    const modules = ['dashboard', 'products', 'categories', 'producttypes', 'homepage', 'seo', 'roles', 'audit', 'settings', 'users', 'contact'];
    const perm = db.prepare('INSERT INTO role_permissions (role_id, module, access) VALUES (?, ?, ?)');
    for (const m of modules) perm.run(roleIds.superAdmin, m, 'manage');
    for (const m of modules) {
      const access = ['products', 'categories'].includes(m) ? 'manage' : m === 'dashboard' ? 'view' : 'none';
      perm.run(roleIds.catalogManager, m, access);
    }
    for (const m of modules) {
      const access = ['users', 'contact'].includes(m) ? 'manage' : m === 'dashboard' ? 'view' : 'none';
      perm.run(roleIds.salesSupport, m, access);
    }
    for (const m of modules) {
      const access = ['homepage', 'seo'].includes(m) ? 'manage' : m === 'dashboard' ? 'view' : 'none';
      perm.run(roleIds.contentEditor, m, access);
    }
  } else {
    const rows = db.prepare('SELECT id, name FROM roles').all();
    for (const r of rows) {
      if (r.name === 'Super Admin') roleIds.superAdmin = r.id;
      if (r.name === 'Catalog Manager') roleIds.catalogManager = r.id;
      if (r.name === 'Sales Support') roleIds.salesSupport = r.id;
      if (r.name === 'Content Editor') roleIds.contentEditor = r.id;
    }
  }

  // ---- admin_users ----
  if (!already('admin_users')) {
    const ins = db.prepare(
      'INSERT INTO admin_users (full_name, email, password_hash, role_id, status) VALUES (?, ?, ?, ?, ?)'
    );
    const admins = [
      ['Sofia Reyes', 'sofia@aurumandco.com', roleIds.superAdmin],
      ['Marcus Webb', 'marcus@aurumandco.com', roleIds.catalogManager],
      ['Elena Cross', 'elena@aurumandco.com', roleIds.contentEditor],
    ];
    console.log('\n=== Seeded admin accounts (one-time temporary passwords) ===');
    for (const [full_name, email, role_id] of admins) {
      const pw = randomPassword();
      ins.run(full_name, email, hashPassword(pw), role_id, 'active');
      console.log(`  ${email}  ->  ${pw}`);
    }
    console.log('Change these after first login. This message will not be shown again.\n');
  }

  // ---- categories ----
  let typeIds = {};
  for (const row of db.prepare('SELECT id, key FROM product_types').all()) typeIds[row.key] = row.id;

  if (!already('categories')) {
    const ins = db.prepare(
      'INSERT INTO categories (product_type_id, group_key, name, sort_order, enabled) VALUES (?, ?, ?, ?, 1)'
    );
    const diamondCats = ['Loose Diamonds', 'Certified Diamonds', 'Natural Diamonds', 'CVD Diamonds', 'Novelty Cut Diamonds', 'Matching Pair', 'Diamond Parcels', 'Exclusive Collection', 'New Arrivals'];
    diamondCats.forEach((name, i) => ins.run(typeIds.diamond, null, name, i));

    const jewelryCats = ['Gold Jewelry', 'Silver Jewelry', 'Natural Diamond Jewelry', 'CVD Jewelry', 'Moissanite Jewelry'];
    jewelryCats.forEach((name, i) => ins.run(typeIds.jewelry, null, name, i));

    const gemNatural = ['Ruby', 'Sapphire', 'Emerald', 'Spinel', 'Tourmaline', 'Aquamarine', 'Tanzanite', 'Opal', 'Alexandrite', 'Topaz', 'Peridot', 'Garnet', 'Morganite', 'Amethyst', 'Citrine', 'Zircon', 'Moonstone', 'Pearl', 'Coral'];
    gemNatural.forEach((name, i) => ins.run(typeIds.gemstone, 'natural', name, i));

    const gemLab = ['Lab Ruby', 'Lab Sapphire', 'Lab Emerald', 'Cubic Zirconia', 'Nano Stones'];
    gemLab.forEach((name, i) => ins.run(typeIds.gemstone, 'lab', name, i));
  }

  if (!already('subcategories')) {
    const ins = db.prepare('INSERT INTO subcategories (name, sort_order, enabled) VALUES (?, ?, 1)');
    ['Rings', 'Earrings', 'Pendants', 'Necklaces', 'Bracelets', 'Bangles', 'Chains', 'Brooches'].forEach((name, i) => ins.run(name, i));
  }

  // ---- product_attributes (Shape / Color / Certification picklists) ----
  if (!already('product_attributes')) {
    const ins = db.prepare('INSERT INTO product_attributes (attribute_type, name, sort_order, enabled) VALUES (?, ?, ?, 1)');
    const seedGroup = (type, names) => names.forEach((name, i) => ins.run(type, name, i));
    seedGroup('shape', ['Round', 'Oval', 'Emerald', 'Cushion', 'Pear', 'Hexagon', 'Princess', 'Kite', 'Marquise', 'Radiant', 'Asscher', 'Cabochon']);
    seedGroup('color', [
      'D', 'E', 'F', 'G', 'H', 'I',
      'Fancy Yellow', 'Fancy Brown', 'Fancy Light Brown', 'Fancy Dark Brown', 'Fancy Orangy Brown', 'Fancy Yellow Brown', 'Fancy Red Yellow', 'Fancy White',
      'Fancy Brown Salt and Pepper', 'White Salt and Pepper', 'Salt and Pepper', 'Black',
      'Blue', 'Red', 'Green', 'Pink', 'Blue-Green', 'Colorless',
    ]);
    seedGroup('certification', ['GIA', 'IGI', 'HRD', 'GRS']);
  }

  function categoryId(typeKey, name, groupKey = null) {
    const row = db
      .prepare('SELECT id FROM categories WHERE product_type_id = ? AND name = ? AND group_key IS ?')
      .get(typeIds[typeKey], name, groupKey);
    return row ? row.id : null;
  }
  function subcategoryId(name) {
    const row = db.prepare('SELECT id FROM subcategories WHERE name = ?').get(name);
    return row ? row.id : null;
  }

  // ---- customers ----
  if (!already('customers')) {
    const ins = db.prepare(
      `INSERT INTO customers (full_name, email, password_hash, country, company_name, status, email_verified_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`
    );
    const unusableHash = hashPassword(randomPassword());
    const customers = [
      ['Amelia Grant', 'amelia@grantvance.com', 'USA', 'Grant & Vance Jewelers', 'approved'],
      ['Marco Rossi', 'marco@rossigioielli.it', 'Italy', 'Rossi Gioielli', 'pending'],
      ['Wei Chen', 'wei.chen@jadeco.hk', 'Hong Kong', 'Jade & Co.', 'pending'],
      ['Fatima Al-Sayed', 'fatima@alsayedjewels.ae', 'UAE', 'Al-Sayed Jewels', 'approved'],
      ['Priya Nair', 'priya@nairtrading.in', 'India', 'Nair Trading Co.', 'suspended'],
      ['Tom Baker', 'tom@bakerdiamonds.com', 'UK', null, 'pending'],
    ];
    for (const [full_name, email, country, company_name, status] of customers) {
      ins.run(full_name, email, unusableHash, country, company_name, status);
    }
  }

  // ---- products ----
  if (!already('products')) {
    const ins = db.prepare(`
      INSERT INTO products (
        sku, type, category_id, subcategory_id, status,
        weight_carat, shape, color, clarity, measurements,
        certificate_authority, certificate_number, certificate_website,
        metal, gold_purity, gold_color, gold_weight_grams,
        stone_name, origin,
        price_per_carat, total_price
      ) VALUES (@sku, @type, @category_id, @subcategory_id, @status,
        @weight_carat, @shape, @color, @clarity, @measurements,
        @certificate_authority, @certificate_number, @certificate_website,
        @metal, @gold_purity, @gold_color, @gold_weight_grams,
        @stone_name, @origin,
        @price_per_carat, @total_price)
    `);
    const base = {
      category_id: null, subcategory_id: null, status: 'active',
      weight_carat: null, shape: null, color: null, clarity: null, measurements: null,
      certificate_authority: null, certificate_number: null, certificate_website: null,
      metal: null, gold_purity: null, gold_color: null, gold_weight_grams: null,
      stone_name: null, origin: null, price_per_carat: null, total_price: null,
    };
    const gia = 'https://www.gia.edu/report-check';
    const igi = 'https://www.igi.org/verify-report';

    const diamonds = [
      { sku: 'AC-D1042', category_id: categoryId('diamond', 'Certified Diamonds'), weight_carat: '1.50', shape: 'Round', color: 'D', clarity: 'VS1', measurements: '7.35×7.30×4.52mm', certificate_authority: 'GIA', certificate_number: '2201456789', certificate_website: gia, price_per_carat: 8200, total_price: 12300 },
      { sku: 'AC-D1088', category_id: categoryId('diamond', 'Loose Diamonds'), weight_carat: '2.01', shape: 'Oval', color: 'F', clarity: 'VVS2', measurements: '9.10×6.40×4.05mm', certificate_authority: 'IGI', certificate_number: '55201', certificate_website: igi, price_per_carat: 7600, total_price: 15276 },
      { sku: 'AC-D1120', category_id: categoryId('diamond', 'Exclusive Collection'), weight_carat: '3.02', shape: 'Emerald', color: 'G', clarity: 'VS2', measurements: '9.80×7.20×4.80mm', certificate_authority: 'GIA', certificate_number: '2201456790', certificate_website: gia, price_per_carat: 9100, total_price: 27482 },
      { sku: 'AC-D1155', category_id: categoryId('diamond', 'Certified Diamonds'), weight_carat: '1.02', shape: 'Cushion', color: 'E', clarity: 'VS1', measurements: '6.20×6.05×4.10mm', certificate_authority: 'GIA', certificate_number: '2201456791', certificate_website: gia, price_per_carat: 8000, total_price: 8160 },
      { sku: 'AC-D1201', category_id: categoryId('diamond', 'Certified Diamonds'), weight_carat: '0.90', shape: 'Pear', color: 'H', clarity: 'SI1', measurements: '8.90×5.60×3.40mm', certificate_authority: 'IGI', certificate_number: '55202', certificate_website: igi, price_per_carat: 5200, total_price: 4680 },
      { sku: 'AC-D1233', category_id: categoryId('diamond', 'Certified Diamonds'), weight_carat: '2.55', shape: 'Round', color: 'I', clarity: 'VVS1', measurements: '8.60×8.55×5.30mm', certificate_authority: 'GIA', certificate_number: '2201456792', certificate_website: gia, price_per_carat: 7800, total_price: 19890 },
    ].map(d => ({ ...base, ...d, type: 'diamond' }));

    const jewelry = [
      { sku: 'AC-J2201', category_id: categoryId('jewelry', 'Gold Jewelry'), subcategory_id: subcategoryId('Rings'), metal: 'Gold', gold_purity: '18k', gold_color: 'Yellow', gold_weight_grams: '4.2', weight_carat: '0.90', certificate_authority: 'IGI', certificate_number: 'JC-88213', certificate_website: igi, total_price: 4200 },
      { sku: 'AC-J2244', category_id: categoryId('jewelry', 'Natural Diamond Jewelry'), subcategory_id: subcategoryId('Bracelets'), status: 'hidden', metal: 'Gold', gold_purity: '18k', gold_color: 'White', gold_weight_grams: '9.1', weight_carat: '5.00', certificate_authority: 'GIA', certificate_number: '9911223', certificate_website: gia, total_price: 18500 },
      { sku: 'AC-J2288', category_id: categoryId('jewelry', 'Gold Jewelry'), subcategory_id: subcategoryId('Chains'), metal: 'Gold', gold_purity: '18k', gold_color: 'Yellow', gold_weight_grams: '45', total_price: 2600 },
      { sku: 'AC-J2310', category_id: categoryId('jewelry', 'CVD Jewelry'), subcategory_id: subcategoryId('Earrings'), metal: 'Gold', gold_purity: '18k', gold_color: 'White', weight_carat: '1.20', total_price: 3100 },
      { sku: 'AC-J2355', category_id: categoryId('jewelry', 'Moissanite Jewelry'), subcategory_id: subcategoryId('Bangles'), metal: 'Silver', total_price: 950 },
      { sku: 'AC-J2390', category_id: categoryId('jewelry', 'Gold Jewelry'), subcategory_id: subcategoryId('Pendants'), metal: 'Gold', gold_purity: '18k', gold_color: 'Yellow', stone_name: 'Natural Emerald', total_price: 2750 },
    ].map(j => ({ ...base, ...j, type: 'jewelry' }));

    const gemstones = [
      { sku: 'AC-G3004', category_id: categoryId('gemstone', 'Sapphire', 'natural'), stone_name: 'Ceylon Sapphire', origin: 'Natural', weight_carat: '2.10', color: 'Blue', shape: 'Oval', certificate_authority: 'GRS', certificate_number: '88213', price_per_carat: 550, total_price: 1155 },
      { sku: 'AC-G3005', category_id: categoryId('gemstone', 'Ruby', 'natural'), stone_name: 'Burma Ruby', origin: 'Natural', weight_carat: '1.40', color: 'Red', shape: 'Oval', certificate_authority: 'GRS', certificate_number: '77102', price_per_carat: 2100, total_price: 2940 },
      { sku: 'AC-G3006', category_id: categoryId('gemstone', 'Emerald', 'natural'), stone_name: 'Colombian Emerald', origin: 'Natural', weight_carat: '1.80', color: 'Green', shape: 'Emerald', certificate_authority: 'GRS', certificate_number: '65310', price_per_carat: 1400, total_price: 2520 },
      { sku: 'AC-G3007', category_id: categoryId('gemstone', 'Spinel', 'natural'), stone_name: 'Natural Spinel', origin: 'Natural', weight_carat: '1.60', color: 'Pink', shape: 'Cushion', certificate_authority: 'GRS', certificate_number: '91004', price_per_carat: 380, total_price: 608 },
      { sku: 'AC-G3008', category_id: categoryId('gemstone', 'Tourmaline', 'natural'), stone_name: 'Paraiba Tourmaline', origin: 'Natural', weight_carat: '0.95', color: 'Blue-Green', shape: 'Oval', certificate_authority: 'GRS', certificate_number: '40217', price_per_carat: 3200, total_price: 3040 },
      { sku: 'AC-G3009', category_id: categoryId('gemstone', 'Cubic Zirconia', 'lab'), stone_name: 'Cubic Zirconia', origin: 'Lab Created', weight_carat: '1.80', color: 'Colorless', shape: 'Round', price_per_carat: 45, total_price: 81 },
      { sku: 'AC-G3010', category_id: categoryId('gemstone', 'Lab Ruby', 'lab'), stone_name: 'Lab Ruby', origin: 'Lab Created', weight_carat: '1.50', color: 'Red', shape: 'Oval', certificate_authority: 'IGI', certificate_number: 'LG-2201', certificate_website: igi, price_per_carat: 220, total_price: 330 },
      { sku: 'AC-G3011', category_id: categoryId('gemstone', 'Lab Sapphire', 'lab'), stone_name: 'Lab Sapphire', origin: 'Lab Created', weight_carat: '1.70', color: 'Blue', shape: 'Oval', certificate_authority: 'IGI', certificate_number: 'LG-2202', certificate_website: igi, price_per_carat: 180, total_price: 306 },
      { sku: 'AC-G3012', category_id: categoryId('gemstone', 'Lab Emerald', 'lab'), stone_name: 'Lab Emerald', origin: 'Lab Created', weight_carat: '1.20', color: 'Green', shape: 'Emerald', certificate_authority: 'IGI', certificate_number: 'LG-2203', certificate_website: igi, price_per_carat: 160, total_price: 192 },
    ].map(g => ({ ...base, ...g, type: 'gemstone' }));

    for (const p of [...diamonds, ...jewelry, ...gemstones]) ins.run(p);
  }

  // ---- inquiries (matching AdminDashboard.dc.html's mock "Recent Inquiries") ----
  if (!already('inquiries')) {
    const customerByName = name => db.prepare('SELECT id FROM customers WHERE full_name = ?').get(name);
    const productByKu = sku => db.prepare('SELECT id FROM products WHERE sku = ?').get(sku);
    const insInq = db.prepare(`INSERT INTO inquiries (customer_id, channel, status, created_at) VALUES (?, 'email', 'replied', ?)`);
    const insItem = db.prepare(`INSERT INTO inquiry_items (inquiry_id, product_id, sku, name, qty, price_label) VALUES (?, ?, ?, ?, 1, NULL)`);
    const rows = [
      { customer: 'Amelia Grant', sku: 'AC-D1042', name: '1.50ct Round Brilliant', date: '2026-07-28' },
      { customer: 'Marco Rossi', sku: 'AC-J2201', name: '18k Halo Solitaire Ring', date: '2026-07-22' },
      { customer: 'Fatima Al-Sayed', sku: 'AC-G3004', name: 'Ceylon Sapphire, 2.1ct', date: '2026-07-15' },
      { customer: 'Wei Chen', sku: 'AC-D1120', name: '3.02ct Emerald Cut', date: '2026-06-30' },
    ];
    for (const r of rows) {
      const cust = customerByName(r.customer);
      const prod = productByKu(r.sku);
      const inqId = insInq.run(cust ? cust.id : null, `${r.date} 12:00:00`).lastInsertRowid;
      insItem.run(inqId, prod ? prod.id : null, r.sku, r.name);
    }
  }

  // ---- homepage_slides + homepage_sections ----
  if (!already('homepage_slides')) {
    const ins = db.prepare(
      'INSERT INTO homepage_slides (title, kicker, sub, cta, href, sort_order, enabled) VALUES (?, ?, ?, ?, ?, ?, 1)'
    );
    ins.run('Exceptional Diamonds, Timeless Craftsmanship', 'Est. Trade & Retail Diamond House', 'Certified natural and lab-grown diamonds, fine jewelry and rare gemstones — sourced directly, priced for trade and collectors alike.', 'Explore Collections', 'Diamonds.dc.html', 0);
    ins.run('Fine Jewelry, Crafted to Your Design', 'Bespoke Jewelry, Made to Order', 'Gold, diamond and moissanite pieces finished in-house — or built entirely to your own specification.', 'Explore Jewelry', 'Jewelry.dc.html', 1);
    ins.run('Gemstones Sourced From Every Corner', 'Rare Color, Fully Certified', 'Natural and lab-created color stones, graded and documented before they ever reach your desk.', 'Explore Gemstones', 'Gemstones.dc.html', 2);
  }
  if (!already('homepage_sections')) {
    const ins = db.prepare('INSERT INTO homepage_sections (key, label, enabled) VALUES (?, ?, 1)');
    ins.run('promoBanner', 'Promo Banner (Marketing)');
    ins.run('newArrivals', 'New Arrivals Grid');
    ins.run('spotlight', "Editor's Pick Spotlight (Marketing)");
    ins.run('favorites', 'Client Favorites Carousel');
    ins.run('gemHighlights', 'Gemstone Highlights Grid');
    ins.run('newsletter', 'Trade Circle Newsletter (Marketing)');
    ins.run('whyUs', 'Why Choose Us');
    ins.run('storyTeaser', 'Our Story Teaser');
  }

  // ---- content_blocks (Home marketing banners + About text/photo blocks) ----
  // Seeded verbatim from today's hardcoded copy in Home.dc.html / About.dc.html
  // so the live pages look identical until an admin edits something.
  if (!already('content_blocks')) {
    const ins = db.prepare(
      `INSERT INTO content_blocks (key, page, kicker, title, body, cta, href, image_url, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, datetime('now'))`
    );
    ins.run('promo', 'home', 'Limited-Time Trade Offer', 'The August Carat Edit',
      'Approved trade accounts save on loose diamond parcels this month only — certificates included.',
      'View the Offer', 'Diamonds.dc.html');
    ins.run('spotlight', 'home', "Editor's Pick", 'The Emerald Cut Revival',
      'Why the emerald cut is having a moment with collectors this season — and which stones to see first.',
      'Read the Story', 'Diamonds.dc.html');
    ins.run('storyTeaser', 'home', 'Our Story', 'Three Generations of Stone Craft',
      "Founded on a cutting-room floor and grown into a full-service diamond, jewelry and gemstone house, Aurum & Co. still answers to the same standard it opened with: every stone earns its certificate before it earns its price.",
      'Learn Our Story', 'About.dc.html');
    ins.run('hero', 'about', 'About Aurum & Co.', 'Three Decades of Stone Craft, One Family Standard',
      'Aurum & Co. began as a single cutting bench in 1994 and has grown into a full-service diamond, jewelry and gemstone house serving wholesalers, retailers and private collectors across forty countries. We still cut, grade and certify every stone under one roof — the same discipline the company opened with.',
      null, null);
    ins.run('story', 'about', 'Our Story', 'From Cutting Bench to Global Trade House',
      "What started as a two-person polishing operation is now a vertically integrated house spanning sourcing, cutting, certification and bespoke jewelry manufacture. Every expansion — from our first GIA-recognized lab partnership to our Surat production facility — was built on the same principle: transparency with the buyer, at every step of the stone's journey.",
      null, null);
    ins.run('mission', 'about', 'Mission', 'Uncompromising Transparency',
      'To deliver certified diamonds, jewelry and gemstones with complete transparency in sourcing, grading and pricing — for trade partners and private collectors alike.',
      null, null);
    ins.run('vision', 'about', 'Vision', 'The Trusted House, Worldwide',
      'To be the diamond and jewelry house that trade buyers and collectors return to first — for craftsmanship, certification and integrity, across every market we serve.',
      null, null);
  }

  // ---- homepage_collections ----
  if (!already('homepage_collections')) {
    const ins = db.prepare(
      'INSERT INTO homepage_collections (key, title, description, href, image_url, sort_order) VALUES (?, ?, ?, ?, NULL, ?)'
    );
    ins.run('diamond', 'Diamonds', 'Loose, certified and novelty-cut stones ready for setting or resale.', 'Diamonds.dc.html', 0);
    ins.run('jewelry', 'Jewelry', 'Gold, silver, diamond and moissanite pieces in rings, chains and more.', 'Jewelry.dc.html', 1);
    ins.run('gemstone', 'Gemstones', 'Natural and lab-created color stones sourced and certified worldwide.', 'Gemstones.dc.html', 2);
  }

  // ---- why_us_bullets (Home and About kept independently editable) ----
  if (!already('why_us_bullets')) {
    const ins = db.prepare(
      'INSERT INTO why_us_bullets (page, title, description, sort_order, enabled) VALUES (?, ?, ?, ?, 1)'
    );
    const bullets = [
      ['Certified Authenticity', 'Every stone ships with GIA, IGI or HRD documentation.'],
      ['Direct Factory Pricing', 'No middlemen — cut, polished and priced in-house.'],
      ['Global Trade Network', 'Serving wholesalers and retailers across 40+ countries.'],
      ['Bespoke Craftsmanship', 'Custom settings built to your specification, in-house.'],
    ];
    for (const page of ['home', 'about']) {
      bullets.forEach(([title, description], i) => ins.run(page, title, description, i));
    }
  }

  // ---- team_members ----
  if (!already('team_members')) {
    const ins = db.prepare('INSERT INTO team_members (name, role, photo_url, sort_order, enabled) VALUES (?, ?, NULL, ?, 1)');
    ins.run('Rajesh Mehta', 'Founder & Master Cutter', 0);
    ins.run('Priya Shah', 'Head of Gemology', 1);
    ins.run('Daniel Cohen', 'Director of Trade Sales', 2);
    ins.run('Aiko Tanaka', 'Head of Jewelry Design', 3);
  }

  // ---- company_timeline ----
  if (!already('company_timeline')) {
    const ins = db.prepare('INSERT INTO company_timeline (year, title, description, sort_order, enabled) VALUES (?, ?, ?, ?, 1)');
    ins.run('1994', 'The First Bench', 'A two-person cutting and polishing operation opens in Surat.', 0);
    ins.run('2003', 'First Export Contract', 'Certified loose diamonds begin shipping to European trade partners.', 1);
    ins.run('2011', 'In-House Certification Lab', 'GIA-recognized grading partnership brings certification in-house.', 2);
    ins.run('2018', 'Jewelry Manufacturing Launch', 'Full jewelry production line added alongside loose stone trade.', 3);
    ins.run('2024', 'Global Trade Platform', 'Trade and retail buyers in 40+ countries served through one house.', 4);
  }

  // ---- certifications ----
  if (!already('certifications')) {
    const ins = db.prepare('INSERT INTO certifications (name, logo_url, sort_order, enabled) VALUES (?, NULL, ?, 1)');
    ins.run('GIA', 0);
    ins.run('IGI', 1);
    ins.run('HRD', 2);
    ins.run('RJC', 3);
  }

  // about_gallery is intentionally left empty at seed time — it's a real list of
  // uploaded photos/videos (its `url` column is NOT NULL), not a single block with
  // an optional image, so there's nothing sensible to pre-fill until an admin
  // uploads the factory photos/videos through the admin panel.

  // ---- 'about' permission module backfill ----
  // Not gated by already('roles') — roles already exist on this DB and that
  // seeding block is skipped, so this runs on its own guard to backfill the
  // new module onto every existing role (there's no live permissions-editing
  // UI, so this one-time insert is the only way these rows get created).
  if (!db.prepare("SELECT 1 FROM role_permissions WHERE module = 'about' LIMIT 1").get()) {
    const perm = db.prepare('INSERT INTO role_permissions (role_id, module, access) VALUES (?, ?, ?)');
    for (const row of db.prepare('SELECT id, name FROM roles').all()) {
      const access = (row.name === 'Super Admin' || row.name === 'Content Editor') ? 'manage' : 'none';
      perm.run(row.id, 'about', access);
    }
  }

  // ---- 'contact' permission module backfill (same reasoning as 'about' above) ----
  if (!db.prepare("SELECT 1 FROM role_permissions WHERE module = 'contact' LIMIT 1").get()) {
    const perm = db.prepare('INSERT INTO role_permissions (role_id, module, access) VALUES (?, ?, ?)');
    for (const row of db.prepare('SELECT id, name FROM roles').all()) {
      const access = (row.name === 'Super Admin' || row.name === 'Sales Support') ? 'manage' : 'none';
      perm.run(row.id, 'contact', access);
    }
  }

  // ---- seo_pages ----
  if (!already('seo_pages')) {
    const ins = db.prepare('INSERT INTO seo_pages (page_key, meta_title, meta_description) VALUES (?, ?, ?)');
    ins.run('home', 'Aurum & Co. | Certified Diamonds, Jewelry & Gemstones', 'Trade and retail diamond, jewelry and gemstone house — certified sourcing, direct pricing.');
    ins.run('diamonds', 'Certified Diamonds | Aurum & Co.', 'Browse certified loose diamonds — natural and lab-grown, GIA/IGI graded.');
    ins.run('jewelry', 'Fine Jewelry | Aurum & Co.', 'Gold, silver and diamond jewelry, finished in-house or made to order.');
    ins.run('gemstones', 'Natural & Lab Gemstones | Aurum & Co.', 'Certified natural and lab-created gemstones sourced worldwide.');
  }

  // ---- site_settings ----
  if (!already('site_settings')) {
    db.prepare(
      `INSERT INTO site_settings (id, site_name, support_email, whatsapp_number, inquiry_email, line_id, skype_id, price_mode)
       VALUES (1, 'Aurum & Co.', 'sales@aurumandco.com', '+15551234567', 'sales@aurumandco.com', '@aurumandco', 'live:.cid.aurumandco', 'approved')`
    ).run();
  }

  // ---- audit_log (verbatim from utils/auditData.js) ----
  if (!already('audit_log')) {
    const ins = db.prepare('INSERT INTO audit_log (date, time, actor, action, target, module) VALUES (?, ?, ?, ?, ?, ?)');
    const AUDIT_LOG = [
      { date: '2026-08-05', time: '14:22', actor: 'Sofia Reyes', action: 'Approved user', target: 'Amelia Grant', module: 'Users' },
      { date: '2026-08-05', time: '11:03', actor: 'Sofia Reyes', action: 'Updated product', target: 'AC-D1042', module: 'Products' },
      { date: '2026-08-04', time: '09:15', actor: 'Sofia Reyes', action: 'Added category', target: 'Exclusive Collection', module: 'Categories' },
      { date: '2026-08-03', time: '17:30', actor: 'Marcus Webb', action: 'Hid product', target: 'AC-J2244', module: 'Products' },
      { date: '2026-08-03', time: '10:02', actor: 'Sofia Reyes', action: 'Suspended user', target: 'Priya Nair', module: 'Users' },
      { date: '2026-08-02', time: '13:58', actor: 'Sofia Reyes', action: 'Updated SEO meta', target: 'Diamonds', module: 'SEO' },
      { date: '2026-08-02', time: '08:40', actor: 'Marcus Webb', action: 'Toggled homepage section', target: 'Spotlight banner', module: 'Homepage' },
      { date: '2026-08-01', time: '19:12', actor: 'Elena Cross', action: 'Edited role', target: 'Catalog Manager', module: 'Roles' },
      { date: '2026-08-01', time: '12:05', actor: 'Sofia Reyes', action: 'Added product', target: 'AC-G3009', module: 'Products' },
      { date: '2026-07-30', time: '15:44', actor: 'Marcus Webb', action: 'Rejected user', target: 'Tom Baker', module: 'Users' },
      { date: '2026-07-29', time: '10:50', actor: 'Sofia Reyes', action: 'Updated price visibility', target: 'Show Prices Only to Approved Users', module: 'Settings' },
      { date: '2026-07-28', time: '09:02', actor: 'Elena Cross', action: 'Added subcategory', target: 'Brooches', module: 'Categories' },
      { date: '2026-07-25', time: '14:16', actor: 'Sofia Reyes', action: 'Updated product', target: 'AC-J2201', module: 'Products' },
      { date: '2026-07-20', time: '16:05', actor: 'Sofia Reyes', action: 'Approved user', target: 'Fatima Al-Sayed', module: 'Users' },
      { date: '2026-07-18', time: '13:22', actor: 'Elena Cross', action: 'Disabled product type', target: 'Videos feature', module: 'Product Types' },
      { date: '2026-07-15', time: '10:40', actor: 'Sofia Reyes', action: 'Updated SEO meta', target: 'Home', module: 'SEO' },
      { date: '2026-07-10', time: '17:55', actor: 'Marcus Webb', action: 'Edited slide', target: 'Hero slide 2', module: 'Homepage' },
      { date: '2026-07-05', time: '09:18', actor: 'Sofia Reyes', action: 'Added category', target: 'Lab Sapphire', module: 'Categories' },
      { date: '2026-06-27', time: '15:12', actor: 'Sofia Reyes', action: 'Suspended user', target: 'Wei Chen', module: 'Users' },
      { date: '2026-06-19', time: '11:47', actor: 'Elena Cross', action: 'Updated product', target: 'AC-D1120', module: 'Products' },
      { date: '2026-06-04', time: '08:55', actor: 'Sofia Reyes', action: 'Edited role', target: 'Sales Support', module: 'Roles' },
      { date: '2026-05-29', time: '10:20', actor: 'Sofia Reyes', action: 'Approved user', target: 'Marco Rossi', module: 'Users' },
      { date: '2026-05-14', time: '16:38', actor: 'Marcus Webb', action: 'Updated SEO meta', target: 'Gemstones', module: 'SEO' },
      { date: '2026-05-02', time: '09:41', actor: 'Elena Cross', action: 'Added product', target: 'AC-G3004', module: 'Products' },
      { date: '2026-04-21', time: '13:10', actor: 'Sofia Reyes', action: 'Toggled homepage section', target: 'Newsletter banner', module: 'Homepage' },
      { date: '2026-04-08', time: '11:02', actor: 'Marcus Webb', action: 'Added category', target: 'CVD Jewelry', module: 'Categories' },
      { date: '2026-03-16', time: '15:47', actor: 'Sofia Reyes', action: 'Updated settings', target: 'WhatsApp Number', module: 'Settings' },
      { date: '2026-01-11', time: '09:00', actor: 'Sofia Reyes', action: 'Added product', target: 'AC-D1233', module: 'Products' },
      { date: '2025-11-19', time: '14:28', actor: 'Sofia Reyes', action: 'Approved user', target: 'Grant & Vance Jewelers', module: 'Users' },
      { date: '2025-09-06', time: '12:15', actor: 'Marcus Webb', action: 'Edited role', target: 'Content Editor', module: 'Roles' },
      { date: '2025-06-30', time: '17:05', actor: 'Elena Cross', action: 'Updated product', target: 'AC-J2244', module: 'Products' },
      { date: '2025-04-14', time: '10:52', actor: 'Sofia Reyes', action: 'Added category', target: 'Moissanite Jewelry', module: 'Categories' },
      { date: '2025-02-02', time: '08:47', actor: 'Marcus Webb', action: 'Updated SEO meta', target: 'Jewelry', module: 'SEO' },
      { date: '2024-12-18', time: '16:20', actor: 'Sofia Reyes', action: 'Suspended user', target: 'Test Account', module: 'Users' },
      { date: '2024-08-27', time: '13:33', actor: 'Elena Cross', action: 'Added product', target: 'AC-D1088', module: 'Products' },
      { date: '2024-05-09', time: '09:59', actor: 'Sofia Reyes', action: 'Updated settings', target: 'Support Email', module: 'Settings' },
    ];
    for (const a of AUDIT_LOG) ins.run(a.date, a.time, a.actor, a.action, a.target, a.module);
  }
});

run();
console.log('Seed complete.');
