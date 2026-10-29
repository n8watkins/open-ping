-- Scheduling (build plan, B4): the platform runs each customer's scheduler,
-- since a user Worker in a dispatch namespace has no Cron Trigger of its own.
-- The every-minute cron claims the tenants that are due and puts one message
-- per tenant on the schedule queue; the consumer calls the tenant's
-- POST /__platform/scheduled (src/scheduling.ts).

-- When the cron should next enqueue the tenant (epoch ms). 0 means "as soon
-- as it is ready": the first claim spreads tenants over their interval.
ALTER TABLE tenants ADD COLUMN schedule_next_at INTEGER NOT NULL DEFAULT 0;
-- The run the cron last claimed (its run id), so a stale or duplicate queue
-- message can't start a run nobody asked for.
ALTER TABLE tenants ADD COLUMN schedule_claim TEXT;
-- The claimed run's attempt that is calling the tenant ('<run id>:<attempt>');
-- a second delivery of the same attempt finds it already taken.
ALTER TABLE tenants ADD COLUMN schedule_running TEXT;
-- Nothing else is claimed or started for the tenant before this time (epoch
-- ms): the wait in the queue, then the call's timeout and a margin. It runs
-- out on its own, so a consumer that dies frees the tenant within a minute or two.
ALTER TABLE tenants ADD COLUMN schedule_lease_until INTEGER;

-- The cron reads only due tenants that may run: a partial index whose WHERE
-- is exactly the due query's (test/scheduling.test.ts checks the query plan),
-- so not-ready, suspended and owner-suspended tenants are never read, and the
-- cron's cost grows with the tenants due this minute, not with all of them.
CREATE INDEX idx_tenants_schedule_due ON tenants(schedule_next_at)
  WHERE provision_state = 'ready' AND status <> 'suspended' AND owner_suspended_at IS NULL;

-- Each tenant's latest run and today's totals, for the admin console. One
-- row per tenant, rewritten once per run (one D1 row written per run: the
-- cost at 1-minute checks matters, platform/README.md "Scheduling costs").
-- The run's own numbers come from its ScheduledRunSummary (the contract,
-- section 6); duration and lag are measured by the platform.
CREATE TABLE scheduler_stats (
  tenant_id         TEXT PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  last_run_id       TEXT NOT NULL,
  last_at           INTEGER NOT NULL,       -- when the platform called (epoch ms)
  last_outcome      TEXT NOT NULL CHECK (last_outcome IN ('ran', 'lease_busy', 'failed', 'error', 'timeout')),
  last_duration_ms  INTEGER NOT NULL,       -- the call, measured by the platform
  last_tenant_ms    INTEGER,                -- the run, as the tenant reported it
  last_lag_ms       INTEGER NOT NULL,       -- from due to called: queue lag
  last_checked      INTEGER,
  last_failures     INTEGER,
  last_deferred     INTEGER,
  last_d1_queries   INTEGER,
  last_version      TEXT,
  last_error        TEXT,                   -- short and never secret
  last_ok_at        INTEGER,                -- the latest run that answered 'ran'
  streak            INTEGER NOT NULL DEFAULT 0, -- runs in a row that failed or got no answer
  day               INTEGER NOT NULL,       -- UTC day (epoch ms / 86400000) the totals below are for
  day_runs          INTEGER NOT NULL,
  day_errors        INTEGER NOT NULL,       -- runs that failed or got no answer
  day_checked       INTEGER NOT NULL,
  day_failures      INTEGER NOT NULL,
  day_d1_queries    INTEGER NOT NULL,
  day_ms            INTEGER NOT NULL,       -- total call time
  day_max_ms        INTEGER NOT NULL
) WITHOUT ROWID;

-- Earlier days' totals, written once per tenant per day when a run finds
-- scheduler_stats holding an older day. Kept 90 days.
CREATE TABLE scheduler_days (
  tenant_id   TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  day         INTEGER NOT NULL,
  runs        INTEGER NOT NULL,
  errors      INTEGER NOT NULL,
  checked     INTEGER NOT NULL,
  failures    INTEGER NOT NULL,
  d1_queries  INTEGER NOT NULL,
  total_ms    INTEGER NOT NULL,
  max_ms      INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, day)
) WITHOUT ROWID;
