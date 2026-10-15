// The review queue: everything nothing else could categorize, one at a time,
// with suggestions as buttons. Every pick can become a rule so the queue
// shrinks over time.
//
// Suggestion sources, best first:
//   history — what you picked for this merchant before
//   ai      — dry-dock (Phase 2; rows in ai_suggestions)
//   bank    — Chase's own category on card rows, mapped to ours
const express = require('express');
const { query, tx } = require('../db/pool');
const { int } = require('../lib/validate');
const { notFound, badRequest } = require('../lib/errors');
const { applyRules } = require('../services/rules');
const { audit } = require('../services/audit');

const router = express.Router();
router.use(express.json({ limit: '32kb' }));

// Chase card "Category" → our category name.
const CHASE_MAP = {
  'Food & Drink': 'Restaurants', Groceries: 'Groceries', Gas: 'Gas', Travel: 'Travel', Shopping: 'Shopping',
  'Bills & Utilities': 'Utilities', Entertainment: 'Entertainment', 'Health & Wellness': 'Health',
  Personal: 'Personal care', Home: 'Household supplies', Automotive: 'Auto maintenance',
  'Gifts & Donations': 'Gifts & donations', Education: 'Education', 'Professional Services': 'Legal & professional',
  'Fees & Adjustments': 'Bank fees',
};

async function suggestionsFor(t, catByName) {
  const out = [];
  const seen = new Set();
  const push = (s) => {
    const key = `${s.category_id}:${s.stream_id || ''}`;
    if (!s.category_id || seen.has(key)) return;
    seen.add(key); out.push(s);
  };
  if (t.merchant) {
    const { rows } = await query(
      `SELECT category_id, stream_id, count(*) AS n FROM transactions
        WHERE lower(merchant) = lower($1) AND category_id IS NOT NULL AND id <> $2
          AND categorized_by IN ('user','rule')
        GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 3`, [t.merchant, t.id]);
    rows.forEach((r) => push({ source: 'history', category_id: r.category_id, stream_id: r.stream_id, note: `${r.n}× before` }));
  }
  const { rows: ai } = await query(
    `SELECT category_id, stream_id, confidence, reason FROM ai_suggestions
      WHERE transaction_id = $1 AND status = 'pending' ORDER BY confidence DESC NULLS LAST LIMIT 3`, [t.id]);
  ai.forEach((r) => push({ source: 'ai', category_id: r.category_id, stream_id: r.stream_id, confidence: r.confidence, note: r.reason }));
  const bank = t.meta?.chase_category && CHASE_MAP[t.meta.chase_category];
  if (bank && catByName.has(bank)) push({ source: 'bank', category_id: catByName.get(bank), stream_id: null, note: t.meta.chase_category });
  return out.slice(0, 4);
}

router.get('/review', async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 20, 50);
  const [{ rows }, { rows: [{ n }] }, { rows: cats }] = await Promise.all([
    query(
      `SELECT t.*, a.name AS account_name, a.kind AS account_kind FROM transactions t JOIN accounts a ON a.id = t.account_id
        WHERE t.category_id IS NULL AND NOT t.is_split
        ORDER BY t.posted_on DESC, t.id DESC LIMIT $1`, [limit]),
    query('SELECT count(*) AS n FROM transactions WHERE category_id IS NULL AND NOT is_split'),
    query('SELECT id, name FROM categories WHERE parent_id IS NOT NULL AND NOT archived'),
  ]);
  const catByName = new Map(cats.map((c) => [c.name, c.id]));
  const items = [];
  for (const t of rows) items.push({ ...t, suggestions: await suggestionsFor(t, catByName) });
  res.json({ total: n, items });
});

// Resolve one. Optional rule: { scope: 'merchant' } → "always do this for <merchant>",
// applied immediately to the rest of the queue.
router.post('/review/:id', async (req, res) => {
  const id = int(req.params.id, 'id');
  const categoryId = int(req.body.category_id, 'category_id');
  const streamId = req.body.stream_id ? int(req.body.stream_id, 'stream_id') : null;
  const scope = req.body.rule?.scope || null;
  const result = await tx(async (db) => {
    const { rows: [t] } = await db.query('SELECT * FROM transactions WHERE id = $1 FOR UPDATE', [id]);
    if (!t) throw notFound('Transaction not found');
    const { rows: [cat] } = await db.query('SELECT id, kind FROM categories WHERE id = $1', [categoryId]);
    if (!cat) throw badRequest('Unknown category');
    await db.query(
      `UPDATE transactions SET category_id = $2, stream_id = $3, categorized_by = 'user', rule_id = NULL, updated_at = now()
        WHERE id = $1`, [id, categoryId, streamId]);
    await db.query(
      `UPDATE ai_suggestions SET status = CASE WHEN category_id = $2 THEN 'accepted' ELSE 'rejected' END
        WHERE transaction_id = $1 AND status = 'pending'`, [id, categoryId]);
    await audit(db, { actor: req.actor, action: 'review', entity: 'transaction', entityId: id,
      before: { category_id: t.category_id, stream_id: t.stream_id }, after: { category_id: categoryId, stream_id: streamId } });

    let rule = null;
    let applied = 0;
    if (scope === 'merchant') {
      if (!t.merchant) throw badRequest('No merchant name to build a rule from');
      const match = { merchant: t.merchant };
      // Direction matters for merchants that both charge and refund.
      match.direction = t.amount_cents < 0 ? 'out' : 'in';
      const { rows: [r] } = await db.query(
        `INSERT INTO rules (name, match, set_category_id, set_stream_id, created_from_txn)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [`${t.merchant} (${match.direction})`, JSON.stringify(match), categoryId, streamId, id]);
      rule = r;
      applied = await applyRules(db, { onlyRuleId: r.id });
      await audit(db, { actor: req.actor, action: 'create', entity: 'rule', entityId: r.id, after: r });
    }
    return { rule, applied };
  });
  res.json(result);
});

module.exports = router;
