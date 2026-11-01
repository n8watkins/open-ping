-- 0018: Starter mode, customers as ordinary Workers on Workers Paid
-- (docs/hosted/CONTRACT.md, section 10; src/starter.ts).
--
-- Additive: one column and two tables, nothing existing changes. Every
-- existing tenant is in the dispatch namespace, so the column's default.

-- Where the tenant's OpenPing runs: 'dispatch' (a user Worker in the dispatch
-- namespace, called with props) or 'starter' (an ordinary Worker t-<id> on
-- the account, called over signed HTTPS). Set from TENANT_MODE when the
-- tenant is requested; per tenant, so a fleet can move to Workers for
-- Platforms one tenant at a time (src/tenant-move.ts).
ALTER TABLE tenants ADD COLUMN runtime TEXT NOT NULL DEFAULT 'dispatch' CHECK (runtime IN ('dispatch', 'starter'));

-- Each starter tenant's PLATFORM_CALL_SECRET, encrypted with PLATFORM_KEY
-- (AES-256-GCM, bound to its tenant id, like escrowed_keys), set on that
-- tenant's Worker only. One per tenant, never shared; deleted with the tenant.
CREATE TABLE tenant_call_secrets (
  tenant_id  TEXT PRIMARY KEY,
  ciphertext TEXT NOT NULL,              -- v1:<iv>:<ciphertext>, base64url
  created_at INTEGER NOT NULL
);

-- Nonces of starter tenants' signed calls to the platform, each recorded once
-- after its signature verifies, kept until expires_at (epoch ms), past any
-- window the call could be accepted in; each insert deletes the expired ones.
CREATE TABLE tenant_call_nonces (
  nonce      TEXT PRIMARY KEY,
  tenant_id  TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_tenant_call_nonces_expires ON tenant_call_nonces(expires_at);
