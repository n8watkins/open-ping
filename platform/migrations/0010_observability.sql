-- Observability (build plan, C4): what the platform's health endpoint
-- (GET app.<domain>/__health, src/observability/health.ts) and the admin
-- console's Operations tab (src/observability/metrics.ts) read. Every read
-- here is by primary key or over a partial index, so neither ever scans the
-- tenants (test/observability.test.ts checks the query plans).

-- The cron's last tick, and the scheduler's last enqueue, one row each,
-- rewritten every minute (2 rows written a minute, about 86,400 a month).
-- A health check reads both by primary key to tell "the cron stopped" from
-- "the cron runs but can't reach the queue".
CREATE TABLE platform_heartbeats (
  name   TEXT PRIMARY KEY,                   -- 'cron', 'enqueue'
  at     INTEGER NOT NULL,                   -- when it last ran (epoch ms)
  detail TEXT                                -- small JSON, never secret (the enqueue's counts)
) WITHOUT ROWID;

-- Every scheduler run on the platform, added up per UTC minute: one row per
-- minute, upserted once per queue consumer batch (up to 25 runs), so it costs
-- about 1/25 of a row written per run. Durations are also counted in fixed
-- buckets (d0 to d9, upper bounds in src/observability/metrics.ts), which is
-- what the console's p95 is read from: the bucket the 95th percentile falls
-- in, never a scan of the runs themselves. Kept 8 days.
CREATE TABLE scheduler_minutes (
  minute       INTEGER PRIMARY KEY,          -- epoch ms / 60000 of when the runs started
  runs         INTEGER NOT NULL,
  errors       INTEGER NOT NULL,             -- failed, error or timeout: runs without a clean answer
  timeouts     INTEGER NOT NULL,
  busy         INTEGER NOT NULL,             -- lease_busy: the tenant was still running its last one
  checked      INTEGER NOT NULL,             -- monitors checked, as the tenants reported
  failures     INTEGER NOT NULL,             -- failed checks, as the tenants reported
  total_ms     INTEGER NOT NULL,             -- call time, measured by the platform
  max_ms       INTEGER NOT NULL,
  lag_total_ms INTEGER NOT NULL,             -- from due to called: queue lag
  lag_max_ms   INTEGER NOT NULL,
  d0 INTEGER NOT NULL DEFAULT 0, d1 INTEGER NOT NULL DEFAULT 0, d2 INTEGER NOT NULL DEFAULT 0,
  d3 INTEGER NOT NULL DEFAULT 0, d4 INTEGER NOT NULL DEFAULT 0, d5 INTEGER NOT NULL DEFAULT 0,
  d6 INTEGER NOT NULL DEFAULT 0, d7 INTEGER NOT NULL DEFAULT 0, d8 INTEGER NOT NULL DEFAULT 0,
  d9 INTEGER NOT NULL DEFAULT 0
);

-- The tenants whose scheduler keeps failing: scheduler_stats.streak counts a
-- tenant's runs in a row without a clean answer, and is 0 for a healthy one,
-- so this partial index holds only the failing tenants. A healthy tenant's
-- run never writes to it (its streak stays 0, outside the WHERE), and the
-- health check and the console count and list failing tenants from it alone.
CREATE INDEX idx_scheduler_stats_failing ON scheduler_stats(streak) WHERE streak > 0;
