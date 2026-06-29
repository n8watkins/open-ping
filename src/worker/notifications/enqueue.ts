import type { Env } from "../types";
import type { MonitorRecord } from "../db/monitors";
import type { IncidentRecord } from "../db/incidents";
import { listChannels } from "../db/channels";
import { enqueue } from "../db/outbox";
import { getSetting } from "../db/settings";
import { channelWantsEvent, type ChannelKind, type NotifyEvent } from "../../shared/notifications";
import { buildIncidentPayload } from "./payload";

/**
 * Enqueue outbox deliveries for an incident event across every channel that
 * wants it (per the defaults matrix + per-channel overrides + the monitor's
 * own channel restriction). One entry per channel; idempotent via event_key.
 * Web Push subscriptions are enqueued separately (Phase 4b).
 */
export async function enqueueIncidentEvent(
  env: Env,
  monitor: MonitorRecord,
  incident: IncidentRecord,
  event: NotifyEvent,
): Promise<void> {
  const channels = (await listChannels(env)).filter((c) => c.enabled && c.type !== "push");
  if (!channels.length) return;

  const appUrl = (await getSetting(env, "app_url")) ?? undefined;
  const payload = buildIncidentPayload(monitor, incident, event, appUrl);
  const restrict = monitor.notify?.channels ?? [];

  const entries = channels
    .filter((ch) => channelWantsEvent(ch.type as ChannelKind, event, ch.events))
    .filter((ch) => restrict.length === 0 || restrict.includes(ch.id))
    .map((ch) => ({
      eventKey: `${event}:${incident.id}:${ch.id}`,
      channelId: ch.id,
      channelType: ch.type,
      eventType: event,
      payload,
    }));

  if (entries.length) await enqueue(env, entries);
}
