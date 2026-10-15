// Daily jobs, keyed by the local (Chicago) date so DST can't double-run or
// skip them: every tick, enqueue today's job if it's past the hour; the
// dedupe_key makes repeat enqueues no-ops.
//
// If Beachhead auto-pause is ever enabled for this app, backend and postgres
// must be listed in always_on_services or none of this runs.
const { pool } = require('../db/pool');
const queue = require('./queue');
const { today, hourIn } = require('../lib/dates');
const { snapshotAll } = require('../services/balances');
const { runBackup } = require('./backup');

const DAILY = [
  { kind: 'balance_snapshot', hour: 2 },
  { kind: 'db_backup', hour: 3 },
];

queue.register('balance_snapshot', async () => ({ accounts: await snapshotAll(pool) }));
queue.register('db_backup', runBackup);

async function tick() {
  const day = today();
  const hour = hourIn();
  for (const j of DAILY) {
    if (hour >= j.hour) await queue.enqueue(j.kind, { day }, { dedupeKey: `${j.kind}:${day}` });
  }
}

let timer = null;
function start() {
  tick().catch((e) => console.error('[scheduler]', e.message));
  timer = setInterval(() => tick().catch((e) => console.error('[scheduler]', e.message)), 10 * 60_000);
  timer.unref();
  queue.start();
}

module.exports = { start, tick };
