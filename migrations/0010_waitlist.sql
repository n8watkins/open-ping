-- 0010: The OpenPing Hosted waitlist (docs/HOSTED_PLAN.md, stage 1).
-- Only the canonical install (WAITLIST_ENABLED = "true") accepts entries; every
-- other install keeps this table empty. One row per email (stored lowercased);
-- timestamps are integer epoch milliseconds, like the rest of the schema.
CREATE TABLE waitlist (
  id         TEXT PRIMARY KEY,
  email      TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);

-- Newest first for the admin list and the CSV export.
CREATE INDEX idx_waitlist_created ON waitlist(created_at);
