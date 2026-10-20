// Positions in investment accounts: manual entry, the portfolio view, and
// quote refresh. Imports (Fidelity statement / Positions CSV) replace an
// account's positions via services/imports.js instead.
const express = require('express');
const { query, tx } = require('../db/pool');
const { int, str, oneOf, optional, cents } = require('../lib/validate');
const { notFound, badRequest } = require('../lib/errors');
const { audit } = require('../services/audit');
const { positions, INVEST_KINDS } = require('../services/portfolio');
const { accountBalances } = require('../services/balances');
const quotes = require('../services/quotes');
const { today } = require('../lib/dates');
const config = require('../config');

const router = express.Router();
router.use(express.json({ limit: '32kb' }));

const TYPES = ['stock', 'etf', 'mutual_fund', 'crypto', 'cash', 'other'];

function readPosition(b, base = {}) {
  const assetType = optional(b.asset_type) ? base.asset_type : oneOf(b.asset_type, 'asset_type', TYPES);
  let symbol = optional(b.symbol) ? base.symbol : str(b.symbol, 'symbol', { max: 20, nullable: true });
  if (assetType === 'cash' && !symbol) symbol = 'USD';
  if (!symbol) throw badRequest('Symbol is required');
  symbol = symbol.toUpperCase().replace(/\s+/g, '');
  if (!/^[A-Z0-9.\-]{1,20}$/.test(symbol)) throw badRequest('Symbol can only contain letters, numbers, . and -');
  let quantity = base.quantity;
  if (!optional(b.quantity)) {
    quantity = Number(String(b.quantity).replace(/[$,\s]/g, ''));
    if (!Number.isFinite(quantity) || quantity < 0) throw badRequest('Quantity must be a number ≥ 0');
  }
  if (quantity === undefined) throw badRequest('Quantity is required');
  const costBasis = optional(b.cost_basis) && optional(b.cost_basis_cents) ? base.cost_basis_cents
    : (b.cost_basis === '' || b.cost_basis === null) ? null : cents({ amount: b.cost_basis, amount_cents: b.cost_basis_cents });
  let manualPrice = base.manual_price ?? null;
  if (!optional(b.manual_price)) {
    manualPrice = b.manual_price === '' || b.manual_price === null ? null : Number(String(b.manual_price).replace(/[$,\s]/g, ''));
    if (manualPrice !== null && !(manualPrice >= 0)) throw badRequest('Price must be a number ≥ 0');
  }
  return {
    symbol, asset_type: assetType, quantity,
    name: optional(b.name) ? base.name : str(b.name, 'name', { max: 120, nullable: true }),
    cost_basis_cents: costBasis ?? null,
    manual_price: assetType === 'other' ? manualPrice : null,
  };
}

async function investAccount(db, id) {
  const { rows: [a] } = await db.query('SELECT * FROM accounts WHERE id = $1', [id]);
  if (!a) throw notFound('Account not found');
  if (!INVEST_KINDS.includes(a.kind)) throw badRequest('Positions belong to brokerage, retirement, exchange or wallet accounts');
  return a;
}

// Whole portfolio: refreshes stale quotes (bounded wait), then values everything.
router.get('/portfolio', async (req, res) => {
  if (req.query.refresh !== '0') await quotes.refreshStale({ waitMs: 5000 });
  const [list, accounts] = await Promise.all([positions({ query }), accountBalances({ query }, { includeClosed: false })]);
  const invest = accounts.filter((a) => INVEST_KINDS.includes(a.kind));
  res.json({
    total_cents: invest.reduce((s, a) => s + a.balance_cents, 0),
    day_change_cents: invest.reduce((s, a) => s + (a.day_change_cents || 0), 0),
    accounts: invest.map((a) => ({
      id: a.id, name: a.name, kind: a.kind, balance_cents: a.balance_cents, day_change_cents: a.day_change_cents || 0,
      positions: list.filter((p) => p.account_id === a.id),
    })),
    live_prices: Boolean(config.tiingoKey),
  });
});

router.get('/accounts/:id/positions', async (req, res) => {
  const id = int(req.params.id, 'id');
  await investAccount({ query }, id);
  res.json(await positions({ query }, { accountId: id }));
});

router.post('/accounts/:id/positions', async (req, res) => {
  const id = int(req.params.id, 'id');
  const p = readPosition(req.body);
  const row = await tx(async (db) => {
    await investAccount(db, id);
    const { rows } = await db.query(
      `INSERT INTO positions (account_id, symbol, name, asset_type, quantity, cost_basis_cents, manual_price, source, as_of)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'manual',$8)
       ON CONFLICT (account_id, symbol) DO UPDATE SET name = COALESCE(EXCLUDED.name, positions.name),
         asset_type = EXCLUDED.asset_type, quantity = EXCLUDED.quantity,
         cost_basis_cents = COALESCE(EXCLUDED.cost_basis_cents, positions.cost_basis_cents),
         manual_price = EXCLUDED.manual_price, source = 'manual', as_of = EXCLUDED.as_of, updated_at = now()
       RETURNING *`,
      [id, p.symbol, p.name, p.asset_type, p.quantity, p.cost_basis_cents, p.manual_price, today()]);
    await audit(db, { actor: req.actor, action: 'upsert', entity: 'position', entityId: rows[0].id, after: rows[0] });
    return rows[0];
  });
  // Price it now so the number shows straight away (bounded wait).
  await quotes.refreshStale({ waitMs: 4000 });
  res.status(201).json(row);
});

router.patch('/positions/:id', async (req, res) => {
  const id = int(req.params.id, 'id');
  const row = await tx(async (db) => {
    const { rows: [b] } = await db.query('SELECT * FROM positions WHERE id = $1 FOR UPDATE', [id]);
    if (!b) throw notFound('Position not found');
    const p = readPosition(req.body, b);
    const { rows } = await db.query(
      `UPDATE positions SET symbol=$2, name=$3, asset_type=$4, quantity=$5, cost_basis_cents=$6, manual_price=$7,
              source='manual', as_of=$8, updated_at=now() WHERE id=$1 RETURNING *`,
      [id, p.symbol, p.name, p.asset_type, p.quantity, p.cost_basis_cents, p.manual_price, today()]);
    await audit(db, { actor: req.actor, action: 'update', entity: 'position', entityId: id, before: b, after: rows[0] });
    return rows[0];
  });
  await quotes.refreshStale({ waitMs: 4000 });
  res.json(row);
});

router.delete('/positions/:id', async (req, res) => {
  const id = int(req.params.id, 'id');
  await tx(async (db) => {
    const { rows: [b] } = await db.query('DELETE FROM positions WHERE id = $1 RETURNING *', [id]);
    if (!b) throw notFound('Position not found');
    await audit(db, { actor: req.actor, action: 'delete', entity: 'position', entityId: id, before: b });
  });
  res.json({ ok: true });
});

// "Is this a real symbol, and what's it at?" — used by the add form.
router.get('/quotes/lookup', async (req, res) => {
  const symbol = str(req.query.symbol, 'symbol', { min: 1, max: 20 }).toUpperCase();
  const type = oneOf(req.query.type, 'type', ['stock', 'etf', 'mutual_fund', 'crypto']);
  if (type !== 'crypto' && !config.tiingoKey) return res.json({ symbol, price: null, note: 'Live prices are off (no TIINGO_API_KEY)' });
  try {
    const q = await quotes.lookup(symbol, type);
    res.json({ symbol, price: q?.price ?? null, quoted_at: q?.quoted_at ?? null });
  } catch (err) {
    res.status(err.status === 404 ? 404 : 502).json({ error: err.status === 404 ? `Couldn’t find ${symbol}` : `Price lookup failed: ${err.message}` });
  }
});

router.post('/quotes/refresh', async (_req, res) => {
  res.json(await quotes.refreshQuotes({ force: true }));
});

module.exports = router;
