const path = require('path');
const express = require('express');
const session = require('express-session');
const env = require('./config/env');
const PostgresSessionStore = require('./middleware/postgresSession');
const { errorHandler } = require('./middleware/errorHandler');

const app = express();

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
app.use('/api/contact', require('./routes/contactPostgres'));
app.use('/api/admin/products', require('./routes/adminProductsPostgres'));
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

app.use('/uploads', express.static(env.uploadsDir));
app.use(express.static(env.rootDir, { extensions: ['html'] }));

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));
app.use(errorHandler);

module.exports = app;
