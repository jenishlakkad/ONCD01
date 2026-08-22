const db = require('../db/connection');

module.exports = function requireAdmin(req, res, next) {
  const id = req.session && req.session.adminId;
  if (!id) return res.status(401).json({ error: 'Admin login required.' });
  const admin = db.prepare('SELECT * FROM admin_users WHERE id = ?').get(id);
  if (!admin) {
    req.session.adminId = null;
    return res.status(401).json({ error: 'Admin login required.' });
  }
  if (admin.status === 'suspended') {
    return res.status(403).json({ error: 'This admin account has been suspended.' });
  }
  const role = db.prepare('SELECT * FROM roles WHERE id = ?').get(admin.role_id);
  const permRows = db.prepare('SELECT module, access FROM role_permissions WHERE role_id = ?').all(admin.role_id);
  const permissions = {};
  for (const r of permRows) permissions[r.module] = r.access;

  delete admin.password_hash;
  req.adminUser = admin;
  req.adminRole = role;
  req.adminPermissions = permissions;
  next();
};
