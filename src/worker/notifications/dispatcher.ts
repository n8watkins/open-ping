import type { Env } from "../types";
import type { ChannelRecord } from "../db/channels";
import { getChannel, recordChannelResult, secretFieldsFor } from "../db/channels";
import { getSubscription, recordPushResult } from "../db/push";
import {
  claimDue,
  markDeferred,
  markSent,
  markFailed,
  markSuppressed,
  recentSendsStatement,
  type OutboxEntry,
  type OutboxIds,
} from "../db/outbox";
import { NOTIFY_EVENTS, type NotifyEvent } from "../../shared/notifications";
import { newId } from "../lib/ids";
import { getSetting } from "../db/settings";
import { defaultFrom, sendEmail } from "./mail";
import { sendDiscordMessage } from "./channels/discord";
import { sendWebhook } from "./channels/webhook";
import { sendSlackMessage, toSlackMessage } from "./channels/slack";
import { sendTeamsMessage, toTeamsMessage } from "./channels/teams";
import { sendTelegramMessage, toTelegramMessage } from "./channels/telegram";
import type { SendResult } from "./channels/http";
import {
  checkSlackWebhookUrl,
  checkTeamsWebhookUrl,
  checkTelegramBotToken,
  checkTelegramChatId,
  type TargetCheck,
} from "../../shared/channel-targets";
import { sendWebPush, type VapidKeys } from "./push/webpush";
import { getVapid } from "./push/vapid";
import { sendFcm, serviceAccount, type FcmAlert } from "./push/fcm";
import { configuredOrigin } from "../lib/app-origin";
import {
  buildGroupPayload,
  isNotificationPayload,
  toEmailHtml,
  toEmailText,
  toDiscordEmbed,
  type NotificationPayload,
} from "./payload";
import { assertSafeUrl } from "../lib/ssrf";
import { DecryptError, isCiphertext } from "../lib/crypto";

const MAX_ATTEMPTS = 5;
const BATCH = 25;

/** A provider-specific destination check failed: never send anywhere else. */
function invalidTarget(check: TargetCheck, prefix: string): SendResult | null {
  return check.ok ? null : { ok: false, error: `${prefix}: ${check.reason}` };
}

/** Deliver one payload to one channel via the appropriate provider. */
export async function deliverToChannel(
  env: Env,
  channel: ChannelRecord,
  payload: NotificationPayload,
  /** The `email_from` setting, when the caller already read it (null: unset). */
  emailFrom?: () => Promise<string | null>,
): Promise<SendResult> {
  const cfg = channel.config as Record<string, string | undefined>;
  // A secret that is still ciphertext here could not be decrypted (for example
  // the MASTER_KEY that sealed it is gone). Fail closed instead of sending the
  // ciphertext to a provider as if it were a URL or a bot token.
  for (const field of secretFieldsFor(channel.type)) {
    if (isCiphertext(cfg[field])) return { ok: false, error: "channel_secret_unreadable" };
  }
  switch (channel.type) {
    case "discord": {
      if (!cfg.url) return { ok: false, error: "missing_webhook_url" };
      const safe = assertSafeUrl(cfg.url);
      if (!safe.ok) return { ok: false, error: `unsafe_url: ${safe.reason}` };
      return sendDiscordMessage(cfg.url, { embeds: [toDiscordEmbed(payload)] });
    }
    case "slack": {
      if (!cfg.url) return { ok: false, error: "missing_webhook_url" };
      // Checked per delivery, not just on save: only Slack's own hosts, ever.
      const bad = invalidTarget(checkSlackWebhookUrl(cfg.url), "invalid_slack_url");
      if (bad) return bad;
      const safe = assertSafeUrl(cfg.url);
      if (!safe.ok) return { ok: false, error: `unsafe_url: ${safe.reason}` };
      return sendSlackMessage(cfg.url, toSlackMessage(payload));
    }
    case "teams": {
      if (!cfg.url) return { ok: false, error: "missing_webhook_url" };
      const bad = invalidTarget(checkTeamsWebhookUrl(cfg.url), "invalid_teams_url");
      if (bad) return bad;
      const safe = assertSafeUrl(cfg.url);
      if (!safe.ok) return { ok: false, error: `unsafe_url: ${safe.reason}` };
      return sendTeamsMessage(cfg.url, toTeamsMessage(payload));
    }
    case "telegram": {
      if (!cfg.botToken) return { ok: false, error: "missing_bot_token" };
      if (!cfg.chatId) return { ok: false, error: "missing_chat_id" };
      // The token lands in the request path, so it must be exactly a token:
      // anything else (a slash, a query) could change where the request goes.
      const bad =
        invalidTarget(checkTelegramBotToken(cfg.botToken), "invalid_telegram_config") ??
        invalidTarget(checkTelegramChatId(cfg.chatId), "invalid_telegram_config");
      if (bad) return bad;
      return sendTelegramMessage(cfg.botToken, toTelegramMessage(cfg.chatId, payload));
    }
    case "webhook": {
      if (!cfg.url) return { ok: false, error: "missing_url" };
      // Same SSRF guard the monitor checks use - a channel URL could otherwise
      // point at loopback/link-local/metadata/private ranges and reflect the
      // internal response into last_error. Validated per-delivery (not just at
      // create time) so pre-existing configs are covered and there's no TOCTOU.
      const safe = assertSafeUrl(cfg.url);
      if (!safe.ok) return { ok: false, error: `unsafe_url: ${safe.reason}` };
      return sendWebhook(cfg.url, cfg.secret, payload);
    }
    case "email": {
      if (!cfg.to) return { ok: false, error: "missing_recipient" };
      const from =
        cfg.from || (await (emailFrom ? emailFrom() : getSetting(env, "email_from"))) || defaultFrom(env);
      return sendEmail(env, {
        from,
        to: cfg.to,
        subject: payload.title,
        html: toEmailHtml(payload),
        text: toEmailText(payload),
        category: "alert",
      });
    }
    default:
      return { ok: false, error: "unsupported_channel" };
  }
}

// --- Grouped alerts and the alert cap ----------------------------------------
//
// On 2026-11-11 a firewall rule made every HTTP monitor fail at once, and each
// monitor's down alert, then its recovery, went out as its own email: about 30
// in minutes, enough for Gmail to start filing the sender as spam. Two guards:
//
// - Grouping: when GROUP_MIN or more monitors go down (or recover) within
//   GROUP_WINDOW_MS, each channel and push device gets ONE message listing them
//   all. A run queues its alerts with its writes and delivers them at its end,
//   so the monitors that changed in one run, and any earlier alerts still
//   waiting, are grouped. Fewer than GROUP_MIN go out one by one as before.
// - The cap: no destination gets more than ALERT_CAP alerts in
//   ALERT_CAP_WINDOW_MS (a grouped one counts once). The rest are held back
//   (status 'suppressed') and logged, never sent late.

/** Monitors changing state within this window of each other are alerted together. */
export const GROUP_WINDOW_MS = 2 * 60_000;
/** How many monitors changing together make a grouped alert. */
export const GROUP_MIN = 3;
/** At most this many alerts per channel (or push device) ... */
export const ALERT_CAP = 10;
/** ... within this window. */
export const ALERT_CAP_WINDOW_MS = 10 * 60_000;

/** Which events group together: the down family, and recoveries. */
const GROUP_KIND: Partial<Record<NotifyEvent, "down" | "recovered">> = {
  down: "down",
  heartbeat_missed: "down",
  flapping: "down",
  recovered: "recovered",
};

/**
 * The events the cap counts and holds back: what monitoring raises by itself.
 * Not tests, the weekly summary, or an incident update an admin wrote.
 */
export const CAPPED_EVENTS: readonly NotifyEvent[] = NOTIFY_EVENTS.filter(
  (e) => e !== "test" && e !== "weekly" && e !== "incident_update",
);
const CAPPED = new Set<string>(CAPPED_EVENTS);

/** One channel, or one push device: what the cap and grouping are per. */
export function destinationOf(entry: Pick<OutboxEntry, "channelType" | "channelId" | "target">): string {
  return entry.channelType === "push" ? `push:${entry.target ?? ""}` : `channel:${entry.channelId ?? ""}`;
}

/**
 * One message to send: a single outbox entry, or a grouped alert standing for
 * several (`group` set, its payload built from theirs). `lead` is the entry
 * whose destination, attempts and bookkeeping the message uses.
 */
export interface Delivery {
  lead: OutboxEntry;
  entries: OutboxEntry[];
  group?: { kind: "down" | "recovered"; payload: NotificationPayload };
}

/**
 * Turn the due entries into the messages to send, in order: GROUP_MIN or more
 * entries of one kind (down or recovered) for one destination, each queued
 * within GROUP_WINDOW_MS of the first, become one grouped delivery at the place
 * of the first; everything else stays a single delivery. Pure.
 */
export function planDeliveries(due: readonly OutboxEntry[]): Delivery[] {
  const buckets = new Map<string, OutboxEntry[]>();
  for (const entry of due) {
    const kind = GROUP_KIND[entry.eventType as NotifyEvent];
    if (!kind || entry.payloadError || !isNotificationPayload(entry.payload)) continue;
    const key = `${destinationOf(entry)}|${kind}`;
    const list = buckets.get(key);
    if (list) list.push(entry);
    else buckets.set(key, [entry]);
  }

  const groupOf = new Map<string, Delivery>();
  for (const [key, list] of buckets) {
    if (list.length < GROUP_MIN) continue;
    const kind = key.endsWith("|recovered") ? "recovered" : "down";
    const sorted = [...list].sort((a, b) => a.createdAt - b.createdAt);
    let cluster: OutboxEntry[] = [];
    const close = () => {
      if (cluster.length >= GROUP_MIN) {
        const payload = buildGroupPayload(
          cluster.map((e) => e.payload as NotificationPayload),
          kind,
        );
        // The entry that comes first in `due` leads, so the group goes where it would have.
        const lead = due.find((e) => cluster.includes(e))!;
        const delivery: Delivery = { lead, entries: cluster, group: { kind, payload } };
        for (const e of cluster) groupOf.set(e.id, delivery);
      }
    };
    for (const entry of sorted) {
      if (cluster.length > 0 && entry.createdAt - cluster[0]!.createdAt > GROUP_WINDOW_MS) {
        close();
        cluster = [];
      }
      cluster.push(entry);
    }
    close();
  }

  const plan: Delivery[] = [];
  const placed = new Set<Delivery>();
  for (const entry of due) {
    const grouped = groupOf.get(entry.id);
    if (!grouped) plan.push({ lead: entry, entries: [entry] });
    else if (!placed.has(grouped)) {
      placed.add(grouped);
      plan.push(grouped);
    }
  }
  return plan;
}

/** What a delivery marks: one entry, or every entry a grouped alert carried, under a new batch id for this attempt. */
function idsOf(delivery: Delivery): OutboxIds {
  return delivery.group ? { ids: delivery.entries.map((e) => e.id), batchId: newId("grp") } : delivery.lead.id;
}

/** How many deliveries one pass takes for a requested limit (0 to BATCH). */
export function outboxTake(limit: number = BATCH): number {
  return Math.min(BATCH, Math.max(0, Math.floor(limit)));
}

/**
 * What one pass reads once and reuses for every entry: each channel, the VAPID
 * keys, the `email_from` setting and this install's address (for the Android
 * app's alerts). Undefined means not read yet.
 */
export interface DeliveryCache {
  channels: Map<string, ChannelRecord | null>;
  vapid: VapidKeys | null | undefined;
  emailFrom: string | null | undefined;
  origin: string | null | undefined;
}

export function newDeliveryCache(): DeliveryCache {
  return { channels: new Map(), vapid: undefined, emailFrom: undefined, origin: undefined };
}

/**
 * The most D1 queries delivering `entry` can make, given what the pass has
 * already read (lib/budget.ts uses it so a run never overruns its plan):
 *
 * - a push device: the subscription, the VAPID keys (a browser, once per
 *   pass) or this install's address (the Android app, once per pass), marking
 *   the entry sent or failed, and the device's result;
 * - a channel: the channel (once per channel per pass), `email_from` (once per
 *   pass, email only), marking the entry, and the channel's result;
 * - a payload that can't be read: only marking it failed;
 * - plus one in every case for marking it failed if delivery throws.
 */
export function deliveryD1Cost(entry: OutboxEntry, cache: DeliveryCache): number {
  if (entry.payloadError || !isNotificationPayload(entry.payload)) return 1;
  // The device's kind is only known once it is read, so count either read.
  if (entry.channelType === "push") {
    return 3 + (cache.vapid === undefined ? 1 : 0) + (cache.origin === undefined ? 1 : 0) + 1;
  }
  const channelRead = entry.channelId && !cache.channels.has(entry.channelId) ? 1 : 0;
  const fromRead = entry.channelType === "email" && cache.emailFrom === undefined ? 1 : 0;
  return 2 + channelRead + fromRead + 1;
}

/**
 * Process due outbox entries (PRD §12 outbox): deliver each independently,
 * record success/failure, retry transient failures with backoff, stop at max.
 * Never throws - a provider failure must not break the monitoring cycle.
 *
 * With `canSpend`, each entry is delivered only if its worst-case D1 cost
 * (deliveryD1Cost) still fits the caller's budget; the rest stay due for the
 * next pass, untouched.
 */
export async function processOutbox(
  env: Env,
  now: number = Date.now(),
  /** At most this many deliveries this time (the cron run's budget); the rest wait. */
  limit: number = BATCH,
  /**
   * Entries the caller already claimed (the scheduler reads them in the same D1
   * batch as its other end-of-run work, to save a round trip). Omitted, this
   * claims them itself.
   */
  claimed?: OutboxEntry[],
  opts: { canSpend?: (d1: number) => boolean } = {},
): Promise<{ processed: number; sent: number; failed: number }> {
  const take = outboxTake(limit);
  if (take === 0) return { processed: 0, sent: 0, failed: 0 };
  let due: OutboxEntry[];
  if (claimed) {
    due = claimed.slice(0, take);
  } else {
    try {
      due = await claimDue(env, now, take);
    } catch (e) {
      console.error("[dispatcher] claimDue failed", e);
      return { processed: 0, sent: 0, failed: 0 };
    }
  }

  let sent = 0;
  let failed = 0;
  let processed = 0;
  const cache = newDeliveryCache();
  const emailFrom = async () => {
    if (cache.emailFrom === undefined) cache.emailFrom = await getSetting(env, "email_from");
    return cache.emailFrom;
  };
  const origin = async () => {
    if (cache.origin === undefined) cache.origin = await configuredOrigin(env);
    return cache.origin;
  };
  const vapid = async () => {
    if (cache.vapid === undefined) cache.vapid = await getVapid(env);
    return cache.vapid;
  };
  const channelById = async (id: string) => {
    if (!cache.channels.has(id)) cache.channels.set(id, await getChannel(env, id));
    return cache.channels.get(id) ?? null;
  };

  const plan = planDeliveries(due);

  // The alert cap: what each destination was already sent in its window, read
  // once (only when something here counts toward it), then kept up to date as
  // this pass sends. Without the read (no budget, or it failed) the cap still
  // holds within this pass.
  const sentRecently = new Map<string, number>();
  if (plan.some((d) => CAPPED.has(d.lead.eventType)) && (!opts.canSpend || opts.canSpend(1))) {
    try {
      const { results } = await recentSendsStatement(env, now - ALERT_CAP_WINDOW_MS, CAPPED_EVENTS).all<{
        channel_id: string | null;
        target: string | null;
        sent: number;
      }>();
      for (const r of results ?? []) {
        const key = destinationOf({ channelType: r.channel_id ? "channel" : "push", channelId: r.channel_id, target: r.target });
        sentRecently.set(key, (sentRecently.get(key) ?? 0) + r.sent);
      }
    } catch (e) {
      console.error("[dispatcher] reading recent alerts for the cap failed", e);
    }
  }
  const suppressed: OutboxEntry[] = [];

  for (const delivery of plan) {
    const entry = delivery.lead;
    const ids = idsOf(delivery);
    const destination = destinationOf(entry);
    if (CAPPED.has(entry.eventType) && (sentRecently.get(destination) ?? 0) >= ALERT_CAP) {
      suppressed.push(...delivery.entries);
      continue;
    }
    if (opts.canSpend && !opts.canSpend(deliveryD1Cost(entry, cache))) {
      console.log(`[dispatcher] out of budget; ${due.length - processed} deliveries wait for the next run`);
      break;
    }
    processed += delivery.entries.length;
    // A grouped alert's entries share their attempts from the first try on; the
    // most any of them has made is the one that counts.
    const attempts = Math.max(...delivery.entries.map((e) => e.attempts));
    const payload = delivery.group?.payload ?? entry.payload;
    try {
      // Never send ciphertext or malformed legacy data to an external provider.
      // Keep the row in the normal bounded retry flow so operators can see the
      // failure without one corrupt row blocking every other due delivery.
      if (entry.payloadError) {
        await markFailed(env, ids, attempts + 1, entry.payloadError, MAX_ATTEMPTS);
        failed++;
        continue;
      }
      if (!isNotificationPayload(payload)) {
        await markFailed(env, ids, attempts + 1, "payload_invalid_shape", MAX_ATTEMPTS);
        failed++;
        continue;
      }

      // Web Push entries target a device subscription, not a channel.
      if (entry.channelType === "push") {
        const r = await deliverPush(env, ids, entry.target, attempts, payload, vapid, origin);
        if (r === "sent") {
          sent++;
          sentRecently.set(destination, (sentRecently.get(destination) ?? 0) + 1);
        } else if (r === "failed") failed++;
        // "pruned" (subscription gone/expired) is neither a send nor a failure.
        continue;
      }

      const channel = entry.channelId ? await channelById(entry.channelId) : null;
      if (!channel || !channel.enabled) {
        // Channel removed/disabled - drop the entry as dead.
        await markFailed(env, ids, MAX_ATTEMPTS, "channel_unavailable", MAX_ATTEMPTS);
        failed++;
        continue;
      }
      const result = await deliverToChannel(env, channel, payload, emailFrom);
      if (result.ok) {
        await markSent(env, ids);
        sentRecently.set(destination, (sentRecently.get(destination) ?? 0) + 1);
        // Bookkeeping only - must never reach the outer catch (which would
        // re-mark this already-sent entry failed and re-deliver it).
        try {
          await recordChannelResult(env, channel.id, true);
        } catch (e) {
          console.error("[dispatcher] recordChannelResult failed", e);
        }
        sent++;
      } else if (result.deferUntil !== undefined) {
        // The sender can't take it before then (Hosted's daily email cap):
        // wait, without spending an attempt.
        await markDeferred(env, ids, result.deferUntil, result.error ?? "deferred");
        await recordChannelResult(env, channel.id, false, result.error ?? "deferred");
        failed++;
      } else {
        await markFailed(
          env,
          ids,
          attempts + 1,
          result.error ?? "send_failed",
          MAX_ATTEMPTS,
          result.retryAfterMs,
        );
        await recordChannelResult(env, channel.id, false, result.error ?? "send_failed");
        failed++;
      }
    } catch (e) {
      failed++;
      await markFailed(
        env,
        ids,
        attempts + 1,
        e instanceof Error ? e.message : "exception",
        MAX_ATTEMPTS,
      ).catch(() => {});
    }
  }

  if (suppressed.length > 0) {
    const byDestination = new Map<string, number>();
    for (const e of suppressed) byDestination.set(destinationOf(e), (byDestination.get(destinationOf(e)) ?? 0) + 1);
    for (const [destination, count] of byDestination) {
      console.warn(
        `[dispatcher] alert cap: ${destination} already got ${ALERT_CAP} alerts in ${ALERT_CAP_WINDOW_MS / 60_000} min; held back ${count} more`,
        suppressed
          .filter((e) => destinationOf(e) === destination)
          .map((e) => ({ id: e.id, event: e.eventType, monitorId: e.monitorId })),
      );
    }
    // One query for all of them; without the budget they stay due and are
    // judged again next run.
    if (!opts.canSpend || opts.canSpend(1)) {
      try {
        await markSuppressed(
          env,
          suppressed.map((e) => e.id),
          `alert_cap: over ${ALERT_CAP} alerts in ${ALERT_CAP_WINDOW_MS / 60_000} min on this channel`,
        );
        processed += suppressed.length;
      } catch (e) {
        console.error("[dispatcher] marking capped alerts failed", e);
      }
    }
  }

  return { processed, sent, failed };
}

type PushOutcome = "sent" | "failed" | "pruned";

/** Deliver one push (one entry, or a grouped alert's entries). "pruned" = the subscription is simply gone. */
async function deliverPush(
  env: Env,
  ids: OutboxIds,
  subscriptionId: string | null,
  attempts: number,
  payload: NotificationPayload,
  loadVapid: () => Promise<VapidKeys | null>,
  loadOrigin: () => Promise<string | null>,
): Promise<PushOutcome> {
  let sub: Awaited<ReturnType<typeof getSubscription>>;
  try {
    sub = subscriptionId ? await getSubscription(env, subscriptionId) : null;
  } catch (e) {
    // Its endpoint or keys can't be decrypted (for example the MASTER_KEY that
    // sealed them is gone): retrying can never succeed, so stop now.
    if (!(e instanceof DecryptError)) throw e;
    await markFailed(env, ids, MAX_ATTEMPTS, "subscription_unreadable", MAX_ATTEMPTS);
    return "failed";
  }
  if (!sub || sub.disabled) {
    await markFailed(env, ids, MAX_ATTEMPTS, "subscription_gone", MAX_ATTEMPTS);
    return "pruned";
  }
  let result: Awaited<ReturnType<typeof sendFcm>>;
  if (sub.kind === "fcm") {
    // The Android app (notifications/push/fcm.ts).
    const sa = serviceAccount(env);
    if (!sa) {
      await markFailed(env, ids, MAX_ATTEMPTS, "fcm_not_configured", MAX_ATTEMPTS);
      return "failed";
    }
    result = await sendFcm(sa, sub.endpoint, fcmAlert(await loadOrigin(), payload));
  } else {
    const vapid = await loadVapid();
    if (!vapid) {
      await markFailed(env, ids, MAX_ATTEMPTS, "vapid_not_configured", MAX_ATTEMPTS);
      return "failed";
    }
    result = await sendWebPush({
      subscription: { endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth },
      payload: JSON.stringify({ title: payload.title, body: payload.body, url: payload.url }),
      vapid,
    });
  }
  if (result.ok) {
    await markSent(env, ids);
    // Bookkeeping only - isolate so a failure here can't reach the caller's
    // catch and re-mark this already-sent entry failed (duplicate push).
    try {
      await recordPushResult(env, sub.id, true);
    } catch (e) {
      console.error("[dispatcher] recordPushResult failed", e);
    }
    return "sent";
  }
  if (result.expired || result.invalid) {
    // Gone (404/410), or permanently invalid (SSRF-blocked endpoint / corrupt
    // keys): the subscription can never succeed, so prune it and stop retrying
    // instead of burning the retry budget on a guaranteed failure.
    await recordPushResult(env, sub.id, false, { expired: true });
    await markSent(env, ids);
    return "pruned";
  }
  await markFailed(env, ids, attempts + 1, result.error ?? "push_failed", MAX_ATTEMPTS, result.retryAfterMs);
  await recordPushResult(env, sub.id, false);
  return "failed";
}

/**
 * What the Android app shows for an alert: the same title and text as Web
 * Push, where a tap goes on this install, and which install it is.
 */
export function fcmAlert(configured: string | null, payload: NotificationPayload): FcmAlert {
  const origin = configured ?? (payload.url ? safeOrigin(payload.url) : null) ?? "";
  const url = payload.url && origin && safeOrigin(payload.url) === origin ? payload.url : `${origin}/`;
  return {
    title: payload.title,
    body: payload.body,
    url,
    origin,
    tag: payload.incidentId ?? payload.monitorId,
  };
}

function safeOrigin(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}
