// Entities (books), income streams and categories — the small reference sets
// the app loads once at startup.
const express = require('express');
const { query, tx } = require('../db/pool');
const { int, str, oneOf, optional } = require('../lib/validate');
const { notFound, badRequest } = require('../lib/errors');
const { audit } = require('../services/audit');

const router = express.Router();

router.get('/reference', async (_req, res) => {
  const [entities, streams, categories] = await Promise.all([
    query('SELECT * FROM entities ORDER BY id'),
    query('SELECT * FROM streams ORDER BY sort, id'),
    // Flat list; the client builds the two-level tree from parent_id.
    query(`SELECT c.*, p.name AS parent_name FROM categories c LEFT JOIN categories p ON p.id = c.parent_id
            ORDER BY c.sort, c.id`),
  ]);
  res.json({ entities: entities.rows, streams: streams.rows, categories: categories.rows });
});

// ── entities ────────────────────────────────────────────────────────────
router.post('/entities', async (req, res) => {
  const name = str(req.body.name, 'name', { min: 1, max: 80 });
  const kind = oneOf(req.body.kind || 'llc', 'kind', ['personal', 'sole_prop', 'llc', 'other']);
  const row = await tx(async (db) => {
    const { rows } = await db.query('INSERT INTO entities (name, kind) VALUES ($1, $2) RETURNING *', [name, kind]);
    await audit(db, { actor: req.actor, action: 'create', entity: 'entity', entityId: rows[0].id, after: rows[0] });
    return rows[0];
  });
  res.status(201).json(row);
});

router.patch('/entities/:id', async (req, res) => {
  const id = int(req.params.id, 'id');
  const row = await tx(async (db) => {
    const { rows: [before] } = await db.query('SELECT * FROM entities WHERE id = $1', [id]);
    if (!before) throw notFound('Entity not found');
    const name = optional(req.body.name) ? before.name : str(req.body.name, 'name', { min: 1, max: 80 });
    const kind = optional(req.body.kind) ? before.kind : oneOf(req.body.kind, 'kind', ['personal', 'sole_prop', 'llc', 'other']);
    const { rows } = await db.query('UPDATE entities SET name = $2, kind = $3 WHERE id = $1 RETURNING *', [id, name, kind]);
    await audit(db, { actor: req.actor, action: 'update', entity: 'entity', entityId: id, before, after: rows[0] });
    return rows[0];
  });
  res.json(row);
});

// ── streams ─────────────────────────────────────────────────────────────
router.post('/streams', async (req, res) => {
  const name = str(req.body.name, 'name', { min: 1, max: 40 });
  const kind = oneOf(req.body.kind || 'schedule_c', 'kind', ['w2', 'schedule_c', 'other']);
  const entityId = req.body.entity_id ? int(req.body.entity_id, 'entity_id')
    : (await query("SELECT id FROM entities WHERE kind = 'personal' ORDER BY id LIMIT 1")).rows[0].id;
  const color = str(req.body.color, 'color', { max: 20, nullable: true });
  const row = await tx(async (db) => {
    const { rows } = await db.query(
      `INSERT INTO streams (entity_id, name, kind, color, sort)
       VALUES ($1, $2, $3, $4, (SELECT COALESCE(max(sort), 0) + 1 FROM streams)) RETURNING *`,
      [entityId, name, kind, color],
    );
    await audit(db, { actor: req.actor, action: 'create', entity: 'stream', entityId: rows[0].id, after: rows[0] });
    return rows[0];
  });
  res.status(201).json(row);
});

router.patch('/streams/:id', async (req, res) => {
  const id = int(req.params.id, 'id');
  const row = await tx(async (db) => {
    const { rows: [b] } = await db.query('SELECT * FROM streams WHERE id = $1', [id]);
    if (!b) throw notFound('Stream not found');
    const next = {
      name: optional(req.body.name) ? b.name : str(req.body.name, 'name', { min: 1, max: 40 }),
      kind: optional(req.body.kind) ? b.kind : oneOf(req.body.kind, 'kind', ['w2', 'schedule_c', 'other']),
      color: optional(req.body.color) ? b.color : str(req.body.color, 'color', { max: 20, nullable: true }),
      active: optional(req.body.active) ? b.active : Boolean(req.body.active),
      entity_id: optional(req.body.entity_id) ? b.entity_id : int(req.body.entity_id, 'entity_id'),
    };
    const { rows } = await db.query(
      'UPDATE streams SET name=$2, kind=$3, color=$4, active=$5, entity_id=$6 WHERE id=$1 RETURNING *',
      [id, next.name, next.kind, next.color, next.active, next.entity_id],
    );
    await audit(db, { actor: req.actor, action: 'update', entity: 'stream', entityId: id, before: b, after: rows[0] });
    return rows[0];
  });
  res.json(row);
});

// ── categories ──────────────────────────────────────────────────────────
router.post('/categories', async (req, res) => {
  const name = str(req.body.name, 'name', { min: 1, max: 60 });
  const parentId = req.body.parent_id ? int(req.body.parent_id, 'parent_id') : null;
  let kind = req.body.kind;
  if (parentId) {
    const { rows } = await query('SELECT kind FROM categories WHERE id = $1 AND parent_id IS NULL', [parentId]);
    if (!rows.length) throw badRequest('Parent must be a top-level category');
    kind = rows[0].kind; // children inherit — an "income" child under an expense group would break totals
  }
  oneOf(kind, 'kind', ['income', 'expense', 'transfer']);
  const row = await tx(async (db) => {
    const { rows } = await db.query(
      `INSERT INTO categories (parent_id, name, kind, tax_line, is_business, sort)
       VALUES ($1, $2, $3, $4, $5, (SELECT COALESCE(max(sort), 0) + 1 FROM categories WHERE parent_id IS NOT DISTINCT FROM $1))
       RETURNING *`,
      [parentId, name, kind, str(req.body.tax_line, 'tax_line', { max: 20, nullable: true }), Boolean(req.body.is_business)],
    );
    await audit(db, { actor: req.actor, action: 'create', entity: 'category', entityId: rows[0].id, after: rows[0] });
    return rows[0];
  });
  res.status(201).json(row);
});

router.patch('/categories/:id', async (req, res) => {
  const id = int(req.params.id, 'id');
  const row = await tx(async (db) => {
    const { rows: [b] } = await db.query('SELECT * FROM categories WHERE id = $1', [id]);
    if (!b) throw notFound('Category not found');
    const next = {
      name: optional(req.body.name) ? b.name : str(req.body.name, 'name', { min: 1, max: 60 }),
      tax_line: optional(req.body.tax_line) ? b.tax_line : str(req.body.tax_line, 'tax_line', { max: 20, nullable: true }),
      is_business: optional(req.body.is_business) ? b.is_business : Boolean(req.body.is_business),
      archived: optional(req.body.archived) ? b.archived : Boolean(req.body.archived),
    };
    if (b.system_key && next.archived) throw badRequest('Built-in categories can’t be archived');
    const { rows } = await db.query(
      'UPDATE categories SET name=$2, tax_line=$3, is_business=$4, archived=$5 WHERE id=$1 RETURNING *',
      [id, next.name, next.tax_line, next.is_business, next.archived],
    );
    await audit(db, { actor: req.actor, action: 'update', entity: 'category', entityId: id, before: b, after: rows[0] });
    return rows[0];
  });
  res.json(row);
});

module.exports = router;
