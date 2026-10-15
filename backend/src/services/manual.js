// Manual transactions — quick add from the phone, iOS Shortcuts, cash, checks.
const crypto = require('crypto');
const { normalizeMerchant } = require('./merchant');
const { assertUnlocked } = require('./locks');
const { audit } = require('./audit');
const { badRequest } = require('../lib/errors');
const { today } = require('../lib/dates');

async function createManual(db, input, actor) {
  const { account_id, amount_cents, description, posted_on = today(), category_id = null, stream_id = null, notes = null } = input;
  const { rows: [acct] } = await db.query('SELECT id FROM accounts WHERE id = $1 AND NOT is_closed', [account_id]);
  if (!acct) throw badRequest('Account not found or closed');
  if (!amount_cents) throw badRequest('Amount can’t be zero');
  await assertUnlocked(db, account_id, posted_on);
  const { rows } = await db.query(
    `INSERT INTO transactions (account_id, posted_on, amount_cents, description_raw, merchant, category_id, stream_id,
                               source, external_id, categorized_by, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'manual', $8, $9, $10) RETURNING *`,
    [account_id, posted_on, amount_cents, description, normalizeMerchant(description) || description,
      category_id, stream_id, crypto.randomUUID(), category_id ? 'user' : null, notes],
  );
  await audit(db, { actor, action: 'create', entity: 'transaction', entityId: rows[0].id, after: rows[0] });
  return rows[0];
}

module.exports = { createManual };
