-- The platform database (PLATFORM_DB): who the customers are, how they sign
-- in, which OpenPing is theirs, what they pay, and what happened. It never
-- holds monitoring data; that lives in each tenant's own D1 database.
--
-- Times are epoch milliseconds, ids are prefixed text ('acc_...'), and
-- booleans are 0 or 1, the same conventions as OpenPing's own migrations.

-- A customer. The email is stored lowercased and trimmed.
CREATE TABLE accounts (
  id          TEXT PRIMARY KEY,               -- 'acc_<random>'
  email       TEXT NOT NULL UNIQUE,
  name        TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  disabled_at INTEGER                         -- set by the owner for abuse; blocks sign-in
);

-- The ways an account signs in (decision D3). One row per method, so a new
-- method (Google, after launch) is a new kind, not a new table.
--   email:   subject = the lowercased address (the same as accounts.email)
--   github:  subject = the numeric GitHub user id, as text
--   passkey: subject = the base64url credential id, with its key in the columns below
CREATE TABLE account_identities (
  id              TEXT PRIMARY KEY,           -- 'idn_<random>'
  account_id      TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL CHECK (kind IN ('email', 'github', 'passkey')),
  subject         TEXT NOT NULL,
  label           TEXT,                       -- GitHub login, or the passkey's name
  public_key      TEXT,                       -- passkey: base64url COSE_Key
  alg             INTEGER,                    -- passkey: COSE algorithm (-7 or -257)
  sign_count      INTEGER NOT NULL DEFAULT 0, -- passkey
  transports      TEXT,                       -- passkey: JSON array
  backup_eligible INTEGER NOT NULL DEFAULT 0, -- passkey
  backup_state    INTEGER NOT NULL DEFAULT 0, -- passkey
  created_at      INTEGER NOT NULL,
  last_used_at    INTEGER,
  UNIQUE (kind, subject),
  CHECK (kind <> 'passkey' OR (public_key IS NOT NULL AND alg IS NOT NULL))
);
CREATE INDEX idx_account_identities_account ON account_identities(account_id);

-- One customer OpenPing: a user Worker in the dispatch namespace and its own
-- D1 database. `status` is billing state (the contract's TenantStatus);
-- `provision_state` is how far provisioning got (B3), and only 'ready'
-- tenants are dispatched to.
CREATE TABLE tenants (
  id              TEXT PRIMARY KEY,           -- 16 chars [a-z0-9] (contract: isTenantId)
  account_id      TEXT NOT NULL REFERENCES accounts(id),
  slug            TEXT NOT NULL UNIQUE,       -- <slug>.<HOSTED_DOMAIN> (src/slugs.ts)
  script_name     TEXT NOT NULL UNIQUE,       -- 't-<id>' (contract: tenantScriptName)
  d1_id           TEXT,                       -- the tenant database's id, once created
  status          TEXT NOT NULL DEFAULT 'trial'
                  CHECK (status IN ('trial', 'active', 'past_due', 'suspended')),
  plan            TEXT NOT NULL DEFAULT 'trial'
                  CHECK (plan IN ('trial', 'hosted', 'hosted_fast')),
  provision_state TEXT NOT NULL DEFAULT 'requested'
                  CHECK (provision_state IN ('requested', 'db_created', 'uploaded', 'migrated', 'ready', 'deleting')),
  version         TEXT,                       -- OpenPing version of the uploaded bundle
  limit_overrides TEXT,                       -- JSON, partial PlanLimits over the plan's defaults
  trial_ends_at   INTEGER,
  suspended_at    INTEGER,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX idx_tenants_account ON tenants(account_id);
CREATE INDEX idx_tenants_status ON tenants(status);

-- The Stripe side of an account's plan (B5). Plan changes reach tenants.plan
-- from webhook state only, never from the browser.
CREATE TABLE subscriptions (
  id                     TEXT PRIMARY KEY,    -- 'sub_<random>' (ours, not Stripe's)
  account_id             TEXT NOT NULL REFERENCES accounts(id),
  tenant_id              TEXT REFERENCES tenants(id),
  stripe_customer_id     TEXT NOT NULL,
  stripe_subscription_id TEXT UNIQUE,
  status                 TEXT NOT NULL,       -- Stripe's subscription status, as sent
  plan                   TEXT NOT NULL CHECK (plan IN ('hosted', 'hosted_fast')),
  current_period_end     INTEGER,
  cancel_at_period_end   INTEGER NOT NULL DEFAULT 0,
  created_at             INTEGER NOT NULL,
  updated_at             INTEGER NOT NULL
);
CREATE INDEX idx_subscriptions_account ON subscriptions(account_id);
CREATE INDEX idx_subscriptions_customer ON subscriptions(stripe_customer_id);

-- Each tenant's MASTER_KEY, encrypted with PLATFORM_KEY (decision D4). A
-- rotation adds a row and retires the old one, so a backup made under the old
-- key can still be restored.
CREATE TABLE escrowed_keys (
  tenant_id  TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  kid        TEXT NOT NULL,                   -- the key id OpenPing writes into v2:<kid>:... values
  ciphertext TEXT NOT NULL,                   -- AES-GCM under PLATFORM_KEY
  created_at INTEGER NOT NULL,
  retired_at INTEGER,
  PRIMARY KEY (tenant_id, kid)
);

-- What happened, for the owner's console and, for support sign-ins, for the
-- customer too. Tenants write here through the platform capability's audit().
CREATE TABLE audit_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  at         INTEGER NOT NULL,
  account_id TEXT,
  tenant_id  TEXT,
  actor      TEXT NOT NULL CHECK (actor IN ('customer', 'support', 'system', 'owner')),
  action     TEXT NOT NULL,                   -- dotted lowercase, e.g. 'session.created'
  detail     TEXT                             -- small JSON object, never secret
);
CREATE INDEX idx_audit_events_tenant ON audit_events(tenant_id, at);
CREATE INDEX idx_audit_events_account ON audit_events(account_id, at);

-- Fixed-window counters for sign-up and sign-in limits, the same shape as
-- OpenPing's own (migrations/0007_rate_limits.sql), so its limiter is reusable.
CREATE TABLE rate_limits (
  key          TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count        INTEGER NOT NULL
);
CREATE INDEX idx_rate_limits_window ON rate_limits(window_start);
