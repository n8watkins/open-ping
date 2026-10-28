-- 0016: Cache each domain monitor's last RDAP read.
-- monitor_state.domain_cache: JSON written by the check path (checks/domain.ts
-- DomainCache): the domain it belongs to, the expiry date read, when it was
-- read, and after a failed refresh when to try again and why it failed. A
-- domain monitor judges its expiry from this most cycles instead of asking RDAP
-- every 12 minutes, and keeps using it through a rate limit or an RDAP outage.
-- NULL for other monitor types and for domain monitors not yet read.
ALTER TABLE monitor_state ADD COLUMN domain_cache TEXT;
