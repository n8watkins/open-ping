import type { Env } from "../types";
import type { MonitorRecord } from "../db/monitors";
import type { IncidentRecord } from "../db/incidents";
import { listChannels } from "../db/channels";
import { listActiveSubscriptions } from "../db/push";
import { enqueue } from "../db/outbox";
import { getSetting } from "../db/settings";
import { isVapidConfigured } from "./push/vapid";
import { channelWantsEvent, type ChannelKind, type NotifyEvent } from "../../shared/notifications";
import { buildIncidentPayload } from "./payload";

/**
 * Per-monitor alert cooldown for down-family events. Mirrors FLAP_WINDOW_MS in
 * checks/state.ts: repeated down/flapping/heartbeat_missed alerts for the same
 * monitor inside this window are coalesced into the first one of that type.
 */
const ALERT_COOLDOWN_MS = 60 * 60 * 1000;

/** Down-family events subject to coalescing. `recovered` is never suppressed. */
const COOLDOWN_EVENTS: ReadonlySet<NotifyEvent> = new Set([
  "down",
  "flapping",
  "heartbeat_missed",
]);

/**
 * True when an alert of this exact event type for this monitor was already
 * enqueued within the cooldown window — the signal used to coalesce flapping/
 * down storms (one alert per event type per monitor per window). The outbox has
 * no monitor_id column, so the monitor is matched via the JSON payload.
 * Best-effort: any query error fails OPEN (returns false) so a genuine alert is
 * never lost to a transient DB issue.
 */
async function recentlyAlerted(
  env: Env,
  monitorId: string,
  event: NotifyEvent,
  since: number,
): Promise<boolean> {
  try {
    const row = await env.DB.prepare(
      `SELECT 1 FROM notification_outbox
        WHERE event_type = ?
          AND created_at >= ?
          AND json_extract(payload, '$.monitorId') = ?
        LIMIT 1`,
    )
      .bind(event, since, monitorId)
      .first();
    return row != null;
  } catch (e) {
    console.error("[notify] alert cooldown check failed", e);
    return false;
  }
}

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
  // Coalesce flapping/down storms: a flapping monitor opens a fresh incident per
  // flap and would otherwise emit one alert per incident (dozens/hour). Suppress
  // a repeat down/flapping/heartbeat_missed alert when one of the same type for
  // this monitor already fired within the cooldown window. Skip ALL deliveries
  // (channels + push) for the coalesced event; never suppress `recovered`.
  if (COOLDOWN_EVENTS.has(event)) {
    if (await recentlyAlerted(env, monitor.id, event, Date.now() - ALERT_COOLDOWN_MS)) {
      return;
    }
  }

  const channels = (await listChannels(env)).filter((c) => c.enabled && c.type !== "push");
  if (!channels.length) return;

  const appUrl = (await getSetting(env, "app_url")) ?? undefined;
  const payload = buildIncidentPayload(monitor, incident, event, appUrl);
  const restrict = monitor.notify?.channels ?? [];

  const entries: Parameters<typeof enqueue>[1] = channels
    .filter((ch) => channelWantsEvent(ch.type as ChannelKind, event, ch.events))
    .filter((ch) => restrict.length === 0 || restrict.includes(ch.id))
    .map((ch) => ({
      eventKey: `${event}:${incident.id}:${ch.id}`,
      channelId: ch.id,
      channelType: ch.type,
      eventType: event,
      payload,
    }));

  // Web Push: one entry per active device subscription (separate from channels).
  // Honor the monitor's channel restriction. When `restrict` is non-empty it is
  // the allow-list of channels permitted to fire for this monitor; push device
  // IDs can't appear in that channel-id list, so push is suppressed unless the
  // user explicitly opts it back in with a "push" sentinel in notify.channels.
  // (Least-surprising: a restricted monitor fires ONLY what is listed.)
  const pushAllowed = restrict.length === 0 || restrict.includes("push");
  if (pushAllowed && channelWantsEvent("push", event, null) && (await isVapidConfigured(env))) {
    const subs = await listActiveSubscriptions(env);
    for (const s of subs) {
      entries.push({
        eventKey: `${event}:${incident.id}:push:${s.id}`,
        channelId: null,
        channelType: "push",
        target: s.id,
        eventType: event,
        payload,
      });
    }
  }

  if (entries.length) await enqueue(env, entries);
}
