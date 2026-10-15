// Chase statement PDFs: deposit accounts (checking/savings), credit cards and
// Chase Auto loans.
//
// Deterministic: pdftotext -layout, then line patterns. A deposit or card
// statement only counts as reconciled when Σ(rows) = closing − opening from the
// statement's own summary, so a layout change shows up as "doesn't balance"
// instead of silently wrong numbers. AI never produces amounts here.
//
// Layouts handled (checked against Will's real statements, Oct 2026):
//  - Deposit, "consolidated": one PDF covers several accounts (e.g. College
//    Checking + Savings). Each account gets its own parse → its own import batch.
//  - Deposit rows grouped by type (DEPOSITS AND ADDITIONS, ELECTRONIC
//    WITHDRAWALS, …) with unsigned amounts — the section gives the sign.
//  - Deposit rows in TRANSACTION DETAIL with a running balance column.
//  - Card: ACCOUNT ACTIVITY, purchases positive / credits negative (flipped here).
//  - Chase Auto loan: Transaction Activity + unpaid principal (balance-only plus payments).
//
// parse() returns an ARRAY — one entry per account in the file.
const { execFile } = require('child_process');
const { promisify } = require('util');
const { toCents } = require('../lib/money');
const { fromUS, fromLong, resolveMonthDay, addDays } = require('../lib/dates');
const { makeExternalIds, summarize } = require('./util');
const { unprocessable, HttpError } = require('../lib/errors');

const run = promisify(execFile);
const AMT = String.raw`-?\$?[\d,]+\.\d{2}`;

async function extractText(filePath) {
  try {
    const { stdout } = await run('pdftotext', ['-layout', filePath, '-'], { maxBuffer: 32 * 1024 * 1024 });
    return stdout;
  } catch (err) {
    if (err.code === 'ENOENT') throw new HttpError(500, 'pdftotext is not installed (poppler-utils) — the backend image is misconfigured');
    throw unprocessable(`Couldn’t read that PDF: ${err.message.split('\n')[0]}`);
  }
}

function sniff(text) {
  if (!/chase|jpmorgan/i.test(text)) return null;
  // Headings are matched case-sensitively: body copy says "Account Activity
  // section" in mixed case, the real heading is upper case.
  if (/(CHECKING|SAVINGS) SUMMARY/.test(text)) return 'deposit';
  if (/ACCOUNT ACTIVITY/.test(text) && /New Balance/i.test(text)) return 'credit';
  if (/Unpaid Principal Balance/i.test(text) && /Transaction Activity/i.test(text)) return 'loan';
  return null;
}

function last4Of(s) {
  const digits = String(s || '').replace(/\D/g, '');
  return digits.length >= 4 ? digits.slice(-4) : null;
}

function amountAfter(text, labelRe) {
  const m = text.match(new RegExp(`${labelRe.source}[^\\n]*?(${AMT})`, labelRe.flags.includes('i') ? 'i' : ''));
  return m ? toCents(m[1]) : null;
}

const NOISE = /(page \d+ of \d+|account number|transaction detail|^\s*date\s+description|^\s*\*(start|end)\*|\(continued\)|chase\.com|jpmorgan|^\s*total\b)/i;

// ── deposit accounts ────────────────────────────────────────────────────
// Sections that list rows with unsigned amounts; the heading carries the sign.
const SECTIONS = [
  { name: 'deposits', re: /^\s*DEPOSITS AND ADDITIONS(\s*\(continued\))?\s*$/, sign: 1 },
  { name: 'checks', re: /^\s*CHECKS PAID(\s*\(continued\))?\s*$/, sign: -1, checks: true },
  { name: 'atm_debit', re: /^\s*ATM & DEBIT CARD WITHDRAWALS(\s*\(continued\))?\s*$/, sign: -1 },
  { name: 'electronic', re: /^\s*ELECTRONIC WITHDRAWALS(\s*\(continued\))?\s*$/, sign: -1 },
  { name: 'other', re: /^\s*OTHER WITHDRAWALS(\s*\(continued\))?\s*$/, sign: -1 },
  { name: 'fees', re: /^\s*FEES(\s*\(continued\))?\s*$/, sign: -1 },
];

function parseSections(seg, period, warnings) {
  const rowRe = new RegExp(String.raw`^\s*(\d{2}\/\d{2})\s+(.*?)\s+(${AMT})\s*$`);
  const checkRe = new RegExp(String.raw`^\s*(\d{3,})\s*[\^*]?\s+(?:.*?\s+)?(\d{2}\/\d{2})\s+(${AMT})\s*$`);
  const out = [];
  let section = null;
  let last = null;
  for (const line of seg.split('\n')) {
    const heading = SECTIONS.find((s) => s.re.test(line));
    if (heading) { section = heading; last = null; continue; }
    if (!section) continue;
    if (/^\s*Total\b/i.test(line) || /^\s*\*end\*/.test(line)) { section = null; last = null; continue; }
    const m = line.match(rowRe);
    const c = section.checks ? line.match(checkRe) : null;
    if (m || c) {
      const md = c ? c[2] : m[1];
      const posted_on = resolveMonthDay(md, period.start, period.end);
      if (!posted_on) { warnings.push(`Date ${md} is outside the statement period — skipped`); last = null; continue; }
      const amount = Math.abs(toCents(c ? c[3] : m[3])) * section.sign;
      last = {
        posted_on,
        amount_cents: amount,
        description_raw: c ? `Check #${c[1]}` : m[2].replace(/\s{2,}/g, ' ').trim(),
        meta: { section: section.name },
      };
      out.push(last);
      continue;
    }
    // Wrapped description: indented text-only line right after a row.
    if (last && /^\s{8,}\S/.test(line) && !new RegExp(AMT).test(line) && !NOISE.test(line) && line.trim().length < 90) {
      last.description_raw = `${last.description_raw} ${line.trim()}`;
    } else if (NOISE.test(line)) {
      last = null;
    }
  }
  return out;
}

function parseRunningDetail(seg, period, opening, warnings) {
  const start = seg.search(/TRANSACTION DETAIL/);
  const lines = seg.slice(start).split('\n');
  const lineRe = new RegExp(String.raw`^\s*(\d{2}\/\d{2})\s+(.*?)\s+(${AMT})(?:\s+(${AMT}))?\s*$`);
  const out = [];
  let prevBal = opening;
  let last = null;
  for (const line of lines) {
    if (/Ending Balance/i.test(line) && out.length) break;
    if (/Beginning Balance/i.test(line)) continue;
    if (/^\s*\*end\*transaction detail/i.test(line)) break;
    const m = line.match(lineRe);
    if (m) {
      const posted_on = resolveMonthDay(m[1], period.start, period.end);
      if (!posted_on) { warnings.push(`Date ${m[1]} is outside the statement period — skipped`); last = null; continue; }
      let amount = toCents(m[3]);
      const bal = m[4] ? toCents(m[4]) : null;
      if (bal !== null && prevBal !== null) {
        if (prevBal + amount === bal) { /* consistent */ }
        else if (prevBal - amount === bal) amount = -amount; // layout dropped the minus sign
        else warnings.push(`${m[1]} ${m[2].trim().slice(0, 40)}: running balance doesn’t follow`);
      }
      if (bal !== null) prevBal = bal;
      last = { posted_on, amount_cents: amount, description_raw: m[2].replace(/\s{2,}/g, ' ').trim(), meta: { statement_balance_cents: bal } };
      out.push(last);
      continue;
    }
    if (last && /^\s{8,}\S/.test(line) && !new RegExp(AMT).test(line) && !NOISE.test(line) && line.trim().length < 90) {
      last.description_raw = `${last.description_raw} ${line.trim()}`;
    } else if (NOISE.test(line)) {
      last = null;
    }
  }
  return out;
}

function parseDeposit(text) {
  const p = text.match(/([A-Z][a-z]+ \d{1,2}, \d{4})\s*through\s*([A-Z][a-z]+ \d{1,2}, \d{4})/);
  const period = { start: p ? fromLong(p[1]) : null, end: p ? fromLong(p[2]) : null };
  if (!period.start || !period.end) throw unprocessable('Couldn’t find the statement period (“… through …”)');

  // One segment per account, starting at its SUMMARY heading.
  const heads = [...text.matchAll(/^\s*(CHECKING|SAVINGS) SUMMARY\b/gm)];
  return heads.map((h, i) => {
    const from = h.index;
    const to = i + 1 < heads.length ? heads[i + 1].index : text.length;
    // The account's product header (name + number) sits just above its summary.
    const before = text.slice(Math.max(0, from - 1500), from);
    const numbers = [...before.matchAll(/Account Number:?\s*([\dX][\dX\s-]{3,30}\d)/gi)];
    const product = [...before.matchAll(/^\s*(CHASE (?:[A-Z][A-Z ]* )?(?:CHECKING|SAVINGS))\s*$/gm)].at(-1)?.[1];
    // The next account's header precedes its summary — don't let it bleed into this segment.
    let seg = text.slice(from, to);
    const nextHeader = seg.search(/\*start\*global product/);
    if (nextHeader > 0) seg = seg.slice(0, nextHeader);

    const warnings = [];
    const opening = amountAfter(seg, /Beginning Balance/);
    const closing = amountAfter(seg, /Ending Balance/);
    const kind = h[1] === 'SAVINGS' ? 'savings' : 'checking';
    const rows = /TRANSACTION DETAIL/.test(seg)
      ? parseRunningDetail(seg, period, opening, warnings)
      : parseSections(seg, period, warnings);
    return {
      accountKind: kind,
      accountLabel: product ? product.replace(/\b(\w)(\w*)/g, (_, a, b) => a + b.toLowerCase()) : null,
      last4: last4Of(numbers.at(-1)?.[1]),
      period_start: period.start,
      period_end: period.end,
      opening, closing, transactions: rows, warnings,
    };
  });
}

// ── credit cards ────────────────────────────────────────────────────────
function parseCard(text) {
  const warnings = [];
  const p = text.match(/Opening\/Closing Date\s+(\d{2}\/\d{2}\/\d{2,4})\s*-\s*(\d{2}\/\d{2}\/\d{2,4})/i);
  const period = { start: p ? fromUS(p[1]) : null, end: p ? fromUS(p[2]) : null };
  if (!period.start || !period.end) throw unprocessable('Couldn’t find the Opening/Closing Date');

  // Statement shows what you owe as positive; our convention is negative.
  const prev = amountAfter(text, /Previous Balance/);
  const next = amountAfter(text, /New Balance/);

  const start = text.search(/^\s*ACCOUNT ACTIVITY\b/m);
  const rest = text.slice(start);
  const endRel = rest.search(/Totals Year-to-Date|^\s*INTEREST CHARGES\s*$/m);
  const body = endRel > 0 ? rest.slice(0, endRel) : rest;
  const lineRe = new RegExp(String.raw`^\s*(\d{2}\/\d{2})\s+(.*?)\s+(${AMT})\s*$`);

  const transactions = [];
  for (const line of body.split('\n')) {
    const m = line.match(lineRe);
    if (!m) continue;
    // Card rows carry the transaction date, which can precede the cycle by a few days.
    const posted_on = resolveMonthDay(m[1], addDays(period.start, -5), period.end);
    if (!posted_on) { warnings.push(`Date ${m[1]} is outside the statement period — skipped`); continue; }
    transactions.push({ posted_on, amount_cents: -toCents(m[3]), description_raw: m[2].replace(/\s{2,}/g, ' ').trim(), meta: {} });
  }
  const acct = text.match(/Account (?:Number|number):?\s*(X[X\s]+\d{4})/);
  return [{
    accountKind: 'credit',
    last4: last4Of(acct?.[1]),
    period_start: period.start,
    period_end: period.end,
    opening: prev === null ? null : -prev,
    closing: next === null ? null : -next,
    transactions,
    warnings,
  }];
}

// ── auto loans ──────────────────────────────────────────────────────────
// Balance is the unpaid principal (a liability → negative). A payment row
// "PAYMENT - THANK YOU (PRINCIPAL $191.81) (INTEREST$22.63) ($214.44)" becomes
// +214.44 (the transfer in from checking) and −22.63 interest (a real expense),
// so the loan balance moves by the principal only.
function parseLoan(text) {
  const warnings = [];
  const stmt = fromUS((text.match(/Statement Date\s+(\d{2}\/\d{2}\/\d{2,4})/) || [])[1]);
  if (!stmt) throw unprocessable('Couldn’t find the loan Statement Date');
  const principal = amountAfter(text, /Unpaid Principal Balance as of Statement Date/);
  const number = (text.match(/Account Number\s+(\d{6,})/) || [])[1];
  const vehicle = (text.match(/Vehicle Description\s+(.+?)\s{2,}/) || [])[1];

  const start = text.search(/Transaction Activity/);
  const body = start >= 0 ? text.slice(start, start + 4000) : '';
  const rowRe = /^\s*(\d{2}\/\d{2}\/\d{2,4})\s+(.+?)\s+(\(?-?\$?[\d,]+\.\d{2}\)?)\s*$/;
  const transactions = [];
  for (const line of body.split('\n')) {
    if (/Additional Information/i.test(line)) break;
    const m = line.match(rowRe);
    if (!m) continue;
    const posted_on = fromUS(m[1]);
    const desc = m[2].replace(/\s{2,}/g, ' ').trim();
    const shown = toCents(m[3]); // parenthesised = reduces what you owe
    const amount = -shown;
    const interest = desc.match(/INTEREST\s*\$?([\d,]+\.\d{2})/i);
    transactions.push({ posted_on, amount_cents: amount, description_raw: desc.replace(/\s*\(PRINCIPAL.*$/i, '').trim() || desc, meta: { loan_row: desc } });
    if (interest && amount > 0) {
      transactions.push({ posted_on, amount_cents: -toCents(interest[1]), description_raw: 'Loan interest', meta: { loan_row: desc } });
    }
  }
  if (start < 0) warnings.push('No Transaction Activity section — imported the balance only');
  return [{
    accountKind: 'loan',
    accountLabel: vehicle ? `${vehicle} loan` : 'Auto loan',
    last4: last4Of(number),
    period_start: transactions.map((t) => t.posted_on).sort()[0] || stmt,
    period_end: stmt,
    opening: null,
    closing: null,
    balanceOnly: principal === null ? null : { as_of: stmt, balance_cents: -principal },
    transactions,
    warnings,
  }];
}

// ── assemble ────────────────────────────────────────────────────────────
function finish(r, kindTag) {
  makeExternalIds(r.transactions, `${kindTag}stmt`);
  const out = {
    parser: `chase-pdf-${r.accountKind}`,
    kind: 'pdf',
    source: 'chase-pdf',
    accountKind: r.accountKind,
    accountLabel: r.accountLabel || null,
    last4: r.last4,
    transactions: r.transactions,
    balances: [],
    period_start: r.period_start,
    period_end: r.period_end,
    opening_cents: r.opening,
    closing_cents: r.closing,
    warnings: r.warnings,
  };
  if (r.closing !== null) out.balances.push({ as_of: r.period_end, balance_cents: r.closing, source: 'statement' });
  if (r.opening !== null) out.balances.push({ as_of: addDays(r.period_start, -1), balance_cents: r.opening, source: 'statement' });
  if (r.balanceOnly) out.balances.push({ ...r.balanceOnly, source: 'statement' });
  const s = summarize(out);
  if (s.reconciled === false) {
    s.warnings.push(`Rows add up to ${(s.parsed_sum_cents / 100).toFixed(2)} but the statement moved ${((r.closing - r.opening) / 100).toFixed(2)} — something was missed or misread`);
  }
  return s;
}

function parseText(text) {
  const kind = sniff(text);
  if (!kind) throw unprocessable('Not a recognised Chase statement');
  if (kind === 'deposit') {
    const accounts = parseDeposit(text);
    if (!accounts.length) throw unprocessable('Found no account sections in this statement');
    return accounts.map((r) => finish(r, r.accountKind === 'savings' ? 'sav' : 'chk'));
  }
  if (kind === 'credit') return parseCard(text).map((r) => finish(r, 'card'));
  return parseLoan(text).map((r) => finish(r, 'loan'));
}

async function parse(filePath) {
  return parseText(await extractText(filePath));
}

module.exports = { id: 'chase-pdf', sniff, parse, parseText, extractText };
