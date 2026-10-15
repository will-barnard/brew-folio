// The one path every source takes into the ledger:
//   normalize → dedupe (hard key, then cross-source soft match) → insert
//   → transfer detection → rules → balance anchors
// Runs inside the caller's transaction so an import is all-or-nothing.
const { normalizeMerchant } = require('./merchant');
const { detectTransfers } = require('./transfers');
const { applyRules } = require('./rules');
const { lockedThrough } = require('./locks');

const STOP = new Set(['the', 'and', 'card', 'purchase', 'payment', 'pos', 'debit', 'with', 'pin', 'recurring']);
function tokens(s) {
  return new Set(String(s).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/)
    .filter((w) => w.length >= 3 && !STOP.has(w) && !/^\d+$/.test(w)));
}
function similarity(a, b) {
  const A = tokens(a); const B = tokens(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / Math.min(A.size, B.size);
}

// rows: normalized transactions. Returns stats.
async function ingest(db, { accountId, source, rows, batchId = null, balances = [] }) {
  const stats = { parsed: rows.length, inserted: 0, duplicates: 0, merged: 0, locked: 0, transfers: 0, ruled: 0 };
  const through = await lockedThrough(db, accountId);
  const claimed = [];
  const insertedIds = [];

  for (const t of rows) {
    if (through && t.posted_on <= through) { stats.locked++; continue; }

    // 1. Same source, same id → already have it.
    const hard = await db.query(
      'SELECT id, import_batch_id FROM transactions WHERE account_id = $1 AND source = $2 AND external_id = $3',
      [accountId, source, t.external_id],
    );
    if (hard.rows.length) {
      // Same statement imported again (e.g. downloaded twice). Record that this
      // batch also vouches for the row, so undoing either copy keeps it.
      const h = hard.rows[0];
      if (batchId && h.import_batch_id !== batchId) {
        await db.query(
          `INSERT INTO evidence (transaction_id, source, external_id, import_batch_id, posted_on, amount_cents, description_raw)
           SELECT $1, $2, $3, $4, $5, $6, $7
            WHERE NOT EXISTS (SELECT 1 FROM evidence WHERE transaction_id = $1 AND import_batch_id = $4)`,
          [h.id, source, t.external_id, batchId, t.posted_on, t.amount_cents, t.description_raw],
        );
      }
      stats.duplicates++;
      continue;
    }

    // 2. Same money from a different source (CSV vs PDF vs sync) → evidence, not a new row.
    const { rows: cands } = await db.query(
      `SELECT id, description_raw, posted_on FROM transactions
        WHERE account_id = $1 AND amount_cents = $2 AND source <> $3
          AND posted_on BETWEEN ($4::date - 3) AND ($4::date + 3)
          AND NOT (id = ANY($5))
        ORDER BY abs(posted_on - $4::date), id LIMIT 5`,
      [accountId, t.amount_cents, source, t.posted_on, claimed],
    );
    const match = cands.find((c) => similarity(c.description_raw, t.description_raw) >= 0.34)
      || (cands.length === 1 && cands[0].posted_on === t.posted_on ? cands[0] : null);
    if (match) {
      // Skip if this exact evidence was already recorded (re-import of the second source).
      const ev = await db.query('SELECT 1 FROM evidence WHERE transaction_id = $1 AND source = $2 AND external_id = $3',
        [match.id, source, t.external_id]);
      if (!ev.rows.length) {
        await db.query(
          `INSERT INTO evidence (transaction_id, source, external_id, import_batch_id, posted_on, amount_cents, description_raw)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [match.id, source, t.external_id, batchId, t.posted_on, t.amount_cents, t.description_raw],
        );
        stats.merged++;
      } else {
        stats.duplicates++;
      }
      claimed.push(match.id);
      continue;
    }

    const ins = await db.query(
      `INSERT INTO transactions (account_id, posted_on, amount_cents, description_raw, merchant, status,
                                 source, external_id, import_batch_id, meta)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
      [accountId, t.posted_on, t.amount_cents, t.description_raw, normalizeMerchant(t.description_raw),
        t.status || 'posted', source, t.external_id, batchId, JSON.stringify(t.meta || {})],
    );
    insertedIds.push(ins.rows[0].id);
    claimed.push(ins.rows[0].id);
    stats.inserted++;
  }

  const tr = await detectTransfers(db, insertedIds);
  stats.transfers = tr.paired + tr.flagged;
  stats.ruled = await applyRules(db, { ids: insertedIds });

  for (const b of balances) {
    await db.query(
      `INSERT INTO balance_snapshots (account_id, as_of, balance_cents, source, import_batch_id)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (account_id, as_of, source) DO UPDATE SET balance_cents = EXCLUDED.balance_cents,
         import_batch_id = EXCLUDED.import_batch_id`,
      [accountId, b.as_of, b.balance_cents, b.source, batchId],
    );
  }

  return { stats, insertedIds };
}

module.exports = { ingest, similarity };
