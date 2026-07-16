import type { Env } from "../types";
import type { ChannelRecord } from "../db/channels";
import { getChannel, recordChannelResult } from "../db/channels";
import { getSubscription, recordPushResult } from "../db/push";
import { claimDue, markSent, markFailed } from "../db/outbox";
import { getSetting } from "../db/settings";
import { sendResendEmail } from "./channels/resend";
import { sendDiscordMessage } from "./channels/discord";
import { sendWebhook } from "./channels/webhook";
import { sendWebPush } from "./push/webpush";
import { getVapid } from "./push/vapid";
import {
  isNotificationPayload,
  toEmailHtml,
  toEmailText,
  toDiscordEmbed,
  type NotificationPayload,
} from "./payload";
import { assertSafeUrl } from "../lib/ssrf";

const MAX_ATTEMPTS = 5;
const BATCH = 25;
const DEFAULT_FROM = "OpenPing <onboarding@resend.dev>";

interface SendResult {
  ok: boolean;
  status?: number;
  error?: string;
}

/** Deliver one payload to one channel via the appropriate provider. */
export async function deliverToChannel(
  env: Env,
  channel: ChannelRecord,
  payload: NotificationPayload,
): Promise<SendResult> {
  const cfg = channel.config as Record<string, string | undefined>;
  switch (channel.type) {
    case "discord": {
      if (!cfg.url) return { ok: false, error: "missing_webhook_url" };
      const safe = assertSafeUrl(cfg.url);
      if (!safe.ok) return { ok: false, error: `unsafe_url: ${safe.reason}` };
      return sendDiscordMessage(cfg.url, { embeds: [toDiscordEmbed(payload)] });
    }
    case "webhook": {
      if (!cfg.url) return { ok: false, error: "missing_url" };
      // Same SSRF guard the monitor checks use — a channel URL could otherwise
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
        cfg.from || (await getSetting(env, "email_from")) || DEFAULT_FROM;
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

/**
 * Process due outbox entries (PRD §12 outbox): deliver each independently,
 * record success/failure, retry transient failures with backoff, stop at max.
 * Never throws — a provider failure must not break the monitoring cycle.
 */
export async function processOutbox(
  env: Env,
  now: number = Date.now(),
): Promise<{ processed: number; sent: number; failed: number }> {
  let due;
  try {
    due = await claimDue(env, now, BATCH);
  } catch (e) {
    console.error("[dispatcher] claimDue failed", e);
    return { processed: 0, sent: 0, failed: 0 };
  }

  let sent = 0;
  let failed = 0;

  for (const entry of due) {
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
        );
        if (r === "sent") sent++;
        else if (r === "failed") failed++;
        // "pruned" (subscription gone/expired) is neither a send nor a failure.
        continue;
      }

      const channel = entry.channelId ? await getChannel(env, entry.channelId) : null;
      if (!channel || !channel.enabled) {
        // Channel removed/disabled — drop the entry as dead.
        await markFailed(env, entry.id, MAX_ATTEMPTS, "channel_unavailable", MAX_ATTEMPTS);
        failed++;
        continue;
      }
      const result = await deliverToChannel(env, channel, entry.payload);
      if (result.ok) {
        await markSent(env, entry.id);
        // Bookkeeping only — must never reach the outer catch (which would
        // re-mark this already-sent entry failed and re-deliver it).
        try {
          await recordChannelResult(env, channel.id, true);
        } catch (e) {
          console.error("[dispatcher] recordChannelResult failed", e);
        }
        sent++;
      } else {
        await markFailed(env, entry.id, entry.attempts + 1, result.error ?? "send_failed", MAX_ATTEMPTS);
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

  return { processed: due.length, sent, failed };
}

type PushOutcome = "sent" | "failed" | "pruned";

/** Deliver one push outbox entry. "pruned" = the subscription is simply gone. */
async function deliverPush(
  env: Env,
  entryId: string,
  subscriptionId: string | null,
  attempts: number,
  payload: NotificationPayload,
): Promise<PushOutcome> {
  const sub = subscriptionId ? await getSubscription(env, subscriptionId) : null;
  if (!sub || sub.disabled) {
    await markFailed(env, entryId, MAX_ATTEMPTS, "subscription_gone", MAX_ATTEMPTS);
    return "pruned";
  }
  const vapid = await getVapid(env);
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
    // Bookkeeping only — isolate so a failure here can't reach the caller's
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
