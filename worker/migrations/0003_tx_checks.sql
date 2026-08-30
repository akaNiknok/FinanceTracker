-- 0003: put the write-path invariants in the schema (F20).
-- SQLite cannot add a CHECK in place, so `transactions` is recreated.
-- ORDER MATTERS. The copy runs FIRST, because it is the only statement that can
-- fail (a row that breaks a new CHECK). A migration file is not one transaction,
-- so a failure after the drops would leave the app with no ledger_view and no
-- transactions table. Failing at the copy leaves the live schema untouched, and
-- IF EXISTS makes the retry-after-cleanup clean.
-- ledger_view is dropped before the rename: ALTER TABLE ... RENAME re-parses every
-- view in the schema and fails on one that points at a table no longer there.
-- Generated columns are copied VERBATIM from 0001 — a changed expression would
-- silently restate every month key and every PHP amount.
DROP TABLE IF EXISTS transactions_new;

CREATE TABLE transactions_new (
  id            TEXT PRIMARY KEY,
  date          TEXT NOT NULL CHECK (date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
                  AND CAST(substr(date, 6, 2) AS INTEGER) BETWEEN 1 AND 12
                  AND CAST(substr(date, 9, 2) AS INTEGER) BETWEEN 1 AND 31),
  period        TEXT CHECK (period IS NULL OR period GLOB '[0-9][0-9][0-9][0-9]-[A-Z][a-z][a-z]'),
  category_id   INTEGER NOT NULL REFERENCES categories(id),
  description   TEXT,
  account_id    INTEGER NOT NULL REFERENCES accounts(id),
  amount_u      INTEGER NOT NULL CHECK (amount_u != 0),   -- signed, may be negative; never zero
  fx_rate       REAL CHECK (fx_rate IS NULL OR fx_rate > 0),
  to_account_id INTEGER REFERENCES accounts(id),
  to_amount_u   INTEGER,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  month TEXT GENERATED ALWAYS AS (COALESCE(period,
    substr(date, 1, 4) || '-' || substr('JanFebMarAprMayJunJulAugSepOctNovDec',
      (CAST(substr(date, 6, 2) AS INTEGER) - 1) * 3 + 1, 3))) STORED,
  amount_php_u INTEGER GENERATED ALWAYS AS (CAST(ROUND(amount_u * COALESCE(fx_rate, 1)) AS INTEGER)) STORED,
  -- a transfer carries both halves or neither (table-level: it spans two columns)
  CHECK ((to_account_id IS NULL) = (to_amount_u IS NULL))
);

INSERT INTO transactions_new
  (id, date, period, category_id, description, account_id, amount_u, fx_rate, to_account_id, to_amount_u, created_at)
SELECT id, date, period, category_id, description, account_id, amount_u, fx_rate, to_account_id, to_amount_u, created_at
FROM transactions;

DROP VIEW ledger_view;
DROP TABLE transactions;
ALTER TABLE transactions_new RENAME TO transactions;

CREATE INDEX idx_tx_month      ON transactions(month);
CREATE INDEX idx_tx_date       ON transactions(date);
CREATE INDEX idx_tx_account    ON transactions(account_id);
CREATE INDEX idx_tx_to_account ON transactions(to_account_id);
CREATE INDEX idx_tx_category   ON transactions(category_id);

CREATE VIEW ledger_view AS
SELECT l.id, l.tx_id, l.bsp_rate, l.filed,
  COALESCE(t.date, l.date_received)     AS date_received,
  t.month                               AS reporting_period,   -- the derived month, same rule as the sheet
  COALESCE(t.amount_u, l.wise_amount_u) AS wise_amount_u,
  CAST(ROUND(COALESCE(t.amount_u, l.wise_amount_u) * COALESCE(l.bsp_rate, 1))        AS INTEGER) AS total_income_u,
  CAST(ROUND(COALESCE(t.amount_u, l.wise_amount_u) * COALESCE(l.bsp_rate, 1) * 0.08) AS INTEGER) AS tax_u,
  (l.tx_id IS NOT NULL AND t.id IS NULL) AS tx_deleted          -- the UI renders the warning row
FROM ledger l LEFT JOIN transactions t ON t.id = l.tx_id;
