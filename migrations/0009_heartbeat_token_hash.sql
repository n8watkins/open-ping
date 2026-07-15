-- Store heartbeat ingestion tokens as one-way SHA-256 hashes.
-- Existing plaintext tokens remain usable and are migrated after a successful
-- heartbeat or when an administrator rotates the token.
ALTER TABLE monitors ADD COLUMN heartbeat_token_hash TEXT;

CREATE UNIQUE INDEX idx_monitors_heartbeat_token_hash
  ON monitors(heartbeat_token_hash)
  WHERE heartbeat_token_hash IS NOT NULL;
