// Central config. Anything that is a misconfiguration (as opposed to a
// transient outage) fails loudly at boot rather than at first use.
const crypto = require('crypto');

const isProd = process.env.NODE_ENV === 'production';

function parseKey(raw) {
  if (!raw) return null;
  const s = raw.trim();
  if (/^[0-9a-f]{64}$/i.test(s)) return Buffer.from(s, 'hex');
  const b = Buffer.from(s, 'base64');
  if (b.length === 32) return b;
  const err = new Error('FOLIO_ENC_KEY must be 32 bytes as 64 hex chars or base64 (openssl rand -hex 32)');
  err.status = 500;
  throw err;
}

let encKey = parseKey(process.env.FOLIO_ENC_KEY);
if (!encKey) {
  if (isProd) {
    throw new Error('FOLIO_ENC_KEY is required in production — set it as a global Beachhead env var (openssl rand -hex 32)');
  }
  // Dev only: a fixed, obviously-insecure key so local restarts can still
  // read files they wrote. Never reached in production (see above).
  console.warn('[config] FOLIO_ENC_KEY unset — using an insecure development key');
  encKey = crypto.createHash('sha256').update('brew-folio-dev-key').digest();
}

module.exports = {
  isProd,
  port: Number(process.env.PORT) || 3001,
  db: {
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 5432,
    database: process.env.DB_NAME || 'folio',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || '',
  },
  encKey,
  tz: process.env.FOLIO_TZ || 'America/Chicago',
  cookieSecure: isProd,
  sessionDays: 90,
  maxUploadBytes: 60 * 1024 * 1024,
  storage: {
    driver: process.env.BREW_BUCKET_URL ? 'brew-bucket' : 'local',
    localDir: process.env.FILES_DIR || (isProd ? '/data/files' : require('path').join(__dirname, '..', '.data', 'files')),
    bucketUrl: (process.env.BREW_BUCKET_URL || '').replace(/\/+$/, ''),
    bucketKey: process.env.BREW_BUCKET_KEY || '',
    bucket: process.env.BREW_BUCKET_BUCKET || 'uploads',
    backupBucket: process.env.BREW_BUCKET_BACKUP_BUCKET || 'backups',
    prefix: 'folio/',
  },
  drydock: {
    baseUrl: (process.env.DRYDOCK_BASE_URL || '').replace(/\/+$/, ''),
    apiKey: process.env.DRYDOCK_API_KEY || '',
  },
  schedulerEnabled: process.env.FOLIO_SCHEDULER !== 'off',
};
