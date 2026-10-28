-- 0021: What OpenPing Hosted support did in this OpenPing
-- (docs/hosted/CONTRACT.md, section 7; src/worker/lib/support.ts).
--
-- Additive: one new table, nothing existing changes. Only a support sign-in
-- (a `hosted_support` session) writes to it, so it stays empty on a plain
-- install and for a customer nobody has helped.
--
-- One row per support sign-in, per change support made, and per change it
-- was refused. The customer sees them in Settings > Sign-in & security.
CREATE TABLE support_activity (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  at       INTEGER NOT NULL,               -- epoch ms
  kind     TEXT NOT NULL CHECK (kind IN ('signed_in', 'change', 'refused')),
  identity TEXT NOT NULL,                  -- the support person's email, from the hand-off
  method   TEXT,                           -- for a change: the HTTP method
  path     TEXT,                           -- for a change: the API path, ids included
  status   INTEGER                         -- for a change: the answer's status
);
