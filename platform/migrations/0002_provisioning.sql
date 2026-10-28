-- Provisioning (build plan, B3): how far each tenant got, when to try again,
-- and who is working on it. The steps themselves are tenants.provision_state
-- (0001): requested, db_created, uploaded, migrated, ready, and deleting while
-- a tenant is removed.

-- Failed attempts since the last step that succeeded; reset on each success.
ALTER TABLE tenants ADD COLUMN provision_attempts INTEGER NOT NULL DEFAULT 0;
-- The last failure, short and never secret (an operation and Cloudflare's error codes).
ALTER TABLE tenants ADD COLUMN provision_error TEXT;
-- Not before this time (epoch ms) is the next attempt due; null means now.
ALTER TABLE tenants ADD COLUMN provision_next_at INTEGER;
-- A run holds the tenant until this time (epoch ms), so two runs (a queue
-- message, the retry sweep) never work on it at once. The token is the
-- holding run's; every write a run makes checks it, so a run that lost its
-- lease (it stalled past the time) changes nothing.
ALTER TABLE tenants ADD COLUMN provision_lease_until INTEGER;
ALTER TABLE tenants ADD COLUMN provision_lease_token TEXT;
-- Set when provisioning stopped for the owner to look at: a failure that
-- retrying can't fix (a bad API token, a broken bundle), or too many in a
-- row. Nothing is rolled back; resumeProvisioning or removeTenant decide.
ALTER TABLE tenants ADD COLUMN provision_paused_at INTEGER;
-- The Durable Object migration tag the uploaded script is at (null: none),
-- so an update sends only the bundle's later steps (src/cloudflare/upload.ts).
ALTER TABLE tenants ADD COLUMN do_migration_tag TEXT;
-- When the tenant became ready (epoch ms): sign-up to dashboard, measured.
ALTER TABLE tenants ADD COLUMN provisioned_at INTEGER;

-- The cron's sweep reads only tenants still being provisioned: a partial
-- index, so it never scans the ready ones (test/provisioning.test.ts checks
-- the query plan).
CREATE INDEX idx_tenants_provisioning ON tenants(provision_next_at) WHERE provision_state <> 'ready';

-- At most one active escrowed key per tenant (src/keys.ts, ensureMasterKey).
CREATE UNIQUE INDEX idx_escrowed_keys_active ON escrowed_keys(tenant_id) WHERE retired_at IS NULL;

-- Slugs a removed tenant held, kept out of reach for a while so a new
-- customer can't pick up an address someone else's visitors still use.
CREATE TABLE slug_holds (
  slug       TEXT PRIMARY KEY,
  held_until INTEGER NOT NULL,                -- epoch ms
  reason     TEXT NOT NULL                    -- 'deleted', 'renamed', 'owner'
);
