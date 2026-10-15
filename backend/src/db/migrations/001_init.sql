-- brew-folio initial schema.
-- Money is integer cents (bigint). Sign convention, for every account kind:
-- negative = money left this account, positive = money arrived. So a card
-- purchase is negative and a card balance you owe is negative; net worth is
-- a plain sum of balances.

CREATE EXTENSION IF NOT EXISTS pgcrypto; -- gen_random_uuid()

-- ── auth ────────────────────────────────────────────────────────────────
CREATE TABLE users (
  id               serial PRIMARY KEY,
  username         text NOT NULL UNIQUE,
  password_hash    text NOT NULL,
  totp_secret_enc  text,
  totp_enabled     boolean NOT NULL DEFAULT false,
  totp_last_step   bigint,              -- replay guard: a code works once
  is_admin         boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  id            bigserial PRIMARY KEY,
  user_id       int NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash    text NOT NULL UNIQUE,   -- sha256 of the cookie value; the value itself is never stored
  user_agent    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL
);

CREATE TABLE api_keys (
  id            serial PRIMARY KEY,
  name          text NOT NULL,
  prefix        text NOT NULL UNIQUE,
  key_hash      text NOT NULL,
  scopes        text[] NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz,
  revoked_at    timestamptz
);

-- ── books ───────────────────────────────────────────────────────────────
-- An entity is a set of books. Everything starts in "Personal"; when the dev
-- LLC forms, its accounts and stream move to a new entity and money between
-- the two becomes owner contributions/draws (transfer categories).
CREATE TABLE entities (
  id          serial PRIMARY KEY,
  name        text NOT NULL UNIQUE,
  kind        text NOT NULL CHECK (kind IN ('personal','sole_prop','llc','other')),
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- An income stream is a P&L unit: income rows and business-expense rows carry
-- one. Untagged rows are household.
CREATE TABLE streams (
  id          serial PRIMARY KEY,
  entity_id   int NOT NULL REFERENCES entities(id),
  name        text NOT NULL UNIQUE,
  kind        text NOT NULL CHECK (kind IN ('w2','schedule_c','other')),
  color       text,
  active      boolean NOT NULL DEFAULT true,
  sort        int NOT NULL DEFAULT 0
);

CREATE TABLE accounts (
  id            serial PRIMARY KEY,
  entity_id     int NOT NULL REFERENCES entities(id),
  name          text NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('checking','savings','credit','brokerage','retirement',
                                              'exchange','wallet','cash','clearing','asset','loan')),
  institution   text,
  last4         text,                   -- matches statements/CSVs to the account
  connector     text NOT NULL DEFAULT 'manual',
  external_id   text,
  currency      text NOT NULL DEFAULT 'USD',
  is_closed     boolean NOT NULL DEFAULT false,
  sort          int NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Credentials for sync connectors (Phase 2+). secret_enc is AES-GCM under FOLIO_ENC_KEY.
CREATE TABLE connections (
  id               serial PRIMARY KEY,
  connector        text NOT NULL,
  label            text,
  secret_enc       text,
  status           text NOT NULL DEFAULT 'active',
  last_success_at  timestamptz,
  last_error       text,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE categories (
  id           serial PRIMARY KEY,
  parent_id    int REFERENCES categories(id),
  name         text NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('income','expense','transfer')),
  tax_line     text,                   -- e.g. 'C-27a' — a hint for the accountant, not tax advice
  is_business  boolean NOT NULL DEFAULT false,
  system_key   text UNIQUE,            -- stable handle code can look up ('transfer', 'cc_payment', …)
  archived     boolean NOT NULL DEFAULT false,
  sort         int NOT NULL DEFAULT 0,
  UNIQUE NULLS NOT DISTINCT (parent_id, name)
);

-- ── imports ─────────────────────────────────────────────────────────────
CREATE TABLE import_batches (
  id                serial PRIMARY KEY,
  origin            text NOT NULL DEFAULT 'web' CHECK (origin IN ('web','inbox')),
  kind              text NOT NULL CHECK (kind IN ('csv','qfx','pdf')),
  parser            text,
  filename          text,
  mime              text,
  storage_key       text,
  sha256            text NOT NULL,
  bytes             bigint,
  account_id        int REFERENCES accounts(id),
  detected_last4    text,
  detected_kind     text,
  status            text NOT NULL CHECK (status IN ('parsed','imported','failed')),
  period_start      date,
  period_end        date,
  opening_cents     bigint,
  closing_cents     bigint,
  parsed_sum_cents  bigint,
  reconciled        boolean,            -- null = source has no balances to check against
  parsed            jsonb,              -- normalized rows, kept until commit for the preview
  warnings          jsonb NOT NULL DEFAULT '[]',
  stats             jsonb NOT NULL DEFAULT '{}',
  error             text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  imported_at       timestamptz
);
-- The same file twice is almost always a mistake; failed attempts may be retried.
CREATE UNIQUE INDEX import_batches_sha_live ON import_batches (sha256) WHERE status <> 'failed';

-- ── ledger ──────────────────────────────────────────────────────────────
CREATE TABLE rules (
  id                serial PRIMARY KEY,
  name              text,
  priority          int NOT NULL DEFAULT 100,   -- lower runs first
  match             jsonb NOT NULL,
  set_category_id   int REFERENCES categories(id),
  set_stream_id     int REFERENCES streams(id),
  set_merchant      text,
  created_from_txn  bigint,
  enabled           boolean NOT NULL DEFAULT true,
  hits              int NOT NULL DEFAULT 0,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE transactions (
  id                 bigserial PRIMARY KEY,
  account_id         int NOT NULL REFERENCES accounts(id),
  posted_on          date NOT NULL,
  amount_cents       bigint NOT NULL,
  description_raw    text NOT NULL,
  merchant           text,
  category_id        int REFERENCES categories(id),
  stream_id          int REFERENCES streams(id),
  status             text NOT NULL DEFAULT 'posted' CHECK (status IN ('pending','posted')),
  source             text NOT NULL,      -- 'chase-csv', 'chase-pdf', 'manual', 'simplefin', …
  external_id        text NOT NULL,      -- unique per (account, source); synthesized for files
  import_batch_id    int REFERENCES import_batches(id) ON DELETE SET NULL,
  transfer_group_id  uuid,
  categorized_by     text CHECK (categorized_by IN ('rule','ai','user','transfer')),
  rule_id            int REFERENCES rules(id) ON DELETE SET NULL,
  notes              text,
  meta               jsonb NOT NULL DEFAULT '{}',   -- source-specific extras (Chase type/category, running balance)
  is_split           boolean NOT NULL DEFAULT false,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, source, external_id)
);
CREATE INDEX transactions_account_date ON transactions (account_id, posted_on);
CREATE INDEX transactions_date ON transactions (posted_on);
CREATE INDEX transactions_uncategorized ON transactions (posted_on) WHERE category_id IS NULL;
CREATE INDEX transactions_merchant ON transactions (lower(merchant));
CREATE INDEX transactions_transfer ON transactions (transfer_group_id) WHERE transfer_group_id IS NOT NULL;

CREATE TABLE transaction_splits (
  id              serial PRIMARY KEY,
  transaction_id  bigint NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  amount_cents    bigint NOT NULL,
  category_id     int REFERENCES categories(id),
  stream_id       int REFERENCES streams(id),
  notes           text
);

-- When the same transaction arrives from a second source (CSV + PDF + sync),
-- the extra copies are kept here as evidence instead of becoming duplicates.
CREATE TABLE evidence (
  id               bigserial PRIMARY KEY,
  transaction_id   bigint NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  source           text NOT NULL,
  external_id      text NOT NULL,
  import_batch_id  int REFERENCES import_batches(id) ON DELETE CASCADE,
  posted_on        date,
  amount_cents     bigint,
  description_raw  text,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX evidence_txn ON evidence (transaction_id);

-- Phase 2: dry-dock suggestions. Phase 1 computes history-based suggestions on the fly.
CREATE TABLE ai_suggestions (
  id              bigserial PRIMARY KEY,
  transaction_id  bigint NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  category_id     int REFERENCES categories(id),
  stream_id       int REFERENCES streams(id),
  confidence      real,
  reason          text,
  worker          text,
  pool            text,
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','rejected','superseded')),
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE balance_snapshots (
  id               bigserial PRIMARY KEY,
  account_id       int NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  as_of            date NOT NULL,
  balance_cents    bigint NOT NULL,
  -- statement/csv/manual/sync are anchors (observed); computed is our own nightly roll-forward
  source           text NOT NULL CHECK (source IN ('statement','csv','manual','sync','computed')),
  import_batch_id  int REFERENCES import_batches(id) ON DELETE CASCADE,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, as_of, source)
);

CREATE TABLE receipts (
  id              serial PRIMARY KEY,
  transaction_id  bigint REFERENCES transactions(id) ON DELETE SET NULL,
  storage_key     text NOT NULL,
  filename        text,
  mime            text,
  bytes           bigint,
  origin          text NOT NULL DEFAULT 'web',
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE mileage (
  id          serial PRIMARY KEY,
  on_date     date NOT NULL,
  miles       numeric(8,1) NOT NULL CHECK (miles > 0),
  purpose     text NOT NULL,
  stream_id   int REFERENCES streams(id),
  from_place  text,
  to_place    text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ── Phase 3/4 seams (tables exist so later phases are additive) ────────
CREATE TABLE tax_payments (
  id            serial PRIMARY KEY,
  tax_year      int NOT NULL,
  quarter       int CHECK (quarter BETWEEN 1 AND 4),
  jurisdiction  text NOT NULL,          -- 'federal', 'IL', …
  amount_cents  bigint NOT NULL,
  paid_on       date NOT NULL,
  transaction_id bigint REFERENCES transactions(id) ON DELETE SET NULL
);

CREATE TABLE period_locks (
  id            serial PRIMARY KEY,
  entity_id     int NOT NULL REFERENCES entities(id),
  through_date  date NOT NULL,
  note          text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE holdings (
  id                 serial PRIMARY KEY,
  account_id         int NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  symbol             text NOT NULL,
  quantity           numeric(38,18) NOT NULL,
  cost_basis_cents   bigint,
  as_of              date NOT NULL,
  UNIQUE (account_id, symbol, as_of)
);

CREATE TABLE prices (
  symbol       text NOT NULL,
  on_date      date NOT NULL,
  price_cents  numeric(20,6) NOT NULL,
  PRIMARY KEY (symbol, on_date)
);

-- gear-tracker owns items and valuations; folio keeps a reference + value history.
CREATE TABLE assets (
  id            serial PRIMARY KEY,
  kind          text NOT NULL CHECK (kind IN ('gear','vehicle','other')),
  name          text NOT NULL,
  external_ref  text UNIQUE,            -- 'gear-tracker:<id>'
  entity_id     int REFERENCES entities(id),
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE asset_valuations (
  asset_id     int NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  as_of        date NOT NULL,
  value_cents  bigint NOT NULL,
  source       text NOT NULL DEFAULT 'manual',
  PRIMARY KEY (asset_id, as_of)
);

-- ── ops ─────────────────────────────────────────────────────────────────
CREATE TABLE jobs (
  id           bigserial PRIMARY KEY,
  kind         text NOT NULL,
  payload      jsonb NOT NULL DEFAULT '{}',
  dedupe_key   text UNIQUE,
  run_at       timestamptz NOT NULL DEFAULT now(),
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','done','failed')),
  attempts     int NOT NULL DEFAULT 0,
  last_error   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  started_at   timestamptz,
  finished_at  timestamptz
);
CREATE INDEX jobs_due ON jobs (run_at) WHERE status = 'pending';

CREATE TABLE audit_log (
  id         bigserial PRIMARY KEY,
  at         timestamptz NOT NULL DEFAULT now(),
  actor      text NOT NULL,
  action     text NOT NULL,
  entity     text NOT NULL,
  entity_id  text,
  before     jsonb,
  after      jsonb
);
CREATE INDEX audit_log_entity ON audit_log (entity, entity_id);
