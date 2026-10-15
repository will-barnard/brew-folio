// Chase "Download account activity" CSVs.
//
// Checking:  Details,Posting Date,Description,Amount,Type,Balance,Check or Slip #
//   - newest first; Amount already signed; Balance is the running balance
//   - rows often carry a trailing comma (one more field than the header) — harmless,
//     we map by header name
// Card:      Transaction Date,Post Date,Description,Category,Type,Amount,Memo
//   - Amount: purchases negative, payments/returns positive (matches our convention)
//
// Account last4 comes from the filename Chase uses: Chase1234_Activity_20261014.CSV
//
// UNVERIFIED against Will's real exports until samples/ is populated — column
// names are from Chase's published format. Unknown headers fail loudly rather
// than guessing.
const { parseCsv } = require('../lib/csv');
const { toCents } = require('../lib/money');
const { fromUS } = require('../lib/dates');
const { makeExternalIds, summarize } = require('./util');
const { unprocessable } = require('../lib/errors');

const CHECKING = ['details', 'posting date', 'description', 'amount', 'type', 'balance'];
const CARD = ['transaction date', 'post date', 'description', 'category', 'type', 'amount'];

function headerIndex(header) {
  const idx = {};
  header.forEach((h, i) => { idx[h.trim().toLowerCase()] = i; });
  return idx;
}

function sniff(text) {
  const first = text.replace(/^﻿/, '').split(/\r?\n/, 1)[0].toLowerCase();
  if (CHECKING.every((h) => first.includes(h))) return 'checking';
  if (CARD.every((h) => first.includes(h))) return 'credit';
  return null;
}

function last4FromFilename(name) {
  const m = String(name || '').match(/chase(\d{4})_activity/i);
  return m ? m[1] : null;
}

function parse(text, { filename } = {}) {
  const accountKind = sniff(text);
  if (!accountKind) throw unprocessable('Not a recognised Chase CSV (header didn’t match checking or card format)');
  const [header, ...rows] = parseCsv(text);
  const ix = headerIndex(header);
  const col = (r, name) => (r[ix[name]] ?? '').trim();
  const warnings = [];
  const transactions = [];

  rows.forEach((r, i) => {
    const line = i + 2;
    if (accountKind === 'checking') {
      const posted_on = fromUS(col(r, 'posting date'));
      const amount_cents = toCents(col(r, 'amount'));
      if (!posted_on || amount_cents === null) { warnings.push(`Row ${line}: unreadable date or amount — skipped`); return; }
      transactions.push({
        posted_on,
        amount_cents,
        description_raw: col(r, 'description') || '(no description)',
        meta: {
          details: col(r, 'details') || undefined,
          type: col(r, 'type') || undefined,
          balance_cents: toCents(col(r, 'balance')),
          check: col(r, 'check or slip #') || undefined,
        },
      });
    } else {
      const posted_on = fromUS(col(r, 'post date'));
      const amount_cents = toCents(col(r, 'amount'));
      if (!posted_on || amount_cents === null) { warnings.push(`Row ${line}: unreadable date or amount — skipped`); return; }
      transactions.push({
        posted_on,
        amount_cents,
        description_raw: col(r, 'description') || '(no description)',
        meta: {
          transaction_date: fromUS(col(r, 'transaction date')) || undefined,
          chase_category: col(r, 'category') || undefined,
          type: col(r, 'type') || undefined,
          memo: col(r, 'memo') || undefined,
        },
      });
    }
  });

  makeExternalIds(transactions, accountKind === 'checking' ? 'chk' : 'card');

  const out = {
    parser: `chase-csv-${accountKind}`,
    kind: 'csv',
    source: 'chase-csv',
    accountKind,
    last4: last4FromFilename(filename),
    transactions,
    balances: [],
    opening_cents: null,
    closing_cents: null,
    warnings,
  };

  // Checking: the running balance lets us verify the file is internally
  // complete and gives an observed balance anchor for the account.
  if (accountKind === 'checking') {
    const withBal = transactions.filter((t) => t.meta.balance_cents !== null);
    if (withBal.length === transactions.length && transactions.length) {
      const oldestFirst = [...transactions].reverse(); // Chase lists newest first
      let mismatches = 0;
      for (let i = 1; i < oldestFirst.length; i++) {
        if (oldestFirst[i - 1].meta.balance_cents + oldestFirst[i].amount_cents !== oldestFirst[i].meta.balance_cents) mismatches++;
      }
      if (mismatches) {
        warnings.push(`Running balance broke ${mismatches} time(s) — rows may be out of order or missing`);
      } else {
        out.opening_cents = oldestFirst[0].meta.balance_cents - oldestFirst[0].amount_cents;
        out.closing_cents = oldestFirst[oldestFirst.length - 1].meta.balance_cents;
      }
      const newest = transactions[0];
      out.balances.push({ as_of: newest.posted_on, balance_cents: newest.meta.balance_cents, source: 'csv' });
    } else if (transactions.length) {
      warnings.push('Some rows have no running balance — reconciliation skipped for this file');
    }
  }

  return summarize(out);
}

module.exports = { id: 'chase-csv', sniff, parse, last4FromFilename };
