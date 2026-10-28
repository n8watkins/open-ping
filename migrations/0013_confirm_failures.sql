-- 0013: Confirm a failure with a second check before opening an incident.
-- monitors.confirm_failures: 'retry' (re-check once before alerting, the
-- default) or 'off' (alert on the first failed check). NULL means 'retry', so
-- monitors created before this migration keep confirming.
ALTER TABLE monitors ADD COLUMN confirm_failures TEXT;
-- incidents.confirmed: 1 when a second check agreed before the incident opened.
ALTER TABLE incidents ADD COLUMN confirmed INTEGER NOT NULL DEFAULT 0;
-- Per scheduler run: second checks made, how many of them passed (a blip that
-- did not alert), and how many waited for the next run for lack of budget.
-- NULL for runs recorded before this migration.
ALTER TABLE scheduler_runs ADD COLUMN confirmations INTEGER;
ALTER TABLE scheduler_runs ADD COLUMN confirmations_cleared INTEGER;
ALTER TABLE scheduler_runs ADD COLUMN confirmations_deferred INTEGER;
