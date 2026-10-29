-- Platform mail (build plan, section 3): each customer's OpenPing sends its
-- email through the platform capability, which counts it here against the
-- plan's emailsPerDay (contract, section 5) for each UTC day, by category
-- ("alert", "report", ...), for the cap and the admin console.

CREATE TABLE tenant_email_usage (
  tenant_id TEXT NOT NULL,
  day       TEXT NOT NULL,                   -- the UTC day, 'YYYY-MM-DD'
  category  TEXT NOT NULL,
  sent      INTEGER NOT NULL DEFAULT 0,      -- accepted by the mail provider (and reserved while sending)
  failed    INTEGER NOT NULL DEFAULT 0,      -- refused by it, or not answered
  refused   INTEGER NOT NULL DEFAULT 0,      -- refused by the cap
  PRIMARY KEY (tenant_id, day, category)
);
-- The cron's cleanup drops old days; the console reads one tenant's today.
CREATE INDEX idx_tenant_email_usage_day ON tenant_email_usage(day);
