/** Monitor lifecycle states (PRD §10). Shared by worker + client. */
export const MONITOR_STATES = [
  "unknown",
  "warming_up",
  "up",
  "degraded",
  "down",
  "scheduled_off",
  "paused",
  "maintenance",
] as const;

export type MonitorState = (typeof MONITOR_STATES)[number];

/** Only `down` contributes to incident downtime (PRD §10). */
export const DOWNTIME_STATES: ReadonlySet<MonitorState> = new Set(["down"]);

export const MONITOR_TYPES = ["http", "heartbeat"] as const;
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
  scheduled_off: { label: "Scheduled off", token: "scheduled" },
  paused: { label: "Paused", token: "paused" },
  maintenance: { label: "Maintenance", token: "maint" },
};
