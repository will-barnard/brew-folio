-- Investment positions valued at live prices.
--
-- Investment accounts (brokerage, retirement, exchange, wallet) don't sync
-- transactions. They hold positions — entered by hand or replaced wholesale
-- from a Fidelity statement / Positions CSV — and their balance is
-- Σ quantity × latest quote. Nightly balance snapshots record the value, so
-- investment history accrues from day one.

-- The Phase 4 seam from 001 assumed per-day holding snapshots; positions are
-- current state instead (history lives in balance_snapshots). Never used.
DROP TABLE IF EXISTS holdings;

CREATE TABLE positions (
  id                serial PRIMARY KEY,
  account_id        int NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  symbol            text NOT NULL,           -- ticker, crypto symbol, or USD for plain cash
  name              text,
  asset_type        text NOT NULL CHECK (asset_type IN ('stock','etf','mutual_fund','crypto','cash','other')),
  -- For cash and money-market positions, quantity is dollars (price is always 1).
  quantity          numeric(38,18) NOT NULL CHECK (quantity >= 0),
  cost_basis_cents  bigint,
  -- For things with no market price (private holdings, restricted shares).
  manual_price      numeric(20,6),
  source            text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','fidelity-csv','fidelity-pdf')),
  as_of             date,                    -- date the quantity was last confirmed (statement date for imports)
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, symbol)
);

-- Latest price per symbol. Securities and crypto are keyed separately: "ETH"
-- the token and a ticker that happens to be ETH are different things.
CREATE TABLE quotes (
  symbol       text NOT NULL,
  asset_class  text NOT NULL CHECK (asset_class IN ('security','crypto')),
  price        numeric(20,6) NOT NULL,
  prev_close   numeric(20,6),
  quoted_at    timestamptz NOT NULL,          -- when the price is from, not when we fetched it
  fetched_at   timestamptz NOT NULL DEFAULT now(),
  provider     text NOT NULL,                 -- tiingo-iex, tiingo-daily, coinbase, fidelity-csv, fidelity-pdf
  last_error   text,
  error_at     timestamptz,
  PRIMARY KEY (symbol, asset_class)
);
