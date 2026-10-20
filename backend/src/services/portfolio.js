// Position valuation. Values are display-grade (quantity × price, rounded to
// cents) — they never enter the ledger, so float math is acceptable here.
const { query } = require('../db/pool');

const INVEST_KINDS = ['brokerage', 'retirement', 'exchange', 'wallet'];

function valuePosition(p) {
  const qty = Number(p.quantity);
  if (p.asset_type === 'cash') {
    return { price: 1, value_cents: Math.round(qty * 100), day_change_cents: 0, priced: true };
  }
  const price = p.quote_price != null ? Number(p.quote_price) : p.manual_price != null ? Number(p.manual_price) : null;
  if (price == null) return { price: null, value_cents: 0, day_change_cents: null, priced: false };
  const prev = p.quote_prev_close != null ? Number(p.quote_prev_close) : null;
  return {
    price,
    value_cents: Math.round(qty * price * 100),
    day_change_cents: prev != null ? Math.round(qty * (price - prev) * 100) : null,
    priced: true,
  };
}

async function positions(db = { query }, { accountId = null } = {}) {
  const { rows } = await db.query(
    `SELECT p.*, a.name AS account_name, a.kind AS account_kind,
            q.price AS quote_price, q.prev_close AS quote_prev_close, q.quoted_at, q.provider AS quote_provider,
            q.last_error AS quote_error
       FROM positions p
       JOIN accounts a ON a.id = p.account_id
       LEFT JOIN quotes q ON q.symbol = p.symbol
        AND q.asset_class = CASE WHEN p.asset_type = 'crypto' THEN 'crypto' ELSE 'security' END
      WHERE ($1::int IS NULL OR p.account_id = $1)
      ORDER BY p.account_id, (p.asset_type = 'cash'), p.symbol`,
    [accountId],
  );
  return rows.map((p) => {
    const v = valuePosition(p);
    return {
      id: p.id, account_id: p.account_id, account_name: p.account_name, symbol: p.symbol, name: p.name,
      asset_type: p.asset_type, quantity: p.quantity, cost_basis_cents: p.cost_basis_cents,
      manual_price: p.manual_price, source: p.source, as_of: p.as_of,
      ...v,
      gain_cents: p.cost_basis_cents != null && v.priced ? v.value_cents - Number(p.cost_basis_cents) : null,
      quoted_at: p.quoted_at, quote_provider: p.quote_provider, quote_error: p.quote_error,
    };
  });
}

// account_id → { value_cents, day_change_cents, count, unpriced, oldest_quote }
async function valuesByAccount(db = { query }) {
  const out = new Map();
  for (const p of await positions(db)) {
    const a = out.get(p.account_id) || { value_cents: 0, day_change_cents: 0, count: 0, unpriced: 0, oldest_quote: null };
    a.value_cents += p.value_cents;
    a.day_change_cents += p.day_change_cents || 0;
    a.count += 1;
    if (!p.priced) a.unpriced += 1;
    if (p.quoted_at && (!a.oldest_quote || new Date(p.quoted_at) < new Date(a.oldest_quote))) a.oldest_quote = p.quoted_at;
    out.set(p.account_id, a);
  }
  return out;
}

module.exports = { INVEST_KINDS, valuePosition, positions, valuesByAccount };
