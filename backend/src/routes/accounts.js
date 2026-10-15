const express = require('express');
const { query, tx } = require('../db/pool');
const { int, str, oneOf, optional, date, cents } = require('../lib/validate');
const { notFound, badRequest } = require('../lib/errors');
const { accountBalances } = require('../services/balances');
const { audit } = require('../services/audit');

const router = express.Router();
const KINDS = ['checking', 'savings', 'credit', 'brokerage', 'retirement', 'exchange', 'wallet', 'cash', 'clearing', 'asset', 'loan'];

router.get('/accounts', async (_req, res) => {
  res.json(await accountBalances({ query }));
});

router.post('/accounts', async (req, res) => {
  const b = req.body;
  const entityId = b.entity_id ? int(b.entity_id, 'entity_id')
    : (await query("SELECT id FROM entities WHERE kind = 'personal' ORDER BY id LIMIT 1")).rows[0].id;
  const last4 = str(b.last4, 'last4', { max: 4, nullable: true });
  if (last4 && !/^\d{4}$/.test(last4)) throw badRequest('last4 must be 4 digits');
  const row = await tx(async (db) => {
    const { rows } = await db.query(
      `INSERT INTO accounts (entity_id, name, kind, institution, last4, sort)
       VALUES ($1, $2, $3, $4, $5, (SELECT COALESCE(max(sort), 0) + 1 FROM accounts)) RETURNING *`,
      [entityId, str(b.name, 'name', { min: 1, max: 80 }), oneOf(b.kind, 'kind', KINDS),
        str(b.institution, 'institution', { max: 80, nullable: true }), last4],
    );
    await audit(db, { actor: req.actor, action: 'create', entity: 'account', entityId: rows[0].id, after: rows[0] });
    return rows[0];
  });
  res.status(201).json(row);
});

router.patch('/accounts/:id', async (req, res) => {
  const id = int(req.params.id, 'id');
  const row = await tx(async (db) => {
    const { rows: [b] } = await db.query('SELECT * FROM accounts WHERE id = $1', [id]);
    if (!b) throw notFound('Account not found');
    const p = req.body;
    const next = {
      name: optional(p.name) ? b.name : str(p.name, 'name', { min: 1, max: 80 }),
      kind: optional(p.kind) ? b.kind : oneOf(p.kind, 'kind', KINDS),
      institution: optional(p.institution) ? b.institution : str(p.institution, 'institution', { max: 80, nullable: true }),
      last4: optional(p.last4) ? b.last4 : str(p.last4, 'last4', { max: 4, nullable: true }),
      entity_id: optional(p.entity_id) ? b.entity_id : int(p.entity_id, 'entity_id'),
      is_closed: optional(p.is_closed) ? b.is_closed : Boolean(p.is_closed),
    };
    if (next.last4 && !/^\d{4}$/.test(next.last4)) throw badRequest('last4 must be 4 digits');
    const { rows } = await db.query(
      `UPDATE accounts SET name=$2, kind=$3, institution=$4, last4=$5, entity_id=$6, is_closed=$7 WHERE id=$1 RETURNING *`,
      [id, next.name, next.kind, next.institution, next.last4, next.entity_id, next.is_closed],
    );
    await audit(db, { actor: req.actor, action: 'update', entity: 'account', entityId: id, before: b, after: rows[0] });
    return rows[0];
  });
  res.json(row);
});

// Manual balance anchor: "on this date the bank said X". For a card, enter
// what you owe as a negative number (or pass owed: true with a positive one).
router.post('/accounts/:id/balance', async (req, res) => {
  const id = int(req.params.id, 'id');
  let amount = cents(req.body);
  const { rows: [acct] } = await query('SELECT kind FROM accounts WHERE id = $1', [id]);
  if (!acct) throw notFound('Account not found');
  if (req.body.owed && amount > 0) amount = -amount;
  const asOf = date(req.body.as_of, 'as_of');
  await tx(async (db) => {
    await db.query(
      `INSERT INTO balance_snapshots (account_id, as_of, balance_cents, source) VALUES ($1, $2, $3, 'manual')
       ON CONFLICT (account_id, as_of, source) DO UPDATE SET balance_cents = EXCLUDED.balance_cents`,
      [id, asOf, amount],
    );
    await audit(db, { actor: req.actor, action: 'balance_anchor', entity: 'account', entityId: id, after: { as_of: asOf, balance_cents: amount } });
  });
  res.status(201).json({ ok: true });
});

// Per-statement check. Two things must hold for a month to be trusted:
//  1. the statement parsed cleanly: Σ rows = closing − opening (batch.reconciled)
//  2. the ledger has nothing extra in that period — every transaction dated
//     inside it is either from this statement or was merged with one of its
//     rows. An "extra" is usually a duplicate another source slipped past
//     dedupe, or a manual entry the bank never saw.
router.get('/accounts/:id/reconciliation', async (req, res) => {
  const id = int(req.params.id, 'id');
  // One row per statement period: the same statement downloaded twice is one month, not two.
  const { rows: batches } = await query(
    `SELECT DISTINCT ON (period_start, period_end)
            id AS batch_id, filename, parser, period_start, period_end, opening_cents, closing_cents,
            closing_cents - opening_cents AS statement_delta_cents, parsed_sum_cents, reconciled,
            array(SELECT b2.id FROM import_batches b2
                   WHERE b2.account_id = b.account_id AND b2.kind = 'pdf' AND b2.status = 'imported'
                     AND b2.period_start = b.period_start AND b2.period_end = b.period_end) AS same_period
       FROM import_batches b
      WHERE account_id = $1 AND status = 'imported' AND kind = 'pdf'
        AND opening_cents IS NOT NULL AND closing_cents IS NOT NULL
      ORDER BY period_start DESC, period_end DESC, id`,
    [id],
  );
  const out = [];
  for (const b of batches) {
    const { rows: extras } = await query(
      `SELECT t.id, t.posted_on, t.amount_cents, t.description_raw, t.source
         FROM transactions t
        WHERE t.account_id = $1 AND t.posted_on BETWEEN $2 AND $3
          AND NOT (COALESCE(t.import_batch_id, 0) = ANY($4))
          AND NOT EXISTS (SELECT 1 FROM evidence e WHERE e.transaction_id = t.id AND e.import_batch_id = ANY($4))
        ORDER BY t.posted_on LIMIT 50`,
      [id, b.period_start, b.period_end, b.same_period],
    );
    const { same_period: _s, ...row } = b;
    out.push({ ...row, extras, ok: b.reconciled === true && extras.length === 0 });
  }
  res.json(out);
});

module.exports = router;
