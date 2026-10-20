// Live prices for positions.
//
//   stocks / ETFs  → Tiingo IEX (intraday, one batched request for all tickers)
//   mutual funds   → Tiingo end-of-day (NAVs post once a day, after midnight ET)
//   crypto         → Coinbase public spot price (no key, no account access)
//   cash / other   → no quote: cash is $1, "other" uses the position's manual price
//
// Called when the app opens (Glance) and before the nightly snapshot. Quotes
// are cached with a TTL so opening the app ten times doesn't spend ten
// requests of a free tier: 15 min for stocks while the market is open, 3 h
// otherwise, 6 h for fund NAVs, 10 min for crypto. A failed symbol keeps its
// last good price, records the error, and isn't retried for 30 minutes.
//
// Without TIINGO_API_KEY, securities keep whatever price the last Fidelity
// import carried — the app still works, values just don't move between imports.
const { query } = require('../db/pool');
const config = require('../config');

const MIN = 60_000;
const ERROR_BACKOFF = 30 * MIN;
const TIMEOUT = 8000;

const classOf = (assetType) => (assetType === 'crypto' ? 'crypto' : 'security');
const quotable = (assetType) => ['stock', 'etf', 'mutual_fund', 'crypto'].includes(assetType);

// US market hours in New York time, weekdays 9:30–16:00. Holidays are ignored:
// the cost of a wrong guess is one extra request.
function marketOpen(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', minute: 'numeric', hourCycle: 'h23',
  }).formatToParts(now).map((p) => [p.type, p.value]));
  if (['Sat', 'Sun'].includes(parts.weekday)) return false;
  const mins = Number(parts.hour) * 60 + Number(parts.minute);
  return mins >= 9 * 60 + 30 && mins < 16 * 60;
}

function ttlFor(assetType, now) {
  if (assetType === 'crypto') return 10 * MIN;
  if (assetType === 'mutual_fund') return 6 * 60 * MIN;
  return marketOpen(now) ? 15 * MIN : 3 * 60 * MIN;
}

function isStale(q, assetType, now = new Date()) {
  if (!q) return true;
  // After a failure, wait before retrying — a day if the provider doesn't know the symbol at all.
  const backoff = /not found/i.test(q.last_error || '') ? 24 * 60 * MIN : ERROR_BACKOFF;
  if (q.error_at && now - new Date(q.error_at) < backoff && new Date(q.error_at) > new Date(q.fetched_at)) return false;
  // Imported prices (from a statement/CSV) are always worth replacing with a live one.
  if (q.provider.startsWith('fidelity')) return true;
  return now - new Date(q.fetched_at) > ttlFor(assetType, now);
}

// ── providers (fetchImpl injectable for tests) ──────────────────────────
const tiingoTicker = (s) => s.toLowerCase().replace(/\./g, '-'); // BRK.B → brk-b

async function getJson(fetchImpl, url, headers = {}) {
  const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(TIMEOUT) });
  if (!res.ok) {
    const err = new Error(`${new URL(url).host} ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

async function tiingoIex(symbols, key, fetchImpl) {
  const url = `https://api.tiingo.com/iex/?tickers=${symbols.map(tiingoTicker).join(',')}`;
  const rows = await getJson(fetchImpl, url, { Authorization: `Token ${key}` });
  const out = new Map();
  for (const r of rows || []) {
    const price = r.tngoLast ?? r.last ?? r.prevClose;
    if (price == null) continue;
    const sym = symbols.find((s) => tiingoTicker(s) === String(r.ticker).toLowerCase());
    if (sym) out.set(sym, { price, prev_close: r.prevClose ?? null, quoted_at: r.timestamp || new Date().toISOString(), provider: 'tiingo-iex' });
  }
  return out;
}

async function tiingoDaily(symbol, key, fetchImpl) {
  const start = new Date(Date.now() - 10 * 86_400_000).toISOString().slice(0, 10);
  const url = `https://api.tiingo.com/tiingo/daily/${tiingoTicker(symbol)}/prices?startDate=${start}`;
  const rows = await getJson(fetchImpl, url, { Authorization: `Token ${key}` });
  if (!Array.isArray(rows) || !rows.length) throw new Error('no prices returned');
  const last = rows[rows.length - 1];
  const prev = rows.length > 1 ? rows[rows.length - 2] : null;
  return { price: last.close, prev_close: prev?.close ?? null, quoted_at: last.date, provider: 'tiingo-daily' };
}

async function coinbaseSpot(symbol, fetchImpl) {
  const base = `https://api.coinbase.com/v2/prices/${encodeURIComponent(symbol.toUpperCase())}-USD/spot`;
  const now = await getJson(fetchImpl, base);
  const price = Number(now?.data?.amount);
  if (!Number.isFinite(price)) throw new Error('no spot price');
  // Yesterday's spot gives a day change; not worth failing the quote over.
  let prev = null;
  try {
    const y = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    prev = Number((await getJson(fetchImpl, `${base}?date=${y}`))?.data?.amount) || null;
  } catch { /* day change just won't show */ }
  return { price, prev_close: prev, quoted_at: new Date().toISOString(), provider: 'coinbase' };
}

// ── store ───────────────────────────────────────────────────────────────
async function saveQuote(db, symbol, assetClass, q) {
  await db.query(
    `INSERT INTO quotes (symbol, asset_class, price, prev_close, quoted_at, provider, fetched_at, last_error, error_at)
     VALUES ($1, $2, $3, $4, $5, $6, now(), NULL, NULL)
     ON CONFLICT (symbol, asset_class) DO UPDATE SET price = EXCLUDED.price, prev_close = EXCLUDED.prev_close,
       quoted_at = EXCLUDED.quoted_at, provider = EXCLUDED.provider, fetched_at = now(), last_error = NULL, error_at = NULL`,
    [symbol, assetClass, q.price, q.prev_close, q.quoted_at, q.provider],
  );
}

async function saveError(db, symbol, assetClass, message) {
  // Keep the last good price; only record what went wrong.
  await db.query(
    `UPDATE quotes SET last_error = $3, error_at = now() WHERE symbol = $1 AND asset_class = $2`,
    [symbol, assetClass, String(message).slice(0, 300)],
  );
}

// An imported price (statement or CSV) only fills a gap or replaces something older.
async function saveImportedQuote(db, symbol, assetType, price, asOf, provider) {
  if (!quotable(assetType) || price == null) return;
  await db.query(
    `INSERT INTO quotes (symbol, asset_class, price, quoted_at, provider, fetched_at)
     VALUES ($1, $2, $3, $4, $5, now() - interval '1 day')
     ON CONFLICT (symbol, asset_class) DO UPDATE SET price = EXCLUDED.price, quoted_at = EXCLUDED.quoted_at,
       provider = EXCLUDED.provider, prev_close = NULL
     WHERE quotes.quoted_at < EXCLUDED.quoted_at`,
    [symbol, classOf(assetType), price, asOf, provider],
  );
}

// ── refresh ─────────────────────────────────────────────────────────────
async function refreshQuotes({ force = false, db = { query }, fetchImpl = fetch, apiKey = config.tiingoKey, now = new Date() } = {}) {
  const { rows: wanted } = await db.query(
    `SELECT DISTINCT p.symbol, p.asset_type, q.price, q.provider, q.fetched_at, q.error_at, q.last_error
       FROM positions p
       LEFT JOIN quotes q ON q.symbol = p.symbol
        AND q.asset_class = CASE WHEN p.asset_type = 'crypto' THEN 'crypto' ELSE 'security' END
      WHERE p.asset_type IN ('stock','etf','mutual_fund','crypto') AND p.quantity > 0`,
  );
  const stale = wanted.filter((w) => force || isStale(w.price == null ? null : w, w.asset_type, now));
  const result = { checked: wanted.length, updated: 0, failed: [] };
  if (!stale.length) return result;

  const fail = async (w, err) => {
    result.failed.push({ symbol: w.symbol, error: err.message });
    if (w.price != null) await saveError(db, w.symbol, classOf(w.asset_type), err.message);
  };

  // Crypto — per symbol, no key.
  for (const w of stale.filter((x) => x.asset_type === 'crypto')) {
    try { await saveQuote(db, w.symbol, 'crypto', await coinbaseSpot(w.symbol, fetchImpl)); result.updated++; }
    catch (err) { await fail(w, err); }
  }

  const securities = stale.filter((x) => x.asset_type !== 'crypto');
  if (!securities.length) return result;
  if (!apiKey) {
    for (const w of securities) result.failed.push({ symbol: w.symbol, error: 'TIINGO_API_KEY not set — using last imported price' });
    return result;
  }

  // Stocks/ETFs in one batched intraday request; anything it misses (and every
  // mutual fund) falls through to end-of-day, one request each.
  const intraday = securities.filter((x) => x.asset_type !== 'mutual_fund').map((x) => x.symbol);
  let got = new Map();
  if (intraday.length) {
    try { got = await tiingoIex(intraday, apiKey, fetchImpl); } catch (err) {
      if (err.status === 401 || err.status === 403) {
        for (const w of securities) await fail(w, new Error('Tiingo rejected the API key'));
        return result;
      }
      // Otherwise fall through to per-symbol EOD below.
    }
  }
  for (const w of securities) {
    try {
      const q = got.get(w.symbol) || await tiingoDaily(w.symbol, apiKey, fetchImpl);
      await saveQuote(db, w.symbol, 'security', q);
      result.updated++;
    } catch (err) {
      await fail(w, err.status === 404 ? new Error('Symbol not found at Tiingo') : err);
    }
  }
  return result;
}

// One refresh at a time; callers that arrive mid-refresh share it.
let inflight = null;
function refreshShared(opts) {
  if (!inflight) inflight = refreshQuotes(opts).finally(() => { inflight = null; });
  return inflight;
}

// For request paths: start a refresh, but don't hold the page longer than waitMs.
async function refreshStale({ waitMs = 4000 } = {}) {
  const p = refreshShared().catch((err) => { console.warn('[quotes] refresh failed', err.message); return null; });
  return Promise.race([p, new Promise((r) => setTimeout(() => r(null), waitMs))]);
}

// Validate a symbol before saving a manual position.
async function lookup(symbol, assetType, { fetchImpl = fetch, apiKey = config.tiingoKey } = {}) {
  if (assetType === 'crypto') return coinbaseSpot(symbol, fetchImpl);
  if (!apiKey) return null;
  if (assetType === 'mutual_fund') return tiingoDaily(symbol, apiKey, fetchImpl);
  const m = await tiingoIex([symbol], apiKey, fetchImpl);
  return m.get(symbol) || tiingoDaily(symbol, apiKey, fetchImpl);
}

module.exports = {
  refreshQuotes, refreshShared, refreshStale, lookup, saveQuote, saveImportedQuote,
  marketOpen, ttlFor, isStale, classOf, quotable,
};
