// User rules: match a transaction, set category / stream / merchant.
// Rules only ever fill blanks — they never overwrite something you picked by
// hand, and never touch transfers.
//
// match shape (all keys optional, all must hold):
//   { merchant: "Blue Bottle Coffee",   case-insensitive equality on merchant
//     contains: "GOOGLE *CLOUD",        case-insensitive substring of the raw description
//     regex:    "^GOOGLE.*CLOUD",       case-insensitive regex on the raw description
//     account_id: 3,
//     direction: "in" | "out",
//     min_cents: 100, max_cents: 5000   on the absolute amount }
const { badRequest } = require('../lib/errors');

function validateMatch(match) {
  if (!match || typeof match !== 'object') throw badRequest('Rule needs a match object');
  const keys = Object.keys(match).filter((k) => match[k] !== null && match[k] !== '' && match[k] !== undefined);
  if (!keys.length) throw badRequest('A rule must match on something — otherwise it would catch everything');
  const allowed = ['merchant', 'contains', 'regex', 'account_id', 'direction', 'min_cents', 'max_cents'];
  for (const k of keys) if (!allowed.includes(k)) throw badRequest(`Unknown match key ${k}`);
  if (match.regex) {
    try { new RegExp(match.regex, 'i'); } catch { throw badRequest('Regex does not compile'); }
  }
  if (match.direction && !['in', 'out'].includes(match.direction)) throw badRequest('direction is in or out');
  return Object.fromEntries(keys.map((k) => [k, match[k]]));
}

function compile(rule) {
  const m = rule.match || {};
  const re = m.regex ? new RegExp(m.regex, 'i') : null;
  const contains = m.contains ? String(m.contains).toLowerCase() : null;
  const merchant = m.merchant ? String(m.merchant).toLowerCase() : null;
  return (t) => {
    if (merchant && String(t.merchant || '').toLowerCase() !== merchant) return false;
    if (contains && !String(t.description_raw).toLowerCase().includes(contains)) return false;
    if (re && !re.test(t.description_raw)) return false;
    if (m.account_id && Number(m.account_id) !== Number(t.account_id)) return false;
    if (m.direction === 'in' && t.amount_cents < 0) return false;
    if (m.direction === 'out' && t.amount_cents > 0) return false;
    const abs = Math.abs(t.amount_cents);
    if (m.min_cents != null && abs < Number(m.min_cents)) return false;
    if (m.max_cents != null && abs > Number(m.max_cents)) return false;
    return true;
  };
}

async function loadRules(db) {
  const { rows } = await db.query('SELECT * FROM rules WHERE enabled ORDER BY priority, id');
  return rows.map((r) => ({ ...r, test: compile(r) }));
}

// Apply rules to uncategorized, non-transfer transactions.
// ids: limit to these transaction ids (null = all uncategorized).
// onlyRuleId: apply just one rule (the "apply to existing" button).
async function applyRules(db, { ids = null, onlyRuleId = null } = {}) {
  let rules = await loadRules(db);
  if (onlyRuleId) rules = rules.filter((r) => r.id === Number(onlyRuleId));
  if (!rules.length) return 0;
  if (ids && !ids.length) return 0;
  const params = [];
  let where = 'category_id IS NULL AND transfer_group_id IS NULL AND NOT is_split';
  if (ids) { params.push(ids); where += ` AND id = ANY($${params.length})`; }
  const { rows } = await db.query(
    `SELECT id, account_id, amount_cents, description_raw, merchant FROM transactions WHERE ${where}`, params,
  );
  let applied = 0;
  const hits = new Map();
  for (const t of rows) {
    const rule = rules.find((r) => r.test(t));
    if (!rule) continue;
    await db.query(
      `UPDATE transactions
          SET category_id = COALESCE($2, category_id),
              stream_id = COALESCE($3, stream_id),
              merchant = COALESCE($4, merchant),
              categorized_by = 'rule', rule_id = $5, updated_at = now()
        WHERE id = $1`,
      [t.id, rule.set_category_id, rule.set_stream_id, rule.set_merchant, rule.id],
    );
    hits.set(rule.id, (hits.get(rule.id) || 0) + 1);
    applied += 1;
  }
  for (const [id, n] of hits) await db.query('UPDATE rules SET hits = hits + $2 WHERE id = $1', [id, n]);
  return applied;
}

module.exports = { validateMatch, compile, applyRules };
