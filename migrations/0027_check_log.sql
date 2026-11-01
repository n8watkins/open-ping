-- Leaner check writes (docs/HOSTED_PLAN.md, "Cost per customer, measured").
--
-- A passing check that changed nothing is kept in its hour summary's check
-- log instead of a samples row of its own (history/check-log.ts): D1 bills a
-- sample row as 3 rows written (the row and its two indexes) and its delete a
-- day later as another. Every 24-hour view reads both places.
ALTER TABLE summaries ADD COLUMN check_log TEXT;

-- The latest check's details (resolved DNS records, a domain's expiry, a
-- certificate it can't read), for the monitor page when that check has no
-- samples row. Written with the state the check writes anyway.
ALTER TABLE monitor_state ADD COLUMN last_meta TEXT;
