-- The owner's admin console (build plan, B6): suspending and resuming a
-- tenant, each tenant's last reported usage, and the Hosted waitlist
-- imported from the canonical install.

-- A suspension remembers the billing state it interrupted, so resuming puts
-- the tenant back exactly where it was (trial, active or past due), and why.
ALTER TABLE tenants ADD COLUMN status_before_suspend TEXT
  CHECK (status_before_suspend IN ('trial', 'active', 'past_due'));
-- Short and never secret: what the owner wrote, or the billing job's reason (B5).
ALTER TABLE tenants ADD COLUMN suspended_reason TEXT;

-- The counts each customer's OpenPing reports through the platform
-- capability's reportUsage (contract, section 4): after a create or delete
-- and at the end of each scheduled run. For the console and abuse signals,
-- never for enforcement (the tenant enforces its limits from props).
CREATE TABLE tenant_usage (
  tenant_id    TEXT PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  monitors     INTEGER NOT NULL,
  status_pages INTEGER NOT NULL,
  channels     INTEGER NOT NULL,
  counted_at   INTEGER NOT NULL,              -- when the tenant took the counts (its clock, never ahead of ours)
  reported_at  INTEGER NOT NULL               -- when the platform received them
);

-- The Hosted waitlist (the canonical install's `waitlist` table, OpenPing
-- migration 0010), imported from its CSV export so it becomes the launch
-- list (build plan, D5). One row per lowercased email.
CREATE TABLE waitlist_entries (
  email       TEXT PRIMARY KEY,
  joined_at   INTEGER,                        -- when they joined on the canonical install, when the export says
  imported_at INTEGER NOT NULL
);
CREATE INDEX idx_waitlist_entries_joined ON waitlist_entries(joined_at);

-- The admin console's audit log reads newest first, filtered by action.
CREATE INDEX idx_audit_events_action ON audit_events(action, id);
