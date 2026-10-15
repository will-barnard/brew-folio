// File storage for statements, receipts and backups. Everything is encrypted
// with FOLIO_ENC_KEY before it leaves this process, so brew-bucket (or the
// local volume) only ever holds ciphertext.
//
// Drivers:
//   brew-bucket — when BREW_BUCKET_URL is set. PUT/GET /api/v1/b/:bucket/o/:key
//   local       — the brew-folio-files volume; for dev or before brew-bucket is wired
//
// If you'd rather use brew-bucket's own drop-in client (clients/brew-bucket.js),
// it can replace the two fetch calls below without changing callers.
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { pipeline } = require('stream/promises');
const config = require('../config');
const { createEncryptStream, decryptFileBuffer } = require('../lib/crypto');
const { HttpError } = require('../lib/errors');

const S = config.storage;

function objectUrl(bucket, key) {
  return `${S.bucketUrl}/api/v1/b/${encodeURIComponent(bucket)}/o/${key.split('/').map(encodeURIComponent).join('/')}`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// brew-bucket returns 503 when the NAS is asleep/rebooting — transient, so
// retry with backoff. 507 (quota) and 4xx are not retried.
async function withRetry(fn, label) {
  let lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (err.status !== 503 && err.code !== 'ECONNREFUSED' && err.code !== 'ECONNRESET') throw err;
      await sleep(1000 * 2 ** attempt);
    }
  }
  lastErr.message = `${label}: storage unavailable after retries (${lastErr.message})`;
  throw lastErr;
}

async function bucketError(res, what) {
  const text = await res.text().catch(() => '');
  const err = new HttpError(res.status === 503 ? 503 : 502, `brew-bucket ${what} failed: ${res.status} ${text.slice(0, 200)}`);
  err.status = res.status === 503 ? 503 : res.status === 507 ? 507 : 502;
  return err;
}

// Stream a local file → encrypt → destination. `source` is a file path so a
// retry can reopen it from the start.
async function putFile(key, sourcePath, { bucket = S.bucket, contentType = 'application/octet-stream' } = {}) {
  const fullKey = S.prefix + key;
  if (S.driver === 'local') {
    const dest = path.join(S.localDir, bucket, fullKey);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await pipeline(fs.createReadStream(sourcePath), createEncryptStream(), fs.createWriteStream(dest));
    return fullKey;
  }
  await withRetry(async () => {
    const body = fs.createReadStream(sourcePath).pipe(createEncryptStream());
    const res = await fetch(objectUrl(bucket, fullKey), {
      method: 'PUT',
      headers: { 'X-API-Key': S.bucketKey, 'Content-Type': 'application/octet-stream', 'X-Folio-Content-Type': contentType },
      body,
      duplex: 'half',
    });
    if (!res.ok) throw await bucketError(res, 'PUT');
  }, `PUT ${fullKey}`);
  return fullKey;
}

// Same as putFile but for a stream that can't be reopened (pg_dump output).
// No retry — the caller re-runs the whole job instead.
async function putStream(key, stream, { bucket = S.bucket } = {}) {
  const fullKey = S.prefix + key;
  if (S.driver === 'local') {
    const dest = path.join(S.localDir, bucket, fullKey);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await pipeline(stream, createEncryptStream(), fs.createWriteStream(dest));
    return fullKey;
  }
  const res = await fetch(objectUrl(bucket, fullKey), {
    method: 'PUT',
    headers: { 'X-API-Key': S.bucketKey, 'Content-Type': 'application/octet-stream' },
    body: stream.pipe(createEncryptStream()),
    duplex: 'half',
  });
  if (!res.ok) throw await bucketError(res, 'PUT');
  return fullKey;
}

// Returns decrypted bytes. fullKey is what putFile returned.
async function getFile(fullKey, { bucket = S.bucket } = {}) {
  let buf;
  if (S.driver === 'local') {
    buf = await fsp.readFile(path.join(S.localDir, bucket, fullKey));
  } else {
    buf = await withRetry(async () => {
      const res = await fetch(objectUrl(bucket, fullKey), { headers: { 'X-API-Key': S.bucketKey } });
      if (!res.ok) throw await bucketError(res, 'GET');
      return Buffer.from(await res.arrayBuffer());
    }, `GET ${fullKey}`);
  }
  return decryptFileBuffer(buf);
}

async function deleteFile(fullKey, { bucket = S.bucket } = {}) {
  if (S.driver === 'local') {
    await fsp.rm(path.join(S.localDir, bucket, fullKey), { force: true });
    return;
  }
  const res = await fetch(objectUrl(bucket, fullKey), { method: 'DELETE', headers: { 'X-API-Key': S.bucketKey } });
  if (!res.ok && res.status !== 404) throw await bucketError(res, 'DELETE');
}

module.exports = { putFile, putStream, getFile, deleteFile, driver: S.driver };
