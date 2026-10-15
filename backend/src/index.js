const config = require('./config');
const { migrate } = require('./db/migrate');
const { pool } = require('./db/pool');
const { createApp } = require('./app');
const scheduler = require('./jobs/scheduler');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // Postgres may still be starting even after its healthcheck on a cold host;
  // retry the connection, but fail loudly on anything that isn't "not up yet".
  for (let attempt = 1; ; attempt++) {
    try { await pool.query('SELECT 1'); break; } catch (err) {
      const transient = ['ECONNREFUSED', 'ENOTFOUND', '57P03', 'EAI_AGAIN'].includes(err.code);
      if (!transient || attempt >= 30) throw err;
      console.log(`[boot] waiting for postgres (${err.code})…`);
      await sleep(2000);
    }
  }
  await migrate();

  const app = createApp();
  const server = app.listen(config.port, () => console.log(`[boot] folio api on :${config.port} (storage: ${require('./services/storage').driver})`));
  // Statement uploads can be tens of MB over a phone connection.
  server.requestTimeout = 10 * 60_000;
  server.headersTimeout = 65_000;

  if (config.schedulerEnabled) scheduler.start();

  const shutdown = (sig) => {
    console.log(`[boot] ${sig} — shutting down`);
    server.close(() => pool.end().finally(() => process.exit(0)));
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('[boot] fatal', err);
  process.exit(1);
});
