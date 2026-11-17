// Customer ID: the 6-digit number customers and staff use to refer to an
// account (shown in My Account, the admin panel, inquiry messages and
// account emails).
//
// It is derived from the account's permanent database id — 100000 + id —
// rather than stored in its own column. That means:
//   - every account has one from the moment it exists (including accounts
//     created before this feature), with no migration and nothing to keep
//     in sync;
//   - it can never collide: customers.id is the table's own unique key;
//   - it stays 6 digits for the first 899,999 accounts.
const CODE_BASE = 100000;

function customerCode(id) {
  const n = Number(id);
  return Number.isSafeInteger(n) && n > 0 ? String(CODE_BASE + n) : null;
}

// "100047", "#100047" or "ONCD-100047" -> 47 (null when it isn't one).
function customerIdFromCode(input) {
  const m = /^\s*(?:#|oncd-?)?\s*(\d{6,})\s*$/i.exec(String(input || ''));
  if (!m) return null;
  const id = Number(m[1]) - CODE_BASE;
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

module.exports = { CODE_BASE, customerCode, customerIdFromCode };
