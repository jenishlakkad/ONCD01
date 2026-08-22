const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const env = require('../config/env');

fs.mkdirSync(path.dirname(env.dbFile), { recursive: true });

const db = new Database(env.dbFile);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

module.exports = db;
