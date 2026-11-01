-- 0027: Nonces of the OpenPing Hosted platform's signed calls, in starter mode
-- (docs/hosted/CONTRACT.md, section 10; src/worker/lib/hosted-starter.ts).
--
-- Additive: one new table, nothing existing changes. Only a starter mode
-- tenant (HOSTED_TRANSPORT "https") writes to it; a plain install and a
-- dispatch mode tenant leave it empty.
--
-- Each signed call from the platform carries a random nonce. Once its
-- signature and timestamp verify, the nonce is inserted here; the primary key
-- makes a second insert of the same nonce do nothing, which is how a replayed
-- call is refused, atomically. A row is kept until `expires_at`
-- (SIGNED_CALL_NONCE_RETENTION_MS past the call's timestamp, epoch ms), after
-- which no call with that nonce can verify anyway; each insert deletes the
-- expired rows first. IF NOT EXISTS because the very first platform call
-- after an upload can arrive before this migration is applied, and the tenant
-- then creates the table itself with this same statement.
CREATE TABLE IF NOT EXISTS used_platform_call_nonces (
  nonce      TEXT PRIMARY KEY,           -- the call's nonce (base64url, 22 chars)
  expires_at INTEGER NOT NULL            -- epoch ms
);
CREATE INDEX IF NOT EXISTS idx_used_platform_call_nonces_expires ON used_platform_call_nonces(expires_at);
