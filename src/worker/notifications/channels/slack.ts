/**
 * Slack incoming-webhook alerts. Builds a Block Kit message inside a coloured
 * attachment (Block Kit itself has no accent colour) and POSTs it to the
 * channel's webhook URL. Pure delivery: no DB access, no retry loop.
 *
 * Slack answers 200 `ok` on success and a short plain-text code on failure
 * (`invalid_payload`, `no_service`, `channel_is_archived`). It rate-limits
 * incoming webhooks to about one message per second and returns 429 with a
 * `Retry-After` header, which the outbox honours.
 * https://api.slack.com/messaging/webhooks, https://api.slack.com/apis/rate-limits
 */

import type { NotificationPayload } from "../payload";
import { EVENT_PILL, emailButtonLabel, eventColorState, metaLines } from "../payload";
import { stateColor } from "./discord";
import { postJson, truncate, type SendResult } from "./http";

// Block Kit limits (https://api.slack.com/reference/block-kit/blocks).
const HEADER_MAX = 150;
const SECTION_TEXT_MAX = 3000;
const FIELD_TEXT_MAX = 2000;
const FALLBACK_TEXT_MAX = 3000;

/**
 * Escape the three characters Slack's mrkdwn treats as control characters, so
 * an attacker-influenced string (a remote error body, a monitor name) can't
 * inject links, `<!channel>` mentions or user pings.
 * https://api.slack.com/reference/surfaces/formatting#escaping
 */
export function escapeSlackText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

type Text = { type: "plain_text" | "mrkdwn"; text: string; emoji?: boolean };
export type SlackBlock =
  | { type: "header"; text: Text }
  | { type: "section"; text?: Text; fields?: Text[] }
  | { type: "context"; elements: Text[] }
  | { type: "actions"; elements: Array<{ type: "button"; text: Text; url: string; action_id: string }> };

export interface SlackMessage {
  /** Notification and screen-reader fallback; Slack requires it alongside blocks. */
  text: string;
  attachments: Array<{ color: string; blocks: SlackBlock[] }>;
}

const hex = (n: number) => `#${n.toString(16).padStart(6, "0")}`;

export function toSlackMessage(p: NotificationPayload): SlackMessage {
  const blocks: SlackBlock[] = [
    // plain_text is never parsed as mrkdwn, so the title needs no escaping.
    { type: "header", text: { type: "plain_text", text: truncate(p.title, HEADER_MAX), emoji: true } },
    {
      type: "section",
      text: { type: "mrkdwn", text: truncate(escapeSlackText(p.body), SECTION_TEXT_MAX) },
    },
  ];

  const facts = metaLines(p).filter(([label]) => label !== "Detected");
  if (facts.length) {
    blocks.push({
      type: "section",
      fields: facts.map(([label, value]) => ({
        type: "mrkdwn",
        text: truncate(`*${label}*\n${escapeSlackText(value)}`, FIELD_TEXT_MAX),
      })),
    });
  }

  // `<!date^...>` renders in each reader's own time zone, with a UTC fallback.
  const seconds = Math.floor(p.detectedAt / 1000);
  const fallback = new Date(p.detectedAt).toUTCString();
  blocks.push({
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: `${EVENT_PILL[p.event]} · Detected <!date^${seconds}^{date_short_pretty} at {time}|${fallback}> · OpenPing`,
      },
    ],
  });

  if (p.url) {
    blocks.push({
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: emailButtonLabel(p.event) },
          url: p.url,
          action_id: "openping_open",
        },
      ],
    });
  }

  return {
    text: truncate(escapeSlackText(`${p.title}: ${p.body}`), FALLBACK_TEXT_MAX),
    attachments: [{ color: hex(stateColor(eventColorState(p.event))), blocks }],
  };
}

export function sendSlackMessage(webhookUrl: string, message: SlackMessage): Promise<SendResult> {
  return postJson(webhookUrl, message, "slack_error");
}
