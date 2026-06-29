-- Post-review hardening migration (security + correctness fixes).

-- (1) Heartbeat overdue detection must key off the last beat ACTUALLY RECEIVED
--     (success OR failure), not the last successful one. Otherwise an
--     on-schedule but failing heartbeat (exit_status != 0) never advances the
--     deadline base and the scheduler wrongly re-declares it "missed" every
--     cycle, overwriting the real error and double-counting downtime.
ALTER TABLE monitor_state ADD COLUMN last_beat_at INTEGER;

-- (2) Backstop the heartbeat-ingestion vs scheduler race: at most one OPEN
--     incident may exist per monitor. If two writers race to open an incident,
--     the loser's INSERT fails and applyIncidentTransition's try/catch swallows
--     it — preventing a permanently-orphaned duplicate incident.
CREATE UNIQUE INDEX idx_incidents_one_open ON incidents(monitor_id) WHERE status = 'open';
