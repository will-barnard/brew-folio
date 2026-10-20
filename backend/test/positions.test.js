process.env.FOLIO_ENC_KEY = '3'.repeat(64);
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const fidelity = require('../src/connectors/fidelity');
const { valuePosition } = require('../src/services/portfolio');
const quotes = require('../src/services/quotes');

const fx = (f) => fs.readFileSync(path.join(__dirname, 'fixtures', f), 'utf8');

test('fidelity statement: holdings per account, reconciled to Total Holdings', () => {
  const [ind, roth] = fidelity.parseStatementText(fx('fidelity-statement.txt'));
  assert.equal(ind.accountKind, 'brokerage');
  assert.equal(ind.last4, '1111');
  assert.equal(ind.accountLabel, 'Fidelity Brokerage');
  assert.equal(ind.reconciled, true, ind.warnings.join('; '));
  assert.deepEqual(ind.positions.map((p) => [p.symbol, p.asset_type, p.quantity]), [['SPAXX', 'cash', 250], ['VOO', 'etf', 2]]);
  assert.equal(ind.positions[1].name, 'VANGUARD INDEX FUNDS S&P 500 ETF USD');
  assert.equal(roth.accountKind, 'retirement');
  assert.equal(roth.accountLabel, 'Fidelity Roth IRA');
  assert.equal(roth.reconciled, true, roth.warnings.join('; '));
  const fx_ = roth.positions.find((p) => p.symbol === 'FXAIX');
  assert.equal(fx_.asset_type, 'mutual_fund');
  assert.equal(fx_.cost_basis_cents, 500000);
  const unpriced = roth.positions.find((p) => p.asset_type === 'other');
  assert.match(unpriced.symbol, /^UNPRICED-/);
  assert.equal(unpriced.value_cents, 0);
  assert.equal(roth.period_end, '2026-03-31');
});

test('fidelity positions CSV', () => {
  const list = fidelity.parseCsvText(fx('Portfolio_Positions_Mar-31-2026.csv'), { filename: 'Portfolio_Positions_Mar-31-2026.csv' });
  assert.equal(list.length, 2);
  const [ind, roth] = list;
  assert.equal(ind.last4, '1111');
  assert.deepEqual(ind.positions.map((p) => [p.symbol, p.asset_type, p.quantity, p.value_cents]),
    [['SPAXX', 'cash', 250, 25000], ['VOO', 'etf', 2, 120000]]);
  assert.ok(ind.warnings.some((w) => /Pending activity/.test(w)));
  assert.equal(roth.accountKind, 'retirement');
  assert.equal(roth.positions[0].asset_type, 'mutual_fund');
  assert.equal(roth.period_end, '2026-03-31');
});

test('closed-positions export is rejected with a pointer', () => {
  assert.throws(() => fidelity.parseCsvText(fx('fidelity-closed-positions.csv')), /closed-positions/);
});

test('valuation', () => {
  assert.deepEqual(valuePosition({ asset_type: 'cash', quantity: '1152.87' }), { price: 1, value_cents: 115287, day_change_cents: 0, priced: true });
  const v = valuePosition({ asset_type: 'etf', quantity: '34.806', quote_price: '739.77', quote_prev_close: '735.00' });
  assert.equal(v.value_cents, 2574843);
  assert.equal(v.day_change_cents, Math.round(34.806 * 4.77 * 100));
  assert.equal(valuePosition({ asset_type: 'other', quantity: '10', manual_price: '2.5' }).value_cents, 2500);
  assert.equal(valuePosition({ asset_type: 'stock', quantity: '1' }).priced, false);
});

test('quote TTLs and market hours', () => {
  // Tue 2026-10-20 14:00 UTC = 10:00 ET (open); 02:00 UTC = 22:00 ET Mon (closed); Sat closed.
  assert.equal(quotes.marketOpen(new Date('2026-10-20T14:00:00Z')), true);
  assert.equal(quotes.marketOpen(new Date('2026-10-20T02:00:00Z')), false);
  assert.equal(quotes.marketOpen(new Date('2026-10-24T15:00:00Z')), false);
  const now = new Date('2026-10-20T14:00:00Z');
  const q = (mins, provider = 'tiingo-iex') => ({ provider, fetched_at: new Date(now - mins * 60000) });
  assert.equal(quotes.isStale(q(10), 'stock', now), false);
  assert.equal(quotes.isStale(q(20), 'stock', now), true);
  assert.equal(quotes.isStale(q(120), 'mutual_fund', now), false);
  assert.equal(quotes.isStale(q(400), 'mutual_fund', now), true);
  assert.equal(quotes.isStale(q(1, 'fidelity-pdf'), 'stock', now), true);
  // Recent error after the last good fetch → back off.
  assert.equal(quotes.isStale({ ...q(60), error_at: new Date(now - 5 * 60000) }, 'stock', now), false);
  // Unknown symbol: back off a day, not 30 minutes.
  assert.equal(quotes.isStale({ ...q(600), error_at: new Date(now - 120 * 60000), last_error: 'Symbol not found at Tiingo' }, 'stock', now), false);
  assert.equal(quotes.isStale({ ...q(600), error_at: new Date(now - 120 * 60000), last_error: 'timeout' }, 'stock', now), true);
});
