const path = require('path');
const express = require('express');
const session = require('express-session');
const env = require('./config/env');
const SqliteSessionStore = require('./middleware/session');
const { errorHandler } = require('./middleware/errorHandler');

const app = express();

app.use(express.json({ limit: '2mb' }));
app.use(
  session({
    store: new SqliteSessionStore(),
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

app.use('/api/auth', require('./routes/auth'));
app.use('/api/admin/auth', require('./routes/adminAuth'));
app.use('/api/products', require('./routes/products'));
app.use('/api/categories', require('./routes/categories'));
app.use('/api/attributes', require('./routes/attributes'));
app.use('/api', require('./routes/productTypes'));
app.use('/api/homepage', require('./routes/homepage'));
app.use('/api/about', require('./routes/about'));
app.use('/api/seo', require('./routes/seo'));
app.use('/api/settings', require('./routes/settings'));
app.use('/api/inquiries', require('./routes/inquiries'));
app.use('/api/cart', require('./routes/cart'));
app.use('/api/saved-items', require('./routes/savedItems'));
app.use('/api/contact', require('./routes/contact'));
app.use('/api/admin/products', require('./routes/adminProducts'));
app.use('/api/admin/categories', require('./routes/adminCategories'));
app.use('/api/admin/attributes', require('./routes/adminAttributes'));
app.use('/api/admin', require('./routes/adminProductTypes'));
app.use('/api/admin/customers', require('./routes/adminUsers'));
app.use('/api/admin/homepage', require('./routes/adminHomepage'));
app.use('/api/admin/about', require('./routes/adminAbout'));
app.use('/api/admin/seo', require('./routes/adminSeo'));
app.use('/api/admin/settings', require('./routes/adminSettings'));
app.use('/api/admin/roles', require('./routes/adminRoles'));
app.use('/api/admin/audit', require('./routes/adminAudit'));
app.use('/api/admin/dashboard', require('./routes/adminDashboard'));
app.use('/api/admin/contact', require('./routes/adminContact'));

app.use('/uploads', express.static(env.uploadsDir));
app.use(express.static(env.rootDir, { extensions: ['html'] }));

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));
app.use(errorHandler);

module.exports = app;
