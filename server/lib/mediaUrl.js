const r2Storage = require('../services/r2Storage');

// Translates a stored media value into the URL an API response should expose.
// Pure and synchronous — no network request, no credential ever touches this
// module beyond what r2Storage.getPublicUrl() already needs to build a
// string. The database value itself is NEVER modified by this function; it
// only changes what a response serializes, and only when explicitly enabled.
//
// R2_MEDIA_READS_ENABLED must be the EXACT string "true" to activate R2
// resolution — any other value (unset, "false", "1", etc.) keeps today's
// behavior of returning the stored value unchanged. This is the single
// on/off switch for the R2 read cutover; flipping it back is the rollback.
const UPLOADS_PREFIX = '/uploads/';

function toPublicMediaUrl(value) {
  if (value === null || value === undefined || value === '') return value;
  if (typeof value !== 'string') return value;
  if (process.env.R2_MEDIA_READS_ENABLED !== 'true') return value;
  if (/^https?:\/\//i.test(value)) return value;
  if (!value.startsWith(UPLOADS_PREFIX)) return value;

  const key = value.slice(UPLOADS_PREFIX.length);
  return r2Storage.getPublicUrl(key);
}

module.exports = { toPublicMediaUrl };
