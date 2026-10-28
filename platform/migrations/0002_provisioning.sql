-- Provisioning (build plan, B3): how far each tenant got, when to try again,
-- and who is working on it. The steps themselves are tenants.provision_state
-- (0001): requested, db_created, uploaded, migrated, ready, and deleting while
-- a failed or cancelled tenant is rolled back or a tenant is removed.

-- Failed attempts since the last step that succeeded; reset on each success.
ALTER TABLE tenants ADD COLUMN provision_attempts INTEGER NOT NULL DEFAULT 0;
-- The last failure, short and never secret (an operation and Cloudflare's error codes).
ALTER TABLE tenants ADD COLUMN provision_error TEXT;
-- Not before this time (epoch ms) is the next attempt due; null means now.
ALTER TABLE tenants ADD COLUMN provision_next_at INTEGER;
-- A run holds the tenant until this time (epoch ms), so the request that
-- started provisioning and the retry sweep never work on it at once.
ALTER TABLE tenants ADD COLUMN provision_lease_until INTEGER;
-- When the tenant became ready (epoch ms): sign-up to dashboard, measured.
ALTER TABLE tenants ADD COLUMN provisioned_at INTEGER;

CREATE INDEX idx_tenants_provisioning ON tenants(provision_state, provision_next_at);

-- Slugs a removed tenant held, kept out of reach for a while so a new
-- customer can't pick up an address someone else's visitors still use.
CREATE TABLE slug_holds (
  slug       TEXT PRIMARY KEY,
  held_until INTEGER NOT NULL,                -- epoch ms
  reason     TEXT NOT NULL                    -- 'deleted', 'renamed', 'owner'
);
