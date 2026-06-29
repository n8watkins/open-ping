-- OpenPing v1 schema. SQLite/D1. All timestamps are integer epoch milliseconds.
-- JSON-shaped config is stored as TEXT; sensitive fields are encrypted before
-- being placed inside those JSON blobs (see lib/crypto). Referential integrity
-- is declared with FKs; the app also performs explicit cascading deletes so it
-- works whether or not D1 enforces FKs for a given operation.

-- ---------------------------------------------------------------------------
-- Settings: key/value app configuration + secrets (encrypted flag).
-- ---------------------------------------------------------------------------
CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  encrypted  INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

-- ---------------------------------------------------------------------------
-- Auth: sessions + single-use tokens (magic link, OAuth state).
-- Session id stored is the SHA-256 of the cookie token (token never persisted).
-- ---------------------------------------------------------------------------
CREATE TABLE sessions (
  id            TEXT PRIMARY KEY,
  identity      TEXT NOT NULL,           -- github login or email
  identity_kind TEXT NOT NULL,           -- 'github' | 'email'
  csrf_secret   TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  last_seen_at  INTEGER,
  user_agent    TEXT,
  ip            TEXT
);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);

CREATE TABLE auth_tokens (
  id         TEXT PRIMARY KEY,           -- SHA-256 of the raw token
  kind       TEXT NOT NULL,              -- 'magic_link' | 'oauth_state'
  data       TEXT,                       -- JSON (email, redirect, state, …)
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at    INTEGER
);
CREATE INDEX idx_auth_tokens_expires ON auth_tokens(expires_at);

-- ---------------------------------------------------------------------------
-- Monitors + mutable current state.
-- ---------------------------------------------------------------------------
CREATE TABLE monitors (
  id               TEXT PRIMARY KEY,
  type             TEXT NOT NULL,        -- 'http' | 'heartbeat'
  name             TEXT NOT NULL,
  enabled          INTEGER NOT NULL DEFAULT 1,
  paused           INTEGER NOT NULL DEFAULT 0,
  interval_seconds INTEGER NOT NULL DEFAULT 720,
  grace_seconds    INTEGER,              -- heartbeat grace period
  config           TEXT NOT NULL DEFAULT '{}',  -- JSON: http request, timeouts, thresholds, auth (secrets encrypted)
  schedule         TEXT NOT NULL DEFAULT '{}',  -- JSON: mode, weekdays, hours, timezone, custom periods, exclusions, overrides
  assertions       TEXT,                 -- JSON array of content/JSON assertions
  notify           TEXT,                 -- JSON: per-event channel preferences
  public           TEXT,                 -- JSON: public status-page config
  heartbeat_token  TEXT UNIQUE,          -- token used in /hb/:token
  sort_order       INTEGER NOT NULL DEFAULT 0,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);
CREATE INDEX idx_monitors_enabled ON monitors(enabled, paused);

CREATE TABLE monitor_state (
  monitor_id            TEXT PRIMARY KEY REFERENCES monitors(id) ON DELETE CASCADE,
  state                 TEXT NOT NULL DEFAULT 'unknown',
  state_since           INTEGER,
  last_checked_at       INTEGER,
  last_success_at       INTEGER,
  last_duration_ms      INTEGER,
  last_status_code      INTEGER,
  last_error            TEXT,
  consecutive_failures  INTEGER NOT NULL DEFAULT 0,
  consecutive_successes INTEGER NOT NULL DEFAULT 0,
  active_incident_id    TEXT,
  next_check_at         INTEGER,
  warmup                INTEGER NOT NULL DEFAULT 0,
  flap_count            INTEGER NOT NULL DEFAULT 0,
  is_flapping           INTEGER NOT NULL DEFAULT 0,
  updated_at            INTEGER
);
CREATE INDEX idx_monitor_state_due ON monitor_state(next_check_at);

-- ---------------------------------------------------------------------------
-- Incidents + timeline.
-- ---------------------------------------------------------------------------
CREATE TABLE incidents (
  id               TEXT PRIMARY KEY,
  monitor_id       TEXT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
  status           TEXT NOT NULL DEFAULT 'open',  -- 'open' | 'resolved'
  title            TEXT,
  root_cause       TEXT,                 -- category
  started_at       INTEGER NOT NULL,
  last_observed_at INTEGER,
  resolved_at      INTEGER,
  duration_seconds INTEGER,
  http_status      INTEGER,
  error            TEXT,                 -- internal error / network category
  private_notes    TEXT,
  public_message   TEXT,
  resolution       TEXT,
  public           INTEGER NOT NULL DEFAULT 0,
  is_flapping      INTEGER NOT NULL DEFAULT 0,
  notified         INTEGER NOT NULL DEFAULT 0,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);
CREATE INDEX idx_incidents_monitor ON incidents(monitor_id, started_at);
CREATE INDEX idx_incidents_status ON incidents(status);

CREATE TABLE incident_events (
  id          TEXT PRIMARY KEY,
  incident_id TEXT NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  at          INTEGER NOT NULL,
  kind        TEXT NOT NULL,             -- opened|observed|note|public_update|recovered|flapping
  message     TEXT,
  data        TEXT
);
CREATE INDEX idx_incident_events_incident ON incident_events(incident_id, at);

-- ---------------------------------------------------------------------------
-- History: recent samples (24h) → status intervals → period summaries.
-- ---------------------------------------------------------------------------
CREATE TABLE samples (
  id              TEXT PRIMARY KEY,
  monitor_id      TEXT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
  at              INTEGER NOT NULL,
  ok              INTEGER NOT NULL,
  state           TEXT NOT NULL,
  duration_ms     INTEGER,
  status_code     INTEGER,
  error           TEXT,
  attempts        INTEGER,
  warmup          INTEGER NOT NULL DEFAULT 0,
  retry_recovered INTEGER NOT NULL DEFAULT 0,
  meta            TEXT                   -- JSON (heartbeat duration/exit/message/metrics)
);
CREATE INDEX idx_samples_monitor_at ON samples(monitor_id, at);

CREATE TABLE status_intervals (
  id             TEXT PRIMARY KEY,
  monitor_id     TEXT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
  state          TEXT NOT NULL,
  started_at     INTEGER NOT NULL,
  ended_at       INTEGER,               -- NULL while open
  checks         INTEGER NOT NULL DEFAULT 0,
  ok_checks      INTEGER NOT NULL DEFAULT 0,
  sum_latency_ms INTEGER NOT NULL DEFAULT 0,
  min_latency_ms INTEGER,
  max_latency_ms INTEGER,
  reason         TEXT                    -- why this interval started
);
CREATE INDEX idx_intervals_monitor ON status_intervals(monitor_id, started_at);
CREATE INDEX idx_intervals_open ON status_intervals(monitor_id, ended_at);

CREATE TABLE summaries (
  id                TEXT PRIMARY KEY,    -- monitor_id:period:bucket_start
  monitor_id        TEXT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
  period            TEXT NOT NULL,       -- 'hour' | 'day' | 'month'
  bucket_start      INTEGER NOT NULL,
  checks            INTEGER NOT NULL DEFAULT 0,
  ok_checks         INTEGER NOT NULL DEFAULT 0,
  fail_checks       INTEGER NOT NULL DEFAULT 0,
  retry_recoveries  INTEGER NOT NULL DEFAULT 0,
  sum_latency_ms    INTEGER NOT NULL DEFAULT 0,
  min_latency_ms    INTEGER,
  max_latency_ms    INTEGER,
  monitored_seconds INTEGER NOT NULL DEFAULT 0,
  down_seconds      INTEGER NOT NULL DEFAULT 0,
  UNIQUE(monitor_id, period, bucket_start)
);
CREATE INDEX idx_summaries_lookup ON summaries(monitor_id, period, bucket_start);

-- ---------------------------------------------------------------------------
-- Notifications: channels, push devices, delivery outbox.
-- ---------------------------------------------------------------------------
CREATE TABLE notification_channels (
  id              TEXT PRIMARY KEY,
  type            TEXT NOT NULL,         -- 'push'|'email'|'discord'|'webhook'
  name            TEXT,
  enabled         INTEGER NOT NULL DEFAULT 1,
  config          TEXT NOT NULL DEFAULT '{}',  -- JSON (secrets encrypted)
  events          TEXT,                  -- JSON enabled event types
  last_success_at INTEGER,
  last_failure_at INTEGER,
  last_error      TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE TABLE push_subscriptions (
  id              TEXT PRIMARY KEY,
  endpoint        TEXT NOT NULL UNIQUE,
  p256dh          TEXT NOT NULL,
  auth            TEXT NOT NULL,
  label           TEXT,
  user_agent      TEXT,
  platform        TEXT,
  created_at      INTEGER NOT NULL,
  last_success_at INTEGER,
  last_failure_at INTEGER,
  failures        INTEGER NOT NULL DEFAULT 0,
  disabled        INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE notification_outbox (
  id              TEXT PRIMARY KEY,
  event_key       TEXT NOT NULL UNIQUE,  -- idempotency key
  channel_id      TEXT,
  channel_type    TEXT NOT NULL,
  target          TEXT,                  -- subscription id / email / url
  event_type      TEXT NOT NULL,         -- down|recovered|heartbeat_missed|flapping|degraded|maintenance|weekly|test
  payload         TEXT NOT NULL,         -- JSON
  status          TEXT NOT NULL DEFAULT 'pending',  -- pending|sent|failed|dead
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER,
  last_error      TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX idx_outbox_pending ON notification_outbox(status, next_attempt_at);

-- ---------------------------------------------------------------------------
-- Maintenance windows.
-- ---------------------------------------------------------------------------
CREATE TABLE maintenance_windows (
  id             TEXT PRIMARY KEY,
  title          TEXT,
  scope          TEXT NOT NULL,          -- 'global' | 'monitors'
  monitor_ids    TEXT,                   -- JSON array when scope='monitors'
  starts_at      INTEGER NOT NULL,
  ends_at        INTEGER NOT NULL,
  recurrence     TEXT,                   -- JSON rule or NULL
  public_message TEXT,
  private_notes  TEXT,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE INDEX idx_maintenance_window ON maintenance_windows(starts_at, ends_at);

-- ---------------------------------------------------------------------------
-- Operational: execution leases + scheduler run diagnostics.
-- ---------------------------------------------------------------------------
CREATE TABLE locks (
  name        TEXT PRIMARY KEY,
  holder      TEXT,
  acquired_at INTEGER,
  expires_at  INTEGER
);

CREATE TABLE scheduler_runs (
  id                    TEXT PRIMARY KEY,
  cron                  TEXT,
  started_at            INTEGER NOT NULL,
  finished_at           INTEGER,
  ok                    INTEGER,
  monitors_checked      INTEGER,
  monitors_skipped      INTEGER,
  check_failures        INTEGER,
  notification_failures INTEGER,
  duration_ms           INTEGER,
  error                 TEXT
);
CREATE INDEX idx_scheduler_runs_started ON scheduler_runs(started_at);
