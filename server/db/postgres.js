// PostgreSQL (Supabase) connection layer — STEP 1 of the SQLite -> Postgres
// migration. This file is NOT wired into the running app yet: server/db/connection.js
// (better-sqlite3) remains the live database for the website. This module exists
// so later steps can convert routes one at a time against a proven async layer.
//
// Deliberately does NOT imitate better-sqlite3's synchronous prepare().get()/all()/run()
// API — pg is async by nature, so every helper here returns a Promise.

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('DATABASE_URL is not set. Add it to your .env file.');
}

// Supabase's Session Pooler terminates TLS with a certificate that isn't in
// Node's default trust store, so rejectUnauthorized must be false — same
// setting already proven to connect in migrate-to-postgres.js.
//
// Opening a connection to Supabase costs ~1.2s (TLS + pooler handshake)
// versus ~150ms for a query on a warm one, so idle connections are kept
// for a while (pg's default 10s closed them between most page views).
//
// But Supabase's SESSION pooler caps clients at 15 for the whole database,
// and that cap is shared by every server using it (the live site and any
// dev/test instance) plus scripts. Hitting it fails queries everywhere
// with EMAXCONNSESSION — so each process holds at most a few connections
// and lets them go after a short idle spell. Both are tunable per
// deployment: PG_POOL_MAX, PG_IDLE_MS.
const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false },
  max: Number(process.env.PG_POOL_MAX) || 5,
  idleTimeoutMillis: Number(process.env.PG_IDLE_MS) || 30 * 1000,
  keepAlive: true,
});

// A pooled client can emit 'error' outside of any query (e.g. the backend
// restarts an idle connection) — without this handler that crashes the whole
// process. Logs only the error message/code, never the connection string.
pool.on('error', (err) => {
  console.error('[postgres] Unexpected error on idle client:', err && err.message);
});

// Runs a query and returns the raw pg QueryResult (rows, rowCount, fields, ...).
async function query(text, params) {
  return pool.query(text, params);
}

// Runs a query and returns just the first row, or undefined if none matched.
async function get(text, params) {
  const result = await pool.query(text, params);
  return result.rows[0];
}

// Runs a query and returns all rows as a plain array.
async function all(text, params) {
  const result = await pool.query(text, params);
  return result.rows;
}

// Runs `fn` against a single dedicated client wrapped in BEGIN/COMMIT, so
// every query inside `fn` participates in the same transaction. Rolls back
// and rethrows on any error; always releases the client back to the pool.
//
// Usage:
//   await transaction(async (client) => {
//     await client.query(...);
//     await client.query(...);
//   });
async function transaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      console.error('[postgres] Rollback failed:', rollbackErr && rollbackErr.message);
    }
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { pool, query, get, all, transaction };
