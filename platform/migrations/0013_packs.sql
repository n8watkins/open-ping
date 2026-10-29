-- Launch pricing (decision D13): packs of more monitors on a paid plan, as
-- quantities on the customer's Stripe subscription (src/billing/). Billing
-- writes them from the webhook only, with the plan; the tenant's limits are
-- the plan's plus its packs (planLimitsWithPacks in the contract), so they
-- reach the tenant's OpenPing in props on its next call. Additive: every
-- existing row has no packs.
--
-- 0013 because PR #77 (audit retention) adds 0012; the two are independent
-- and apply in either order.

-- The packs a subscription carries, as Stripe last told it, each already
-- held to its cap (at most 4 monitor packs, 3 fast monitor packs).
ALTER TABLE subscriptions ADD COLUMN monitor_packs INTEGER NOT NULL DEFAULT 0;
ALTER TABLE subscriptions ADD COLUMN fast_packs INTEGER NOT NULL DEFAULT 0;
-- What a change waiting for its invoice to be paid would add, JSON
-- [{"kind":"fast"|"monitor_pack"|"fast_pack","quantity":n}], for the
-- billing page's "waiting on a payment"; null when nothing waits.
ALTER TABLE subscriptions ADD COLUMN pending_items TEXT;

-- The packs the deciding subscription carries: with tenants.plan, what the
-- tenant's limits are made of.
ALTER TABLE tenants ADD COLUMN monitor_packs INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tenants ADD COLUMN fast_packs INTEGER NOT NULL DEFAULT 0;

-- Fast monitors (checked more often than every 12 minutes) the tenant last
-- reported, for the account page's usage; null from bundles older than the
-- count.
ALTER TABLE tenant_usage ADD COLUMN fast_monitors INTEGER;
