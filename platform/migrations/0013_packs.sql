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
-- What Stripe bills, by its own quantities, JSON {"fast":n,"monitor_pack":n,
-- "fast_pack":n}: the renewal total the billing page shows, and packs that
-- are billed but don't count (past a cap, or fast packs without the add-on),
-- which the customer can always remove. Null for rows saved before.
ALTER TABLE subscriptions ADD COLUMN billed_items TEXT;
-- About how much removed packs left as a credit for the next renewal
-- (create_prorations), in cents, estimated when the pack is removed and
-- cleared when a renewal invoice is paid; for the billing page only, since
-- Stripe keeps the exact amount.
ALTER TABLE subscriptions ADD COLUMN credit_cents INTEGER NOT NULL DEFAULT 0;

-- The packs the deciding subscription carries: with tenants.plan, what the
-- tenant's limits are made of.
ALTER TABLE tenants ADD COLUMN monitor_packs INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tenants ADD COLUMN fast_packs INTEGER NOT NULL DEFAULT 0;

-- Fast monitors (checked more often than every 12 minutes) the tenant last
-- reported, for the account page's usage; null from bundles older than the
-- count.
ALTER TABLE tenant_usage ADD COLUMN fast_monitors INTEGER;

-- Support grants (tenants.limit_overrides) are now added to the plan and
-- its packs instead of replacing them (withLimitGrant in the contract), so
-- a grant can never take away a pack the customer paid for. Rows written
-- before hold whole limits; each becomes what it adds over its plan, so
-- every tenant keeps exactly the limits it had. A shorter interval used to
-- let every monitor be fast; fast monitors are now granted only through
-- fastMonitors, so such a row gets a fastMonitors grant for all of its
-- monitors first. None exist in production yet; the plans' numbers are
-- PLAN_LIMITS (trial 5 monitors, 1 page, 50 emails; hosted and hosted_fast
-- 20, 2, 500; fast monitors 5 on hosted_fast). A grant never subtracts.
UPDATE tenants SET limit_overrides = json_set(limit_overrides, '$.fastMonitors',
    MAX(0, COALESCE(json_extract(limit_overrides, '$.monitors'), CASE plan WHEN 'trial' THEN 5 ELSE 20 END)
         - CASE plan WHEN 'hosted_fast' THEN 5 ELSE 0 END))
  WHERE json_valid(limit_overrides) AND json_extract(limit_overrides, '$.minIntervalMinutes') < 12
    AND json_type(limit_overrides, '$.fastMonitors') IS NULL;
UPDATE tenants SET limit_overrides = json_set(limit_overrides, '$.monitors',
    MAX(0, json_extract(limit_overrides, '$.monitors') - CASE plan WHEN 'trial' THEN 5 ELSE 20 END))
  WHERE json_valid(limit_overrides) AND json_type(limit_overrides, '$.monitors') IN ('integer', 'real');
UPDATE tenants SET limit_overrides = json_set(limit_overrides, '$.statusPages',
    MAX(0, json_extract(limit_overrides, '$.statusPages') - CASE plan WHEN 'trial' THEN 1 ELSE 2 END))
  WHERE json_valid(limit_overrides) AND json_type(limit_overrides, '$.statusPages') IN ('integer', 'real');
UPDATE tenants SET limit_overrides = json_set(limit_overrides, '$.emailsPerDay',
    MAX(0, json_extract(limit_overrides, '$.emailsPerDay') - CASE plan WHEN 'trial' THEN 50 ELSE 500 END))
  WHERE json_valid(limit_overrides) AND json_type(limit_overrides, '$.emailsPerDay') IN ('integer', 'real');
