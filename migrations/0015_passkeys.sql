-- Passkeys (WebAuthn) for the single administrator (docs/SECURITY.md, "Passkeys").
--
-- Additive: one new table, nothing existing changes. A credential's public key
-- is public by design, so it is stored as is (COSE, base64url); nothing here
-- can be used to sign in without the authenticator that holds the private key.
-- A passkey only works on the hostname it was registered on (rp_id).
--
-- Sessions created with a passkey use identity_kind 'passkey' and the row id
-- below as their identity, so removing a passkey can end its sessions.
-- Challenges reuse auth_tokens (kinds 'passkey_register' and 'passkey_login'),
-- single use and expiring after 5 minutes like the other sign-in tokens.
CREATE TABLE passkeys (
  id              TEXT PRIMARY KEY,           -- 'pk_<uuid>'
  credential_id   TEXT NOT NULL UNIQUE,       -- base64url credential id
  public_key      TEXT NOT NULL,              -- base64url COSE_Key
  alg             INTEGER NOT NULL,           -- COSE algorithm: -7 (ES256) or -257 (RS256)
  sign_count      INTEGER NOT NULL DEFAULT 0,
  transports      TEXT,                       -- JSON array, a hint for the browser
  aaguid          TEXT,                       -- authenticator model (hex), all zero with "none" attestation
  backup_eligible INTEGER NOT NULL DEFAULT 0, -- 1 when the passkey can sync
  backup_state    INTEGER NOT NULL DEFAULT 0, -- 1 when it is synced
  rp_id           TEXT NOT NULL,              -- the hostname it is bound to
  name            TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  last_used_at    INTEGER
);
