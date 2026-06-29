/** Notification event types + default per-channel matrix (PRD §12). */

export const NOTIFY_EVENTS = [
  "down",
  "recovered",
  "heartbeat_missed",
  "flapping",
  "degraded",
  "maintenance_start",
  "maintenance_end",
  "weekly",
  "test",
] as const;

export type NotifyEvent = (typeof NOTIFY_EVENTS)[number];

export type ChannelKind = "push" | "email" | "discord" | "webhook";

/**
 * Default channel routing per event. A channel with its own `events` list
 * overrides these defaults; otherwise these decide whether it fires.
 */
export const NOTIFY_DEFAULTS: Record<NotifyEvent, Record<ChannelKind, boolean>> = {
  down: { push: true, email: true, discord: true, webhook: true },
  recovered: { push: true, email: true, discord: true, webhook: true },
  heartbeat_missed: { push: true, email: true, discord: true, webhook: true },
  flapping: { push: true, email: true, discord: true, webhook: true },
  degraded: { push: false, email: false, discord: false, webhook: false },
  maintenance_start: { push: false, email: false, discord: false, webhook: true },
  maintenance_end: { push: false, email: false, discord: false, webhook: true },
  weekly: { push: false, email: true, discord: false, webhook: false },
  test: { push: true, email: true, discord: true, webhook: true },
};

export function channelWantsEvent(
  kind: ChannelKind,
  event: NotifyEvent,
  channelEvents: string[] | null,
): boolean {
  if (channelEvents && channelEvents.length) return channelEvents.includes(event);
  return NOTIFY_DEFAULTS[event]?.[kind] ?? false;
}
