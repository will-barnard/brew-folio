// Period locks: once a period is closed (e.g. a filed tax year), nothing in it
// can change — so a filed return can't drift away from the ledger.
const { conflict } = require('../lib/errors');

async function lockedThrough(db, accountId) {
  const { rows } = await db.query(
    `SELECT max(l.through_date) AS through FROM period_locks l
       JOIN accounts a ON a.entity_id = l.entity_id WHERE a.id = $1`,
    [accountId],
  );
  return rows[0]?.through || null;
}

async function assertUnlocked(db, accountId, ...dates) {
  const through = await lockedThrough(db, accountId);
  if (!through) return;
  for (const d of dates) {
    if (d && d <= through) throw conflict(`Books are locked through ${through}`);
  }
}

module.exports = { lockedThrough, assertUnlocked };
