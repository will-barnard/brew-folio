// Postgres-backed job queue. Jobs survive a redeploy mid-run: a job left in
// 'running' by a killed process is picked up again after STALE_MIN minutes.
// Single backend replica, but FOR UPDATE SKIP LOCKED keeps it safe regardless.
const { query } = require('../db/pool');

const STALE_MIN = 30;
const MAX_ATTEMPTS = 5;
const handlers = new Map();

function register(kind, fn) { handlers.set(kind, fn); }

async function enqueue(kind, payload = {}, { runAt = null, dedupeKey = null } = {}) {
  const { rows } = await query(
    `INSERT INTO jobs (kind, payload, run_at, dedupe_key) VALUES ($1, $2, COALESCE($3, now()), $4)
     ON CONFLICT (dedupe_key) DO NOTHING RETURNING id`,
    [kind, JSON.stringify(payload), runAt, dedupeKey],
  );
  return rows[0]?.id || null;
}

async function claim() {
  const { rows } = await query(
    `UPDATE jobs SET status = 'running', started_at = now(), attempts = attempts + 1
      WHERE id = (
        SELECT id FROM jobs
         WHERE (status = 'pending' AND run_at <= now())
            OR (status = 'running' AND started_at < now() - interval '${STALE_MIN} minutes')
         ORDER BY run_at FOR UPDATE SKIP LOCKED LIMIT 1)
     RETURNING *`,
  );
  return rows[0] || null;
}

async function runOne() {
  const job = await claim();
  if (!job) return false;
  const fn = handlers.get(job.kind);
  try {
    if (!fn) throw new Error(`no handler for job kind ${job.kind}`);
    const result = await fn(job.payload, job);
    await query(`UPDATE jobs SET status = 'done', finished_at = now(), last_error = NULL,
                   payload = payload || jsonb_build_object('result', $2::jsonb) WHERE id = $1`,
      [job.id, JSON.stringify(result ?? null)]);
  } catch (err) {
    const retry = job.attempts < MAX_ATTEMPTS && err.status !== 400 && err.status !== 401;
    console.error(`[jobs] ${job.kind}#${job.id} failed (attempt ${job.attempts}):`, err.message);
    await query(
      `UPDATE jobs SET status = $2, last_error = $3, finished_at = now(),
              run_at = now() + ($4 || ' minutes')::interval WHERE id = $1`,
      [job.id, retry ? 'pending' : 'failed', String(err.message).slice(0, 2000), String(2 ** job.attempts)],
    );
  }
  return true;
}

let timer = null;
let busy = false;
function start(intervalMs = 15_000) {
  if (timer) return;
  timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try { while (await runOne()) { /* drain */ } } catch (err) { console.error('[jobs] loop error', err.message); }
    finally { busy = false; }
  }, intervalMs);
  timer.unref();
}
function stop() { clearInterval(timer); timer = null; }

module.exports = { register, enqueue, runOne, start, stop };
