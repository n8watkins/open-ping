-- 0011: How many D1 round trips each scheduler run made (a batch counts as one).
-- A run's duration_ms is wall-clock time, and a run that checks nothing spends
-- nearly all of it waiting on D1, so the two together show the run's latency to
-- the database. NULL for runs recorded before this migration.
ALTER TABLE scheduler_runs ADD COLUMN d1_queries INTEGER;
