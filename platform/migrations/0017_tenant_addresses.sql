-- 0017: Customer addresses as Workers Custom Domains (decision D2's cheaper
-- start: customers at <slug>.openping.n8builds.dev; src/addresses.ts).
--
-- Additive: one column and one table, nothing existing changes.
--
-- With TENANT_ADDRESSES "custom_domains", provisioning attaches one Workers
-- Custom Domain per tenant (its own certificate, at no extra cost, even two
-- levels below the zone) and records its id here, so the teardown detaches
-- exactly that one. NULL while it has none (wildcard addresses, or not yet).
ALTER TABLE tenants ADD COLUMN custom_domain_id TEXT;

-- How much of a Cloudflare limit the platform uses: 'custom_domains' (100
-- per zone, every Custom Domain on the zone counts, the owner's own too) and
-- 'workers' (500 per account on Workers Paid, starter mode). Refreshed from
-- the Cloudflare API every hour and moved by one at each attach and detach;
-- sign-ups stop short of the cap and the health check warns the owner first.
CREATE TABLE platform_capacity (
  resource   TEXT PRIMARY KEY,            -- 'custom_domains' | 'workers'
  used       INTEGER NOT NULL,
  cap        INTEGER NOT NULL,
  checked_at INTEGER NOT NULL             -- epoch ms of the last count from the API
);
