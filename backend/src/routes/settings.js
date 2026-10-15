// API keys, mileage, connector status, jobs and the audit log.
const express = require('express');
const { query, tx } = require('../db/pool');
const { int, str, date } = require('../lib/validate');
const { notFound, badRequest, notImplemented } = require('../lib/errors');
const { randomToken, sha256 } = require('../lib/crypto');
const { audit } = require('../services/audit');
const connectors = require('../connectors');
const storage = require('../services/storage');
const config = require('../config');

const router = express.Router();
router.use(express.json({ limit: '32kb' }));

// ── API keys ────────────────────────────────────────────────────────────
const SCOPES = ['inbox:write', 'transactions:write'];

router.get('/api-keys', async (_req, res) => {
  const { rows } = await query('SELECT id, name, prefix, scopes, created_at, last_used_at, revoked_at FROM api_keys ORDER BY id DESC');
  res.json({ keys: rows, scopes: SCOPES });
});

// The plaintext is returned once and never stored.
router.post('/api-keys', async (req, res) => {
  const name = str(req.body.name, 'name', { min: 1, max: 60 });
  const scopes = Array.isArray(req.body.scopes) ? req.body.scopes : [];
  if (!scopes.length || scopes.some((s) => !SCOPES.includes(s))) throw badRequest(`scopes must be from ${SCOPES.join(', ')}`);
  const prefix = randomToken(6).toLowerCase().replace(/[^a-z0-9]/g, '').padEnd(8, '0').slice(0, 8);
  const key = `fk_${prefix}_${randomToken(24)}`;
  const row = await tx(async (db) => {
    const { rows } = await db.query(
      'INSERT INTO api_keys (name, prefix, key_hash, scopes) VALUES ($1,$2,$3,$4) RETURNING id, name, prefix, scopes, created_at',
      [name, prefix, sha256(key), scopes]);
    await audit(db, { actor: req.actor, action: 'create', entity: 'api_key', entityId: rows[0].id, after: { name, scopes } });
    return rows[0];
  });
  res.status(201).json({ ...row, key });
});

router.delete('/api-keys/:id', async (req, res) => {
  const id = int(req.params.id, 'id');
  await tx(async (db) => {
    const { rows } = await db.query('UPDATE api_keys SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL RETURNING id', [id]);
    if (!rows.length) throw notFound('Key not found or already revoked');
    await audit(db, { actor: req.actor, action: 'revoke', entity: 'api_key', entityId: id });
  });
  res.json({ ok: true });
});

// ── mileage ─────────────────────────────────────────────────────────────
router.get('/mileage', async (req, res) => {
  const year = Number(req.query.year) || new Date().getFullYear();
  const { rows } = await query(
    `SELECT m.*, s.name AS stream_name FROM mileage m LEFT JOIN streams s ON s.id = m.stream_id
      WHERE extract(year FROM m.on_date) = $1 ORDER BY m.on_date DESC, m.id DESC`, [year]);
  const total = rows.reduce((a, r) => a + Number(r.miles), 0);
  res.json({ year, total_miles: Math.round(total * 10) / 10, trips: rows });
});

router.post('/mileage', async (req, res) => {
  const miles = Number(req.body.miles);
  if (!(miles > 0 && miles < 5000)) throw badRequest('miles must be between 0 and 5000');
  const { rows } = await query(
    `INSERT INTO mileage (on_date, miles, purpose, stream_id, from_place, to_place) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [date(req.body.on_date, 'on_date'), Math.round(miles * 10) / 10, str(req.body.purpose, 'purpose', { min: 1, max: 200 }),
      req.body.stream_id ? int(req.body.stream_id, 'stream_id') : null,
      str(req.body.from_place, 'from_place', { max: 120, nullable: true }), str(req.body.to_place, 'to_place', { max: 120, nullable: true })]);
  res.status(201).json(rows[0]);
});

router.delete('/mileage/:id', async (req, res) => {
  const { rowCount } = await query('DELETE FROM mileage WHERE id = $1', [int(req.params.id, 'id')]);
  if (!rowCount) throw notFound('Trip not found');
  res.json({ ok: true });
});

// ── connectors & system ─────────────────────────────────────────────────
router.get('/connectors', (_req, res) => {
  res.json({ available: connectors.available, planned: connectors.planned });
});

router.post('/connectors/:id/sync', (req) => {
  const p = connectors.planned.find((c) => c.id === req.params.id);
  if (!p) throw notFound('Unknown connector');
  throw notImplemented(`${p.name} sync arrives in Phase ${p.phase}`);
});

router.get('/system', async (_req, res) => {
  const [jobs, counts] = await Promise.all([
    query(`SELECT DISTINCT ON (kind) kind, status, finished_at, last_error, payload->'result' AS result
             FROM jobs ORDER BY kind, created_at DESC`),
    query(`SELECT (SELECT count(*) FROM transactions) AS transactions, (SELECT count(*) FROM import_batches) AS imports,
                  (SELECT count(*) FROM rules) AS rules, (SELECT count(*) FROM receipts) AS receipts`),
  ]);
  res.json({
    storage: storage.driver,
    backups: storage.driver === 'brew-bucket' ? 'nightly → brew-bucket' : 'off (no BREW_BUCKET_URL)',
    drydock: config.drydock.baseUrl ? 'configured (Phase 2)' : 'not configured',
    jobs: jobs.rows,
    counts: counts.rows[0],
  });
});

router.get('/audit', async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const { rows } = await query('SELECT id, at, actor, action, entity, entity_id FROM audit_log ORDER BY id DESC LIMIT $1', [limit]);
  res.json(rows);
});

module.exports = router;
