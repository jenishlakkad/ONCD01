const session = require('express-session');
const db = require('../db/postgres');

// Explicitly schema-qualified: Supabase's built-in `auth` schema also has
// its own, unrelated `auth.sessions` table (part of Supabase Auth/GoTrue,
// which this app doesn't use). Qualifying every query as `public.sessions`
// removes any doubt about which table is being read/written, even though
// the default search_path would already resolve plain `sessions` correctly.
const TABLE = 'public.sessions';

// PostgreSQL counterpart to server/middleware/session.js (SQLite). NOT wired
// into app.js yet — this class exists so it can be exercised/tested on its
// own before any cutover decision is made.
class PostgresSessionStore extends session.Store {
  constructor() {
    super();
    // pg has no prepared-statement-object equivalent to better-sqlite3's
    // db.prepare() — queries are plain parameterized strings sent per call
    // over the pool created in server/db/postgres.js. Same 15-minute
    // best-effort prune cadence and .unref() behavior as the SQLite version.
    this._pruneTimer = setInterval(() => {
      db.query(`DELETE FROM ${TABLE} WHERE expires < $1`, [Date.now()]).catch(() => { /* ignore */ });
    }, 15 * 60 * 1000);
    this._pruneTimer.unref();
  }

  get(sid, cb) {
    db.get(`SELECT data, expires FROM ${TABLE} WHERE sid = $1`, [sid])
      .then((row) => {
        if (!row) return cb(null, null);
        // pg returns BIGINT columns as strings, not numbers (to avoid silent
        // precision loss) — Number(...) makes the comparison and any future
        // arithmetic unambiguous instead of relying on implicit coercion.
        if (Number(row.expires) < Date.now()) {
          return db.query(`DELETE FROM ${TABLE} WHERE sid = $1`, [sid])
            .then(() => cb(null, null))
            .catch((err) => cb(err));
        }
        cb(null, JSON.parse(row.data));
      })
      .catch((err) => cb(err));
  }

  set(sid, sessionData, cb) {
    const maxAge = sessionData.cookie && sessionData.cookie.maxAge ? sessionData.cookie.maxAge : 24 * 60 * 60 * 1000;
    const expires = Date.now() + maxAge;
    db.query(
      `INSERT INTO ${TABLE} (sid, data, expires) VALUES ($1, $2, $3)
       ON CONFLICT (sid) DO UPDATE SET data = excluded.data, expires = excluded.expires`,
      [sid, JSON.stringify(sessionData), expires]
    )
      .then(() => cb && cb(null))
      .catch((err) => cb && cb(err));
  }

  destroy(sid, cb) {
    db.query(`DELETE FROM ${TABLE} WHERE sid = $1`, [sid])
      .then(() => cb && cb(null))
      .catch((err) => cb && cb(err));
  }

  touch(sid, sessionData, cb) {
    const maxAge = sessionData.cookie && sessionData.cookie.maxAge ? sessionData.cookie.maxAge : 24 * 60 * 60 * 1000;
    db.query(`UPDATE ${TABLE} SET expires = $1 WHERE sid = $2`, [Date.now() + maxAge, sid])
      .then(() => cb && cb(null))
      .catch((err) => cb && cb(err));
  }
}

module.exports = PostgresSessionStore;
