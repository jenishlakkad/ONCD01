const db = require('../db/postgres');

function pad(n) {
  return String(n).padStart(2, '0');
}

// PostgreSQL counterpart to server/lib/audit.js. NOT wired into any real
// route yet — used only by the parallel *Postgres.js route files.
//
// actor: display name string. action/target/module: short human strings,
// matching the shape utils/auditData.js used ({date,time,actor,action,target,module}).
async function writeAudit({ actor, action, target, module }) {
  const now = new Date();
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  await db.query(
    `INSERT INTO audit_log (date, time, actor, action, target, module) VALUES ($1, $2, $3, $4, $5, $6)`,
    [date, time, actor, action, target, module]
  );
}

module.exports = { writeAudit };
