import type { Env } from "../types";
import type { MonitorRecord } from "../db/monitors";
import type { IncidentRecord } from "../db/incidents";
import { getIncidentById } from "../db/incidents";
import { getMonitor } from "../db/monitors";
import {
  createIncidentUpdate,
  type CreateUpdateResult,
  type IncidentUpdate,
  type postUpdateSchema,
} from "../db/incident-updates";
import type { z } from "zod";
import { listChannels, type ChannelRecord } from "../db/channels";
import { listActiveSubscriptionIds } from "../db/push";
import { enqueue, type NewOutboxEntry } from "../db/outbox";
import { getSetting } from "../db/settings";
import { isVapidConfigured } from "./push/vapid";
import { channelWantsEvent, type ChannelKind, type NotifyEvent } from "../../shared/notifications";
import { buildIncidentPayload, buildIncidentUpdatePayload, type NotificationPayload } from "./payload";

/**
 * Per-monitor alert cooldown for down-family events. Mirrors FLAP_WINDOW_MS in
 * checks/state.ts: repeated down/flapping/heartbeat_missed alerts for the same
 * monitor inside this window are coalesced into the first one of that type.
 */
export const ALERT_COOLDOWN_MS = 60 * 60 * 1000;

/** Down-family events subject to coalescing. `recovered` is never suppressed. */
export const COOLDOWN_EVENTS: ReadonlySet<NotifyEvent> = new Set([
  "down",
  "flapping",
  "heartbeat_missed",
]);

/**
 * The down-family events already queued for this monitor since `since` (rows:
 * `{ event_type }`), so a caller that batches its reads can apply the cooldown
 * (the same rule as recentlyAlerted) for whichever event it ends up sending.
 */
export function recentAlertsStatement(env: Env, monitorId: string, since: number): D1PreparedStatement {
  return env.DB.prepare(
    `SELECT DISTINCT event_type FROM notification_outbox
      WHERE monitor_id = ? AND created_at >= ?
        AND event_type IN (SELECT value FROM json_each(?))`,
  ).bind(monitorId, since, JSON.stringify([...COOLDOWN_EVENTS]));
}

/** What fanning an alert out needs: the channels, the app URL and the Web Push devices. */
export interface NotifyContext {
  /** Every channel, as listChannels returns them. */
  channels: ChannelRecord[];
  appUrl: string | undefined;
  /** Active Web Push device ids; empty when Web Push isn't configured. */
  pushIds: string[];
}

/**
 * True when an alert of this exact event type for this monitor was already
 * enqueued within the cooldown window - the signal used to coalesce flapping/
 * down storms (one alert per event type per monitor per window). Matched on the
 * indexed monitor_id column. Best-effort: any query error fails OPEN (returns
 * false) so a genuine alert is never lost to a transient DB issue.
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
          AND monitor_id = ?
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

  await fanOut(env, monitor, event, incident.id, (appUrl) =>
    buildIncidentPayload(monitor, incident, event, appUrl),
  );
}

/**
 * Enqueue outbox deliveries for a status update an admin just posted to an
 * incident, to the incident's monitor's channels exactly as its down and
 * recovered alerts go (same defaults matrix, per-channel event lists and the
 * monitor's channel restriction). Never coalesced: each update is written on
 * purpose, and an incident holds at most 100. Delivered by the next cron run.
 *
 * Returns how many deliveries were queued (0 when the incident or its monitor
 * is gone, or no channel wants the event). About five D1 queries, no fetch.
 */
export async function enqueueIncidentUpdateEvent(
  env: Env,
  incidentId: string,
  update: Pick<IncidentUpdate, "id" | "status" | "message" | "postedAt">,
): Promise<number> {
  const incident = await getIncidentById(env, incidentId);
  if (!incident) return 0;
  const monitor = await getMonitor(env, incident.monitorId);
  if (!monitor) return 0;
  return fanOut(env, monitor, "incident_update", update.id, (appUrl) =>
    buildIncidentUpdatePayload(monitor, incident, update, appUrl),
  );
}

/**
 * One outbox entry per channel (and Web Push device) that wants `event` for
 * this monitor, keyed `${event}:${subjectId}:${channel}` so a retry is a no-op.
 * The payload is built only once a channel exists (it may read the app URL
 * setting). Returns how many entries were offered to the outbox.
 */
async function fanOut(
  env: Env,
  monitor: MonitorRecord,
  event: NotifyEvent,
  subjectId: string,
  buildPayload: (appUrl: string | undefined) => NotificationPayload,
): Promise<number> {
  const channels = await listChannels(env);
  if (!channels.some((c) => c.enabled && c.type !== "push")) return 0;
  const appUrl = env.APP_URL ?? (await getSetting(env, "app_url")) ?? undefined;
  const pushIds = (await isVapidConfigured(env)) ? await listActiveSubscriptionIds(env) : [];
  const entries = deliveriesFor(monitor, event, subjectId, buildPayload, { channels, appUrl, pushIds });
  if (entries.length) await enqueue(env, entries);
  return entries.length;
}

/**
 * The outbox entries for `event` on this monitor (see fanOut), from an already
 * read {@link NotifyContext}: one per enabled channel that wants the event and
 * that the monitor's channel restriction allows, plus one per Web Push device.
 * Pure, so a caller can batch the inserts with its other writes.
 */
export function deliveriesFor(
  monitor: MonitorRecord,
  event: NotifyEvent,
  subjectId: string,
  buildPayload: (appUrl: string | undefined) => NotificationPayload,
  ctx: NotifyContext,
): NewOutboxEntry[] {
  const channels = ctx.channels.filter((c) => c.enabled && c.type !== "push");
  if (!channels.length) return [];

  const payload = buildPayload(ctx.appUrl);

  const restrict = monitor.notify?.channels ?? [];

  const entries: NewOutboxEntry[] = channels
    .filter((ch) => channelWantsEvent(ch.type as ChannelKind, event, ch.events))
    .filter((ch) => restrict.length === 0 || restrict.includes(ch.id))
    .map((ch) => ({
      eventKey: `${event}:${subjectId}:${ch.id}`,
      monitorId: monitor.id,
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
  if (pushAllowed && channelWantsEvent("push", event, null)) {
    for (const id of ctx.pushIds) {
      entries.push({
        eventKey: `${event}:${subjectId}:push:${id}`,
        monitorId: monitor.id,
        channelId: null,
        channelType: "push",
        target: id,
        eventType: event,
        payload,
      });
    }
  }
  return entries;
}

/**
 * The deliveries for an incident event (enqueueIncidentEvent without the
 * cooldown, which a batching caller applies from recentAlertsStatement).
 */
export function incidentDeliveries(
  monitor: MonitorRecord,
  incident: IncidentRecord,
  event: NotifyEvent,
  ctx: NotifyContext,
): NewOutboxEntry[] {
  return deliveriesFor(monitor, event, incident.id, (appUrl) =>
    buildIncidentPayload(monitor, incident, event, appUrl),
  ctx);
}

/** What posting an update did: the update, and how many alerts were queued. */
export type PostUpdateResult =
  | { ok: true; update: IncidentUpdate; alertsQueued: number; alertsError?: "enqueue_failed" }
  | Extract<CreateUpdateResult, { ok: false }>;

/**
 * Post a status update to an incident and, unless `notify` is false, queue
 * alerts for it (POST /api/incidents/:id/updates, the MCP and the CLI). The
 * update is saved first; a failure to queue its alerts is logged and reported
 * as `alertsError`, never as a failed post, so a retry can't post it twice.
 */
export async function postIncidentUpdate(
  env: Env,
  incidentId: string,
  input: z.input<typeof postUpdateSchema>,
): Promise<PostUpdateResult> {
  const r = await createIncidentUpdate(env, incidentId, { status: input.status, message: input.message });
  if (!r.ok) return r;
  if (input.notify === false) return { ok: true, update: r.update, alertsQueued: 0 };
  try {
    return { ok: true, update: r.update, alertsQueued: await enqueueIncidentUpdateEvent(env, incidentId, r.update) };
  } catch (e) {
    console.error("[notify] incident update alerts failed", e);
    return { ok: true, update: r.update, alertsQueued: 0, alertsError: "enqueue_failed" };
  }
}
