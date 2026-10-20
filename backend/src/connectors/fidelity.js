// Fidelity positions — two sources, same output: one parsed entry per
// account, each carrying `positions` (not transactions). Committing an entry
// replaces that account's positions wholesale.
//
//  - Statement PDF ("INVESTMENT REPORT"): the Holdings table for every account
//    in the statement. Checked against Will's Sep 2026 statement. A parse is
//    reconciled when Σ ending market values = the statement's "Total Holdings".
//  - Positions CSV (Accounts → Positions → download): UNVERIFIED — built from
//    Fidelity's published column names; no real sample yet. The "closed
//    positions" export (Proceeds / gain-loss columns) is rejected with a pointer.
const crypto = require('crypto');
const { parseCsv } = require('../lib/csv');
const { toCents } = require('../lib/money');
const { fromLong } = require('../lib/dates');
const { unprocessable } = require('../lib/errors');

const last4 = (acct) => (String(acct).replace(/\D/g, '').slice(-4) || null);
const num = (s) => {
  const c = toCents(String(s ?? '').replace(/^\$/, ''));
  return c;
};
// Prices and quantities carry more than two decimals; parse them as plain numbers.
const dec = (s) => {
  const v = Number(String(s ?? '').replace(/[$,\s]/g, ''));
  return Number.isFinite(v) ? v : null;
};

function kindFromName(name) {
  return /\b(ROTH|IRA|401\s*\(?K\)?|403|RETIREMENT|ROLLOVER|SEP)\b/i.test(name || '') ? 'retirement' : 'brokerage';
}
function labelFor(name, kind) {
  if (kind === 'retirement') {
    if (/ROTH/i.test(name)) return 'Fidelity Roth IRA';
    if (/401/i.test(name)) return 'Fidelity 401(k)';
    return 'Fidelity IRA';
  }
  return 'Fidelity Brokerage';
}
// US mutual fund tickers are five letters ending in X (FXAIX, VTSAX).
const looksLikeFund = (sym) => /^[A-Z]{4}X$/.test(sym);

function entry({ parser, source, kind, accountNumber, name, positions, asOf, statementTotal = null, warnings = [] }) {
  const total = positions.reduce((s, p) => s + (p.value_cents || 0), 0);
  const accountKind = kindFromName(name);
  return {
    parser, kind, source,
    institution: 'Fidelity',
    accountKind,
    accountLabel: labelFor(name, accountKind),
    last4: last4(accountNumber),
    transactions: [],
    balances: [],
    positions,
    positions_total_cents: total,
    period_start: asOf,
    period_end: asOf,
    opening_cents: null,
    closing_cents: statementTotal,
    parsed_sum_cents: total,
    // Only statements state a total to check against.
    reconciled: statementTotal == null ? null : statementTotal === total,
    warnings: statementTotal != null && statementTotal !== total
      ? [...warnings, `Holdings add up to ${(total / 100).toFixed(2)} but the statement says ${(statementTotal / 100).toFixed(2)}`]
      : warnings,
  };
}

// ── statement PDF ───────────────────────────────────────────────────────
function sniffPdf(text) {
  return /INVESTMENT REPORT/.test(text) && /Fidelity/i.test(text) && /^\s*Holdings\b/m.test(text);
}

const SECTION = [
  [/^Core Account\b/, 'cash'],
  [/^Mutual Funds\b/, 'mutual_fund'],
  [/^Exchange Traded Products\b/, 'etf'],
  [/^Stocks\b/, 'stock'],
  [/^(Bonds|Options|Other Holdings|Certificates of Deposit|Other)\b/, 'other'],
];
const AMT = String.raw`\$?-?[\d,]+\.\d{2}`;
const ROW = new RegExp(String.raw`^(\S.*?)\s{2,}(${AMT}|unavailable)\s+([\d,]+\.\d{3})\s+(\$?[\d,]+\.\d{2,4}|-)\s+(${AMT}|unavailable)\s+(${AMT}|not applicable|unknown|unavailable)`);

function parseStatementText(text) {
  const period = text.match(/([A-Z][a-z]+ \d{1,2}, \d{4})\s*-\s*([A-Z][a-z]+ \d{1,2}, \d{4})/);
  const asOf = period ? fromLong(period[2]) : null;
  if (!asOf) throw unprocessable('Couldn’t find the statement period on this Fidelity statement');

  // Account names come from the Portfolio Summary table: "FIDELITY ROTH IRA … 221-447701".
  const names = new Map();
  for (const m of text.matchAll(/^\s*\d*\s+(FIDELITY .+?)\s{2,}([A-Z0-9]{1,4}-\d{6})\b/gm)) names.set(m[2], m[1]);

  const accounts = new Map(); // number → { positions, total, warnings }
  let account = null;
  let inHoldings = false;
  let section = null;
  let last = null;      // most recent row, to attach a wrapped symbol to
  let wrap = 0;

  for (const raw of text.split('\n')) {
    const line = raw.trim();
    const acct = raw.match(/Account #\s+([A-Z0-9]{1,4}-\d{6})/);
    if (acct) { account = acct[1]; if (!accounts.has(account)) accounts.set(account, { positions: [], total: null, warnings: [] }); }
    if (/^Holdings\b/.test(line)) { inHoldings = true; continue; }
    if (!inHoldings || !account) continue;
    if (/^(Activity|Estimated Cash Flow|Your Holdings)\b/.test(line)) { inHoldings = false; last = null; continue; }

    if (/^Total Holdings\b/.test(line)) {
      const m = line.match(new RegExp(AMT));
      accounts.get(account).total = m ? num(m[0]) : null;
      inHoldings = false; last = null;
      continue;
    }
    const sec = SECTION.find(([re]) => re.test(line));
    if (sec) { section = sec[1]; last = null; continue; }
    if (/^Total\b/.test(line)) { last = null; continue; }

    const m = line.match(ROW);
    if (m && section) {
      const [, desc, , qtyS, priceS, endS, costS] = m;
      const qty = dec(qtyS);
      const end = endS === 'unavailable' ? null : num(endS);
      const price = priceS === '-' ? null : dec(priceS);
      last = {
        description: desc.trim(),
        section,
        quantity: qty,
        price,
        value_cents: end,
        cost_basis_cents: /^[\d$,.-]/.test(costS) ? num(costS) : null,
      };
      accounts.get(account).positions.push(last);
      wrap = 0;
      continue;
    }
    // Wrapped description lines: the ticker is often on the second line, "(VOO)".
    // Page furniture (headers, page numbers, yield figures) is skipped, not appended.
    if (last && wrap < 3 && line
        && !/^(--|S$|MR_CE|Description|Market Value|Beginning|Includes|Equity|Common|Stock Funds|Bond Funds|All positions|INVESTMENT REPORT|Account #|\d+ of \d+|[A-Z][a-z]+ \d{1,2}, \d{4})/.test(line)
        && !/^[\d$.%-]/.test(line)) {
      wrap += 1;
      const text0 = raw.trim().split(/\s{2,}/)[0];
      last.description = `${last.description} ${text0}`.trim();
    }
  }

  const out = [];
  for (const [number, a] of accounts) {
    if (!a.positions.length) continue;
    const positions = a.positions.map((p) => {
      const sym = (p.description.match(/\(([A-Z][A-Z0-9.]{0,7})\)/) || [])[1];
      // Drop the ticker and the statement's footnote letters ("IRA q") from the name.
      const name = p.description.replace(/\s*\([A-Z][A-Z0-9.]{0,7}\)\s*/g, ' ').replace(/\s[a-z]\b/g, '').replace(/\s+/g, ' ').trim();
      if (p.section === 'cash') {
        // Money market / FDIC sweep: track as dollars.
        return { symbol: sym || 'CORE', name, asset_type: 'cash', quantity: (p.value_cents ?? 0) / 100, cost_basis_cents: null, last_price: 1, value_cents: p.value_cents ?? 0 };
      }
      if (!sym || p.price == null) {
        // Unpriced (restricted / delisted). Kept so nothing silently disappears; valued at 0 like Fidelity does.
        const id = crypto.createHash('sha1').update(p.description).digest('hex').slice(0, 6).toUpperCase();
        return { symbol: sym || `UNPRICED-${id}`, name, asset_type: 'other', quantity: p.quantity, cost_basis_cents: p.cost_basis_cents, last_price: null, value_cents: 0 };
      }
      const type = p.section === 'mutual_fund' || looksLikeFund(sym) ? 'mutual_fund' : p.section;
      return { symbol: sym, name, asset_type: type, quantity: p.quantity, cost_basis_cents: p.cost_basis_cents, last_price: p.price, value_cents: p.value_cents };
    });
    out.push(entry({
      parser: 'fidelity-pdf-positions', source: 'fidelity-pdf', kind: 'pdf',
      accountNumber: number, name: names.get(number) || '', positions, asOf, statementTotal: a.total,
    }));
  }
  if (!out.length) throw unprocessable('Found no holdings in this Fidelity statement');
  return out;
}

// ── Positions CSV ───────────────────────────────────────────────────────
function sniffCsv(text) {
  const head = text.replace(/^﻿/, '').split(/\r?\n/, 1)[0].toLowerCase();
  return head.includes('account number') && head.includes('symbol') && head.includes('description');
}

function parseCsvText(text, { filename } = {}) {
  const rows = parseCsv(text);
  const header = rows[0].map((h) => h.trim().toLowerCase());
  if (header.includes('proceeds')) {
    throw unprocessable('That’s Fidelity’s closed-positions (realized gains) export. In Fidelity, open Positions and use its download button instead — or upload the monthly statement PDF.');
  }
  if (!header.includes('quantity')) throw unprocessable('This Fidelity CSV has no Quantity column — download it from the Positions page');
  const ix = (name) => header.findIndex((h) => h === name);
  const col = (r, ...names) => {
    for (const n of names) { const i = ix(n); if (i >= 0 && r[i] !== undefined) return r[i].trim(); }
    return '';
  };

  const downloaded = text.match(/Date downloaded\s+([A-Za-z]{3})-(\d{1,2})-(\d{4})/) || String(filename || '').match(/_([A-Za-z]{3})-(\d{1,2})-(\d{4})/);
  const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const asOf = downloaded
    ? `${downloaded[3]}-${String(MONTHS.indexOf(downloaded[1].toLowerCase()) + 1).padStart(2, '0')}-${downloaded[2].padStart(2, '0')}`
    : new Date().toISOString().slice(0, 10);

  const byAccount = new Map();
  const warnings = [];
  for (const r of rows.slice(1)) {
    const acct = col(r, 'account number');
    let sym = col(r, 'symbol');
    if (!acct || !sym || !/[A-Z0-9]/i.test(acct)) continue; // disclaimer/footer lines
    const name = col(r, 'account name');
    if (!byAccount.has(acct)) byAccount.set(acct, { name, positions: [] });
    const value = num(col(r, 'current value'));
    if (/pending activity/i.test(sym)) {
      if (value) warnings.push(`Pending activity of ${(value / 100).toFixed(2)} not included — re-import once it settles`);
      continue;
    }
    const description = col(r, 'description');
    if (sym.endsWith('**') || /money market|core position/i.test(description)) {
      byAccount.get(acct).positions.push({ symbol: sym.replace(/\*+$/, ''), name: description, asset_type: 'cash', quantity: (value ?? 0) / 100, cost_basis_cents: null, last_price: 1, value_cents: value ?? 0 });
      continue;
    }
    sym = sym.toUpperCase();
    const qty = dec(col(r, 'quantity'));
    const price = dec(col(r, 'last price'));
    if (qty == null) { warnings.push(`${sym}: no quantity — skipped`); continue; }
    byAccount.get(acct).positions.push({
      symbol: sym, name: description,
      asset_type: looksLikeFund(sym) ? 'mutual_fund' : /\bETF\b|\bETP\b/i.test(description) ? 'etf' : 'stock',
      quantity: qty,
      cost_basis_cents: num(col(r, 'cost basis total')),
      last_price: price,
      value_cents: value ?? (price != null ? Math.round(qty * price * 100) : 0),
    });
  }
  if (!byAccount.size) throw unprocessable('No positions found in this Fidelity CSV');
  return [...byAccount.entries()].map(([number, a]) => entry({
    parser: 'fidelity-csv-positions', source: 'fidelity-csv', kind: 'csv',
    accountNumber: number, name: a.name, positions: a.positions, asOf, warnings,
  }));
}

module.exports = { sniffPdf, parseStatementText, sniffCsv, parseCsvText, kindFromName };
