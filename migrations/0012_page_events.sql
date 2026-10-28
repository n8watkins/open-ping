-- 0012: Daily click counts for the landing page (docs/LANDING_AND_LOGIN_PLAN.md,
-- item 1.0). Only an install with HOME_PAGE = "landing" (the canonical one)
-- records anything; every other install keeps this table empty.
--
-- Aggregates only: one row per (UTC day, event name) holding a count. No
-- cookies, IP addresses, user agents or anything else about the visitor.
-- Additive: no existing table changes.
CREATE TABLE page_events (
  day   TEXT NOT NULL,     -- "YYYY-MM-DD", UTC
  name  TEXT NOT NULL,     -- one of EVENT_NAMES in src/worker/routes/events.ts
  count INTEGER NOT NULL,
  PRIMARY KEY (day, name)
);
