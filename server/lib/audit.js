const db = require('../db/connection');

function pad(n) {
  return String(n).padStart(2, '0');
}

// actor: display name string. action/target/module: short human strings,
// matching the shape utils/auditData.js used ({date,time,actor,action,target,module}).
function writeAudit({ actor, action, target, module }) {
  const now = new Date();
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  db.prepare(
    `INSERT INTO audit_log (date, time, actor, action, target, module) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(date, time, actor, action, target, module);
}

module.exports = { writeAudit };
