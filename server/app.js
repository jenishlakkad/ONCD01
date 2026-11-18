const path = require('path');
const express = require('express');
const session = require('express-session');
const env = require('./config/env');
const PostgresSessionStore = require('./middleware/postgresSession');
const { errorHandler } = require('./middleware/errorHandler');

const app = express();

// Behind a hosting proxy (Render sets RENDER; TRUST_PROXY=1 for any other
// host): use the visitor's real IP (per-visitor rate limits) and the real
// protocol (secure cookies, correct https:// links in emails).
const behindProxy = !!(process.env.RENDER || process.env.TRUST_PROXY || env.nodeEnv === 'production');
if (behindProxy) app.set('trust proxy', 1);

app.use(express.json({ limit: '2mb' }));
app.use(
  session({
    store: new PostgresSessionStore(),
    secret: env.sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      maxAge: 7 * 24 * 60 * 60 * 1000,
      sameSite: 'lax',
      // HTTPS-only on the live site; plain http keeps working locally.
      secure: behindProxy ? 'auto' : false,
    },
  })
);

app.use('/api/auth', require('./routes/authPostgres'));
app.use('/api/admin/auth', require('./routes/adminAuthPostgres'));
app.use('/api/products', require('./routes/productsPostgres'));
app.use('/api/categories', require('./routes/categoriesPostgres'));
app.use('/api/attributes', require('./routes/attributesPostgres'));
app.use('/api', require('./routes/productTypesPostgres'));
app.use('/api/homepage', require('./routes/homepagePostgres'));
app.use('/api/about', require('./routes/aboutPostgres'));
app.use('/api/seo', require('./routes/seoPostgres'));
app.use('/api/settings', require('./routes/settingsPostgres'));
app.use('/api/inquiries', require('./routes/inquiriesPostgres'));
app.use('/api/cart', require('./routes/cartPostgres'));
app.use('/api/saved-items', require('./routes/savedItemsPostgres'));
app.use('/api/account', require('./routes/accountPostgres'));
app.use('/api/contact', require('./routes/contactPostgres'));
app.use('/api/admin/products', require('./routes/adminProductsPostgres'));
app.use('/api/admin/offers', require('./routes/adminOffersPostgres'));
app.use('/api/admin/categories', require('./routes/adminCategoriesPostgres'));
app.use('/api/admin/attributes', require('./routes/adminAttributesPostgres'));
app.use('/api/admin', require('./routes/adminProductTypesPostgres'));
app.use('/api/admin/customers', require('./routes/adminUsersPostgres'));
app.use('/api/admin/homepage', require('./routes/adminHomepagePostgres'));
app.use('/api/admin/about', require('./routes/adminAboutPostgres'));
app.use('/api/admin/seo', require('./routes/adminSeoPostgres'));
app.use('/api/admin/settings', require('./routes/adminSettingsPostgres'));
app.use('/api/admin/roles', require('./routes/adminRolesPostgres'));
app.use('/api/admin/audit', require('./routes/adminAuditPostgres'));
app.use('/api/admin/dashboard', require('./routes/adminDashboardPostgres'));
app.use('/api/admin/contact', require('./routes/adminContactPostgres'));
app.use('/api/admin/inquiries', require('./routes/adminInquiriesPostgres'));

// The page templates are plain HTML, so the browser sees <img src="{{ x }}">
// before the page code fills in the real address and requests that literal
// text. Answer those with an empty 204 instead of a 404 error.
app.get(/%7B%7B|\{\{/, (req, res) => res.set('Cache-Control', 'public, max-age=86400').status(204).end());

app.use('/uploads', express.static(env.uploadsDir));
// Every upload is stored in R2. A file that isn't on this server's disk —
// Render's disk is wiped on each deploy, hover previews only ever live in
// R2, old links in emails or saved carts — is served from R2 instead.
app.get('/uploads/*', (req, res, next) => {
  const key = decodeURIComponent(req.path.replace(/^\/uploads\//, ''));
  if (!key || key.includes('..')) return next();
  try {
    const url = require('./services/r2Storage').getPublicUrl(key);
    res.set('Cache-Control', 'public, max-age=86400');
    return res.redirect(302, url);
  } catch (_) {
    return next();
  }
});
// Only the website's own public files are served from the project folder.
// That folder also holds the server code, logs, .git and old data files —
// none of which may ever be downloadable — so instead of serving everything
// in it, anything not on this list is a 404.
const PUBLIC_FILE = new RegExp([
  '^/[A-Za-z0-9_-]+\\.dc\\.html$',
  '^/(index|404)\\.html$',
  '^/(robots\\.txt|favicon\\.svg|favicon-32\\.png|apple-touch-icon\\.png)$',
  '^/(support|product-media|video-frame)\\.js$',
  '^/utils/[A-Za-z0-9_-]+\\.js$',
  '^/_ds/[A-Za-z0-9_./-]+\\.(css|woff2?|ttf|otf|svg|png|jpe?g|webp|gif)$',
].join('|'));
app.get('/', (req, res) => res.redirect(302, '/Home.dc.html'));
app.get('/favicon.ico', (req, res) => res.redirect(301, '/favicon-32.png'));
const servePublic = express.static(env.rootDir, { dotfiles: 'deny', index: false });
app.use((req, res, next) => {
  if ((req.method === 'GET' || req.method === 'HEAD') && PUBLIC_FILE.test(req.path) && !req.path.includes('..')) {
    return servePublic(req, res, next);
  }
  return next();
});

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));
// Any other address: the friendly "page not found" page.
app.use((req, res) => res.status(404).sendFile(require('path').join(env.rootDir, '404.html')));
app.use(errorHandler);

module.exports = app;
