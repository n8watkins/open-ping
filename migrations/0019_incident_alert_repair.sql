-- Incidents now record whether their opening alert was queued (`notified`), so
-- a later cron run can queue one that a failed write left out
-- (checks/state.ts). Everything opened before this migration already had its
-- chance: mark it notified so no old incident alerts again.
UPDATE incidents SET notified = 1 WHERE notified = 0;

-- The scheduler reads open incidents still waiting for their alert every run.
CREATE INDEX idx_incidents_unnotified ON incidents(started_at) WHERE notified = 0;
