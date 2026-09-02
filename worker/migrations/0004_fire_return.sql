-- 0004: the FI countdown's one knob.
--
-- Percent per year, REAL (after inflation), used by api.js fireEta to compound the
-- pile toward 25x annual spend. It is a meta row and not a constant so the owner can
-- retune it from the Settings table editor without a deploy. The 4% multiple beside
-- it stays a constant on purpose: that one is the rule's definition, not a taste.
-- INSERT OR IGNORE, so a hand-set value survives a re-run of the migration.
INSERT OR IGNORE INTO meta (key, value) VALUES ('fire_real_return', '5');
