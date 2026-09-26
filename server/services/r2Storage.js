const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
const {
  S3Client,
  PutObjectCommand,
  HeadObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} = require('@aws-sdk/client-s3');

// Cloudflare R2 (S3-compatible) storage helper — STEP: reusable module only.
// NOT wired into any upload/product route yet, and does not touch existing
// local uploads/ media or PostgreSQL/SQLite data. Exists so later steps can
// migrate one upload path at a time against a proven layer, mirroring how
// server/db/postgres.js was introduced before any SQLite route was cut over.
//
// Object keys are provider-independent (e.g. "products/example.jpg") — no
// leading slash, no bucket name, no account ID, no provider hostname baked
// in anywhere. Callers store this key (not a full URL) wherever the current
// code stores a local /uploads/... path, and call getPublicUrl(key) only at
// the point of constructing an API response — exactly mirroring the Step
// 19A audit's recommended "store a key, build the URL in application code"
// strategy, so a future provider change never requires touching stored data.

for (const name of ['R2_BUCKET_NAME', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_ENDPOINT', 'R2_PUBLIC_BASE_URL']) {
  if (!process.env[name]) {
    throw new Error(`${name} is not set. Add it to your .env file.`);
  }
}

const client = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

const BUCKET = process.env.R2_BUCKET_NAME;
const PUBLIC_BASE_URL = process.env.R2_PUBLIC_BASE_URL.replace(/\/+$/, '');

// Keys are relative, forward-slash-delimited paths like "products/abc.jpg" —
// never a leading slash, never a "." / ".." traversal segment. Same shape
// the current local-disk routes already build (just without the leading
// "/uploads/" prefix), so converting an existing route later is a small,
// mechanical change rather than a redesign.
function assertValidKey(key) {
  if (typeof key !== 'string' || !key.length) throw new Error('R2 object key must be a non-empty string.');
  if (key.startsWith('/')) throw new Error(`R2 object key must not start with "/": ${key}`);
  const segments = key.split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..')) {
    throw new Error(`R2 object key must not contain empty/"."/".." segments: ${key}`);
  }
}

function isNotFoundError(err) {
  const status = err && err.$metadata && err.$metadata.httpStatusCode;
  return (err && (err.name === 'NotFound' || err.name === 'NoSuchKey')) || status === 404;
}

// Uploads `body` (Buffer/string/stream) under `key`. Returns the key back
// alongside its public URL so callers rarely need a second getPublicUrl()
// call right after uploading.
async function uploadObject(key, body, contentType) {
  assertValidKey(key);
  const result = await client.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: body,
    ContentType: contentType || 'application/octet-stream',
  }));
  return { key, url: getPublicUrl(key), etag: result.ETag };
}

// Returns true/false — never throws for a plain "not found", but does not
// swallow a real connectivity/auth/permission error, which callers need to
// see rather than silently misreading as "file doesn't exist".
async function objectExists(key) {
  assertValidKey(key);
  try {
    await client.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
    return true;
  } catch (err) {
    if (isNotFoundError(err)) return false;
    throw err;
  }
}

// Reads an object back fully into memory. Returns { body: Buffer,
// contentType, contentLength } rather than a bare Buffer, since a caller
// re-serving this (e.g. for a signed-proxy download) needs the content type
// too, not just the bytes.
async function getObject(key) {
  assertValidKey(key);
  const result = await client.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  const bytes = await result.Body.transformToByteArray();
  return { body: Buffer.from(bytes), contentType: result.ContentType || null, contentLength: result.ContentLength };
}

async function deleteObject(key) {
  assertValidKey(key);
  await client.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
}

// Builds the public URL for `key` from R2_PUBLIC_BASE_URL. Each path
// segment is percent-encoded independently so a "/" in the key stays a
// path separator (never gets encoded into %2F) while special characters
// within a segment (spaces, unicode, etc.) are encoded correctly.
function getPublicUrl(key) {
  assertValidKey(key);
  const encoded = key.split('/').map(encodeURIComponent).join('/');
  return `${PUBLIC_BASE_URL}/${encoded}`;
}

module.exports = { uploadObject, objectExists, getObject, deleteObject, getPublicUrl };
