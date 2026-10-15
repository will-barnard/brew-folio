// Passwords, tokens, at-rest encryption and TOTP — all on node:crypto so the
// backend carries no auth/crypto dependencies.
const crypto = require('crypto');
const { Transform } = require('stream');
const config = require('../config');

// ── passwords (scrypt) ──────────────────────────────────────────────────
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function verifyPassword(password, stored) {
  const [alg, saltB64, hashB64] = String(stored).split('$');
  if (alg !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = crypto.scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length,
    { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return crypto.timingSafeEqual(expected, actual);
}

// ── tokens ──────────────────────────────────────────────────────────────
const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function safeEqualHex(a, b) {
  const x = Buffer.from(String(a), 'hex');
  const y = Buffer.from(String(b), 'hex');
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

// ── string secrets (connector credentials, TOTP secret) ─────────────────
// Format: v1:<base64(iv | tag | ciphertext)>
function encryptString(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', config.encKey, iv);
  const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return `v1:${Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64')}`;
}

function decryptString(enc) {
  if (!enc || !enc.startsWith('v1:')) throw new Error('unrecognised secret format');
  const raw = Buffer.from(enc.slice(3), 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', config.encKey, raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
}

// ── files ───────────────────────────────────────────────────────────────
// Layout: MAGIC(6) | iv(12) | ciphertext | tag(16). The tag goes last so
// encryption can stream; decryption buffers (see decryptFileBuffer).
const MAGIC = Buffer.from('FOLIO1');

function createEncryptStream() {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', config.encKey, iv);
  let headerSent = false;
  return new Transform({
    transform(chunk, _enc, cb) {
      if (!headerSent) { this.push(Buffer.concat([MAGIC, iv])); headerSent = true; }
      cb(null, cipher.update(chunk));
    },
    flush(cb) {
      if (!headerSent) this.push(Buffer.concat([MAGIC, iv]));
      this.push(cipher.final());
      this.push(cipher.getAuthTag());
      cb();
    },
  });
}

// Statements and receipts are small (capped by maxUploadBytes), and GCM can
// only authenticate once it has seen the trailing tag — so decrypting into a
// buffer is the honest option. Streaming plaintext before the tag is checked
// would hand out unauthenticated bytes.
function decryptFileBuffer(buf) {
  if (buf.length < 34 || !buf.subarray(0, 6).equals(MAGIC)) {
    const err = new Error('stored file is not a folio-encrypted blob');
    err.status = 500;
    throw err;
  }
  const iv = buf.subarray(6, 18);
  const tag = buf.subarray(buf.length - 16);
  const d = crypto.createDecipheriv('aes-256-gcm', config.encKey, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(buf.subarray(18, buf.length - 16)), d.final()]);
}

// ── TOTP (RFC 6238, SHA-1, 6 digits, 30 s) ──────────────────────────────
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(str) {
  const clean = str.replace(/=+$/, '').replace(/\s+/g, '').toUpperCase();
  let bits = 0, value = 0; const out = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx === -1) throw new Error('invalid base32');
    value = (value << 5) | idx; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

const totpSecret = () => base32Encode(crypto.randomBytes(20));

function totpAt(secretB32, step) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const h = crypto.createHmac('sha1', base32Decode(secretB32)).update(msg).digest();
  const o = h[h.length - 1] & 0xf;
  const code = ((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).toString();
  return code.padStart(6, '0');
}

// Returns the matched time step (for replay protection) or null.
function verifyTotp(secretB32, code, { window = 1, now = Date.now() } = {}) {
  const c = String(code || '').replace(/\s+/g, '');
  if (!/^\d{6}$/.test(c)) return null;
  const step = Math.floor(now / 1000 / 30);
  for (let w = -window; w <= window; w++) {
    const candidate = totpAt(secretB32, step + w);
    if (crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(c))) return step + w;
  }
  return null;
}

module.exports = {
  hashPassword, verifyPassword, randomToken, sha256, safeEqualHex,
  encryptString, decryptString, createEncryptStream, decryptFileBuffer,
  totpSecret, totpAt, verifyTotp, base32Encode, base32Decode,
};
