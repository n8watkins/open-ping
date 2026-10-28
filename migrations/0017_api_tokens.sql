-- 0017: Named API tokens for the CLI, the MCP server and scripts
-- (docs/CLI.md, docs/MCP.md, docs/SECURITY.md "API tokens").
--
-- Additive: one new table, nothing existing changes. The API_TOKEN Worker
-- secret keeps working beside these.
--
-- Only a SHA-256 hash of each token is stored, like session ids and heartbeat
-- tokens, so a copy of the database cannot be replayed as a credential. The
-- token itself is shown once, when it is created. `prefix` is the token's first
-- characters (not secret on their own) so the owner can tell tokens apart.
-- Revoking a token deletes its row.
CREATE TABLE api_tokens (
  id           TEXT PRIMARY KEY,           -- 'tok_<uuid>'
  name         TEXT NOT NULL,
  token_hash   TEXT NOT NULL UNIQUE,       -- lowercase hex SHA-256 of the token
  prefix       TEXT NOT NULL,              -- e.g. 'opk_Ab3x'
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER
);
