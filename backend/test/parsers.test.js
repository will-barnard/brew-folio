// Parser tests against synthetic fixtures shaped like Chase exports.
// Real-sample checks: node scripts/parse-sample.js ../samples/<file>
process.env.FOLIO_ENC_KEY = '1'.repeat(64);
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const chaseCsv = require('../src/connectors/chase-csv');
const chasePdf = require('../src/connectors/chase-pdf');
const { toCents } = require('../src/lib/money');
const { resolveMonthDay } = require('../src/lib/dates');

const fx = (f) => fs.readFileSync(path.join(__dirname, 'fixtures', f), 'utf8');

test('money parsing', () => {
  assert.equal(toCents('1,234.56'), 123456);
  assert.equal(toCents('-$1,234.56'), -123456);
  assert.equal(toCents('(12.00)'), -1200);
  assert.equal(toCents('12.00-'), -1200);
  assert.equal(toCents('+$163.31'), 16331);
  assert.equal(toCents('5'), 500);
  assert.equal(toCents('.5'), 50);
  assert.equal(toCents('abc'), null);
  assert.equal(toCents(0.1 + 0.2), 30);
});

test('month/day resolves across a year boundary', () => {
  assert.equal(resolveMonthDay('12/30', '2026-12-14', '2027-01-13'), '2026-12-30');
  assert.equal(resolveMonthDay('01/02', '2026-12-14', '2027-01-13'), '2027-01-02');
  assert.equal(resolveMonthDay('06/01', '2026-12-14', '2027-01-13'), null);
});

test('chase checking CSV', () => {
  const p = chaseCsv.parse(fx('Chase1234_Activity_20261014.CSV'), { filename: 'Chase1234_Activity_20261014.CSV' });
  assert.equal(p.parser, 'chase-csv-checking');
  assert.equal(p.last4, '1234');
  assert.equal(p.transactions.length, 7);
  assert.equal(p.opening_cents, 0);
  assert.equal(p.closing_cents, 233767);
  assert.equal(p.reconciled, true);
  assert.deepEqual(p.warnings, []);
  // Two identical coffees on one day stay two transactions.
  const coffees = p.transactions.filter((t) => /Blue Bottle/.test(t.description_raw));
  assert.equal(coffees.length, 2);
  assert.notEqual(coffees[0].external_id, coffees[1].external_id);
  assert.deepEqual(p.balances, [{ as_of: '2026-10-12', balance_cents: 233767, source: 'csv' }]);
});

test('chase CSV ids are stable across re-parse', () => {
  const a = chaseCsv.parse(fx('Chase1234_Activity_20261014.CSV'));
  const b = chaseCsv.parse(fx('Chase1234_Activity_20261014.CSV'));
  assert.deepEqual(a.transactions.map((t) => t.external_id), b.transactions.map((t) => t.external_id));
});

test('chase card CSV', () => {
  const p = chaseCsv.parse(fx('Chase5678_Activity20261014.CSV'), { filename: 'Chase5678_Activity20261014.CSV' });
  assert.equal(p.parser, 'chase-csv-credit');
  assert.equal(p.last4, '5678');
  assert.equal(p.transactions.length, 5);
  assert.equal(p.reconciled, null);
  const pay = p.transactions.find((t) => /Payment Thank You/.test(t.description_raw));
  assert.equal(pay.amount_cents, 41233);
  assert.equal(pay.meta.type, 'Payment');
});

test('unknown CSV fails loudly', () => {
  assert.throws(() => chaseCsv.parse('Date,Amount\n1,2\n'), /Not a recognised Chase CSV/);
});

test('chase checking statement text', () => {
  const [p] = chasePdf.parseText(fx('chase-checking-statement.txt'));
  assert.equal(p.parser, 'chase-pdf-checking');
  assert.equal(p.last4, '1234');
  assert.equal(p.period_start, '2026-09-13');
  assert.equal(p.period_end, '2026-10-12');
  assert.equal(p.transactions.length, 7);
  assert.equal(p.opening_cents, 0);
  assert.equal(p.closing_cents, 233767);
  assert.equal(p.reconciled, true, p.warnings.join('; '));
  // Missing minus sign repaired from the running balance.
  assert.equal(p.transactions.filter((t) => t.amount_cents === -575).length, 2);
  // Wrapped description joined; page footer didn't leak in.
  const stripe = p.transactions.find((t) => /Stripe/.test(t.description_raw));
  assert.match(stripe.description_raw, /Sec:CCD$/);
});

test('chase card statement text', () => {
  const [p] = chasePdf.parseText(fx('chase-card-statement.txt'));
  assert.equal(p.parser, 'chase-pdf-credit');
  assert.equal(p.last4, '5678');
  assert.equal(p.opening_cents, -41233);
  assert.equal(p.closing_cents, -13981);
  assert.equal(p.transactions.length, 5);
  assert.equal(p.reconciled, true, p.warnings.join('; '));
  assert.equal(p.transactions.find((t) => /SPOTIFY/.test(t.description_raw)).amount_cents, -1199);
});

test('a dropped row breaks reconciliation', () => {
  const text = fx('chase-card-statement.txt').replace(/.*SPOTIFY.*\n/, '');
  const [p] = chasePdf.parseText(text);
  assert.equal(p.reconciled, false);
  assert.ok(p.warnings.some((w) => /something was missed/.test(w)));
});

test('card: body text mentioning "Account Activity" doesn\'t hijack the section', () => {
  const text = `Payments post just after the Account Activity section.\n${fx('chase-card-statement.txt')}`;
  const [p] = chasePdf.parseText(text);
  assert.equal(p.transactions.length, 5);
  assert.equal(p.reconciled, true);
});

test('consolidated statement: grouped sections, signs from headings, two accounts', () => {
  const list = chasePdf.parseText(fx('chase-consolidated-statement.txt'));
  assert.equal(list.length, 2);
  const [chk, sav] = list;
  assert.equal(chk.accountKind, 'checking');
  assert.equal(chk.last4, '2222');
  assert.equal(chk.accountLabel, 'Chase Total Checking');
  assert.equal(chk.transactions.length, 6);
  assert.equal(chk.reconciled, true, chk.warnings.join('; '));
  assert.equal(chk.transactions.find((t) => /Check #1043/.test(t.description_raw)).amount_cents, -4000);
  assert.equal(chk.transactions.find((t) => /Payroll/.test(t.description_raw)).amount_cents, 20000);
  assert.equal(sav.accountKind, 'savings');
  assert.equal(sav.last4, '4444');
  assert.equal(sav.accountLabel, 'Chase Savings');
  assert.equal(sav.reconciled, true, sav.warnings.join('; '));
  assert.notEqual(chk.transactions[0].external_id.split(':')[0], sav.transactions[0].external_id.split(':')[0]);
});

test('auto loan: payment splits into transfer + interest, balance is unpaid principal', () => {
  const [p] = chasePdf.parseText(fx('chase-auto-loan-statement.txt'));
  assert.equal(p.accountKind, 'loan');
  assert.equal(p.last4, '1234');
  assert.deepEqual(p.transactions.map((t) => t.amount_cents), [28000, -3000]);
  assert.deepEqual(p.balances, [{ as_of: '2026-04-09', balance_cents: -900000, source: 'statement' }]);
  assert.equal(p.reconciled, null);
});
