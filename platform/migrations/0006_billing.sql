-- Billing (build plan, B5): Stripe Checkout, the Customer Portal, the signed
-- webhook and the subscription state machine (src/billing/). Billing writes
-- tenants.status, tenants.plan and the columns below, never the owner's
-- owner_suspended_* columns: a payment can't lift the owner's suspension.

-- The account's Stripe Customer, made once before its first Checkout.
ALTER TABLE accounts ADD COLUMN stripe_customer_id TEXT;
CREATE UNIQUE INDEX idx_accounts_stripe_customer ON accounts(stripe_customer_id) WHERE stripe_customer_id IS NOT NULL;

-- Why billing has the tenant where it is, for the account page and the
-- console: 'trial_ended', 'unpaid', 'canceled', 'paused' while suspended by
-- billing; null otherwise.
ALTER TABLE tenants ADD COLUMN billing_reason TEXT;

-- The trial sweep reads only tenants still on trial whose end has passed:
-- a partial index, so the paying ones are never read.
CREATE INDEX idx_tenants_trial_end ON tenants(trial_ends_at) WHERE status = 'trial';

-- The subscription as Stripe last told it (0001 made the table).
-- Price ids on it, JSON array, to tell the yearly plan from the add-on.
ALTER TABLE subscriptions ADD COLUMN price_ids TEXT;
-- Dunning: the latest failed payment, and when Stripe tries again (epoch ms).
ALTER TABLE subscriptions ADD COLUMN payment_failed_at INTEGER;
ALTER TABLE subscriptions ADD COLUMN next_payment_attempt INTEGER;
-- When it ended (canceled or expired), as Stripe says.
ALTER TABLE subscriptions ADD COLUMN ended_at INTEGER;

-- Every webhook event, by Stripe's id, so a redelivery is answered without
-- being processed twice. A delivery takes the event for processing_until;
-- processed_at is set once it is done.
CREATE TABLE stripe_events (
  id               TEXT PRIMARY KEY,          -- 'evt_...'
  type             TEXT NOT NULL,
  created          INTEGER NOT NULL,          -- Stripe's `created`, epoch seconds
  received_at      INTEGER NOT NULL,
  processing_until INTEGER,
  processed_at     INTEGER,
  error            TEXT                       -- the last failure, short and never secret
) WITHOUT ROWID;
CREATE INDEX idx_stripe_events_received ON stripe_events(received_at);

-- When the last payment went through (epoch ms, from the event's time), so a
-- payment_failed that arrives after a later invoice.paid doesn't bring the
-- "payment due" banner back.
ALTER TABLE subscriptions ADD COLUMN last_paid_at INTEGER;

-- The account's open Checkout Session, expired before another is made, so
-- two tabs or the two plan buttons can't leave two payable sessions.
ALTER TABLE accounts ADD COLUMN checkout_session_id TEXT;

-- One holder at a time for an account's billing: the webhook and Checkout
-- take it, so two deliveries for one subscription can't interleave their
-- fetch and their save (a stale copy saved last would win). Every write the
-- holder makes checks the token; a holder that stalls past `until` loses it.
CREATE TABLE billing_locks (
  account_id TEXT PRIMARY KEY,
  token      TEXT NOT NULL,
  until      INTEGER NOT NULL
) WITHOUT ROWID;

-- Billing emails already sent, by what they are about ('payment_failed:<invoice>:<attempt>'),
-- so a redelivered event never sends one twice. Kept 90 days, like stripe_events.
CREATE TABLE billing_emails (
  key     TEXT PRIMARY KEY,
  sent_at INTEGER NOT NULL
) WITHOUT ROWID;
CREATE INDEX idx_billing_emails_sent ON billing_emails(sent_at);

-- A change waiting for its invoice to be paid (the 1-minute add-on with
-- payment_behavior=pending_if_incomplete): until when Stripe keeps it, and
-- the invoice's hosted payment page, for the billing page's "finish paying".
ALTER TABLE subscriptions ADD COLUMN pending_until INTEGER;
ALTER TABLE subscriptions ADD COLUMN pending_invoice_url TEXT;
