-- Add monitor_id to notification_outbox so a monitor's queued deliveries can be
-- purged when the monitor is deleted. The event_key embeds the *incident* id
-- (event:incident:channel), not the monitor id, so there was previously no clean
-- way to correlate outbox rows to a monitor without a fragile LIKE on event_key.
-- The column also lets the flap-coalescing lookup match an indexed column instead
-- of json_extract(payload, '$.monitorId').
ALTER TABLE notification_outbox ADD COLUMN monitor_id TEXT;
CREATE INDEX idx_outbox_monitor ON notification_outbox(monitor_id);
