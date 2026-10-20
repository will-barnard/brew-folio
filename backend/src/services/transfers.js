// Transfer detection — the double-counting guard. A card autopay is not
// spending; moving money to savings is not income.
//
// Pairing rule: two rows on different accounts with opposite amounts within
// 5 days, where at least one side LOOKS like a transfer (descriptor pattern or
// the bank's own type field). Opposite amounts alone aren't enough: a $100
// purchase and a $100 Zelle from a friend the same week are not a transfer.
//
// STRONG patterns only ever describe money between your own accounts, so a row
// matching one is a transfer even before its partner is imported. WEAK ones
// ("Online Payment … To", "Autopay") are also how bills get paid — Peoples Gas
// Autopay is a real expense — so they only count when a partner is found.

const STRONG = [
  /payment thank you/i,
  /chase credit crd/i,
  /payment to chase card/i,
  /online (banking )?transfer (to|from)/i,
  /\btransfer (to|from) (chk|sav|checking|savings)/i,
  // Money moving to/from your investment accounts. These accounts hold
  // positions, not transactions, so there's never a partner row to pair with.
  /\bFID BKG SVC\b/i,
  /\bfidelity\b/i,
  /\bcoinbase\b/i,
];
const WEAK = [
  /\bautopay\b/i,
  /automatic payment/i,
  /\bepay\b/i,
  /\bonline payment\b.*\bto\b/i,
  /^payment\b/i,
];
const TYPE_HINTS = new Set(['ACCT_XFER', 'LOAN_PMT', 'Payment']); // Chase CSV 'Type' values

const isStrong = (t) => (t.meta && TYPE_HINTS.has(t.meta.type)) || STRONG.some((re) => re.test(t.description_raw));
function looksLikeTransfer(t) {
  return isStrong(t) || WEAK.some((re) => re.test(t.description_raw));
}

async function categoryIds(db) {
  const { rows } = await db.query("SELECT id, system_key FROM categories WHERE system_key IN ('transfer','cc_payment')");
  return Object.fromEntries(rows.map((r) => [r.system_key, r.id]));
}

async function detectTransfers(db, ids) {
  if (!ids || !ids.length) return { paired: 0, flagged: 0 };
  const cats = await categoryIds(db);
  const { rows: txns } = await db.query(
    `SELECT t.id, t.account_id, t.posted_on, t.amount_cents, t.description_raw, t.meta, a.kind AS account_kind
       FROM transactions t JOIN accounts a ON a.id = t.account_id
      WHERE t.id = ANY($1) AND t.transfer_group_id IS NULL AND t.categorized_by IS DISTINCT FROM 'user'`,
    [ids],
  );
  let paired = 0;
  let flagged = 0;
  const done = new Set();

  for (const t of txns) {
    if (done.has(t.id)) continue;
    const { rows: cands } = await db.query(
      `SELECT t.id, t.account_id, t.posted_on, t.description_raw, t.meta, a.kind AS account_kind
         FROM transactions t JOIN accounts a ON a.id = t.account_id
        WHERE t.account_id <> $1 AND t.amount_cents = $2
          AND t.posted_on BETWEEN ($3::date - 5) AND ($3::date + 5)
          AND t.transfer_group_id IS NULL
          AND t.categorized_by IS DISTINCT FROM 'user'
          AND NOT (t.id = ANY($4))
        ORDER BY abs(t.posted_on - $3::date), t.id
        LIMIT 5`,
      [t.account_id, -t.amount_cents, t.posted_on, [...done]],
    );
    const selfLooks = looksLikeTransfer(t);
    const partner = cands.find((c) => selfLooks || looksLikeTransfer(c));
    const strong = isStrong(t);
    if (partner) {
      const isCard = t.account_kind === 'credit' || partner.account_kind === 'credit';
      const cat = isCard ? cats.cc_payment : cats.transfer;
      await db.query(
        `UPDATE transactions SET transfer_group_id = $2, category_id = $3, stream_id = NULL,
                categorized_by = 'transfer', updated_at = now()
          WHERE id = ANY($1)`,
        [[t.id, partner.id], require('crypto').randomUUID(), cat],
      );
      done.add(t.id); done.add(partner.id);
      paired += 1;
    } else if (strong) {
      const cat = t.account_kind === 'credit' || /card|crd/i.test(t.description_raw) ? cats.cc_payment : cats.transfer;
      await db.query(
        `UPDATE transactions SET category_id = $2, categorized_by = 'transfer', updated_at = now()
          WHERE id = $1 AND category_id IS NULL`,
        [t.id, cat],
      );
      flagged += 1;
    }
  }
  return { paired, flagged };
}

module.exports = { detectTransfers, looksLikeTransfer, isStrong };
