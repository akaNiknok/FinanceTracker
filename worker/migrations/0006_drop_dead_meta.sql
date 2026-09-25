-- 0006: two meta rows that nothing reads.
--
-- data_version has been dead since v2.9.0 (an ETag replaced it). It was kept one
-- release so a `wrangler rollback` would not meet a missing counter; that window is
-- long closed. ledger_first_year was never read by the Worker (getLedger derives the
-- years from the rows). Idempotent: a re-run deletes nothing.
DELETE FROM meta WHERE key IN ('data_version', 'ledger_first_year');
