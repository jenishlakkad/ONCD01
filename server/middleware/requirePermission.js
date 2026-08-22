// Must run after requireAdmin. level: 'view' or 'manage' ('manage' also satisfies a 'view' check).
module.exports = function requirePermission(moduleName, level = 'view') {
  return function (req, res, next) {
    const access = (req.adminPermissions && req.adminPermissions[moduleName]) || 'none';
    const ok = access === 'manage' || (level === 'view' && access === 'view');
    if (!ok) return res.status(403).json({ error: `Your role does not have ${level} access to ${moduleName}.` });
    next();
  };
};
