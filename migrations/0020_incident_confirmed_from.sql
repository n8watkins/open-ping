-- Second-region confirmation (checks/region.ts): a failed check's re-check can
-- run from another Cloudflare location, and the incident records which data
-- center (IATA code, such as 'FRA') confirmed it. NULL when the re-check ran
-- where the first check did, or the incident wasn't confirmed.
ALTER TABLE incidents ADD COLUMN confirmed_from TEXT;
