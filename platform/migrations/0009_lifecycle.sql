-- Lifecycle jobs (build plan, B7): the account emails a tenant's state
-- calls for, sent once each, and exports of a tenant's database to R2,
-- before a deletion and when a customer moves to their own Cloudflare.

-- Every lifecycle email, once per tenant, kind and cycle: a second
-- suspension (a new suspended_at) is a new cycle and gets its own email.
-- A row is claimed as 'sending' before the send and becomes 'sent' only once
-- the mail provider took it; a failed send drops the claim, and a claim left
-- by a run that died is taken again after a few minutes. Deletion counts
-- only a warning that was sent.
CREATE TABLE lifecycle_notices (
  tenant_id  TEXT NOT NULL,
  kind       TEXT NOT NULL,                   -- 'welcome', 'trial_ending_3', 'trial_ending_1', 'payment_failed', 'suspended', 'deletion_warning'
  cycle      TEXT NOT NULL,                   -- what the email is about: a trial end, a suspension time, ...
  state      TEXT NOT NULL CHECK (state IN ('sending', 'sent')),
  claimed_at INTEGER NOT NULL,
  sent_at    INTEGER,                         -- when the provider accepted it
  PRIMARY KEY (tenant_id, kind, cycle)
);

-- One export of a tenant's D1 database to the exports bucket, as SQL with
-- the instructions to run it as a self-hosted OpenPing. Kept without a
-- foreign key: a deleted tenant's last export outlives its row.
CREATE TABLE tenant_exports (
  id          TEXT PRIMARY KEY,               -- 'exp_<random>'
  tenant_id   TEXT NOT NULL,
  account_id  TEXT NOT NULL,
  slug        TEXT NOT NULL,                  -- for the instructions and the account page
  reason      TEXT NOT NULL CHECK (reason IN ('deletion', 'self_host')),
  state       TEXT NOT NULL CHECK (state IN ('requested', 'exporting', 'done', 'failed')),
  bookmark    TEXT,                           -- D1's export bookmark while it runs
  attempts    INTEGER NOT NULL DEFAULT 0,     -- failed tries
  next_at     INTEGER,                        -- not before this is it worked on again
  r2_prefix   TEXT,                           -- exports/<tenant>/<export id>/ once done
  bytes       INTEGER,                        -- the dump's size
  sha256      TEXT,                           -- the dump's SHA-256 hex, checked again before a deletion
  tables      TEXT,                           -- JSON: the tables the dump creates, checked too
  lease_until INTEGER,                        -- one run works on an export at a time (the cron, the account page)
  lease_token TEXT,
  error       TEXT,                           -- the last failure, short and never secret
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  finished_at INTEGER,
  expires_at  INTEGER                         -- when the files are deleted from the bucket
);
CREATE INDEX idx_tenant_exports_tenant ON tenant_exports(tenant_id, created_at);
CREATE INDEX idx_tenant_exports_account ON tenant_exports(account_id, created_at);
CREATE INDEX idx_tenant_exports_open ON tenant_exports(next_at) WHERE state IN ('requested', 'exporting');
CREATE INDEX idx_tenant_exports_expiry ON tenant_exports(expires_at) WHERE expires_at IS NOT NULL;

-- The MASTER_KEY a done export's encrypted values are sealed with, kept with
-- the export (the same AES-GCM ciphertext under PLATFORM_KEY as escrowed_keys)
-- so it outlives a deleted tenant's escrowed key, and is deleted together
-- with the export's files when it expires (decision D12).
CREATE TABLE export_keys (
  export_id  TEXT PRIMARY KEY,
  tenant_id  TEXT NOT NULL,                   -- what the ciphertext is bound to
  kid        TEXT NOT NULL,
  ciphertext TEXT NOT NULL
);

-- One lifecycle run at a time, across the cron's overlapping minutes.
CREATE TABLE lifecycle_locks (
  name  TEXT PRIMARY KEY,
  until INTEGER NOT NULL,
  token TEXT NOT NULL
);
