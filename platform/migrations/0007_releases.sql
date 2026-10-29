-- Releases (build plan, C1): shipping one OpenPing version to every
-- tenant, canary first, then in batches, with a stop on any failed health
-- check and a rollback to the version before. The bundles themselves are in
-- R2 (src/bundle.ts); this is the state of each rollout, so a run that dies
-- anywhere picks up where it stopped (src/releases/runner.ts).

-- One rollout or rollback. At most one is active (canary, rolling or
-- paused) at a time: idx_releases_active below. A dry run is recorded here
-- too, already finished, with what it would do in `plan`.
CREATE TABLE releases (
  id               TEXT PRIMARY KEY,           -- 'rel_<random>'
  kind             TEXT NOT NULL CHECK (kind IN ('rollout', 'rollback')),
  version          TEXT NOT NULL,              -- the bundle going out
  from_version     TEXT,                       -- releases/current when it started; what a rollback goes back to
  dry_run          INTEGER NOT NULL DEFAULT 0,
  state            TEXT NOT NULL
                   CHECK (state IN ('canary', 'rolling', 'paused', 'done', 'refused', 'cancelled')),
  canary_tenant_id TEXT,                       -- the first tenant updated (a rollout only)
  -- How far the canary got: 'pending', 'healthy' (its health answered ok on
  -- the new version), 'ran' (and a scheduled run came back clean).
  canary_state     TEXT CHECK (canary_state IN ('pending', 'healthy', 'ran')),
  batch_size       INTEGER NOT NULL,
  batch            INTEGER NOT NULL DEFAULT 0, -- the batch being worked on; 0 is the canary
  requested_by     TEXT NOT NULL,              -- 'owner:<account id>' or 'cli'
  note             TEXT,                       -- why it stopped, was refused, or how it ended; short, never secret
  plan             TEXT,                       -- JSON: the checks and the batches it planned
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  finished_at      INTEGER,
  -- One run works on a release at a time, the same lease as provisioning's.
  lease_until      INTEGER,
  lease_token      TEXT
);
-- An active release is never a dry run, so this allows only one at a time.
CREATE UNIQUE INDEX idx_releases_active ON releases(dry_run) WHERE state IN ('canary', 'rolling', 'paused');
CREATE INDEX idx_releases_created ON releases(created_at);

-- Each tenant a release touched, and how far it got.
CREATE TABLE release_tenants (
  release_id   TEXT NOT NULL REFERENCES releases(id) ON DELETE CASCADE,
  tenant_id    TEXT NOT NULL,
  batch        INTEGER NOT NULL,              -- 0 for the canary
  state        TEXT NOT NULL CHECK (state IN ('pending', 'uploaded', 'healthy', 'failed', 'skipped')),
  from_version TEXT,                          -- what it ran before
  attempts     INTEGER NOT NULL DEFAULT 0,    -- health checks that weren't ok yet
  error        TEXT,                          -- short, never secret
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (release_id, tenant_id)
);
CREATE INDEX idx_release_tenants_batch ON release_tenants(release_id, batch, state);

-- What the owner asked for: from the admin console, or from the command
-- line (scripts/tenant-release.mjs, through `wrangler d1 execute`). The
-- platform handles each one once, in order, on its next cron tick, so the
-- command line needs nothing but the owner's Cloudflare login.
CREATE TABLE release_requests (
  id           TEXT PRIMARY KEY,              -- 'rrq_<random>'
  action       TEXT NOT NULL CHECK (action IN ('rollout', 'rollback', 'pause', 'resume', 'skip_failed', 'cancel')),
  version      TEXT,                          -- rollout: the version; rollback: an older version, or null for the one before
  dry_run      INTEGER NOT NULL DEFAULT 0,
  canary       TEXT,                          -- a slug or tenant id, or null for the default
  batch_size   INTEGER,
  requested_by TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  handled_at   INTEGER,
  release_id   TEXT,                          -- the release it made or changed
  result       TEXT                           -- what happened, one sentence
);
CREATE INDEX idx_release_requests_pending ON release_requests(created_at) WHERE handled_at IS NULL;
