/** Monitor lifecycle states (PRD §10). Shared by worker + client. */
export const MONITOR_STATES = [
  "unknown",
  "warming_up",
  "up",
  "degraded",
  "down",
  "suspended",
  "scheduled_off",
  "paused",
  "maintenance",
  "cant_check",
] as const;

export type MonitorState = (typeof MONITOR_STATES)[number];

/**
 * Down-family states that contribute to incident downtime / not-up rollups
 * (PRD §10). `suspended` (a Render free-tier app turned off) is a real outage:
 * the service is unavailable, so it accrues downtime exactly like `down` - it is
 * only stored and displayed under a distinct label.
 */
export const DOWNTIME_STATES: ReadonlySet<MonitorState> = new Set([
  "down",
  "suspended",
]);

export const MONITOR_TYPES = ["http", "heartbeat", "dns", "tcp", "domain", "cert"] as const;
export type MonitorType = (typeof MONITOR_TYPES)[number];

export const SCHEDULE_MODES = ["always", "business_hours", "custom"] as const;
export type ScheduleMode = (typeof SCHEDULE_MODES)[number];

/** Human-facing labels + the palette token each state maps to (PRD §21). */
export const STATE_META: Record<MonitorState, { label: string; token: string }> = {
  unknown: { label: "Unknown", token: "paused" },
  warming_up: { label: "Warming up", token: "warming" },
  up: { label: "Up", token: "up" },
  degraded: { label: "Degraded", token: "degraded" },
  down: { label: "Down", token: "down" },
  suspended: { label: "Suspended", token: "suspended" },
  scheduled_off: { label: "Scheduled off", token: "scheduled" },
  paused: { label: "Paused", token: "paused" },
  maintenance: { label: "Maintenance", token: "maint" },
  // A certificate monitor whose certificate can't be read from Cloudflare's
  // network (the host is behind Cloudflare's proxy, or only speaks TLS 1.3):
  // neutral, never an outage, no incident and no alert (checks/cert.ts).
  cant_check: { label: "Can't check", token: "paused" },
};
