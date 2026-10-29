-- 0023: The System page's diagnostics look up the latest failed scheduler run
-- (routes/diagnostics.ts). On an install that has never failed, that lookup
-- read every run record (about 14,000 rows on a four-month-old install, on
-- each page load). This index holds only failed runs, so it reads at most one.
CREATE INDEX IF NOT EXISTS idx_scheduler_runs_failed ON scheduler_runs(started_at) WHERE ok = 0;
