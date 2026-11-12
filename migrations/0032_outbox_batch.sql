-- 0032: Grouped alerts and the per-channel alert cap (notifications/dispatcher.ts).
-- When several monitors go down (or recover) at once, their deliveries to one
-- channel are sent as a single grouped message; every row of that message gets
-- the same batch_id, so the cap counts it as one alert sent, not one per monitor.
--   batch_id  the grouped message this row was last tried in; NULL for a single alert
-- A delivery over the cap is kept with status 'suppressed' (never sent).
ALTER TABLE notification_outbox ADD COLUMN batch_id TEXT;
