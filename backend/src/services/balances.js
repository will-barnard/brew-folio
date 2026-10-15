// Account balances = latest observed anchor (statement, CSV running balance,
// manual entry, or sync) rolled forward by every transaction after it.
// With no anchor, the balance is the plain sum of transactions — flagged as
// 'sum' so the UI can say "set a starting balance".
const { today } = require('../lib/dates');

const ANCHORS = "('statement','csv','manual','sync')";

async function accountBalances(db, { asOf = null, includeClosed = true } = {}) {
  const on = asOf || today();
  const { rows } = await db.query(
    `WITH anchor AS (
       SELECT DISTINCT ON (account_id) account_id, as_of, balance_cents, source
         FROM balance_snapshots
        WHERE source IN ${ANCHORS} AND as_of <= $1
        ORDER BY account_id, as_of DESC,
                 CASE source WHEN 'manual' THEN 0 WHEN 'sync' THEN 1 WHEN 'statement' THEN 2 ELSE 3 END
     )
     SELECT a.*, e.name AS entity_name,
            an.as_of AS anchor_on, an.source AS anchor_source,
            COALESCE(an.balance_cents, 0) + COALESCE((
              SELECT sum(t.amount_cents) FROM transactions t
               WHERE t.account_id = a.id AND t.posted_on <= $1
                 AND (an.as_of IS NULL OR t.posted_on > an.as_of)
            ), 0)::bigint AS balance_cents,
            (SELECT max(t.posted_on) FROM transactions t WHERE t.account_id = a.id) AS last_txn_on,
            (SELECT max(b.created_at) FROM import_batches b WHERE b.account_id = a.id AND b.status = 'imported') AS last_import_at
       FROM accounts a
       JOIN entities e ON e.id = a.entity_id
       LEFT JOIN anchor an ON an.account_id = a.id
      WHERE ($2 OR NOT a.is_closed)
      ORDER BY a.is_closed, a.sort, a.id`,
    [on, includeClosed],
  );
  return rows.map((r) => ({ ...r, balance_basis: r.anchor_on ? 'anchor' : 'sum' }));
}

// Nightly: record today's computed balance for every open account, so
// net-worth history exists from day one (balances can't be backfilled later).
async function snapshotAll(db) {
  const on = today();
  const accounts = await accountBalances(db, { asOf: on, includeClosed: false });
  for (const a of accounts) {
    await db.query(
      `INSERT INTO balance_snapshots (account_id, as_of, balance_cents, source)
       VALUES ($1, $2, $3, 'computed')
       ON CONFLICT (account_id, as_of, source) DO UPDATE SET balance_cents = EXCLUDED.balance_cents`,
      [a.id, on, a.balance_cents],
    );
  }
  return accounts.length;
}

module.exports = { accountBalances, snapshotAll };
