import type { Env } from "../types";
import type { ChannelRecord } from "../db/channels";
import { getChannel, recordChannelResult, secretFieldsFor } from "../db/channels";
import { getSubscription, recordPushResult } from "../db/push";
import { claimDue, markSent, markFailed, type OutboxEntry } from "../db/outbox";
import { getSetting } from "../db/settings";
import { sendResendEmail } from "./channels/resend";
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
import {
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
const DEFAULT_FROM = "OpenPing <onboarding@resend.dev>";

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
        cfg.from || (await (emailFrom ? emailFrom() : getSetting(env, "email_from"))) || DEFAULT_FROM;
      return sendResendEmail(env, {
        from,
        to: cfg.to,
        subject: payload.title,
        html: toEmailHtml(payload),
        text: toEmailText(payload),
      });
    }
    default:
      return { ok: false, error: "unsupported_channel" };
  }
}

/** How many deliveries one pass takes for a requested limit (0 to BATCH). */
export function outboxTake(limit: number = BATCH): number {
  return Math.min(BATCH, Math.max(0, Math.floor(limit)));
}

/**
 * What one pass reads once and reuses for every entry: each channel, the VAPID
 * keys and the `email_from` setting. Undefined means not read yet.
 */
export interface DeliveryCache {
  channels: Map<string, ChannelRecord | null>;
  vapid: VapidKeys | null | undefined;
  emailFrom: string | null | undefined;
}

export function newDeliveryCache(): DeliveryCache {
  return { channels: new Map(), vapid: undefined, emailFrom: undefined };
}

/**
 * The most D1 queries delivering `entry` can make, given what the pass has
 * already read (lib/budget.ts uses it so a run never overruns its plan):
 *
 * - a Web Push device: the subscription, the VAPID keys (once per pass),
 *   marking the entry sent or failed, and the device's result;
 * - a channel: the channel (once per channel per pass), `email_from` (once per
 *   pass, email only), marking the entry, and the channel's result;
 * - a payload that can't be read: only marking it failed;
 * - plus one in every case for marking it failed if delivery throws.
 */
export function deliveryD1Cost(entry: OutboxEntry, cache: DeliveryCache): number {
  if (entry.payloadError || !isNotificationPayload(entry.payload)) return 1;
  if (entry.channelType === "push") return 3 + (cache.vapid === undefined ? 1 : 0) + 1;
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
  const vapid = async () => {
    if (cache.vapid === undefined) cache.vapid = await getVapid(env);
    return cache.vapid;
  };
  const channelById = async (id: string) => {
    if (!cache.channels.has(id)) cache.channels.set(id, await getChannel(env, id));
    return cache.channels.get(id) ?? null;
  };

  for (const entry of due) {
    if (opts.canSpend && !opts.canSpend(deliveryD1Cost(entry, cache))) {
      console.log(`[dispatcher] out of budget; ${due.length - processed} deliveries wait for the next run`);
      break;
    }
    processed++;
    try {
      // Never send ciphertext or malformed legacy data to an external provider.
      // Keep the row in the normal bounded retry flow so operators can see the
      // failure without one corrupt row blocking every other due delivery.
      if (entry.payloadError) {
        await markFailed(
          env,
          entry.id,
          entry.attempts + 1,
          entry.payloadError,
          MAX_ATTEMPTS,
        );
        failed++;
        continue;
      }
      if (!isNotificationPayload(entry.payload)) {
        await markFailed(
          env,
          entry.id,
          entry.attempts + 1,
          "payload_invalid_shape",
          MAX_ATTEMPTS,
        );
        failed++;
        continue;
      }

      // Web Push entries target a device subscription, not a channel.
      if (entry.channelType === "push") {
        const r = await deliverPush(
          env,
          entry.id,
          entry.target,
          entry.attempts,
          entry.payload,
          vapid,
        );
        if (r === "sent") sent++;
        else if (r === "failed") failed++;
        // "pruned" (subscription gone/expired) is neither a send nor a failure.
        continue;
      }

      const channel = entry.channelId ? await channelById(entry.channelId) : null;
      if (!channel || !channel.enabled) {
        // Channel removed/disabled - drop the entry as dead.
        await markFailed(env, entry.id, MAX_ATTEMPTS, "channel_unavailable", MAX_ATTEMPTS);
        failed++;
        continue;
      }
      const result = await deliverToChannel(env, channel, entry.payload, emailFrom);
      if (result.ok) {
        await markSent(env, entry.id);
        // Bookkeeping only - must never reach the outer catch (which would
        // re-mark this already-sent entry failed and re-deliver it).
        try {
          await recordChannelResult(env, channel.id, true);
        } catch (e) {
          console.error("[dispatcher] recordChannelResult failed", e);
        }
        sent++;
      } else {
        await markFailed(
          env,
          entry.id,
          entry.attempts + 1,
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
        entry.id,
        entry.attempts + 1,
        e instanceof Error ? e.message : "exception",
        MAX_ATTEMPTS,
      ).catch(() => {});
    }
  }

  return { processed, sent, failed };
}

type PushOutcome = "sent" | "failed" | "pruned";

/** Deliver one push outbox entry. "pruned" = the subscription is simply gone. */
async function deliverPush(
  env: Env,
  entryId: string,
  subscriptionId: string | null,
  attempts: number,
  payload: NotificationPayload,
  loadVapid: () => Promise<VapidKeys | null>,
): Promise<PushOutcome> {
  let sub: Awaited<ReturnType<typeof getSubscription>>;
  try {
    sub = subscriptionId ? await getSubscription(env, subscriptionId) : null;
  } catch (e) {
    // Its endpoint or keys can't be decrypted (for example the MASTER_KEY that
    // sealed them is gone): retrying can never succeed, so stop now.
    if (!(e instanceof DecryptError)) throw e;
    await markFailed(env, entryId, MAX_ATTEMPTS, "subscription_unreadable", MAX_ATTEMPTS);
    return "failed";
  }
  if (!sub || sub.disabled) {
    await markFailed(env, entryId, MAX_ATTEMPTS, "subscription_gone", MAX_ATTEMPTS);
    return "pruned";
  }
  const vapid = await loadVapid();
  if (!vapid) {
    await markFailed(env, entryId, MAX_ATTEMPTS, "vapid_not_configured", MAX_ATTEMPTS);
    return "failed";
  }
  const result = await sendWebPush({
    subscription: { endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth },
    payload: JSON.stringify({ title: payload.title, body: payload.body, url: payload.url }),
    vapid,
  });
  if (result.ok) {
    await markSent(env, entryId);
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
    await markSent(env, entryId);
    return "pruned";
  }
  await markFailed(env, entryId, attempts + 1, result.error ?? "push_failed", MAX_ATTEMPTS);
  await recordPushResult(env, sub.id, false);
  return "failed";
}
