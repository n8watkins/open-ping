-- 0018: Used OpenPing Hosted sign-in hand-off nonces
-- (docs/hosted/CONTRACT.md, section 7; src/worker/routes/hosted-auth.ts).
--
-- Additive: one new table, nothing existing changes. A plain install never
-- writes to it, so it stays empty there.
--
-- Each hand-off token carries a random nonce and may be used once. After its
-- signature and times check out, the nonce is inserted here; the primary key
-- makes a second insert of the same nonce do nothing, which is how a replayed
-- token is refused, atomically, even when two requests race. A row is kept
-- until `expires_at` (HANDOFF_NONCE_RETENTION_SECONDS past the token's `exp`,
-- in epoch ms), after which no token with that nonce can verify anyway, and
-- the scheduler's expired-auth cleanup deletes it.
CREATE TABLE used_handoff_nonces (
  nonce      TEXT PRIMARY KEY,           -- the token's nonce (base64url, 22 chars)
  used_at    INTEGER NOT NULL,           -- epoch ms
  expires_at INTEGER NOT NULL            -- epoch ms
);
CREATE INDEX idx_used_handoff_nonces_expires ON used_handoff_nonces(expires_at);
