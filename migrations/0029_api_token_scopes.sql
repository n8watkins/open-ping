-- 0029: Scoped, expiring API tokens with a revocation record
-- (src/worker/lib/scopes.ts, docs/SECURITY.md "API tokens").
--
-- Additive: four new columns on api_tokens, nothing removed or renamed.
--
-- scopes      Space-separated scopes (read, monitors:write, incidents:write,
--             maintenance:write, admin). Every existing token becomes 'admin',
--             which is exactly what it could do before, so no client breaks.
-- expires_at  Epoch ms after which the token stops working; NULL never expires.
-- created_via Who created it, from which signed-in session (audit only).
-- revoked_at  Epoch ms the owner revoked it. A revoked token's row is kept as
--             an audit record instead of being deleted.
--
-- Rollback safety: an older OpenPing knows none of these columns, so it would
-- treat a scoped, expired or revoked token as full admin. It never gets the
-- chance: tokens created from now on store their hash as 'v2:<hex>', and
-- revoking a token overwrites its hash with 'revoked:<id>'. An older OpenPing
-- looks tokens up by the bare hex hash, finds neither, and refuses them
-- (fail closed). Rows created before this migration keep the bare hash and
-- stay admin tokens, as they are today.
ALTER TABLE api_tokens ADD COLUMN scopes TEXT NOT NULL DEFAULT 'admin';
ALTER TABLE api_tokens ADD COLUMN expires_at INTEGER;
ALTER TABLE api_tokens ADD COLUMN created_via TEXT;
ALTER TABLE api_tokens ADD COLUMN revoked_at INTEGER;
