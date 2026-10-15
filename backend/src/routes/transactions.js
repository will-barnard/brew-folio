const express = require('express');
const crypto = require('crypto');
const { query, tx } = require('../db/pool');
const { int, str, date, cents, optional } = require('../lib/validate');
const { notFound, badRequest, conflict } = require('../lib/errors');
const { audit } = require('../services/audit');
const { assertUnlocked } = require('../services/locks');
const { createManual } = require('../services/manual');
const { receiveUpload } = require('../services/uploads');
const storage = require('../services/storage');

const router = express.Router();
const json = express.json({ limit: '256kb' });

const SELECT = `
  SELECT t.*, a.name AS account_name, a.kind AS account_kind,
         c.name AS category_name, c.kind AS category_kind, pc.name AS category_parent,
         s.name AS stream_name, s.color AS stream_color,
         (SELECT count(*) FROM receipts r WHERE r.transaction_id = t.id) AS receipt_count,
         (SELECT count(*) FROM evidence e WHERE e.transaction_id = t.id) AS evidence_count
    FROM transactions t
    JOIN accounts a ON a.id = t.account_id
    LEFT JOIN categories c ON c.id = t.category_id
    LEFT JOIN categories pc ON pc.id = c.parent_id
    LEFT JOIN streams s ON s.id = t.stream_id`;

// ── list ────────────────────────────────────────────────────────────────
// Keyset pagination on (posted_on, id) so infinite scroll stays fast and stable.
router.get('/transactions', async (req, res) => {
  const q = req.query;
  const where = [];
  const params = [];
  const add = (sql, v) => { params.push(v); where.push(sql.replace('?', `$${params.length}`)); };
  if (q.account_id) add('t.account_id = ?', int(q.account_id, 'account_id'));
  // Parameters reused within one clause: push once, reference $n twice.
  const addSame = (sqlFn, v) => { params.push(v); where.push(sqlFn(`$${params.length}`)); };
  if (q.category_id) addSame((p) => `(t.category_id = ${p} OR c.parent_id = ${p})`, int(q.category_id, 'category_id'));
  if (q.stream_id) add('t.stream_id = ?', int(q.stream_id, 'stream_id'));
  if (q.uncategorized === '1') where.push('t.category_id IS NULL AND NOT t.is_split');
  if (q.from) add('t.posted_on >= ?', date(q.from, 'from'));
  if (q.to) add('t.posted_on <= ?', date(q.to, 'to'));
  if (q.import_batch_id) add('t.import_batch_id = ?', int(q.import_batch_id, 'import_batch_id'));
  if (q.q) {
    const term = `%${String(q.q).slice(0, 80).replace(/[%_\\]/g, '\\$&')}%`;
    addSame((p) => `(t.description_raw ILIKE ${p} OR t.merchant ILIKE ${p} OR t.notes ILIKE ${p})`, term);
  }
  if (q.before_date && q.before_id) {
    params.push(date(q.before_date, 'before_date'), int(q.before_id, 'before_id'));
    where.push(`(t.posted_on, t.id) < ($${params.length - 1}, $${params.length})`);
  }
  const limit = Math.min(Number(q.limit) || 50, 200);
  params.push(limit);
  const { rows } = await query(
    `${SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY t.posted_on DESC, t.id DESC LIMIT $${params.length}`,
    params,
  );
  res.json({ rows, next: rows.length === limit ? { before_date: rows.at(-1).posted_on, before_id: rows.at(-1).id } : null });
});

router.get('/transactions/:id', async (req, res) => {
  const id = int(req.params.id, 'id');
  const { rows: [t] } = await query(`${SELECT} WHERE t.id = $1`, [id]);
  if (!t) throw notFound('Transaction not found');
  const [splits, evidence, receipts, partner, history] = await Promise.all([
    query('SELECT * FROM transaction_splits WHERE transaction_id = $1 ORDER BY id', [id]),
    query('SELECT * FROM evidence WHERE transaction_id = $1 ORDER BY id', [id]),
    query('SELECT id, filename, mime, bytes, created_at FROM receipts WHERE transaction_id = $1 ORDER BY id', [id]),
    t.transfer_group_id
      ? query(`${SELECT} WHERE t.transfer_group_id = $1 AND t.id <> $2`, [t.transfer_group_id, id])
      : Promise.resolve({ rows: [] }),
    query(`SELECT at, actor, action FROM audit_log WHERE entity = 'transaction' AND entity_id = $1 ORDER BY at DESC LIMIT 20`, [String(id)]),
  ]);
  res.json({ ...t, splits: splits.rows, evidence: evidence.rows, receipts: receipts.rows, transfer_partner: partner.rows[0] || null, history: history.rows });
});

// ── create / edit ───────────────────────────────────────────────────────
router.post('/transactions', json, async (req, res) => {
  const b = req.body;
  const row = await tx((db) => createManual(db, {
    account_id: int(b.account_id, 'account_id'),
    amount_cents: cents(b),
    description: str(b.description, 'description', { min: 1, max: 200 }),
    posted_on: b.posted_on ? date(b.posted_on, 'posted_on') : undefined,
    category_id: b.category_id ? int(b.category_id, 'category_id') : null,
    stream_id: b.stream_id ? int(b.stream_id, 'stream_id') : null,
    notes: str(b.notes, 'notes', { max: 1000, nullable: true }),
  }, req.actor));
  res.status(201).json(row);
});

router.patch('/transactions/:id', json, async (req, res) => {
  const id = int(req.params.id, 'id');
  const p = req.body;
  const row = await tx(async (db) => {
    const { rows: [b] } = await db.query('SELECT * FROM transactions WHERE id = $1 FOR UPDATE', [id]);
    if (!b) throw notFound('Transaction not found');
    const isManual = b.source === 'manual';
    // Bank-sourced facts (date, amount, description) are evidence, not opinion — only manual rows can change them.
    if (!isManual && (!optional(p.posted_on) || !optional(p.amount) || !optional(p.amount_cents) || !optional(p.description_raw))) {
      throw badRequest('Date, amount and description come from the bank and can’t be edited — add a note instead');
    }
    const next = {
      category_id: optional(p.category_id) ? b.category_id : int(p.category_id, 'category_id', { nullable: true }),
      stream_id: optional(p.stream_id) ? b.stream_id : int(p.stream_id, 'stream_id', { nullable: true }),
      notes: optional(p.notes) ? b.notes : str(p.notes, 'notes', { max: 1000, nullable: true }),
      merchant: optional(p.merchant) ? b.merchant : str(p.merchant, 'merchant', { max: 80, nullable: true }),
      posted_on: optional(p.posted_on) ? b.posted_on : date(p.posted_on, 'posted_on'),
      amount_cents: optional(p.amount) && optional(p.amount_cents) ? b.amount_cents : cents(p),
      description_raw: optional(p.description_raw) ? b.description_raw : str(p.description_raw, 'description', { min: 1, max: 200 }),
    };
    await assertUnlocked(db, b.account_id, b.posted_on, next.posted_on);
    if (b.is_split && next.category_id) throw conflict('This transaction is split — edit the splits instead');
    const categoryChanged = next.category_id !== b.category_id || next.stream_id !== b.stream_id;
    const { rows } = await db.query(
      `UPDATE transactions SET category_id=$2, stream_id=$3, notes=$4, merchant=$5, posted_on=$6, amount_cents=$7,
              description_raw=$8,
              categorized_by = CASE WHEN $9 THEN (CASE WHEN $2::int IS NULL THEN NULL ELSE 'user' END) ELSE categorized_by END,
              rule_id = CASE WHEN $9 THEN NULL ELSE rule_id END,
              updated_at = now()
        WHERE id = $1 RETURNING *`,
      [id, next.category_id, next.stream_id, next.notes, next.merchant, next.posted_on, next.amount_cents,
        next.description_raw, categoryChanged],
    );
    if (categoryChanged) {
      await db.query("UPDATE ai_suggestions SET status = 'superseded' WHERE transaction_id = $1 AND status = 'pending'", [id]);
    }
    await audit(db, { actor: req.actor, action: 'update', entity: 'transaction', entityId: id, before: b, after: rows[0] });
    return rows[0];
  });
  res.json(row);
});

router.delete('/transactions/:id', async (req, res) => {
  const id = int(req.params.id, 'id');
  await tx(async (db) => {
    const { rows: [b] } = await db.query('SELECT * FROM transactions WHERE id = $1', [id]);
    if (!b) throw notFound('Transaction not found');
    if (b.source !== 'manual') throw badRequest('Only manual entries can be deleted — undo the import instead');
    await assertUnlocked(db, b.account_id, b.posted_on);
    await db.query('DELETE FROM transactions WHERE id = $1', [id]);
    await audit(db, { actor: req.actor, action: 'delete', entity: 'transaction', entityId: id, before: b });
  });
  res.json({ ok: true });
});

// ── splits ──────────────────────────────────────────────────────────────
// Replace all splits. Parts must sum exactly to the transaction. An empty
// list un-splits it.
router.put('/transactions/:id/splits', json, async (req, res) => {
  const id = int(req.params.id, 'id');
  const parts = Array.isArray(req.body.splits) ? req.body.splits : null;
  if (!parts) throw badRequest('splits must be an array');
  const result = await tx(async (db) => {
    const { rows: [t] } = await db.query('SELECT * FROM transactions WHERE id = $1 FOR UPDATE', [id]);
    if (!t) throw notFound('Transaction not found');
    await assertUnlocked(db, t.account_id, t.posted_on);
    const clean = parts.map((s, i) => ({
      amount_cents: cents(s),
      category_id: s.category_id ? int(s.category_id, `splits[${i}].category_id`) : null,
      stream_id: s.stream_id ? int(s.stream_id, `splits[${i}].stream_id`) : null,
      notes: str(s.notes, 'notes', { max: 300, nullable: true }),
    }));
    if (clean.length === 1) throw badRequest('A split needs at least two parts');
    const sum = clean.reduce((a, s) => a + s.amount_cents, 0);
    if (clean.length && sum !== t.amount_cents) {
      throw badRequest(`Parts add up to ${(sum / 100).toFixed(2)}, transaction is ${(t.amount_cents / 100).toFixed(2)}`);
    }
    const before = (await db.query('SELECT * FROM transaction_splits WHERE transaction_id = $1', [id])).rows;
    await db.query('DELETE FROM transaction_splits WHERE transaction_id = $1', [id]);
    for (const s of clean) {
      await db.query('INSERT INTO transaction_splits (transaction_id, amount_cents, category_id, stream_id, notes) VALUES ($1,$2,$3,$4,$5)',
        [id, s.amount_cents, s.category_id, s.stream_id, s.notes]);
    }
    await db.query(
      `UPDATE transactions SET is_split = $2, category_id = CASE WHEN $2 THEN NULL ELSE category_id END,
              stream_id = CASE WHEN $2 THEN NULL ELSE stream_id END,
              categorized_by = CASE WHEN $2 THEN 'user' ELSE categorized_by END, updated_at = now() WHERE id = $1`,
      [id, clean.length > 0],
    );
    await audit(db, { actor: req.actor, action: 'split', entity: 'transaction', entityId: id, before, after: clean });
    return clean;
  });
  res.json({ splits: result });
});

// ── transfers ───────────────────────────────────────────────────────────
// Pair two rows as one transfer by hand (detection missed it).
router.post('/transactions/:id/transfer', json, async (req, res) => {
  const id = int(req.params.id, 'id');
  const partnerId = int(req.body.partner_id, 'partner_id');
  await tx(async (db) => {
    const { rows } = await db.query(
      `SELECT t.*, a.kind AS account_kind FROM transactions t JOIN accounts a ON a.id = t.account_id
        WHERE t.id = ANY($1) FOR UPDATE OF t`, [[id, partnerId]]);
    if (rows.length !== 2) throw notFound('Both transactions must exist');
    const [x, y] = rows;
    if (x.account_id === y.account_id) throw badRequest('A transfer is between two different accounts');
    if (x.amount_cents !== -y.amount_cents) throw badRequest('Transfer sides must be equal and opposite');
    const key = x.account_kind === 'credit' || y.account_kind === 'credit' ? 'cc_payment' : 'transfer';
    const { rows: [cat] } = await db.query('SELECT id FROM categories WHERE system_key = $1', [key]);
    await db.query(
      `UPDATE transactions SET transfer_group_id = $2, category_id = $3, stream_id = NULL, is_split = false,
              categorized_by = 'user', updated_at = now() WHERE id = ANY($1)`,
      [[id, partnerId], crypto.randomUUID(), cat.id]);
    await audit(db, { actor: req.actor, action: 'pair_transfer', entity: 'transaction', entityId: id, after: { partner_id: partnerId } });
  });
  res.json({ ok: true });
});

router.delete('/transactions/:id/transfer', async (req, res) => {
  const id = int(req.params.id, 'id');
  await tx(async (db) => {
    const { rows: [t] } = await db.query('SELECT transfer_group_id FROM transactions WHERE id = $1', [id]);
    if (!t) throw notFound('Transaction not found');
    if (!t.transfer_group_id) throw badRequest('Not part of a transfer');
    await db.query(
      `UPDATE transactions SET transfer_group_id = NULL, category_id = NULL, categorized_by = NULL, updated_at = now()
        WHERE transfer_group_id = $1`, [t.transfer_group_id]);
    await audit(db, { actor: req.actor, action: 'unpair_transfer', entity: 'transaction', entityId: id });
  });
  res.json({ ok: true });
});

// Candidates for manual pairing: equal and opposite, other accounts, ±10 days.
router.get('/transactions/:id/transfer-candidates', async (req, res) => {
  const id = int(req.params.id, 'id');
  const { rows: [t] } = await query('SELECT * FROM transactions WHERE id = $1', [id]);
  if (!t) throw notFound('Transaction not found');
  const { rows } = await query(
    `${SELECT} WHERE t.account_id <> $1 AND t.amount_cents = $2 AND t.transfer_group_id IS NULL
        AND t.posted_on BETWEEN ($3::date - 10) AND ($3::date + 10)
      ORDER BY abs(t.posted_on - $3::date) LIMIT 10`,
    [t.account_id, -t.amount_cents, t.posted_on]);
  res.json(rows);
});

// ── receipts ────────────────────────────────────────────────────────────
// Raw body upload (image or PDF), no JSON parser on this route.
router.post('/transactions/:id/receipts', async (req, res) => {
  const id = int(req.params.id, 'id');
  const { rows: [t] } = await query('SELECT id FROM transactions WHERE id = $1', [id]);
  if (!t) throw notFound('Transaction not found');
  const up = await receiveUpload(req);
  try {
    if (!/^(image\/|application\/pdf)/.test(up.mime)) throw badRequest('Receipts must be an image or PDF');
    const key = await storage.putFile(`receipts/${up.sha256}`, up.path, { contentType: up.mime });
    const { rows } = await query(
      `INSERT INTO receipts (transaction_id, storage_key, filename, mime, bytes) VALUES ($1,$2,$3,$4,$5)
       RETURNING id, filename, mime, bytes, created_at`, [id, key, up.filename, up.mime, up.bytes]);
    res.status(201).json(rows[0]);
  } finally {
    await up.cleanup();
  }
});

router.get('/receipts', async (req, res) => {
  const unattached = req.query.unattached === '1';
  const { rows } = await query(
    `SELECT id, transaction_id, filename, mime, bytes, origin, created_at FROM receipts
      ${unattached ? 'WHERE transaction_id IS NULL' : ''} ORDER BY created_at DESC LIMIT 100`);
  res.json(rows);
});

router.get('/receipts/:id/file', async (req, res) => {
  const id = int(req.params.id, 'id');
  const { rows: [r] } = await query('SELECT * FROM receipts WHERE id = $1', [id]);
  if (!r) throw notFound('Receipt not found');
  const buf = await storage.getFile(r.storage_key);
  res.setHeader('Content-Type', r.mime || 'application/octet-stream');
  res.setHeader('Content-Disposition', `inline; filename="${(r.filename || 'receipt').replace(/"/g, '')}"`);
  res.setHeader('Cache-Control', 'private, max-age=300');
  res.end(buf);
});

router.patch('/receipts/:id', json, async (req, res) => {
  const id = int(req.params.id, 'id');
  const txnId = int(req.body.transaction_id, 'transaction_id', { nullable: true });
  const { rows } = await query('UPDATE receipts SET transaction_id = $2 WHERE id = $1 RETURNING id, transaction_id', [id, txnId]);
  if (!rows.length) throw notFound('Receipt not found');
  res.json(rows[0]);
});

router.delete('/receipts/:id', async (req, res) => {
  const id = int(req.params.id, 'id');
  const { rows: [r] } = await query('DELETE FROM receipts WHERE id = $1 RETURNING storage_key', [id]);
  if (!r) throw notFound('Receipt not found');
  // Content-addressed key: another receipt row may share the blob.
  const { rows } = await query('SELECT 1 FROM receipts WHERE storage_key = $1 LIMIT 1', [r.storage_key]);
  if (!rows.length) await storage.deleteFile(r.storage_key).catch((e) => console.warn('[receipts] delete blob', e.message));
  res.json({ ok: true });
});

module.exports = router;
