// Nightly pg_dump → gzip → encrypt → brew-bucket `backups` bucket.
// The bucket owns retention (90 days), so this never deletes anything.
// Skipped on the local storage driver: a backup on the same disk as the
// database isn't a backup.
const { spawn } = require('child_process');
const zlib = require('zlib');
const config = require('../config');
const storage = require('../services/storage');
const { today } = require('../lib/dates');

async function runBackup() {
  if (storage.driver !== 'brew-bucket') {
    return { skipped: 'BREW_BUCKET_URL not set — no off-machine backup target' };
  }
  const day = today();
  const dump = spawn('pg_dump', ['--no-owner', '--no-privileges', '-h', config.db.host, '-p', String(config.db.port),
    '-U', config.db.user, config.db.database], { env: { ...process.env, PGPASSWORD: config.db.password } });

  let stderr = '';
  dump.stderr.on('data', (d) => { stderr += d; });
  const exited = new Promise((resolve, reject) => {
    dump.on('error', (err) => reject(err.code === 'ENOENT'
      ? Object.assign(new Error('pg_dump not installed in the backend image'), { status: 400 }) : err));
    dump.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`pg_dump exited ${code}: ${stderr.slice(0, 500)}`))));
  });

  // Await both together: awaiting them in sequence would leave `exited`
  // unhandled if pg_dump died mid-upload, which crashes the process.
  const [key] = await Promise.all([
    storage.putStream(`db-${day}.sql.gz.enc`, dump.stdout.pipe(zlib.createGzip()), { bucket: config.storage.backupBucket }),
    exited,
  ]);
  return { key };
}

module.exports = { runBackup };
