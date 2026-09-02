-- 0005: seen_updates becomes a durable QUEUE, not just a claim.
--
-- Why. Until v2.11.0 /tg answered Telegram 200 and did the work in ctx.waitUntil, and
-- Cloudflare CANCELS waitUntil work that outlives its allowance — torn down, never
-- rejected, so no catch ran and the message was gone in silence (2026-09-02). v2.11.0
-- moved the work INTO the request, which fixed that instance and moved the ceiling to
-- Telegram's webhook patience — a number Telegram does not document. A turn that
-- outlives THAT is lost the same way, because the claim below is taken before the work
-- and a redelivery therefore finds the update already claimed.
--
-- The fix is to make the claim carry the update itself. A row now records a piece of
-- work, not just a name: `payload` is the raw update, `done` says whether the turn
-- finished, and `attempts` counts the rescues. A turn that dies mid-flight leaves its
-- row `done = 0` with the payload intact, and the 2-minute drain cron re-runs it. The
-- row ids the bot writes (tg-<update_id>-<i>) are idempotent, so a rescue that races a
-- turn which was only slow cannot write a transaction twice.
--
-- The table keeps its name. Renaming it would be a destructive migration, and this repo
-- never ships one in the same release as the code that needs it.
ALTER TABLE seen_updates ADD COLUMN payload  TEXT;
ALTER TABLE seen_updates ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE seen_updates ADD COLUMN done     INTEGER NOT NULL DEFAULT 0;

-- Every row that exists today is a claim of a turn that already ended, and none of
-- them carries a payload. Retire them, so the first drain does not walk a day of old
-- updates it can do nothing with. The DEFAULT stays 0 because that is what a NEW row
-- means: claimed, not yet finished.
UPDATE seen_updates SET done = 1;

-- The drain reads exactly this shape, twice a minute at most. Without the index it is
-- a full scan of a table that holds a day of updates.
CREATE INDEX idx_seen_updates_pending ON seen_updates (done, at);
