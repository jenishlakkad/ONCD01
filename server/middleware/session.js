const session = require('express-session');
const db = require('../db/connection');

class SqliteSessionStore extends session.Store {
  constructor() {
    super();
    this._get = db.prepare('SELECT data, expires FROM sessions WHERE sid = ?');
    this._upsert = db.prepare(
      `INSERT INTO sessions (sid, data, expires) VALUES (?, ?, ?)
       ON CONFLICT(sid) DO UPDATE SET data = excluded.data, expires = excluded.expires`
    );
    this._destroy = db.prepare('DELETE FROM sessions WHERE sid = ?');
    this._touch = db.prepare('UPDATE sessions SET expires = ? WHERE sid = ?');
    this._prune = db.prepare('DELETE FROM sessions WHERE expires < ?');
    // Best-effort cleanup of expired rows every 15 minutes.
    setInterval(() => {
      try { this._prune.run(Date.now()); } catch { /* ignore */ }
    }, 15 * 60 * 1000).unref();
  }

  get(sid, cb) {
    try {
      const row = this._get.get(sid);
      if (!row) return cb(null, null);
      if (row.expires < Date.now()) {
        this._destroy.run(sid);
        return cb(null, null);
      }
      cb(null, JSON.parse(row.data));
    } catch (err) {
      cb(err);
    }
  }

  set(sid, sessionData, cb) {
    try {
      const maxAge = sessionData.cookie && sessionData.cookie.maxAge ? sessionData.cookie.maxAge : 24 * 60 * 60 * 1000;
      const expires = Date.now() + maxAge;
      this._upsert.run(sid, JSON.stringify(sessionData), expires);
      cb && cb(null);
    } catch (err) {
      cb && cb(err);
    }
  }

  destroy(sid, cb) {
    try {
      this._destroy.run(sid);
      cb && cb(null);
    } catch (err) {
      cb && cb(err);
    }
  }

  touch(sid, sessionData, cb) {
    try {
      const maxAge = sessionData.cookie && sessionData.cookie.maxAge ? sessionData.cookie.maxAge : 24 * 60 * 60 * 1000;
      this._touch.run(Date.now() + maxAge, sid);
      cb && cb(null);
    } catch (err) {
      cb && cb(err);
    }
  }
}

module.exports = SqliteSessionStore;
