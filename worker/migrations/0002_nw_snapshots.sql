-- 0002_nw_snapshots.sql — monthly net-worth history.
--
-- The on-demand net worth (db.js deltas + shapeAccounts) is always computed at
-- TODAY's FX and share prices, and no historical FX is stored, so a past month's
-- net worth cannot be reconstructed after the fact. This table is that missing
-- record: one row per month, written by the daily cron (jobs.js snapshotNetWorth).
-- Upserted by month, so a month's LAST write of the month is its closing value;
-- the Dashboard's net-worth line reads real history here instead of estimating it
-- by rolling cash flow backward from the current total.
--
-- PHP INTEGER MICROS, same convert-at-the-boundary rule as everything else.
CREATE TABLE nw_snapshots (
  month          TEXT PRIMARY KEY,   -- yyyy-MMM, e.g. '2026-Aug'
  net_worth_u    INTEGER NOT NULL,   -- signed (liabilities pull it down)
  assets_u       INTEGER NOT NULL,
  liabilities_u  INTEGER NOT NULL,   -- liabilities positive, as the API reports them
  shares_u       INTEGER NOT NULL,   -- invested value, subset of assets
  taken_at       TEXT NOT NULL       -- ISO timestamp of the write
);
