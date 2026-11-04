// Centralized error handler so route code can just `next(err)` (or throw
// inside an async handler wrapped by asyncRoute below) instead of every
// route hand-rolling its own try/catch response shape.
function asyncRoute(fn) {
  return function (req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

function errorHandler(err, req, res, next) { // eslint-disable-line no-unused-vars
  console.error('[api]', err);
  if (res.headersSent) return next(err);
  const status = err.status || 500;
  // err.extra: machine-readable details for the page (e.g. retryAfter,
  // code) alongside the human message.
  res.status(status).json({ error: err.expose ? err.message : status === 500 ? 'Unexpected server error.' : err.message, ...(err.extra || {}) });
}

class ApiError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.expose = true;
    if (extra) this.extra = extra;
  }
}

module.exports = { asyncRoute, errorHandler, ApiError };
