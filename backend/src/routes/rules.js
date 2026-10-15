const express = require('express');
const { query, tx } = require('../db/pool');
const { int, str, optional } = require('../lib/validate');
const { notFound, badRequest } = require('../lib/errors');
const { validateMatch, applyRules, compile } = require('../services/rules');
const { audit } = require('../services/audit');

const router = express.Router();
router.use(express.json({ limit: '32kb' }));

router.get('/rules', async (_req, res) => {
  const { rows } = await query(
    `SELECT r.*, c.name AS category_name, s.name AS stream_name FROM rules r
       LEFT JOIN categories c ON c.id = r.set_category_id LEFT JOIN streams s ON s.id = r.set_stream_id
      ORDER BY r.priority, r.id`);
  res.json(rows);
});

function readRule(body, base = {}) {
  const r = {
    name: optional(body.name) ? base.name : str(body.name, 'name', { max: 120, nullable: true }),
    priority: optional(body.priority) ? (base.priority ?? 100) : int(body.priority, 'priority', { min: 0 }),
    match: optional(body.match) ? base.match : validateMatch(body.match),
    set_category_id: optional(body.set_category_id) ? base.set_category_id : int(body.set_category_id, 'set_category_id', { nullable: true }),
    set_stream_id: optional(body.set_stream_id) ? base.set_stream_id : int(body.set_stream_id, 'set_stream_id', { nullable: true }),
    set_merchant: optional(body.set_merchant) ? base.set_merchant : str(body.set_merchant, 'set_merchant', { max: 80, nullable: true }),
    enabled: optional(body.enabled) ? (base.enabled ?? true) : Boolean(body.enabled),
  };
  if (!r.match) throw badRequest('match is required');
  if (!r.set_category_id && !r.set_stream_id && !r.set_merchant) throw badRequest('A rule has to set something');
  return r;
}

router.post('/rules', async (req, res) => {
  const r = readRule(req.body);
  const row = await tx(async (db) => {
    const { rows } = await db.query(
      `INSERT INTO rules (name, priority, match, set_category_id, set_stream_id, set_merchant, enabled)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [r.name, r.priority, JSON.stringify(r.match), r.set_category_id, r.set_stream_id, r.set_merchant, r.enabled]);
    await audit(db, { actor: req.actor, action: 'create', entity: 'rule', entityId: rows[0].id, after: rows[0] });
    return rows[0];
  });
  res.status(201).json(row);
});

router.patch('/rules/:id', async (req, res) => {
  const id = int(req.params.id, 'id');
  const row = await tx(async (db) => {
    const { rows: [b] } = await db.query('SELECT * FROM rules WHERE id = $1', [id]);
    if (!b) throw notFound('Rule not found');
    const r = readRule(req.body, b);
    const { rows } = await db.query(
      `UPDATE rules SET name=$2, priority=$3, match=$4, set_category_id=$5, set_stream_id=$6, set_merchant=$7, enabled=$8
        WHERE id=$1 RETURNING *`,
      [id, r.name, r.priority, JSON.stringify(r.match), r.set_category_id, r.set_stream_id, r.set_merchant, r.enabled]);
    await audit(db, { actor: req.actor, action: 'update', entity: 'rule', entityId: id, before: b, after: rows[0] });
    return rows[0];
  });
  res.json(row);
});

router.delete('/rules/:id', async (req, res) => {
  const id = int(req.params.id, 'id');
  await tx(async (db) => {
    const { rows: [b] } = await db.query('DELETE FROM rules WHERE id = $1 RETURNING *', [id]);
    if (!b) throw notFound('Rule not found');
    await audit(db, { actor: req.actor, action: 'delete', entity: 'rule', entityId: id, before: b });
  });
  res.json({ ok: true });
});

// Dry run: which existing transactions would this match? (Doesn't change anything.)
router.post('/rules/preview', async (req, res) => {
  const test = compile({ match: validateMatch(req.body.match) });
  const { rows } = await query(
    `SELECT id, account_id, posted_on, amount_cents, description_raw, merchant, category_id FROM transactions
      ORDER BY posted_on DESC LIMIT 5000`);
  const hits = rows.filter(test);
  res.json({ count: hits.length, uncategorized: hits.filter((t) => !t.category_id).length, sample: hits.slice(0, 15) });
});

// Fill blanks with this rule. Never overwrites categories you set.
router.post('/rules/:id/apply', async (req, res) => {
  const id = int(req.params.id, 'id');
  const applied = await tx((db) => applyRules(db, { onlyRuleId: id }));
  res.json({ applied });
});

module.exports = router;
