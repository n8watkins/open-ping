-- Changing an account's sign-in email (src/auth/email-change.ts): the new
-- address must prove itself with a 6-digit code or a link, sent to it, before
-- the account switches. One pending change per account; only hashes are kept,
-- as for email sign-ins (0003). Gone once used or 15 minutes old.
CREATE TABLE email_changes (
  id         TEXT PRIMARY KEY,                -- 'emc_<random>', carried by the code form
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  new_email  TEXT NOT NULL,                   -- lowercased and trimmed
  token_hash TEXT NOT NULL UNIQUE,            -- SHA-256 hex of the link's token
  code_hash  TEXT NOT NULL,                   -- SHA-256 hex of '<id>:<code>'
  attempts   INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_email_changes_account ON email_changes(account_id);
CREATE INDEX idx_email_changes_expires ON email_changes(expires_at);
