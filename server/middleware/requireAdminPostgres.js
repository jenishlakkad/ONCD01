const db = require('../db/postgres');

// PostgreSQL counterpart to server/middleware/requireAdmin.js (SQLite). NOT
// wired into any route or app.js yet — exists so it can be exercised/tested
// on its own before any cutover decision is made.
module.exports = async function requireAdmin(req, res, next) {
  try {
    const id = req.session && req.session.adminId;
    if (!id) return res.status(401).json({ error: 'Admin login required.' });

    const admin = await db.get('SELECT * FROM admin_users WHERE id = $1', [id]);
    if (!admin) {
      req.session.adminId = null;
      return res.status(401).json({ error: 'Admin login required.' });
    }
    if (admin.status === 'suspended') {
      return res.status(403).json({ error: 'This admin account has been suspended.' });
    }

    const role = await db.get('SELECT * FROM roles WHERE id = $1', [admin.role_id]);
    const permRows = await db.all('SELECT module, access FROM role_permissions WHERE role_id = $1', [admin.role_id]);
    const permissions = {};
    for (const r of permRows) permissions[r.module] = r.access;

    delete admin.password_hash;
    // admin_users.id / role_id are BIGINT — pg returns these as strings, not
    // numbers, to avoid precision loss. Converting back to Number here keeps
    // req.adminUser.id/role_id behaving exactly like the SQLite version
    // (a plain number), so any downstream `===` comparison still works.
    admin.id = Number(admin.id);
    admin.role_id = Number(admin.role_id);
    if (role) role.id = Number(role.id);

    req.adminUser = admin;
    req.adminRole = role;
    req.adminPermissions = permissions;
    next();
  } catch (err) {
    // Never leak a raw pg error (which could include query text/column
    // names) to the client — hand it to the shared error handler, which
    // already reduces any non-ApiError to a generic 500 message.
    next(err);
  }
};
