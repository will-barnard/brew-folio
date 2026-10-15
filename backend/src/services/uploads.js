// Receives a raw request body (no multipart — the client sends the file as the
// body with X-Filename) into a temp file, hashing as it streams. Callers parse
// from the temp file and then hand it to storage, which encrypts on the way out.
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');
const config = require('../config');
const { tooLarge, badRequest } = require('../lib/errors');

async function receiveUpload(req) {
  const declared = Number(req.get('content-length') || 0);
  if (declared > config.maxUploadBytes) throw tooLarge(`File is over ${config.maxUploadBytes / 1024 / 1024} MB`);

  const tmp = path.join(os.tmpdir(), `folio-up-${crypto.randomUUID()}`);
  const hash = crypto.createHash('sha256');
  let bytes = 0;
  const meter = new Transform({
    transform(chunk, _e, cb) {
      bytes += chunk.length;
      if (bytes > config.maxUploadBytes) return cb(tooLarge('File too large'));
      hash.update(chunk);
      cb(null, chunk);
    },
  });
  try {
    await pipeline(req, meter, fs.createWriteStream(tmp));
  } catch (err) {
    await fsp.rm(tmp, { force: true });
    throw err;
  }
  if (!bytes) { await fsp.rm(tmp, { force: true }); throw badRequest('Empty upload'); }

  let filename = req.get('x-filename') || 'upload';
  try { filename = decodeURIComponent(filename); } catch { /* keep raw */ }
  filename = path.basename(filename).slice(0, 200);

  return {
    path: tmp,
    sha256: hash.digest('hex'),
    bytes,
    filename,
    mime: (req.get('content-type') || 'application/octet-stream').split(';')[0].trim(),
    cleanup: () => fsp.rm(tmp, { force: true }),
  };
}

module.exports = { receiveUpload };
