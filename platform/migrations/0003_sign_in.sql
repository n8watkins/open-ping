-- Platform accounts and sign-in (build plan, B2): sessions on app.<domain>,
-- email sign-in with a link and a 6-digit code, passkey and GitHub
-- ceremonies. Secrets are never stored: sessions, links and codes are kept
-- as SHA-256 hashes, so a copy of this database signs nobody in.

-- The WebAuthn user handle of each account's passkeys: 32 random bytes,
-- base64url, made when the account adds its first passkey.
ALTER TABLE accounts ADD COLUMN webauthn_handle TEXT;
CREATE UNIQUE INDEX idx_accounts_webauthn_handle ON accounts(webauthn_handle);

-- A signed-in browser. The cookie holds the token; only its hash is here.
CREATE TABLE platform_sessions (
  token_hash   TEXT PRIMARY KEY,              -- SHA-256 hex of the cookie value
  account_id   TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  method       TEXT NOT NULL CHECK (method IN ('email', 'github', 'passkey')),
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);
CREATE INDEX idx_platform_sessions_account ON platform_sessions(account_id);
CREATE INDEX idx_platform_sessions_expires ON platform_sessions(expires_at);

-- One email sign-in: the link and the code arrive in the same message, and
-- either one finishes it, once. Wrong codes count against `attempts`.
CREATE TABLE email_logins (
  id         TEXT PRIMARY KEY,                -- 'eml_<random>', carried by the code form
  email      TEXT NOT NULL,                   -- lowercased and trimmed
  token_hash TEXT NOT NULL UNIQUE,            -- SHA-256 hex of the link's token
  code_hash  TEXT NOT NULL,                   -- SHA-256 hex of '<id>:<code>'
  attempts   INTEGER NOT NULL DEFAULT 0,
  next_path  TEXT,                            -- where to go after signing in (a checked local path)
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_email_logins_email ON email_logins(email, created_at);
CREATE INDEX idx_email_logins_expires ON email_logins(expires_at);

-- A passkey or GitHub ceremony in progress, bound to the browser by a cookie
-- holding its id. Single use: consumed by DELETE ... RETURNING.
CREATE TABLE auth_ceremonies (
  id         TEXT PRIMARY KEY,                -- SHA-256 hex of the cookie value
  kind       TEXT NOT NULL CHECK (kind IN ('passkey_register', 'passkey_sign_in', 'github')),
  challenge  TEXT NOT NULL,                   -- WebAuthn challenge, or the OAuth state
  account_id TEXT REFERENCES accounts(id) ON DELETE CASCADE, -- set when a signed-in account started it
  next_path  TEXT,
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_auth_ceremonies_expires ON auth_ceremonies(expires_at);
