const crypto = require('crypto');

// Files carry no transaction IDs, so synthesize one that is stable across
// re-imports of overlapping exports: date | amount | description | n, where n
// counts identical rows within the file (two $5.75 coffees on the same day are
// two transactions, not a duplicate).
function makeExternalIds(rows, prefix) {
  const seen = new Map();
  for (const r of rows) {
    const base = `${r.posted_on}|${r.amount_cents}|${r.description_raw.replace(/\s+/g, ' ').trim().toLowerCase()}`;
    const n = (seen.get(base) || 0) + 1;
    seen.set(base, n);
    r.external_id = `${prefix}:${crypto.createHash('sha1').update(`${base}|${n}`).digest('hex').slice(0, 24)}`;
  }
  return rows;
}

function summarize(parsed) {
  const sum = parsed.transactions.reduce((a, t) => a + t.amount_cents, 0);
  const dates = parsed.transactions.map((t) => t.posted_on).sort();
  return {
    ...parsed,
    parsed_sum_cents: sum,
    period_start: parsed.period_start || dates[0] || null,
    period_end: parsed.period_end || dates[dates.length - 1] || null,
    // Only meaningful when the source states both balances.
    reconciled: parsed.opening_cents != null && parsed.closing_cents != null
      ? parsed.closing_cents - parsed.opening_cents === sum
      : null,
  };
}

module.exports = { makeExternalIds, summarize };
