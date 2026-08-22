const express = require('express');
const db = require('../db/connection');
const { asyncRoute, ApiError } = require('../middleware/errorHandler');
const requireAdmin = require('../middleware/requireAdmin');
const requirePermission = require('../middleware/requirePermission');
const { writeAudit } = require('../lib/audit');

const router = express.Router();
router.use(requireAdmin, requirePermission('users', 'manage'));

function publicCustomer(c) {
  const { password_hash, ...rest } = c;
  return rest;
}

router.get('/', asyncRoute(async (req, res) => {
  const rows = db.prepare('SELECT * FROM customers ORDER BY created_at DESC').all();
  res.json({ data: rows.map(publicCustomer) });
}));

function setStatus(status, actionLabel) {
  return asyncRoute(async (req, res) => {
    const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(req.params.id);
    if (!customer) throw new ApiError(404, 'Customer not found.');
    db.prepare("UPDATE customers SET status = ?, updated_at = datetime('now') WHERE id = ?").run(status, customer.id);
    writeAudit({ actor: req.adminUser.full_name, action: actionLabel, target: customer.full_name, module: 'Users' });
    res.json({ data: publicCustomer({ ...customer, status }) });
  });
}

router.get('/:id/cart', asyncRoute(async (req, res) => {
  const customer = db.prepare('SELECT id FROM customers WHERE id = ?').get(req.params.id);
  if (!customer) throw new ApiError(404, 'Customer not found.');
  const rows = db.prepare(
    'SELECT sku, name, price_label AS priceLabel, qty, updated_at AS updatedAt FROM cart_items WHERE customer_id = ? ORDER BY updated_at DESC'
  ).all(customer.id);
  res.json({ data: rows });
}));

router.get('/:id/inquiries', asyncRoute(async (req, res) => {
  const customer = db.prepare('SELECT id FROM customers WHERE id = ?').get(req.params.id);
  if (!customer) throw new ApiError(404, 'Customer not found.');
  const rows = db.prepare(
    'SELECT id, channel, status, created_at AS createdAt FROM inquiries WHERE customer_id = ? ORDER BY created_at DESC'
  ).all(customer.id);
  const items = db.prepare('SELECT sku, name, qty, price_label AS priceLabel FROM inquiry_items WHERE inquiry_id = ?');
  const data = rows.map((r) => ({ ...r, items: items.all(r.id) }));
  res.json({ data });
}));

router.get('/:id/saved-items', asyncRoute(async (req, res) => {
  const customer = db.prepare('SELECT id FROM customers WHERE id = ?').get(req.params.id);
  if (!customer) throw new ApiError(404, 'Customer not found.');
  const rows = db.prepare(
    'SELECT sku, name, price_label AS priceLabel, product_type AS productType, created_at AS createdAt FROM saved_items WHERE customer_id = ? ORDER BY created_at DESC'
  ).all(customer.id);
  res.json({ data: rows });
}));

router.post('/:id/approve', setStatus('approved', 'Approved user'));
router.post('/:id/reject', setStatus('rejected', 'Rejected user'));
router.post('/:id/suspend', setStatus('suspended', 'Suspended user'));
router.post('/:id/reactivate', setStatus('approved', 'Reactivated user'));

module.exports = router;
