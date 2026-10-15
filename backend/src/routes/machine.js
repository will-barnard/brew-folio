// /api/v1 — for machines: iOS Shortcuts, other brew apps. API key only; the
// session cookie is never accepted here and keys are never accepted elsewhere.
//
// iOS Safari can't receive files from the share sheet (no Web Share Target),
// so a Shortcut posts the file here instead:
//   POST /api/v1/inbox   X-API-Key, X-Filename, Content-Type, body = file
// Statements land as an import awaiting your confirmation in the app;
// anything else (receipt photo, e-receipt PDF) becomes an unattached receipt.
const express = require('express');
const { query, tx } = require('../db/pool');
const { requireApiKey } = require('../middleware/auth');
const { receiveUpload } = require('../services/uploads');
const { createBatch } = require('../services/imports');
const { createManual } = require('../services/manual');
const storage = require('../services/storage');
const { str, date, cents } = require('../lib/validate');
const { badRequest, unprocessable } = require('../lib/errors');

const router = express.Router();

router.get('/health', requireApiKey(null), (req, res) => {
  res.json({ ok: true, key: req.apiKey.name, scopes: req.apiKey.scopes });
});

router.post('/inbox', requireApiKey('inbox:write'), async (req, res) => {
  const up = await receiveUpload(req);
  try {
    const result = await createBatch(up, { origin: 'inbox' });
    if (result.batches) return res.status(201).json({ kind: 'import', ids: result.batches.map((b) => b.id) });
    if (!/^(image\/|application\/pdf)/.test(up.mime)) throw unprocessable(result.notStatement);
    const key = await storage.putFile(`receipts/${up.sha256}`, up.path, { contentType: up.mime });
    const { rows } = await query(
      `INSERT INTO receipts (storage_key, filename, mime, bytes, origin) VALUES ($1,$2,$3,$4,'inbox') RETURNING id`,
      [key, up.filename, up.mime, up.bytes]);
    res.status(201).json({ kind: 'receipt', id: rows[0].id });
  } finally {
    await up.cleanup();
  }
});

// Quick add from a Shortcut: { amount: "-12.50", description, account?, stream?, category?, date?, notes? }
// account / stream / category accept an id or a name.
router.post('/transactions', requireApiKey('transactions:write'), express.json({ limit: '16kb' }), async (req, res) => {
  const b = req.body || {};
  const lookup = async (table, v, label) => {
    if (v === undefined || v === null || v === '') return null;
    const s = String(v).trim();
    let rows;
    if (/^\d+$/.test(s)) {
      ({ rows } = await query(`SELECT id FROM ${table} WHERE id = $1`, [s]));
    } else if (table === 'categories' && s.includes('/')) {
      // Category names repeat across groups (Life/Travel vs Business/Travel) — "Parent/Name" disambiguates.
      const [parent, name] = s.split('/').map((x) => x.trim());
      ({ rows } = await query(
        `SELECT c.id FROM categories c JOIN categories p ON p.id = c.parent_id
          WHERE lower(p.name) = lower($1) AND lower(c.name) = lower($2)`, [parent, name]));
    } else {
      ({ rows } = await query(`SELECT id FROM ${table} WHERE lower(name) = lower($1)`, [s]));
    }
    if (!rows.length) throw badRequest(`Unknown ${label} “${s}”`);
    if (rows.length > 1) throw badRequest(`“${s}” matches more than one ${label} — use "Group/Name"`);
    return rows[0].id;
  };
  let accountId = await lookup('accounts', b.account, 'account');
  if (!accountId) {
    const { rows } = await query("SELECT id FROM accounts WHERE kind = 'cash' AND NOT is_closed ORDER BY id LIMIT 1");
    if (!rows.length) throw badRequest('No account given and no Cash account exists — create one or pass account');
    accountId = rows[0].id;
  }
  const row = await tx(async (db) => createManual(db, {
    account_id: accountId,
    amount_cents: cents(b),
    description: str(b.description, 'description', { min: 1, max: 200 }),
    posted_on: b.date ? date(b.date, 'date') : undefined,
    category_id: await lookup('categories', b.category, 'category'),
    stream_id: await lookup('streams', b.stream, 'stream'),
    notes: str(b.notes, 'notes', { max: 1000, nullable: true }),
  }, req.actor));
  res.status(201).json({ id: row.id, posted_on: row.posted_on, amount_cents: row.amount_cents });
});

module.exports = router;
