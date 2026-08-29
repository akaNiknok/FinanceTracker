-- 0002_nw_snapshots.sql — monthly net-worth history.
--
-- The on-demand net worth (db.js deltas + shapeAccounts) is always computed at
-- TODAY's FX and share prices, and no historical FX is stored, so a past month's
-- net worth cannot be reconstructed after the fact. This table is that missing
-- record: one row per month, written by the daily cron (jobs.js snapshotNetWorth).
-- Upserted by month, and the cron stamps YESTERDAY's month (Manila), so the run on
-- the 1st writes the previous month's true close — a run at 06:00 on the last day of
-- a month would otherwise close it without that day. The Dashboard's net-worth line
-- reads real history here instead of estimating it by rolling cash flow backward
-- from the current total.
--
-- NOTE (corrected 2026-08-30): this file's original comment claimed liabilities are
-- stored positive. They are not, and never were: liabilities_u sums netWorthPhp, so
-- it is NEGATIVE (a liability pulls net worth down) and net_worth_u = assets_u +
-- liabilities_u. Editing an applied migration does not re-run it — the comment is
-- fixed here only so the next reader is not misled.
--
-- PHP INTEGER MICROS, same convert-at-the-boundary rule as everything else.
CREATE TABLE nw_snapshots (
  month          TEXT PRIMARY KEY,   -- yyyy-MMM, e.g. '2026-Aug'
  net_worth_u    INTEGER NOT NULL,   -- signed (liabilities pull it down)
  assets_u       INTEGER NOT NULL,
  liabilities_u  INTEGER NOT NULL,   -- NEGATIVE (signed), matching the API's `liabilities`
  shares_u       INTEGER NOT NULL,   -- invested value, subset of assets
  taken_at       TEXT NOT NULL       -- ISO timestamp of the write
);
