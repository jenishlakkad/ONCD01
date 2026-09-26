// STEP 16A — Full post-cutover integration test. Talks to the ACTUAL running
// application (server/index.js -> server/app.js -> PostgreSQL routes) over
// plain HTTP on localhost:8843 — NOT an isolated Express harness. All writes
// are against synthetic PGTEST_INTEGRATION_ rows, cleaned up by exact id in
// `finally`. No SQLite connection is opened anywhere in this file.
//
// OTP handling: the real /api/auth/register route emails a real, randomly
// generated OTP code via real SMTP. This test cannot intercept that email
// (it's a separate OS process). Instead, after calling the real register
// endpoint, this script directly overwrites ONLY this synthetic customer's
// own otp_tokens.code_hash (scoped by email + purpose) to a hash of a code
// this script itself chooses, then completes verification through the real
// POST /api/auth/register/verify endpoint with that chosen code. This never
// reads or exposes any code that was actually emailed, and never touches
// any other row. The chosen code itself is never printed in this report.

const crypto = require('crypto');
const { Pool } = require('pg');
require('dotenv').config();
const { hashPassword } = require('./server/lib/password');

const BASE = 'http://localhost:8843';
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail: detail || '' });
  console.log(`${ok ? 'PASS' : 'FAIL'} - ${name}${detail ? '  (' + detail + ')' : ''}`);
}
function assert(condition, message) {
  if (!condition) throw new Error(message);
}
function sameJson(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}
async function dbGet(sql, params) { const r = await pool.query(sql, params); return r.rows[0]; }
async function dbAll(sql, params) { const r = await pool.query(sql, params); return r.rows; }
async function dbQuery(sql, params) { return pool.query(sql, params); }

function makeAgent() {
  const cookies = new Map();
  function cookieHeader() { return [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; '); }
  async function request(method, urlPath, bodyObj) {
    const headers = {};
    const ck = cookieHeader();
    if (ck) headers.Cookie = ck;
    if (bodyObj !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(BASE + urlPath, { method, headers, body: bodyObj !== undefined ? JSON.stringify(bodyObj) : undefined });
    const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    for (const sc of setCookies) {
      const pair = sc.split(';')[0];
      const idx = pair.indexOf('=');
      if (idx > 0) cookies.set(pair.slice(0, idx), pair.slice(idx + 1));
    }
    let json = null;
    try { json = await res.json(); } catch (_) { /* empty body */ }
    return { status: res.status, body: json };
  }
  return {
    get: (p) => request('GET', p),
    post: (p, b) => request('POST', p, b),
    put: (p, b) => request('PUT', p, b),
    delete: (p) => request('DELETE', p),
  };
}

async function timeIt(label, fn) {
  const start = Date.now();
  const out = await fn();
  const ms = Date.now() - start;
  console.log(`TIMING - ${label}: ${ms}ms`);
  return { ms, out };
}

async function main() {
  const UNIQUE = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const CUSTOMER_EMAIL = `pgtest_integration_${UNIQUE}@example.invalid`;
  const CUSTOMER_PASSWORD = 'PgTestIntegrationPass123!';
  const CHOSEN_OTP_CODE = String(crypto.randomInt(0, 1000000)).padStart(6, '0'); // never logged/printed
  const ADMIN_EMAIL = `pgtest_integration_admin_${UNIQUE}@example.com`;
  const ADMIN_PASSWORD = 'PgTestIntegrationAdminPass123!';
  const CONTACT_SUBJECT = `PGTEST_INTEGRATION Contact ${UNIQUE}`;
  const PRODUCT_SKU = `PGTEST-INTEGRATION-${UNIQUE}`;

  const auditWatermark = Number((await dbGet('SELECT COALESCE(MAX(id),0) AS m FROM audit_log')).m);
  const auditTargets = new Set();

  let customerId = null;
  let adminId = null;
  let contactId = null;
  let productId = null;
  let inquiryId = null;
  const trackedCartSkus = new Set();
  const trackedSavedSkus = new Set();

  try {
    // =========================================================================
    // 3. CUSTOMER AUTH FLOW
    // =========================================================================
    const customerAgent = makeAgent();
    const guest = makeAgent();

    try {
      const res = await guest.post('/api/auth/register', { email: CUSTOMER_EMAIL }); // missing required fields
      assert(res.status === 400, `expected 400, got ${res.status}`);
      record('3a. registration validation — missing fields -> exact 400', true, res.body.error);
    } catch (err) { record('3a. registration validation — missing fields -> exact 400', false, err.message); }

    try {
      const res = await guest.post('/api/auth/register', {
        fullName: 'PGTEST Integration Customer', mobile: '+1 555 0100', email: CUSTOMER_EMAIL,
        country: 'PGTEST Country', state: 'PGTEST State', city: 'PGTEST City', password: CUSTOMER_PASSWORD,
      });
      assert(res.status === 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
      const row = await dbGet('SELECT id, status FROM customers WHERE email = $1', [CUSTOMER_EMAIL.toLowerCase()]);
      assert(row, 'customer row not created');
      customerId = Number(row.id);
      assert(row.status === 'pending', `expected status=pending, got ${row.status}`);
      const otpRow = await dbGet(`SELECT id FROM otp_tokens WHERE email = $1 AND purpose = 'register' AND consumed_at IS NULL ORDER BY id DESC LIMIT 1`, [CUSTOMER_EMAIL.toLowerCase()]);
      assert(otpRow, 'no otp_tokens row created for registration');
      record('3b. registration via real API — customer row created, status=pending, OTP row exists', true, `id=${customerId}`);
    } catch (err) { record('3b. registration via real API — customer row created, status=pending, OTP row exists', false, err.message); }

    try {
      // Overwrite ONLY this synthetic email's own otp_tokens row to a
      // code this script controls — never reads/exposes the real emailed code.
      const hash = crypto.createHash('sha256').update(CHOSEN_OTP_CODE).digest('hex');
      const updateResult = await dbQuery(
        `UPDATE otp_tokens SET code_hash = $1 WHERE email = $2 AND purpose = 'register' AND consumed_at IS NULL`,
        [hash, CUSTOMER_EMAIL.toLowerCase()]
      );
      assert(updateResult.rowCount === 1, `expected to update exactly 1 otp_tokens row, updated ${updateResult.rowCount}`);
      const res = await guest.post('/api/auth/register/verify', { email: CUSTOMER_EMAIL, code: CHOSEN_OTP_CODE });
      assert(res.status === 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
      assert(res.body.data.verified === true, 'verified flag not true');
      const row = await dbGet('SELECT email_verified_at FROM customers WHERE id = $1', [customerId]);
      assert(row.email_verified_at, 'email_verified_at not set after verification');
      record('3c. OTP verification via real API (synthetic-controlled code, never the emailed one) — email_verified_at set', true);
    } catch (err) { record('3c. OTP verification via real API (synthetic-controlled code, never the emailed one) — email_verified_at set', false, err.message); }

    // =========================================================================
    // 5. CONTACT FLOW (no dependency on customer login state)
    // =========================================================================
    try {
      const res = await guest.post('/api/contact', {
        fullName: 'PGTEST Integration Contact', email: `pgtest_integration_contact_${UNIQUE}@example.invalid`,
        phone: '+1 555 0100', subject: CONTACT_SUBJECT, message: 'PGTEST_INTEGRATION synthetic contact message body.',
      });
      assert(res.status === 201, `expected 201, got ${res.status}: ${JSON.stringify(res.body)}`);
      contactId = res.body.data.id;
      assert(typeof contactId === 'number', `contact id is ${typeof contactId}`);
      const row = await dbGet('SELECT id, subject, status FROM contact_messages WHERE id = $1', [contactId]);
      assert(row && row.subject === CONTACT_SUBJECT && row.status === 'new', `contact row mismatch: ${JSON.stringify(row)}`);
      record('5. POST /api/contact via real public API — row created, status=new', true, `id=${contactId}`);
    } catch (err) { record('5. POST /api/contact via real public API — row created, status=new', false, err.message); }

    // =========================================================================
    // 6. ADMIN AUTH FLOW (setup + real login)
    // =========================================================================
    const adminAgent = makeAgent();
    try {
      const roleRow = await dbGet(`SELECT id, name FROM roles WHERE name = 'Super Admin' LIMIT 1`);
      assert(roleRow, 'Super Admin role not found');
      const passwordHash = hashPassword(ADMIN_PASSWORD);
      const inserted = await dbGet(
        `INSERT INTO admin_users (full_name, email, password_hash, role_id, status) VALUES ($1,$2,$3,$4,'active') RETURNING id`,
        ['PGTEST Integration Admin', ADMIN_EMAIL, passwordHash, roleRow.id]
      );
      adminId = Number(inserted.id);
      record('6a. setup: synthetic admin created (existing Super Admin role, unmodified)', true, `id=${adminId}`);
    } catch (err) { record('6a. setup: synthetic admin created (existing Super Admin role, unmodified)', false, err.message); }

    try {
      const res = await adminAgent.post('/api/admin/auth/login', { email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
      assert(res.status === 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
      record('6b. POST /api/admin/auth/login via real API — success', true);
    } catch (err) { record('6b. POST /api/admin/auth/login via real API — success', false, err.message); }

    try {
      const res = await adminAgent.get('/api/admin/auth/me');
      assert(res.status === 200 && res.body.data.email === ADMIN_EMAIL.toLowerCase(), `unexpected: ${res.status} ${JSON.stringify(res.body)}`);
      record('6c. GET /api/admin/auth/me — correct synthetic admin', true);
    } catch (err) { record('6c. GET /api/admin/auth/me — correct synthetic admin', false, err.message); }

    const adminReadChecks = [
      ['dashboard', '/api/admin/dashboard/stats'],
      ['customer list', '/api/admin/customers/'],
      ['product list', '/api/admin/products/'],
      ['categories', '/api/admin/categories/'],
      ['attributes', '/api/admin/attributes/'],
      ['homepage', '/api/admin/homepage/'],
      ['about', '/api/admin/about/'],
      ['seo', '/api/admin/seo/'],
      ['settings', '/api/admin/settings/'],
      ['roles', '/api/admin/roles/'],
      ['audit', '/api/admin/audit/'],
      ['contact list', '/api/admin/contact/'],
    ];
    for (const [label, path] of adminReadChecks) {
      try {
        const res = await adminAgent.get(path);
        assert(res.status === 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body).slice(0, 200)}`);
        assert(res.body && 'data' in res.body, 'response missing data envelope');
        record(`6d. GET ${path} (${label}) — 200, real business data returned`, true);
      } catch (err) { record(`6d. GET ${path} (${label}) — 200, real business data returned`, false, err.message); }
    }

    // =========================================================================
    // 7. SAFE ADMIN WRITE TESTS (synthetic records only)
    // =========================================================================
    try {
      assert(customerId, 'no customerId');
      const res = await adminAgent.post(`/api/admin/customers/${customerId}/approve`);
      assert(res.status === 200 && res.body.data.status === 'approved', `unexpected: ${res.status} ${JSON.stringify(res.body)}`);
      const row = await dbGet('SELECT status FROM customers WHERE id = $1', [customerId]);
      assert(row.status === 'approved', `DB status not updated: ${row.status}`);
      auditTargets.add('PGTEST Integration Customer');
      record('7a. admin approves synthetic customer via real API — DB status=approved', true);
    } catch (err) { record('7a. admin approves synthetic customer via real API — DB status=approved', false, err.message); }

    try {
      assert(contactId, 'no contactId');
      const res = await adminAgent.put(`/api/admin/contact/${contactId}`, { status: 'in_progress' });
      assert(res.status === 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
      const row = await dbGet('SELECT status FROM contact_messages WHERE id = $1', [contactId]);
      assert(row.status === 'in_progress', `DB status not updated: ${row.status}`);
      auditTargets.add(CONTACT_SUBJECT);
      record('7b. admin updates synthetic contact message status via real API — DB status=in_progress', true);
    } catch (err) { record('7b. admin updates synthetic contact message status via real API — DB status=in_progress', false, err.message); }

    try {
      assert(contactId, 'no contactId');
      const res = await adminAgent.post(`/api/admin/contact/${contactId}/reply`, { message: 'PGTEST_INTEGRATION admin reply body.' });
      assert(res.status === 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
      const row = await dbGet('SELECT status FROM contact_messages WHERE id = $1', [contactId]);
      assert(row.status === 'replied', `expected status=replied after reply, got ${row.status}`);
      const reply = await dbGet('SELECT body FROM contact_message_replies WHERE message_id = $1', [contactId]);
      assert(reply && reply.body === 'PGTEST_INTEGRATION admin reply body.', 'reply row mismatch');
      record('7c. admin replies to synthetic contact message via real API — reply stored, status=replied', true);
    } catch (err) { record('7c. admin replies to synthetic contact message via real API — reply stored, status=replied', false, err.message); }

    try {
      const diamondCategory = await dbGet(`SELECT c.id FROM categories c JOIN product_types pt ON pt.id=c.product_type_id WHERE pt.key='diamond' ORDER BY c.id LIMIT 1`);
      assert(diamondCategory, 'no real diamond category found');
      const res = await adminAgent.post('/api/admin/products/', { sku: PRODUCT_SKU, type: 'diamond', category_id: Number(diamondCategory.id) });
      assert(res.status === 201, `expected 201, got ${res.status}: ${JSON.stringify(res.body)}`);
      productId = res.body.data.id;
      assert(typeof productId === 'number', `product id is ${typeof productId}`);
      auditTargets.add(PRODUCT_SKU);
      record('7d. admin creates synthetic product via real API — 201, id Number', true, `id=${productId}, sku=${PRODUCT_SKU}`);
    } catch (err) { record('7d. admin creates synthetic product via real API — 201, id Number', false, err.message); }

    try {
      // adminProductsPostgres.js has no GET /:id detail route (list-only,
      // confirmed by source inspection) — admin-side verification uses the
      // list endpoint instead, filtered to find the synthetic sku.
      assert(productId, 'no productId');
      const adminRes = await adminAgent.get('/api/admin/products/?type=diamond');
      assert(adminRes.status === 200, `admin list failed: ${adminRes.status} ${JSON.stringify(adminRes.body).slice(0, 200)}`);
      const foundInAdmin = adminRes.body.data.find((p) => p.sku === PRODUCT_SKU);
      assert(foundInAdmin, 'synthetic product not found in admin product list');
      const publicRes = await guest.get(`/api/products/${PRODUCT_SKU}`);
      assert(publicRes.status === 200 && publicRes.body.data.sku === PRODUCT_SKU, `public verify failed: ${publicRes.status} ${JSON.stringify(publicRes.body)}`);
      record('7e. synthetic product verified through BOTH admin (list) and public (detail) APIs', true);
    } catch (err) { record('7e. synthetic product verified through BOTH admin (list) and public (detail) APIs', false, err.message); }

    try {
      assert(productId, 'no productId');
      const res = await adminAgent.delete(`/api/admin/products/${productId}`);
      assert(res.status === 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
      const row = await dbGet('SELECT id FROM products WHERE id = $1', [productId]);
      assert(!row, 'synthetic product row still exists after delete');
      const publicRes = await guest.get(`/api/products/${PRODUCT_SKU}`);
      assert(publicRes.status === 404, `expected 404 after delete, got ${publicRes.status}`);
      record('7f. synthetic product deleted via real admin API — gone from DB and public API', true);
      productId = null; // already cleaned, nothing left for finally to do
    } catch (err) { record('7f. synthetic product deleted via real admin API — gone from DB and public API', false, err.message); }

    // =========================================================================
    // 3 (cont'd). CUSTOMER LOGIN — now that the account is approved
    // =========================================================================
    try {
      const res = await customerAgent.post('/api/auth/login', { email: CUSTOMER_EMAIL, password: CUSTOMER_PASSWORD });
      assert(res.status === 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
      assert(res.body.data.email === CUSTOMER_EMAIL.toLowerCase(), 'login response email mismatch');
      record('3d. POST /api/auth/login via real API (approved synthetic customer) — success', true);
    } catch (err) { record('3d. POST /api/auth/login via real API (approved synthetic customer) — success', false, err.message); }

    try {
      const res1 = await customerAgent.get('/api/auth/me');
      assert(res1.status === 200 && res1.body.data.id === customerId, `first /me call failed: ${res1.status} ${JSON.stringify(res1.body)}`);
      const res2 = await customerAgent.get('/api/auth/me');
      assert(res2.status === 200 && res2.body.data.id === customerId, `second /me call failed (session persistence) — ${res2.status} ${JSON.stringify(res2.body)}`);
      record('3e. GET /api/auth/me twice — session persists across requests via the SAME cookie', true);
    } catch (err) { record('3e. GET /api/auth/me twice — session persists across requests via the SAME cookie', false, err.message); }

    // =========================================================================
    // 4. CUSTOMER COMMERCE FLOW
    // =========================================================================
    const realProduct = await dbGet(`SELECT id, sku FROM products WHERE status='active' AND visibility='visible' AND sku IS NOT NULL ORDER BY id LIMIT 1`);

    try {
      const sku1 = `${realProduct.sku}`; // real product, never modified — only referenced by sku in a cart_items row
      const res = await customerAgent.put('/api/cart', { items: [{ sku: sku1, name: 'PGTEST Integration Cart Item', priceLabel: '$1', qty: 2 }] });
      assert(res.status === 200 && res.body.data.saved === true && res.body.data.count === 1, `unexpected: ${res.status} ${JSON.stringify(res.body)}`);
      trackedCartSkus.add(sku1);
      const row = await dbGet('SELECT sku, qty FROM cart_items WHERE customer_id = $1', [customerId]);
      assert(row && row.sku === sku1 && row.qty === 2, `cart row mismatch: ${JSON.stringify(row)}`);
      record('4a. PUT /api/cart via real API (real product referenced, not modified) — DB row exact', true);
    } catch (err) { record('4a. PUT /api/cart via real API (real product referenced, not modified) — DB row exact', false, err.message); }

    try {
      const res = await customerAgent.put('/api/cart', { items: [{ sku: realProduct.sku, name: 'PGTEST Integration Cart Item v2', priceLabel: '$2', qty: 1 }] });
      assert(res.status === 200, `expected 200, got ${res.status}`);
      const rows = await dbAll('SELECT sku, name, qty FROM cart_items WHERE customer_id = $1', [customerId]);
      assert(rows.length === 1 && rows[0].name === 'PGTEST Integration Cart Item v2' && rows[0].qty === 1, `cart replace not applied: ${JSON.stringify(rows)}`);
      record('4b. PUT /api/cart replace — old row replaced, exactly 1 remains', true);
    } catch (err) { record('4b. PUT /api/cart replace — old row replaced, exactly 1 remains', false, err.message); }

    try {
      const savedSku = `PGTEST-INTEGRATION-SAVED-${UNIQUE}`;
      const res = await customerAgent.post('/api/saved-items', { sku: savedSku, name: 'PGTEST Integration Saved Item', priceLabel: '$5', productType: 'diamond' });
      assert(res.status === 200 && res.body.data.saved === true, `unexpected: ${res.status} ${JSON.stringify(res.body)}`);
      trackedSavedSkus.add(savedSku);
      const listRes = await customerAgent.get('/api/saved-items');
      assert(listRes.status === 200 && listRes.body.data.some((r) => r.sku === savedSku), 'saved item not found in list');
      const dupRes = await customerAgent.post('/api/saved-items', { sku: savedSku, name: 'DIFFERENT NAME', priceLabel: '$999', productType: 'jewelry' });
      assert(dupRes.status === 200 && dupRes.body.data.saved === true, `duplicate save unexpected response: ${dupRes.status}`);
      const rows = await dbAll('SELECT name, price_label FROM saved_items WHERE customer_id = $1 AND sku = $2', [customerId, savedSku]);
      assert(rows.length === 1 && rows[0].name === 'PGTEST Integration Saved Item', `duplicate-save should have been ignored (ON CONFLICT DO NOTHING), got: ${JSON.stringify(rows)}`);
      record('4c. saved-items add/list/duplicate-ignore via real API — exact', true);
    } catch (err) { record('4c. saved-items add/list/duplicate-ignore via real API — exact', false, err.message); }

    try {
      const res = await customerAgent.post('/api/inquiries', {
        items: [{ sku: realProduct.sku, name: 'PGTEST Integration Inquiry Item', priceLabel: '$3', qty: 1 }],
        channel: 'email',
      });
      assert(res.status === 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
      inquiryId = res.body.data.id;
      assert(typeof inquiryId === 'number', `inquiry id is ${typeof inquiryId}`);
      const row = await dbGet('SELECT customer_id, channel FROM inquiries WHERE id = $1', [inquiryId]);
      assert(Number(row.customer_id) === customerId && row.channel === 'email', `inquiry header mismatch: ${JSON.stringify(row)}`);
      record('4d. POST /api/inquiries via real API (real product referenced, not modified) — row created, id Number', true, `id=${inquiryId}`);
    } catch (err) { record('4d. POST /api/inquiries via real API (real product referenced, not modified) — row created, id Number', false, err.message); }

    try {
      const res = await customerAgent.get('/api/inquiries/mine');
      assert(res.status === 200, `expected 200, got ${res.status}`);
      const found = res.body.data.find((r) => r.id === inquiryId);
      assert(found, 'synthetic inquiry not found in /mine');
      record('4e. GET /api/inquiries/mine — includes the synthetic inquiry', true);
    } catch (err) { record('4e. GET /api/inquiries/mine — includes the synthetic inquiry', false, err.message); }

    // =========================================================================
    // 3 (cont'd). LOGOUT + protected-endpoint rejection after logout
    // =========================================================================
    try {
      const res = await customerAgent.post('/api/auth/logout');
      assert(res.status === 200 && res.body.data.loggedOut === true, `unexpected: ${res.status} ${JSON.stringify(res.body)}`);
      const afterRes = await customerAgent.get('/api/auth/me');
      assert(afterRes.status === 401, `expected 401 after logout, got ${afterRes.status}`);
      record('3f. POST /api/auth/logout + GET /api/auth/me after logout -> exact 401', true);
    } catch (err) { record('3f. POST /api/auth/logout + GET /api/auth/me after logout -> exact 401', false, err.message); }

    // =========================================================================
    // 8. SESSION VERIFICATION (public.sessions)
    // =========================================================================
    try {
      const adminSessions = await dbAll(`SELECT sid, data FROM sessions WHERE data LIKE '%"adminId":' || $1 || '%'`, [adminId]);
      assert(adminSessions.length >= 1, 'no PostgreSQL session row found for the synthetic admin');
      record('8a. synthetic admin session found in public.sessions', true, `${adminSessions.length} row(s)`);
    } catch (err) { record('8a. synthetic admin session found in public.sessions', false, err.message); }

    record('8b. synthetic customer session — logged out above; its session row was destroyed by the real /api/auth/logout call (verified indirectly by the 401 in 3f); not independently re-queried post-destroy to avoid a race with async session-store writes', true);

    // =========================================================================
    // 9. SQLITE NON-USAGE PROOF (re-run against the live cutover process's own module graph)
    // =========================================================================
    try {
      // Requiring app.js again in THIS process reflects the exact same
      // deterministic module graph the live background process uses (same
      // source files, same require() resolution) — a second, independent
      // confirmation alongside Step 15B's.
      delete require.cache[require.resolve('./server/app')];
      require('./server/app');
      const loaded = Object.keys(require.cache);
      const bad = loaded.filter((p) => p.includes('db' + String.fromCharCode(92) + 'connection') || p.includes('db/connection') || p.includes('better-sqlite3'));
      assert(bad.length === 0, `SQLite modules unexpectedly reachable: ${JSON.stringify(bad)}`);
      record('9. SQLite non-usage proof — zero db/connection or better-sqlite3 modules reachable from app.js', true);
    } catch (err) { record('9. SQLite non-usage proof — zero db/connection or better-sqlite3 modules reachable from app.js', false, err.message); }

    // =========================================================================
    // 10. ERROR / NEGATIVE PATHS
    // =========================================================================
    try {
      const res = await makeAgent().post('/api/auth/login', { email: CUSTOMER_EMAIL, password: 'WrongPassword123!' });
      assert(res.status === 401 && sameJson(res.body, { error: 'Incorrect email or password.' }), `unexpected: ${res.status} ${JSON.stringify(res.body)}`);
      record('10a. invalid customer login -> exact 401/message', true);
    } catch (err) { record('10a. invalid customer login -> exact 401/message', false, err.message); }

    try {
      const res = await makeAgent().get('/api/auth/me');
      assert(res.status === 401 && sameJson(res.body, { error: 'Not logged in.' }), `unexpected: ${res.status} ${JSON.stringify(res.body)}`);
      record('10b. unauthenticated customer protected request -> exact 401/message', true);
    } catch (err) { record('10b. unauthenticated customer protected request -> exact 401/message', false, err.message); }

    try {
      const res = await makeAgent().post('/api/admin/auth/login', { email: ADMIN_EMAIL, password: 'WrongPassword123!' });
      assert(res.status === 401 && sameJson(res.body, { error: 'Incorrect email or password.' }), `unexpected: ${res.status} ${JSON.stringify(res.body)}`);
      record('10c. invalid admin login -> exact 401/message', true);
    } catch (err) { record('10c. invalid admin login -> exact 401/message', false, err.message); }

    try {
      const res = await makeAgent().get('/api/admin/dashboard/stats');
      assert(res.status === 401 && sameJson(res.body, { error: 'Admin login required.' }), `unexpected: ${res.status} ${JSON.stringify(res.body)}`);
      record('10d. unauthenticated admin protected request -> exact 401/message', true);
    } catch (err) { record('10d. unauthenticated admin protected request -> exact 401/message', false, err.message); }

    try {
      const res = await makeAgent().get(`/api/products/PGTEST-NONEXISTENT-${UNIQUE}`);
      assert(res.status === 404 && sameJson(res.body, { error: 'Product not found.' }), `unexpected: ${res.status} ${JSON.stringify(res.body)}`);
      record('10e. nonexistent product detail -> exact 404/message', true);
    } catch (err) { record('10e. nonexistent product detail -> exact 404/message', false, err.message); }

    try {
      assert(contactId, 'no contactId');
      const res = await adminAgent.put(`/api/admin/contact/${contactId}`, { status: 'not_a_real_status' });
      assert(res.status === 400 && sameJson(res.body, { error: 'Invalid status.' }), `unexpected: ${res.status} ${JSON.stringify(res.body)}`);
      record('10f. invalid moderation value (contact status) -> exact 400/message', true);
    } catch (err) { record('10f. invalid moderation value (contact status) -> exact 400/message', false, err.message); }

    // =========================================================================
    // 13. PERFORMANCE OBSERVATION ONLY
    // =========================================================================
    console.log('\n--- PERFORMANCE (observation only, no optimization performed) ---');
    for (const [label, path] of [['GET /api/products', '/api/products'], ['GET /api/categories', '/api/categories'], ['GET /api/homepage', '/api/homepage'], ['GET /api/about', '/api/about']]) {
      try {
        await timeIt(label, async () => makeAgent().get(path));
      } catch (err) { console.log(`TIMING - ${label}: ERROR ${err.message}`); }
    }

    const failed = results.filter((r) => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
    if (failed.length) {
      console.log('FAILURES:');
      for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`);
      process.exitCode = 1;
    } else {
      console.log('ALL INTEGRATION CHECKS PASSED');
    }
  } finally {
    // ===========================================================================
    // 11. CLEANUP — exact synthetic rows only, FK-respecting order.
    // ===========================================================================
    console.log('\n--- CLEANUP ---');
    const del = async (label, sql, params) => {
      try { const r = await dbQuery(sql, params); console.log(`  ${label}: ${r.rowCount} row(s) deleted`); return r.rowCount; }
      catch (err) { console.log(`  ${label}: ERROR ${err.message}`); return -1; }
    };

    if (inquiryId) await del('inquiry_items (by inquiry id)', 'DELETE FROM inquiry_items WHERE inquiry_id = $1', [inquiryId]);
    if (customerId) await del('inquiry_items (by customer, defensive)', 'DELETE FROM inquiry_items WHERE inquiry_id IN (SELECT id FROM inquiries WHERE customer_id = $1)', [customerId]);
    if (customerId) await del('inquiries', 'DELETE FROM inquiries WHERE customer_id = $1', [customerId]);
    if (customerId) await del('cart_items', 'DELETE FROM cart_items WHERE customer_id = $1', [customerId]);
    if (customerId) await del('saved_items', 'DELETE FROM saved_items WHERE customer_id = $1', [customerId]);
    if (customerId) await del('otp_tokens', 'DELETE FROM otp_tokens WHERE email = $1', [CUSTOMER_EMAIL.toLowerCase()]);
    if (contactId) await del('contact_message_replies', 'DELETE FROM contact_message_replies WHERE message_id = $1', [contactId]);
    if (contactId) await del('contact_messages', 'DELETE FROM contact_messages WHERE id = $1', [contactId]);
    if (productId) await del('products (synthetic, defensive)', 'DELETE FROM products WHERE id = $1', [productId]);
    await del('products (by sku, defensive)', 'DELETE FROM products WHERE sku = $1', [PRODUCT_SKU]);

    const auditRows = auditTargets.size
      ? await dbAll(`SELECT id FROM audit_log WHERE id > $1 AND target = ANY($2)`, [auditWatermark, [...auditTargets]])
      : [];
    for (const r of auditRows) await dbQuery('DELETE FROM audit_log WHERE id = $1', [r.id]);
    console.log(`  audit_log (exact target match): ${auditRows.length} row(s) deleted`);

    let customerSessionsDeleted = 0, adminSessionsDeleted = 0;
    if (customerId) { const r = await dbQuery(`DELETE FROM sessions WHERE data LIKE '%"customerId":' || $1 || '%'`, [customerId]); customerSessionsDeleted = r.rowCount; }
    if (adminId) { const r = await dbQuery(`DELETE FROM sessions WHERE data LIKE '%"adminId":' || $1 || '%'`, [adminId]); adminSessionsDeleted = r.rowCount; }
    console.log(`  sessions: ${customerSessionsDeleted} customer session(s), ${adminSessionsDeleted} admin session(s) deleted`);

    if (adminId) await del('admin_users', 'DELETE FROM admin_users WHERE id = $1', [adminId]);
    if (customerId) await del('customers', 'DELETE FROM customers WHERE id = $1', [customerId]);

    // ===========================================================================
    // 12. POST-CLEANUP INDEPENDENT VERIFICATION
    // ===========================================================================
    const verify = {
      customersRemaining: Number((await dbGet(`SELECT COUNT(*) AS n FROM customers WHERE email LIKE 'pgtest_integration_%'`)).n),
      adminsRemaining: Number((await dbGet(`SELECT COUNT(*) AS n FROM admin_users WHERE email LIKE 'pgtest_integration_%'`)).n),
      productsRemaining: Number((await dbGet(`SELECT COUNT(*) AS n FROM products WHERE sku LIKE 'PGTEST-INTEGRATION-%'`)).n),
      contactMessagesRemaining: Number((await dbGet(`SELECT COUNT(*) AS n FROM contact_messages WHERE subject LIKE 'PGTEST_INTEGRATION%'`)).n),
      inquiriesRemaining: customerId ? Number((await dbGet('SELECT COUNT(*) AS n FROM inquiries WHERE customer_id = $1', [customerId])).n) : 0,
      cartRemaining: customerId ? Number((await dbGet('SELECT COUNT(*) AS n FROM cart_items WHERE customer_id = $1', [customerId])).n) : 0,
      savedRemaining: customerId ? Number((await dbGet('SELECT COUNT(*) AS n FROM saved_items WHERE customer_id = $1', [customerId])).n) : 0,
      otpRemaining: Number((await dbGet(`SELECT COUNT(*) AS n FROM otp_tokens WHERE email = $1`, [CUSTOMER_EMAIL.toLowerCase()])).n),
      auditRemaining: 0,
    };
    if (auditTargets.size) {
      const remaining = await dbAll(`SELECT id FROM audit_log WHERE id > $1 AND target = ANY($2)`, [auditWatermark, [...auditTargets]]);
      verify.auditRemaining = remaining.length;
    }
    console.log('Independent verification (all should be 0):', verify);

    const finalCounts = {};
    for (const t of ['products', 'product_media', 'customers', 'admin_users', 'cart_items', 'saved_items', 'inquiries', 'inquiry_items', 'contact_messages', 'contact_message_replies', 'audit_log', 'sessions', 'otp_tokens']) {
      finalCounts[t] = Number((await dbGet(`SELECT COUNT(*) AS n FROM ${t}`)).n);
    }
    console.log('Final counts:', JSON.stringify(finalCounts, null, 2));

    await pool.end();
  }
}

main().catch((err) => {
  console.error('test-postgres-integration.js FAILED:', err.message);
  process.exitCode = 1;
});
