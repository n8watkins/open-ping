/** Notification event types + default per-channel matrix (PRD §12). */

export const NOTIFY_EVENTS = [
  "down",
  "recovered",
  "heartbeat_missed",
  "flapping",
  "degraded",
  "cert_expiring",
  "maintenance_start",
  "maintenance_end",
  "incident_update",
  "weekly",
  "test",
] as const;

export type NotifyEvent = (typeof NOTIFY_EVENTS)[number];

/** Every notification channel type, plus Web Push devices. */
export const CHANNEL_KINDS = ["push", "email", "discord", "slack", "teams", "telegram", "webhook"] as const;

export type ChannelKind = (typeof CHANNEL_KINDS)[number];

/**
 * Default channel routing per event. A channel with its own `events` list
 * overrides these defaults; otherwise these decide whether it fires.
 */
export const NOTIFY_DEFAULTS: Record<NotifyEvent, Record<ChannelKind, boolean>> = {
  down: { push: true, email: true, discord: true, slack: true, teams: true, telegram: true, webhook: true },
  recovered: { push: true, email: true, discord: true, slack: true, teams: true, telegram: true, webhook: true },
  heartbeat_missed: { push: true, email: true, discord: true, slack: true, teams: true, telegram: true, webhook: true },
  flapping: { push: true, email: true, discord: true, slack: true, teams: true, telegram: true, webhook: true },
  degraded: { push: false, email: false, discord: false, slack: false, teams: false, telegram: false, webhook: false },
  // A certificate monitor crossed one of its warning thresholds (checks/cert.ts):
  // the whole point of the monitor, so every channel hears it by default.
  cert_expiring: { push: true, email: true, discord: true, slack: true, teams: true, telegram: true, webhook: true },
  maintenance_start: { push: false, email: false, discord: false, slack: false, teams: false, telegram: false, webhook: true },
  maintenance_end: { push: false, email: false, discord: false, slack: false, teams: false, telegram: false, webhook: true },
  // The admin posts these; their own devices don't need to hear back about it.
  incident_update: { push: false, email: true, discord: true, slack: true, teams: true, telegram: true, webhook: true },
  weekly: { push: false, email: true, discord: false, slack: false, teams: false, telegram: false, webhook: false },
  test: { push: true, email: true, discord: true, slack: true, teams: true, telegram: true, webhook: true },
};

export function channelWantsEvent(
  kind: ChannelKind,
  event: NotifyEvent,
  channelEvents: string[] | null,
): boolean {
  // Distinguish "no per-channel override" (null/undefined → use defaults) from
  // an explicit empty list (subscribe to nothing - never fall back to defaults).
  if (channelEvents != null) return channelEvents.includes(event);
  return NOTIFY_DEFAULTS[event]?.[kind] ?? false;
}
