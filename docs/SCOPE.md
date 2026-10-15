# brew-folio — scope

Personal finance in one place, at **folio.brew.rip**. Single owner. Read-only toward every
bank and service: folio never moves money, it only collects, categorizes, and reports.

Stack per house defaults: Vue 3 (`<script setup>`, pinia, vue-router, vite) as an installable
PWA · Node/Express (CommonJS) · Postgres with numbered migrations on boot · deployed on
`beachhead.brew.rip` · files in brew-bucket · AI through dry-dock's `/api/v1/generate`.

---

## 1. Decisions to make before code

These four are expensive to unwind. Recommendations are marked.

### F1. How bank data gets in (Chase checking + credit card)

| Option | Cost | Automation | Notes |
|---|---|---|---|
| **SimpleFIN Bridge** ← recommended | $15/yr | ~daily | One setup token → one HTTP GET returns accounts, balances, transactions. No SDK, no OAuth UI to embed. Up to ~90 days history per pull. Goes through MX upstream. Also covers many brokerages. |
| Teller | free dev tier (100 live connections) | on demand | Supports Chase. Needs Teller Connect in the frontend and mTLS client certs on the backend. |
| Plaid Trial | free, 10 production Items | on demand + webhooks | Best coverage (incl. Investments, Liabilities), but Plaid Link SDK, a production-access application, and the trial is only for new teams. |
| Files only | free | none | Chase CSV/QFX export from the website, plus PDF statements. |

Recommendation: **SimpleFIN for ongoing sync, plus files for history and proof.** An aggregator
can't reach years back. **Chase's CSV export is much better than PDF** for backfill: structured,
exact, no parsing risk. Keep the PDF parser for older statements and, more importantly,
**reconciliation**: each statement's opening and closing balance proves no transaction was missed
or duplicated. Every source sits behind the same connector interface (§4), so this choice can change later.

### F2. Ledger model

**Recommended: single-entry with transfer pairing and clearing accounts.** Every row is a
signed amount on one account. Movements between your own accounts are paired and excluded
from income and spend. Money that passes through a middleman (Stripe, PayPal, Venmo) gets its own
"clearing" account, so a Stripe payout landing in Chase is a *transfer*, not income
(the income was the Stripe charge). That gives most of double-entry's correctness with a much
simpler UI. Export to beancount/CSV if an accountant ever wants real books.

### F3. Business vs personal: tags or separate books?

Do the dev business and music freelancing have their own bank accounts or an LLC, or does
everything run through personal Chase? This decides whether an **income stream** is a tag on
transactions (the likely answer) or a separate set of books. The scope below assumes **streams are
a dimension**: every income row and every business-expense row carries a stream (`W2`, `Music`,
`Dev`, `Other…`), and untagged rows are household. Per-stream P&L and Schedule C fall out of that.

### F4. gear-tracker: link or copy?

gear-tracker is its own ledger, so folio should **reference it, not duplicate it**. gear-tracker
owns the items, cost basis, and valuations. folio pulls a valuation summary into net worth, and lets
a "Gear purchase" or "Gear sale" transaction link to a gear-tracker item ID. Needs: does gear-tracker
expose an API (or can it grow `GET /api/items` + `GET /api/valuation` behind an API key)?

---

## 2. What you didn't mention (and probably want)

1. **Double counting is the #1 correctness bug in every finance app.** A credit-card autopay is
   not spending, a Stripe payout is not income, and a GCP charge shouldn't be counted once from the
   BigQuery export and again from the card. Rule: **cash accounts are the ledger; APIs enrich
   and explain.** GCP cost detail becomes a drill-down under the card charge, not a second expense.
   Stripe is the exception: fees never reach the bank, so Stripe is a clearing account (F2).
2. **Dedupe across sources.** The same transaction arrives from SimpleFIN, a CSV, and a PDF.
   Hard key: `(account, source, external_id)`. Soft match: same account, same amount, within 3 days,
   similar description, then merge and keep the others as evidence. Pending transactions change
   amount (tips) and ID when they post.
3. **Statement reconciliation.** Monthly check per account: opening balance + Σ txns = closing balance.
   A green check per month is how you trust automated data.
4. **Taxes. This is where multiple 1099 streams actually cost money.**
   - Schedule C category mapping per business stream (each category gets a `tax_line`).
   - **Quarterly estimated tax tracker**: YTD net self-employment income per stream, W2 withholding
     offset, payments made, next due date (Apr 15 / Jun 15 / Sep 15 / Jan 15).
   - **1099 tracker**: expected 1099-NEC/1099-K per payer vs what actually arrives in January.
   - **Mileage log** for gigs: probably your biggest uncaptured music deduction. Quick-add from phone.
   - Year-end **period lock** so edits can't silently change numbers you already filed.
   - CSV/PDF export for your accountant. (folio tracks; your accountant or tax software decides.)
5. **Splits**: one Costco or Amazon charge that's part business, part personal.
6. **Reimbursements and refunds**: client-reimbursed expenses net to zero, not income + expense.
7. **Receipts**: photo or PDF attached to a transaction, stored in brew-bucket.
8. **Net-worth history has to start on day one.** Balances can't be backfilled the way
   transactions can. A nightly snapshot job (cash, investments, crypto, gear, liabilities) belongs in Phase 1.
9. **Per-client profitability**: label GCP projects per client site, map Stripe customers to clients
   (Seedbook), and dev revenue minus that client's hosting becomes a real number.
10. **Cash-flow forecast**: recurring detection (subscriptions, rent, payroll cadence) plus
    Seedbook's open proposals/invoices as expected income.
11. **Sync health**: aggregator connections break (Chase re-auth). Each connector reports
    last-success time, and a stale connection raises a banner plus a push notification (the Home
    Assistant companion app is already on your phone, or ntfy).
12. **W2 detail**: the Chase deposit is *net* pay. Gross pay, withholding, and 401(k) come from the
    paystub (payroll provider export or paystub PDF). Tax projection needs the withholding number.
13. **Music income channels**: Venmo has no public API (monthly CSV export only), PayPal does,
    Zelle shows up in Chase, and cash/checks need a 5-second mobile entry.
14. **Security**: this is the most sensitive app in the ecosystem. See §6.
15. **Beachhead auto-pause vs. scheduled syncs**: if on-demand idle-stop is ever turned on,
    `backend` and `postgres` must be `always_on_services`, or nightly syncs silently never run.

### Deliberately out of scope (v1)
- Moving money, bill pay, trading. Every key is read-only, forever.
- Envelope-style budgeting (add per-category monthly targets later if wanted).
- Multi-user or household sharing.
- Receipt OCR via vision models (dry-dock has no vision worker today. Text PDFs/e-receipts are parsed; photos are just attached).
- Filing taxes.

---

## 3. Sources

| Source | Method | Pulls | Cadence |
|---|---|---|---|
| Chase checking + card | SimpleFIN (F1) | balances, transactions | nightly |
| Chase history | CSV/QFX upload | transactions | one-time backfill |
| Chase statements | PDF upload | txns + opening/closing balance | monthly, for reconciliation |
| Stripe (dev) | restricted read-only key → Balance Transactions API; webhook for `payout.paid`, `charge.succeeded` | gross, fees, refunds, payouts | webhook + nightly reconcile |
| GCP (dev hosting) | Cloud Billing export → BigQuery; service account with BigQuery read; daily query by project/service/day | cost detail | nightly |
| PayPal (music?) | REST transaction search | transactions | nightly |
| Venmo | monthly CSV upload | transactions | manual |
| Brokerages | SimpleFIN or Plaid Investments, else CSV | holdings, balances | nightly |
| Crypto | exchange read-only API key (e.g. Coinbase) + watch-only public addresses; prices from a public price API | holdings, prices | nightly |
| gear-tracker | its API (F4) | item valuations, cost basis | nightly |
| Seedbook | its API | open proposals/invoices → expected income | nightly |
| W2 paystubs | PDF upload or payroll export | gross, withholding, deductions | per pay period |
| Manual | mobile quick-add | cash, checks, mileage, anything | ad hoc |

GCP notes: there is no simple REST "what did I spend" endpoint. The Budgets API and the
pricing catalog API don't return actual charges. BigQuery export is the path. Create the dataset in
the **US multi-region**, because that backfills from the start of the previous month. A regional
dataset only collects from the day export is enabled. Turn export on now even before folio
exists, since the history only accrues from that point. (If "Google cloud suite" meant **Google Workspace**
subscriptions rather than GCP, those are flat card charges and need no integration.)

Never stored: crypto private keys or seed phrases, bank passwords. Only read-only tokens.

---

## 4. Ingestion pipeline

Every source implements one interface and emits normalized rows. Everything downstream is shared.

```
connector.sync(account, since) → { transactions[], balances[], holdings[] }
        │
        ▼
ingest service
  1. normalize   amount → integer cents (signed), dates → date, raw description kept verbatim
  2. dedupe      hard key, then soft match (§2.2); pending→posted replacement
  3. transfers   pair opposite amounts across own accounts ±5 days (+ known patterns:
                 "AUTOPAY", "Payment Thank You", "STRIPE TRANSFER") → category Transfer
  4. merchant    normalize "SQ *BLUE BOTTLE 1234 CHICAGO IL" → "Blue Bottle"
  5. rules       user rules (merchant/regex/amount/account → category + stream), priority-ordered
  6. AI          anything still uncategorized → dry-dock queue (§5)
  7. review      low-confidence or unknown → review queue
```

**PDF statement parser:** deterministic first. Chase statements are text PDFs, so
`pdftotext -layout` (poppler, in the backend image) plus a parser per template (Chase checking,
Chase card) handles them. The parse is valid only if Σ txns = closing − opening. On mismatch, flag the
batch. An LLM may help parse an *unknown* institution's layout, but its output must pass the same
balance check before anything is written. AI never gets to invent an amount.

Jobs run from a Postgres-backed queue (`jobs` table, `FOR UPDATE SKIP LOCKED`) driven by a
scheduler in the backend, so a redeploy mid-sync resumes instead of vanishing. Single backend
replica, matching dry-dock's own constraint.

---

## 5. dry-dock's role

Categorization and cleanup run in the background, so dry-dock's latency and sleeping machines never
block a human. That makes it a good fit for the fleet, and the financial data never leaves your hardware.

- **Categorize** (main use): batches of ~25 uncategorized transactions per `/api/v1/generate`
  call, **`pool` left unset** so it survives a sleeping MacBook. System prompt = your category
  list + streams + ~30 few-shot examples drawn from your own past picks. Strict JSON out:
  `{id, category, stream, confidence, reason}`. Validate against the real category IDs and
  drop anything invalid.
- **Confidence is earned, not self-reported.** Local models' stated confidence is poorly calibrated.
  Start with *everything* going to the review queue, track acceptance rate per category, and
  auto-apply only where your measured agreement is high. Auto-applied rows stay marked "AI" and are
  one tap to change.
- **Review queue = the "AI isn't sure, you pick" tool.** Mobile-first: the transaction, the
  AI's top 2–3 suggestions as big buttons, a search for anything else, and a stream toggle.
  Every pick offers "always do this for <merchant>" → becomes a rule, so the AI sees less
  over time.
- **Merchant normalization** for messy descriptors the regex pass can't handle.
- **Monthly narrative** (later): a short "what changed this month" over the computed numbers.
  The numbers are computed in SQL. The model only writes prose about them.
- Client: copy the Node client from dry-dock's `DRYDOCK-API.md`. Handle 503 → defer to the next
  run, 504 → halve the batch, 401/422 → fail loudly. Log the returned `worker` and `pool`.

---

## 6. Security

- Auth: signed HttpOnly session cookie, first account bootstraps as admin, registration closed
  after. **TOTP 2FA** (implementable with node `crypto`, no dependency). Long-lived session on the phone.
- Machine callers (iOS Shortcuts, Seedbook, gear-tracker webhooks) get scoped API keys. A key is
  never interchangeable with the session cookie.
- Connector secrets (SimpleFIN access URL, Stripe restricted key, GCP service account JSON,
  exchange keys) are **encrypted at rest** in Postgres with AES-256-GCM under `FOLIO_ENC_KEY`
  (a global Beachhead env var). Read-only scopes everywhere.
- Statements and receipts go in brew-bucket (a `folio` bucket or `uploads/folio/`), proxied
  through the mini, never public. Consider encrypting before upload with the same key.
- Nightly `pg_dump` → brew-bucket `backups`, with a restore that has been tested once.
- Audit log of every edit (who/what/when/before/after). **Privacy mode** toggle blurs
  amounts for use in public.
- Logs never contain full descriptions or amounts at info level.

---

## 7. Data model (first pass)

All money in integer cents (`bigint`). Crypto quantities `numeric(38,18)`.

```
streams            id, name, kind (w2|schedule_c|other), active
accounts           id, name, kind (checking|credit|brokerage|exchange|wallet|cash|clearing|asset|loan),
                   institution, connector, external_id, currency, is_closed
connections        id, connector, secret_enc, status, last_success_at, last_error
categories         id, parent_id, name, kind (income|expense|transfer), tax_line
transactions       id, account_id, posted_on, amount_cents, description_raw, merchant,
                   category_id, stream_id, status (pending|posted), source, external_id,
                   import_batch_id, transfer_group_id, categorized_by (rule|ai|user),
                   notes, locked
                   UNIQUE (account_id, source, external_id)
transaction_splits transaction_id, amount_cents, category_id, stream_id
evidence           transaction_id, source, external_id, import_batch_id   -- merged duplicates
rules              id, priority, match (jsonb), set_category_id, set_stream_id, created_from_txn
ai_suggestions     transaction_id, category_id, stream_id, confidence, reason, worker, pool,
                   status (pending|accepted|rejected|superseded)
import_batches     id, kind (csv|qfx|pdf), bucket_key, sha256, account_id, period_start,
                   period_end, opening_cents, closing_cents, reconciled
balance_snapshots  account_id, as_of, balance_cents
holdings           account_id, symbol, quantity, cost_basis_cents, as_of
prices             symbol, on_date, price_cents
assets             id, kind (gear|other), external_ref (gear-tracker id), name
asset_valuations   asset_id, as_of, value_cents
receipts           id, transaction_id, bucket_key, mime
mileage            id, on_date, miles, purpose, stream_id
tax_payments       id, tax_year, quarter, jurisdiction, amount_cents, paid_on
period_locks       through_date
jobs               id, kind, payload, run_at, status, attempts, last_error
audit_log          id, at, actor, entity, entity_id, before, after
```

---

## 8. Screens

**Mobile-first** (PWA, installable to home screen):
- **Glance**: net worth, this month in/out, per-stream income MTD, review-queue count, stale-sync banner.
- **Quick add**: amount → stream → category → note → optional photo. Mileage mode. Works offline
  (IndexedDB outbox that flushes when back online).
- **Review queue**: one card at a time, AI suggestions as buttons, "make a rule".
- **Transaction detail**: split, attach receipt, link gear item, change stream.

**Desktop-weighted**:
- Imports: drag in CSV/QFX/PDF, see parse + reconciliation result, confirm.
- Accounts & connections: health, last sync, re-link.
- Reports: cash flow by month, **P&L per stream**, net worth over time, spend by category,
  per-client profitability, recurring/subscriptions.
- Taxes: Schedule C view per stream, estimated-tax tracker, 1099 tracker, mileage, export.
- Rules & categories management.

iOS note: Safari doesn't support the Web Share Target API, so "share a PDF to folio" from the iOS
share sheet needs an **iOS Shortcut** that POSTs the file to `/api/v1/inbox` with an API key. The
same trick gives a one-tap "log cash" Shortcut and a Siri phrase.

---

## 9. Layout and deploy

```
brew-folio/
  beachhead.json            public_service: frontend, stateful_services: [postgres]
  docker-compose.yml        frontend, backend, postgres; networks: [internal]; volume name: brew-folio-postgres
  frontend/                 Vue 3 + vite + PWA manifest/service worker; nginx w/ resolver 127.0.0.11 ipv6=off,
                            client_max_body_size raised for statement uploads
  backend/
    src/routes/  services/  middleware/  jobs/
    src/connectors/         simplefin/ chase-csv/ chase-pdf/ stripe/ gcp-bigquery/ paypal/
                            venmo-csv/ coinbase/ gear-tracker/ seedbook/ manual/
    src/db/migrations/      001_init.sql …
    src/lib/drydock.js      copied from dry-dock DRYDOCK-API.md
    src/lib/crypto.js       AES-GCM secrets + TOTP
```

Global env vars: `DB_PASSWORD`, `SESSION_SECRET`, `FOLIO_ENC_KEY`, `DRYDOCK_BASE_URL`,
`DRYDOCK_API_KEY`, `BREW_BUCKET_URL`, `BREW_BUCKET_KEY`. Connector credentials are entered in the
app UI and stored encrypted, not in env, so adding a bank doesn't need a redeploy.

Dependencies worth their weight: `pg`, `express`, `cookie-parser` (backend); `@google-cloud/bigquery`
(or BigQuery REST with a service-account JWT signed via `crypto`, which avoids the SDK); Stripe via
plain `fetch` (the API is simple enough without the SDK); `pdftotext` from poppler-utils in the image.

---

## 10. Phases

| Phase | Ships | Why this order |
|---|---|---|
| 0 | Scaffold, auth + TOTP, migrations, streams/accounts/categories, manual quick-add PWA | usable on the phone from week one |
| 1 | Chase CSV + PDF import with reconciliation, dedupe, transfer pairing, rules, review queue, **nightly balance snapshots** | correct ledger before automation; net-worth history starts accruing |
| 2 | SimpleFIN nightly sync, dry-dock categorization, sync-health alerts | automation on top of a trustworthy base |
| 3 | Stripe + GCP connectors, per-stream P&L, tax views (Schedule C, estimates, 1099s, mileage) | the business side |
| 4 | Brokerages, crypto, gear-tracker valuations, net-worth report | the asset side |
| 5 | Recurring detection, cash-flow forecast, Seedbook link, monthly narrative, accountant export | the nice-to-haves that need history first |

Do now, outside the app: **enable GCP billing export to a US multi-region BigQuery dataset**,
and download Chase CSV history while it's available.

---

## Open questions
1. F1–F4 above.
2. Which brokerages / retirement providers, and which crypto exchanges or wallets?
3. How does music income actually arrive: Venmo, Zelle, PayPal, checks, cash?
4. Payroll provider for the W2 (ADP, Gusto, Paychex…)?
5. Do you file yourself or use an accountant? (Shapes the export format.)
6. "Google cloud suite": GCP billing, Google Workspace, or both?
