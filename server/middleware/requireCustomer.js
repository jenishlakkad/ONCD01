const db = require('../db/connection');

// Re-reads the live DB row on every request (not the session snapshot) so a
// Suspend/Reject takes effect on the very next request, not at next login.
module.exports = function requireCustomer(req, res, next) {
  const id = req.session && req.session.customerId;
  if (!id) return res.status(401).json({ error: 'Not logged in.' });
  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(id);
  if (!customer) {
    req.session.customerId = null;
    return res.status(401).json({ error: 'Not logged in.' });
  }
  if (customer.status !== 'approved') {
    req.session.customerId = null;
    const messages = {
      pending: "Your account is pending admin approval. You'll be notified by email once access is granted.",
      rejected: 'This account has been rejected.',
      suspended: 'This account has been suspended.',
    };
    return res.status(403).json({ error: messages[customer.status] || 'This account is not eligible to log in.' });
  }
  delete customer.password_hash;
  req.customer = customer;
  next();
};
