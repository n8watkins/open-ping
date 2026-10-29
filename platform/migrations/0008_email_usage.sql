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

-- Who a tenant may email besides its account's own address (src/recipients.ts):
-- each other address confirms once, from a link the platform sends it.
CREATE TABLE email_recipients (
  tenant_id     TEXT NOT NULL,
  address       TEXT NOT NULL,                -- lowercased
  state         TEXT NOT NULL CHECK (state IN ('pending', 'confirmed', 'declined')),
  token_hash    TEXT,                         -- SHA-256 hex of the link's token, while pending
  requested_at  INTEGER NOT NULL,             -- when the latest confirmation email went out
  requested_day TEXT NOT NULL,                -- its UTC day, for the per-tenant daily limit
  expires_at    INTEGER NOT NULL,
  confirmed_at  INTEGER,                      -- when it answered, yes or no
  PRIMARY KEY (tenant_id, address)
);
CREATE INDEX idx_email_recipients_token ON email_recipients(token_hash) WHERE token_hash IS NOT NULL;
CREATE INDEX idx_email_recipients_day ON email_recipients(tenant_id, requested_day);
