-- 0001_init.sql — the v2.0.0 schema. Replaces the Google Sheets workbook.
--
-- Conventions the whole codebase depends on:
--   * money/quantities are INTEGER MICROS (native units x 1,000,000). Exact integer
--     sums, and room for fractional IBKR share quantities in the same column (a
--     Shares row's amount IS a quantity, exactly as in the sheet). Decimals appear
--     only at the API boundary (u/1e6), so the wire format is unchanged from v1.
--   * dates are 'yyyy-MM-dd' TEXT; month keys are 'yyyy-MMM' ('2026-Aug') everywhere,
--     including in the DB. The SPA, the Gemini prompt and Budgets all compare that
--     exact shape (the successor to MIG_MONTH_FORMAT).
--   * FKs by integer id internally; the API keeps speaking account/category NAMES
--     (resolved on write, JOINed on read), so a rename is one UPDATE instead of the
--     sheet's "never rename" rule.
--
-- Generated columns use substr/CAST arithmetic and NOT strftime: SQLite registers the
-- date/time functions as non-deterministic (they can read 'now') and a generated
-- column may only call deterministic ones, so strftime here fails at CREATE TABLE
-- time. substr over a 'yyyy-MM-dd' string is deterministic and exact.

PRAGMA foreign_keys = ON;   -- D1 default; the importer must still insert parents first

CREATE TABLE account_types (            -- was the AccountType sheet
  subtype TEXT PRIMARY KEY,
  type    TEXT NOT NULL CHECK (type IN ('Asset','Liability'))
);

CREATE TABLE accounts (                 -- was the Accounts sheet (input columns only)
  id                 INTEGER PRIMARY KEY,
  name               TEXT NOT NULL UNIQUE,
  currency           TEXT NOT NULL DEFAULT 'PHP',
  subtype            TEXT NOT NULL REFERENCES account_types(subtype),
  symbol             TEXT,              -- IBKR ticker for Shares accounts (was inside the GOOGLEFINANCE formula)
  starting_balance_u INTEGER NOT NULL DEFAULT 0,
  interest_frequency TEXT,
  interest_rate      REAL,
  credit_limit_u     INTEGER,
  notes              TEXT,
  color              TEXT
);
-- Current Balance / Available Credit are deliberately NOT columns: computed at read
-- (balances() in src/db.js), the same "derivation is not stored" rule the sheet had.

CREATE TABLE categories (               -- was the Categories sheet
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  type        TEXT NOT NULL CHECK (type IN ('Income','Expense','Transfer')),
  segment     TEXT,
  description TEXT
);

CREATE TABLE transactions (             -- was the Transactions input columns
  id            TEXT PRIMARY KEY,       -- keeps the existing id space: tg-*, gm-*, ui-*, interest-*, legacy
  date          TEXT NOT NULL CHECK (date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  period        TEXT CHECK (period IS NULL OR period GLOB '[0-9][0-9][0-9][0-9]-[A-Z][a-z][a-z]'),
  category_id   INTEGER NOT NULL REFERENCES categories(id),
  description   TEXT,
  account_id    INTEGER NOT NULL REFERENCES accounts(id),
  amount_u      INTEGER NOT NULL,       -- signed, native units, micros (sheet signs copied verbatim)
  fx_rate       REAL,                   -- was ExchangeRate: stamped at write for non-PHP, NULL = 1 (PHP)
  to_account_id INTEGER REFERENCES accounts(id),   -- a transfer stays ONE row, same as the sheet
  to_amount_u   INTEGER,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  -- Month: the Period override wins, else derived from date. Replaces the ARRAYFORMULA,
  -- the '@' text-format gotcha, and the downstream half of tx_parsePeriod_.
  month TEXT GENERATED ALWAYS AS (COALESCE(period,
    substr(date, 1, 4) || '-' || substr('JanFebMarAprMayJunJulAugSepOctNovDec',
      (CAST(substr(date, 6, 2) AS INTEGER) - 1) * 3 + 1, 3))) STORED,
  -- Amount (PHP) in micros. ROUND before CAST — CAST alone truncates toward zero,
  -- which negative amounts make visible immediately.
  amount_php_u INTEGER GENERATED ALWAYS AS (CAST(ROUND(amount_u * COALESCE(fx_rate, 1)) AS INTEGER)) STORED
);
CREATE INDEX idx_tx_month      ON transactions(month);
CREATE INDEX idx_tx_date       ON transactions(date);
CREATE INDEX idx_tx_account    ON transactions(account_id);
CREATE INDEX idx_tx_to_account ON transactions(to_account_id);
CREATE INDEX idx_tx_category   ON transactions(category_id);
-- Type/Segment/Currency are JOINs (categories.type/segment, accounts.currency), not columns.

CREATE TABLE budgets (                  -- was the Budgets sheet: plan only, actuals stay computed
  id          INTEGER PRIMARY KEY,
  segment     TEXT NOT NULL UNIQUE,
  period      TEXT NOT NULL CHECK (period IN ('Monthly','Quarterly')),
  target_type TEXT NOT NULL CHECK (target_type IN ('Percent','Amount')),
  target      REAL NOT NULL,
  currency    TEXT,                     -- 'USD' -> live FX; NULL/'PHP' passes through
  notes       TEXT
);

CREATE TABLE recurring (                -- was the Recurring sheet, reference only
  id          INTEGER PRIMARY KEY,
  description TEXT NOT NULL,
  currency    TEXT,
  amount_u    INTEGER,
  fee_u       INTEGER,
  months_left INTEGER,
  grp         TEXT                      -- 'Group' is keyword-ish in SQL; "Group" on the wire
);

CREATE TABLE ledger (                   -- was the Ledger sheet (BIR 8% tracker)
  id            INTEGER PRIMARY KEY,
  tx_id         TEXT,      -- SOFT reference, deliberately no FK: a deleted tx must render
                           -- the warning row (a LEFT JOIN miss), not block the delete
  bsp_rate      REAL,      -- hand-typed BIR reference rate; deliberately NOT the app's fx_rate
  filed         TEXT,      -- BIR quarter string '2026-Q1'; a legacy 'TRUE' imports as-is
  date_received TEXT,      -- literal fallback for a legacy row never linked to a tx; NULL when tx_id is set
  wise_amount_u INTEGER
);

-- The sheet's per-row formulas (Date Received, Reporting Period, Wise Amount,
-- Total Income, 8% Tax) become one LEFT JOIN.
CREATE VIEW ledger_view AS
SELECT l.id, l.tx_id, l.bsp_rate, l.filed,
  COALESCE(t.date, l.date_received)     AS date_received,
  t.month                               AS reporting_period,   -- the derived month, same rule as the sheet
  COALESCE(t.amount_u, l.wise_amount_u) AS wise_amount_u,
  CAST(ROUND(COALESCE(t.amount_u, l.wise_amount_u) * COALESCE(l.bsp_rate, 1))        AS INTEGER) AS total_income_u,
  CAST(ROUND(COALESCE(t.amount_u, l.wise_amount_u) * COALESCE(l.bsp_rate, 1) * 0.08) AS INTEGER) AS tax_u,
  (l.tx_id IS NOT NULL AND t.id IS NULL) AS tx_deleted          -- the UI renders the warning row
FROM ledger l LEFT JOIN transactions t ON t.id = l.tx_id;

CREATE TABLE prices (                   -- replaces GOOGLEFINANCE; written by the nightly IBKR cron
  symbol    TEXT NOT NULL,
  priced_at TEXT NOT NULL,              -- yyyy-MM-dd (the IBKR report date)
  price     REAL NOT NULL,              -- native quote currency per share
  currency  TEXT NOT NULL,
  PRIMARY KEY (symbol, priced_at)       -- history is free, and is the audit trail the Sheet never had
);

-- The email button's source text. The Worker cannot call GmailApp, so the GAS courier
-- posts the quote it already builds and the 'e:<messageId>' callback reads it back
-- from here. Small by construction: one row per ingested email.
CREATE TABLE email_quotes (
  message_id TEXT PRIMARY KEY,
  quote      TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Telegram redelivers an update until it gets a timely answer, and one Gemini round
-- trip is slow enough to lose that race. Claiming the update_id here is what stops a
-- redelivery starting a second parse and posting a second receipt (the idempotent
-- row id stops the second ROW; this stops the second reply). Own table rather than a
-- meta key so the admin grid and the nightly export stay free of churn.
CREATE TABLE seen_updates (
  update_id INTEGER PRIMARY KEY,
  at        INTEGER NOT NULL          -- epoch ms; rows older than a day are swept on insert
);

-- Replaces Script Properties, and is editable in the admin grid.
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
INSERT INTO meta (key, value) VALUES
  ('data_version',       '1'),
  ('monthly_income_php', '47200'),
  ('usd_php_fallback',   '0'),
  ('owner_email',        'austingimperial@gmail.com'),
  ('ledger_first_year',  '2026'),
  ('tg_last_ids',        '[]');
