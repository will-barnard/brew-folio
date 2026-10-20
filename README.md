# brew-folio

Personal finance at **folio.brew.rip**. All of Will's income streams in one place (W2, dev
business, music). Single owner, read-only toward every bank. Scope and roadmap are in
[docs/SCOPE.md](docs/SCOPE.md).

**Built: Phase 0 + 1, plus investments.** Beachhead scaffold · auth with TOTP · accounts, streams, categories,
books · mobile quick add with an offline outbox · Chase CSV and statement-PDF import with
cross-source dedupe, transfer pairing and monthly reconciliation · rules · review queue ·
splits · receipts · mileage · nightly balance snapshots and DB backups · API keys for iOS
Shortcuts.

## Layout

```
beachhead.json, docker-compose.yml   frontend (public) · backend · postgres (stateful)
backend/    Express (CommonJS), pg, numbered migrations on boot
  src/connectors/   chase-csv, chase-pdf; planned sync connectors listed (501 until their phase)
  src/services/     ingest (dedupe → transfers → rules), imports, balances, storage, …
  src/routes/       /api/auth, /api/v1 (API key), /api/* (session + X-Folio header)
  src/jobs/         Postgres job queue, daily scheduler, pg_dump backup
  scripts/parse-sample.js   run a parser on a real file, no DB needed
  test/             node --test; synthetic Chase fixtures
frontend/   Vue 3 + vite + pinia PWA, nginx with Docker-DNS resolver
samples/    drop real Chase files here (gitignored)
```

## Deploy (Beachhead, beachhead.brew.rip)

Set these as **global** env vars in the dashboard, with no target service. The compose
file references them as `${VAR}`:

| Var | |
|---|---|
| `DB_PASSWORD` | postgres password |
| `FOLIO_ENC_KEY` | `openssl rand -hex 32`. Encrypts statements, receipts, backups and secrets. **Keep a copy in your password manager**: without it, none of those can be read. |
| `BREW_BUCKET_URL`, `BREW_BUCKET_KEY` | optional but recommended. Mint a key scoped to `uploads` + `backups`. Without them, files go to the `brew-folio-files` volume and nightly backups are skipped. |
| `FOLIO_TZ` | defaults to `America/Chicago` |
| `TIINGO_API_KEY` | optional. Free key from tiingo.com. Live prices for stocks, ETFs and mutual funds. Without it, holdings keep the prices from your last Fidelity import. Crypto prices come from Coinbase's public price endpoint and need no key. |

Volumes: `brew-folio-postgres`, `brew-folio-files`. Health check: `/healthz`, proxied
through to the backend so a dead API fails the deploy. If you ever turn on auto-pause, list
`backend` and `postgres` in `always_on_services`, or the nightly jobs never run.

First visit → create the owner account → More, Security: turn on two-factor → Accounts →
Imports.

## Local dev

```bash
# postgres somewhere, then:
cd backend && npm install && DB_HOST=localhost DB_PASSWORD=… npm run dev     # :3001
cd frontend && npm install && npm run dev                                   # :5173, proxies /api
cd backend && npm test
node backend/scripts/parse-sample.js samples/Chase1234_Activity_20261014.CSV --rows
```

## How the import path works

1. Upload: the file streams to a temp file and is parsed right away. Nothing touches
   the ledger yet. Account is auto-matched by last 4 digits (from the CSV filename or the
   statement header).
2. Preview: rows, period, and a reconciliation check (statement rows must add up to
   closing minus opening; a checking CSV's running balance must chain).
3. Commit: `services/ingest.js`
   - **hard dedupe**: `(account, source, external_id)`. File rows get a synthesized ID of
     date, amount, description and occurrence number, so re-importing an overlapping export is a no-op
     and two identical coffees stay two
   - **cross-source match**: same amount, ±3 days, similar description from a *different*
     source (CSV vs PDF vs future sync) → stored as `evidence`, not a second row
   - **transfers**: equal and opposite on two accounts within 5 days *and* at least one side
     looks like a transfer → paired, excluded from income/spending
   - **rules** fill remaining blanks; everything else goes to Review
4. Undo removes the batch's rows, unless another source also confirmed them, in which case
   that source's copy is promoted so nothing is lost.

## Investments

Brokerage, retirement, exchange and wallet accounts hold **positions**, not transactions. Their
balance is quantity × latest price.

- **Fidelity:** upload the monthly statement PDF (all accounts in it, checked against the
  statement's Total Holdings) or the Positions CSV from the Positions page. An import replaces
  that account's holdings, and undo puts the previous ones back. The closed-positions export is
  rejected with a pointer to the right one.
- **Coinbase / anything else:** add holdings by hand on the account page (crypto, cash, stocks,
  funds, or "other" with a manual price).
- **Prices** (`services/quotes.js`): Tiingo IEX for stocks/ETFs (one batched request), Tiingo
  end-of-day for mutual funds, Coinbase spot for crypto. Cached for 15 min while the market is open
  (3 h when closed, 6 h for funds, 10 min for crypto), refreshed when Glance loads and before the
  nightly snapshot. Failures keep the last good price, and a symbol a provider doesn't know is
  retried once a day.
- Transfers from Chase to Fidelity or Coinbase are recognized and kept out of spending.

## Not built yet (seams are in place)

- **SimpleFIN sync** (Phase 2): connector listed, `/api/connectors/simplefin/sync` → 501
- **dry-dock categorization** (Phase 2): `services/categorize.js` documents the plan.
  `ai_suggestions` table and Review UI already read from it
- Stripe, GCP billing, PayPal, Venmo CSV (Phase 3); gear-tracker (Phase 4); Seedbook (Phase 5)
- Tax views (Schedule C report, estimated-tax tracker, 1099s): tables `tax_payments`,
  `period_locks` exist, and locks are already enforced on edits and imports
- QFX/OFX import, generic CSV mapper for non-Chase banks
- Charts. Glance is numbers-only for now
