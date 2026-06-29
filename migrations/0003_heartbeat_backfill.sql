-- Backfill last_beat_at for monitor_state rows that predate migration 0002.
--
-- 0002 added monitor_state.last_beat_at with no backfill, so every pre-existing
-- row is NULL. The scheduler bases a heartbeat monitor's overdue deadline on
-- last_beat_at, falling back to the monitor's createdAt when it is NULL
-- (scheduler.ts: `base = st?.last_beat_at ?? m.createdAt`). For an existing
-- monitor that has been beating for weeks, that fallback is ancient, so the very
-- first post-upgrade tick sees it as instantly overdue — and the freshness guard
-- in markHeartbeatMissed (which skips when last_beat_at is fresh) is bypassed
-- because last_beat_at is NULL. The result is a false DOWN, a spurious incident,
-- and a bogus alert for healthy heartbeat monitors.
--
-- Seed last_beat_at from the most recent real signal we have: the last
-- successful beat, else the last time the monitor was checked. Rows where both
-- are NULL (never checked / never succeeded) stay NULL and fall through to the
-- scheduler's createdAt fallback + warm-up cycle, which is correct for a monitor
-- that has genuinely never beaten.
UPDATE monitor_state
   SET last_beat_at = COALESCE(last_success_at, last_checked_at)
 WHERE last_beat_at IS NULL;
