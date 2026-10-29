-- 0022: Whether a scheduler run's history rollups all landed (1), or not (0).
-- The next run recomputes from the last run with 1, so a pass that failed is
-- made up however long ago it was. NULL for runs recorded before this
-- migration, so the first run after it recomputes everything once.
ALTER TABLE scheduler_runs ADD COLUMN compacted INTEGER;
