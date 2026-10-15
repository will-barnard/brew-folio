// Reporting. Every total is computed over "lines": unsplit transactions plus
// the parts of split ones, so a half-business Costco run lands half on each
// side. Transfers are excluded from income and spending by category kind.
const express = require('express');
const { query } = require('../db/pool');
const { today, monthBounds, addDays } = require('../lib/dates');
const { badRequest } = require('../lib/errors');
const { accountBalances } = require('../services/balances');

const router = express.Router();

const LINES = `
  lines AS (
    SELECT t.id, t.posted_on, t.amount_cents, t.category_id, t.stream_id, t.account_id
      FROM transactions t WHERE NOT t.is_split
    UNION ALL
    SELECT t.id, t.posted_on, s.amount_cents, s.category_id, s.stream_id, t.account_id
      FROM transaction_splits s JOIN transactions t ON t.id = s.transaction_id
  )`;

function monthParam(m) {
  const ym = m || today().slice(0, 7);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(ym)) throw badRequest('month must be YYYY-MM');
  return ym;
}

router.get('/reports/glance', async (req, res) => {
  const ym = monthParam(req.query.month);
  const { start, end } = monthBounds(ym);

  const [accounts, totals, streams, topCats, review, recent] = await Promise.all([
    accountBalances({ query }, { includeClosed: false }),
    query(
      `WITH ${LINES}
       SELECT COALESCE(sum(l.amount_cents) FILTER (WHERE c.kind = 'income'), 0)::bigint AS income_cents,
              COALESCE(-sum(l.amount_cents) FILTER (WHERE c.kind = 'expense'), 0)::bigint AS spending_cents,
              COALESCE(sum(l.amount_cents) FILTER (WHERE l.category_id IS NULL AND l.amount_cents > 0), 0)::bigint AS uncategorized_in_cents,
              COALESCE(-sum(l.amount_cents) FILTER (WHERE l.category_id IS NULL AND l.amount_cents < 0), 0)::bigint AS uncategorized_out_cents
         FROM lines l LEFT JOIN categories c ON c.id = l.category_id
        WHERE l.posted_on BETWEEN $1 AND $2`, [start, end]),
    query(
      `WITH ${LINES}
       SELECT s.id, s.name, s.kind, s.color,
              COALESCE(sum(l.amount_cents) FILTER (WHERE c.kind = 'income'), 0)::bigint AS income_cents,
              COALESCE(-sum(l.amount_cents) FILTER (WHERE c.kind = 'expense'), 0)::bigint AS expense_cents
         FROM streams s
         LEFT JOIN lines l ON l.stream_id = s.id AND l.posted_on BETWEEN $1 AND $2
         LEFT JOIN categories c ON c.id = l.category_id
        WHERE s.active
        GROUP BY s.id ORDER BY s.sort, s.id`, [start, end]),
    query(
      `WITH ${LINES}
       SELECT COALESCE(p.id, c.id) AS id, COALESCE(p.name, c.name) AS name, (-sum(l.amount_cents))::bigint AS spent_cents
         FROM lines l JOIN categories c ON c.id = l.category_id LEFT JOIN categories p ON p.id = c.parent_id
        WHERE c.kind = 'expense' AND l.posted_on BETWEEN $1 AND $2
        GROUP BY 1, 2 HAVING -sum(l.amount_cents) > 0 ORDER BY 3 DESC LIMIT 6`, [start, end]),
    query('SELECT count(*) AS n FROM transactions WHERE category_id IS NULL AND NOT is_split'),
    query(
      `SELECT t.id, t.posted_on, t.amount_cents, t.merchant, t.description_raw, t.category_id, c.name AS category_name,
              a.name AS account_name, s.name AS stream_name, s.color AS stream_color
         FROM transactions t JOIN accounts a ON a.id = t.account_id
         LEFT JOIN categories c ON c.id = t.category_id LEFT JOIN streams s ON s.id = t.stream_id
        ORDER BY t.posted_on DESC, t.id DESC LIMIT 8`),
  ]);

  const netWorth = accounts.reduce((a, x) => a + x.balance_cents, 0);
  // Staleness: an account with no data in 35+ days probably needs a fresh export.
  const staleBefore = addDays(today(), -35);
  res.json({
    month: ym,
    net_worth_cents: netWorth,
    accounts: accounts.map((a) => ({
      id: a.id, name: a.name, kind: a.kind, balance_cents: a.balance_cents, balance_basis: a.balance_basis,
      last_txn_on: a.last_txn_on, stale: !a.last_txn_on || a.last_txn_on < staleBefore,
    })),
    ...totals.rows[0],
    streams: streams.rows.map((s) => ({ ...s, net_cents: s.income_cents - s.expense_cents })),
    top_categories: topCats.rows,
    review_count: review.rows[0].n,
    recent: recent.rows,
  });
});

// Monthly in/out for the last N months.
router.get('/reports/cashflow', async (req, res) => {
  const months = Math.min(Math.max(Number(req.query.months) || 6, 1), 36);
  const endYm = today().slice(0, 7);
  const [y, m] = endYm.split('-').map(Number);
  const startDate = new Date(Date.UTC(y, m - 1 - (months - 1), 1)).toISOString().slice(0, 10);
  const { rows } = await query(
    `WITH ${LINES}
     SELECT to_char(date_trunc('month', l.posted_on), 'YYYY-MM') AS month,
            COALESCE(sum(l.amount_cents) FILTER (WHERE c.kind = 'income'), 0)::bigint AS income_cents,
            COALESCE(-sum(l.amount_cents) FILTER (WHERE c.kind = 'expense'), 0)::bigint AS spending_cents
       FROM lines l LEFT JOIN categories c ON c.id = l.category_id
      WHERE l.posted_on >= $1
      GROUP BY 1 ORDER BY 1`, [startDate]);
  res.json(rows);
});

module.exports = router;
