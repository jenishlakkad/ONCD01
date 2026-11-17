const db = require('../db/postgres');
const { customerCode } = require('../lib/customerCode');

// Signed-in customer guard: loads the account for this session and only
// lets approved accounts through. Sets req.customer (no password hash,
// numeric id, and the 6-digit customer_code shown across the site).
module.exports = async function requireCustomer(req, res, next) {
  try {
    const id = req.session && req.session.customerId;
    if (!id) return res.status(401).json({ error: 'Not logged in.' });

    const customer = await db.get('SELECT * FROM customers WHERE id = $1', [id]);
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
    customer.id = Number(customer.id); // BIGINT -> string from pg
    customer.customer_code = customerCode(customer.id);
    req.customer = customer;
    next();
  } catch (err) {
    next(err);
  }
};
