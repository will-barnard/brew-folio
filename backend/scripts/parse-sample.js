#!/usr/bin/env node
// Run the file parsers against a real export without a database:
//   node scripts/parse-sample.js ../samples/Chase1234_Activity_20261014.CSV [--rows]
// Prints what was detected, the reconciliation result and any warnings.
process.env.FOLIO_ENC_KEY = process.env.FOLIO_ENC_KEY || '0'.repeat(64);
const path = require('path');
const { parseFile } = require('../src/connectors');

(async () => {
  const file = process.argv[2];
  if (!file) { console.error('usage: node scripts/parse-sample.js <file> [--rows]'); process.exit(2); }
  const showRows = process.argv.includes('--rows');
  const mime = /\.pdf$/i.test(file) ? 'application/pdf' : 'text/csv';
  try {
    const list = await parseFile({ path: path.resolve(file), filename: path.basename(file), mime });
    const $ = (c) => (c == null ? '—' : (c / 100).toFixed(2));
    for (const p of list) {
    if (list.length > 1) console.log(`--- account ${list.indexOf(p) + 1} of ${list.length}${p.accountLabel ? `: ${p.accountLabel}` : ''}`);
    console.log(`parser       ${p.parser}`);
    console.log(`account      ${p.accountKind} ending ${p.last4 || '?'}`);
    console.log(`period       ${p.period_start} → ${p.period_end}`);
    console.log(`rows         ${p.transactions.length}`);
    console.log(`sum          ${$(p.parsed_sum_cents)}`);
    console.log(`opening      ${$(p.opening_cents)}   closing ${$(p.closing_cents)}`);
    console.log(`reconciled   ${p.reconciled === null ? 'n/a (no balances in source)' : p.reconciled ? 'YES' : 'NO'}`);
    if (p.warnings.length) console.log(`warnings\n  - ${p.warnings.join('\n  - ')}`);
    if (p.balances.length) console.log(`balances     ${p.balances.map((b) => `${b.as_of} ${$(b.balance_cents)} (${b.source})`).join(', ')}`);
    if (showRows) for (const t of p.transactions) console.log(`  ${t.posted_on}  ${$(t.amount_cents).padStart(11)}  ${t.description_raw}`);
    }
  } catch (err) {
    console.error(`failed: ${err.message}`);
    process.exit(1);
  }
})();
