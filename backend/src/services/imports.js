// Import batches: upload → parse → preview → commit → (optionally) undo.
// Parsing happens at upload so the preview shows exactly what commit will do;
// nothing touches the ledger until commit.
const { query, tx } = require('../db/pool');
const { parseFile } = require('../connectors');
const storage = require('./storage');
const { ingest } = require('./ingest');
const { audit } = require('./audit');
const { lockedThrough } = require('./locks');
const quotes = require('./quotes');
const { conflict, notFound, badRequest } = require('../lib/errors');

const COMPATIBLE = {
  checking: ['checking', 'savings'],
  savings: ['checking', 'savings'],
  credit: ['credit'],
  loan: ['loan'],
  brokerage: ['brokerage', 'retirement'],
  retirement: ['brokerage', 'retirement'],
};

async function guessAccount({ last4, accountKind }, db = { query }) {
  if (!last4) return null;
  const kinds = COMPATIBLE[accountKind] || [];
  const { rows } = await db.query(
    'SELECT id FROM accounts WHERE last4 = $1 AND kind = ANY($2) AND NOT is_closed ORDER BY id', [last4, kinds]);
  return rows.length === 1 ? rows[0].id : null;
}

// Returns { batches: [...] } — one per account in the file (a consolidated
// statement covers checking and savings together) — or, for inbox files that
// aren't statements, { notStatement: error }.
async function createBatch(up, { origin = 'web', accountId = null } = {}) {
  // Sub-batches of one file are keyed sha, sha:1, sha:2 … (one per account).
  // Re-uploading only recreates the accounts whose batch was undone.
  const { rows: existing } = await query(
    `SELECT id, sha256, filename FROM import_batches
      WHERE (sha256 = $1 OR sha256 LIKE $1 || ':%') AND status <> 'failed' ORDER BY id`, [up.sha256]);
  const taken = new Set(existing.map((r) => r.sha256));

  let parsedList = null;
  let error = null;
  try {
    parsedList = await parseFile(up);
  } catch (err) {
    if (!err.status || err.status >= 500) throw err;
    error = err.message;
  }
  if (error && origin === 'inbox') return { notStatement: error };

  const items = parsedList || [null];
  const keyOf = (i) => (i === 0 ? up.sha256 : `${up.sha256}:${i}`);
  if (existing.length && items.every((_, i) => taken.has(keyOf(i)))) {
    throw conflict(`Already uploaded as “${existing[0].filename}”`, { batch_id: existing[0].id });
  }
  const storageKey = await storage.putFile(`statements/${up.sha256}`, up.path, { contentType: up.mime });
  const kind = /pdf/i.test(up.mime) || parsedList?.[0]?.kind === 'pdf' ? 'pdf' : 'csv';
  const ids = [];
  for (let i = 0; i < items.length; i++) {
    if (taken.has(keyOf(i))) continue;
    const parsed = items[i];
    // An explicit account only makes sense for a single-account file.
    const account = (items.length === 1 && accountId) || (parsed ? await guessAccount(parsed) : null);
    const { rows: [batch] } = await query(
      `INSERT INTO import_batches (origin, kind, parser, filename, mime, storage_key, sha256, bytes, account_id,
                                   detected_last4, detected_kind, status, period_start, period_end, opening_cents,
                                   closing_cents, parsed_sum_cents, reconciled, parsed, warnings, error)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21) RETURNING id`,
      [origin, parsed?.kind || kind, parsed?.parser || null, up.filename, up.mime, storageKey,
        keyOf(i), up.bytes, account,
        parsed?.last4 || null, parsed?.accountKind || null, parsed ? 'parsed' : 'failed',
        parsed?.period_start || null, parsed?.period_end || null, parsed?.opening_cents ?? null,
        parsed?.closing_cents ?? null, parsed?.parsed_sum_cents ?? null, parsed?.reconciled ?? null,
        parsed ? JSON.stringify({
          source: parsed.source, transactions: parsed.transactions, balances: parsed.balances, account_label: parsed.accountLabel || null,
          institution: parsed.institution || 'Chase', positions: parsed.positions || null, as_of: parsed.period_end,
        }) : null,
        JSON.stringify(parsed?.warnings || []), error],
    );
    ids.push(batch.id);
  }
  const batches = [];
  for (const id of ids) batches.push(await getBatch(id));
  return { batches };
}

async function getBatch(id, { previewRows = 25 } = {}) {
  const { rows: [b] } = await query(
    `SELECT b.*, a.name AS account_name, a.kind AS account_kind FROM import_batches b
       LEFT JOIN accounts a ON a.id = b.account_id WHERE b.id = $1`, [id]);
  if (!b) throw notFound('Import not found');
  const rows = b.parsed?.transactions || [];
  const { parsed, ...rest } = b;
  const base = b.sha256.split(':')[0];
  const { rows: sib } = await query(
    `SELECT id, detected_kind, detected_last4, status FROM import_batches
      WHERE (sha256 = $1 OR sha256 LIKE $1 || ':%') AND id <> $2 ORDER BY id`, [base, id]);
  return {
    ...rest, row_count: parsed?.positions ? parsed.positions.length : rows.length, preview: rows.slice(0, previewRows),
    positions_preview: parsed?.positions || null,
    account_label: parsed?.account_label || null, institution: parsed?.institution || null,
    balances: parsed?.balances || [], siblings: sib,
  };
}

async function commitBatch(id, { accountId = null, force = false, actor }) {
  return tx(async (db) => {
    const { rows: [b] } = await db.query('SELECT * FROM import_batches WHERE id = $1 FOR UPDATE', [id]);
    if (!b) throw notFound('Import not found');
    if (b.status !== 'parsed') throw conflict(`This import is ${b.status}`);
    // Uploaded before its account existed? Match it now by last 4 digits.
    const acctId = accountId || b.account_id
      || await guessAccount({ last4: b.detected_last4, accountKind: b.detected_kind }, db);
    if (!acctId) throw badRequest('Choose which account this file belongs to');
    const { rows: [acct] } = await db.query('SELECT * FROM accounts WHERE id = $1', [acctId]);
    if (!acct) throw badRequest('Account not found');
    const compatible = COMPATIBLE[b.detected_kind] || [];
    if (b.detected_kind && !compatible.includes(acct.kind) && !force) {
      throw conflict(`This file looks like a ${b.detected_kind} account but “${acct.name}” is ${acct.kind}`, { needsForce: true });
    }
    if (b.detected_last4 && acct.last4 && b.detected_last4 !== acct.last4 && !force) {
      throw conflict(`File is for account ending ${b.detected_last4}, “${acct.name}” ends ${acct.last4}`, { needsForce: true });
    }
    if (b.detected_last4 && !acct.last4) {
      await db.query('UPDATE accounts SET last4 = $2 WHERE id = $1', [acctId, b.detected_last4]);
    }

    const stats = b.parsed.positions
      ? await replacePositions(db, { accountId: acctId, parsed: b.parsed, force })
      : (await ingest(db, {
        accountId: acctId,
        source: b.parsed.source,
        rows: b.parsed.transactions,
        batchId: id,
        balances: b.parsed.balances,
      })).stats;
    await db.query(
      `UPDATE import_batches SET status = 'imported', account_id = $2, stats = $3, parsed = NULL, imported_at = now()
        WHERE id = $1`, [id, acctId, JSON.stringify(stats)]);
    await audit(db, { actor, action: 'import', entity: 'import_batch', entityId: id, after: stats });
    return stats;
  });
}

// A positions import (Fidelity statement / CSV) replaces the account's holdings
// wholesale — the file is the full picture as of its date. The previous
// holdings are kept in the batch's stats so an undo can put them back.
async function replacePositions(db, { accountId, parsed, force }) {
  const asOf = parsed.as_of;
  const { rows: current } = await db.query('SELECT * FROM positions WHERE account_id = $1 ORDER BY id', [accountId]);
  const newest = current.map((p) => p.as_of).filter(Boolean).sort().at(-1);
  if (newest && asOf && newest > asOf && !force) {
    throw conflict(`This account’s positions are newer (as of ${newest}) than this file (${asOf})`, { needsForce: true });
  }
  await db.query('DELETE FROM positions WHERE account_id = $1', [accountId]);
  const source = parsed.source === 'fidelity-csv' ? 'fidelity-csv' : 'fidelity-pdf';
  for (const p of parsed.positions) {
    await db.query(
      `INSERT INTO positions (account_id, symbol, name, asset_type, quantity, cost_basis_cents, source, as_of)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (account_id, symbol) DO UPDATE SET quantity = positions.quantity + EXCLUDED.quantity`,
      [accountId, p.symbol, p.name, p.asset_type, p.quantity, p.cost_basis_cents, source, asOf]);
    await quotes.saveImportedQuote(db, p.symbol, p.asset_type, p.last_price, asOf, source);
  }
  return {
    positions: parsed.positions.length,
    value_cents: parsed.positions.reduce((t, p) => t + (p.value_cents || 0), 0),
    as_of: asOf,
    previous: current.map(({ id: _i, account_id: _a, updated_at: _u, ...rest }) => rest),
  };
}

async function restorePositions(db, b) {
  const { rows: later } = await db.query(
    `SELECT 1 FROM import_batches WHERE account_id = $1 AND status = 'imported' AND id > $2
        AND stats ? 'positions' LIMIT 1`, [b.account_id, b.id]);
  if (later.length) throw conflict('A newer positions import exists for this account — undo that one first');
  await db.query('DELETE FROM positions WHERE account_id = $1', [b.account_id]);
  for (const p of b.stats.previous || []) {
    await db.query(
      `INSERT INTO positions (account_id, symbol, name, asset_type, quantity, cost_basis_cents, manual_price, source, as_of)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [b.account_id, p.symbol, p.name, p.asset_type, p.quantity, p.cost_basis_cents, p.manual_price, p.source, p.as_of]);
  }
  return (b.stats.previous || []).length;
}

// Remove a batch and everything it put in the ledger. If another source
// confirmed one of its rows (evidence), that evidence is promoted to be the
// row instead of being lost with it.
async function undoBatch(id, { actor }) {
  const result = await tx(async (db) => {
    const { rows: [b] } = await db.query('SELECT * FROM import_batches WHERE id = $1 FOR UPDATE', [id]);
    if (!b) throw notFound('Import not found');
    let removed = 0;
    let promoted = 0;
    if (b.status === 'imported' && b.stats?.positions !== undefined) {
      promoted = await restorePositions(db, b); // "promoted" = previous holdings put back
    } else if (b.status === 'imported') {
      const through = await lockedThrough(db, b.account_id);
      if (through) {
        const { rows } = await db.query('SELECT 1 FROM transactions WHERE import_batch_id = $1 AND posted_on <= $2 LIMIT 1', [id, through]);
        if (rows.length) throw conflict(`Some of these rows are in books locked through ${through}`);
      }
      const { rows: txns } = await db.query('SELECT id, transfer_group_id FROM transactions WHERE import_batch_id = $1', [id]);
      for (const t of txns) {
        const { rows: [ev] } = await db.query(
          `SELECT * FROM evidence WHERE transaction_id = $1 AND import_batch_id IS DISTINCT FROM $2 ORDER BY id LIMIT 1`, [t.id, id]);
        if (ev) {
          await db.query(
            `UPDATE transactions SET source = $2, external_id = $3, import_batch_id = $4, posted_on = $5,
                    description_raw = $6, updated_at = now() WHERE id = $1`,
            [t.id, ev.source, ev.external_id, ev.import_batch_id, ev.posted_on, ev.description_raw]);
          await db.query('DELETE FROM evidence WHERE id = $1', [ev.id]);
          promoted++;
          continue;
        }
        if (t.transfer_group_id) {
          await db.query(
            `UPDATE transactions SET transfer_group_id = NULL,
                    category_id = CASE WHEN categorized_by = 'transfer' THEN NULL ELSE category_id END,
                    categorized_by = CASE WHEN categorized_by = 'transfer' THEN NULL ELSE categorized_by END
              WHERE transfer_group_id = $1 AND id <> $2`, [t.transfer_group_id, t.id]);
        }
        await db.query('DELETE FROM transactions WHERE id = $1', [t.id]);
        removed++;
      }
    }
    await db.query('DELETE FROM import_batches WHERE id = $1', [id]); // cascades evidence + balance anchors from this batch
    await audit(db, { actor, action: 'undo_import', entity: 'import_batch', entityId: id, before: { filename: b.filename, status: b.status }, after: { removed, promoted } });
    return { removed, promoted, storageKey: b.storage_key, sha: b.sha256 };
  });
  // Keys are content-addressed, so a failed earlier attempt at the same file
  // shares the blob — only delete it when nothing references it any more.
  const { rows: still } = await query('SELECT 1 FROM import_batches WHERE storage_key = $1 LIMIT 1', [result.storageKey]);
  if (result.storageKey && !still.length) {
    await storage.deleteFile(result.storageKey).catch((e) => console.warn('[imports] could not delete file', e.message));
  }
  return { removed: result.removed, promoted: result.promoted };
}

module.exports = { createBatch, getBatch, commitBatch, undoBatch };
