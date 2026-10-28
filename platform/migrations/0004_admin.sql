-- The owner's admin console (build plan, B6): suspending and resuming a
-- tenant, each tenant's last reported usage, and the Hosted waitlist
-- imported from the canonical install.

-- The owner's suspension (abuse, the terms), kept apart from billing's
-- `status`: a tenant is suspended while either says so. Billing (B5) never
-- touches these columns, so a payment can't lift the owner's suspension, and
-- lifting the owner's leaves billing state exactly as it was.
ALTER TABLE tenants ADD COLUMN owner_suspended_at INTEGER;
-- Short and never secret: what the owner wrote.
ALTER TABLE tenants ADD COLUMN owner_suspended_reason TEXT;

-- The passkey a session signed in with (account_identities.subject, its
-- credential id), so the admin console can accept only the owner's pinned
-- passkeys (PLATFORM_OWNER_PASSKEYS) and not one someone added later.
ALTER TABLE platform_sessions ADD COLUMN passkey_credential TEXT;

-- The counts each customer's OpenPing reports through the platform
-- capability's reportUsage (contract, section 4): after a create or delete
-- and at the end of each scheduled run. For the console and abuse signals,
-- never for enforcement (the tenant enforces its limits from props).
CREATE TABLE tenant_usage (
  tenant_id    TEXT PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  monitors     INTEGER NOT NULL,
  status_pages INTEGER NOT NULL,
  channels     INTEGER NOT NULL,
  counted_at   INTEGER NOT NULL,              -- when the tenant says it took the counts (its clock, as sent; orders the reports)
  reported_at  INTEGER NOT NULL               -- when the platform received them (what the console shows)
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
