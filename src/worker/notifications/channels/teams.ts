/**
 * Microsoft Teams alerts through a Workflows (Power Automate) webhook, the
 * replacement for the retired Office 365 connectors. Posts an Adaptive Card in
 * the `message` envelope that the "When a Teams webhook request is received"
 * trigger expects. Pure delivery: no DB access, no retry loop.
 *
 * The trigger answers 202 Accepted. Throttling returns 429 with `Retry-After`,
 * which the outbox honours.
 * https://learn.microsoft.com/en-us/connectors/teams/#microsoft-teams-webhook
 */

import type { NotificationPayload } from "../payload";
import { emailButtonLabel, eventColorState, metaLines } from "../payload";
import { postJson, truncate, type SendResult } from "./http";

const TITLE_MAX = 256;
const BODY_MAX = 4000;
const VALUE_MAX = 1000;

/**
 * A `TextRun` inside a `RichTextBlock` is shown verbatim: unlike `TextBlock`
 * and `FactSet` it is never parsed as Markdown, so an attacker-influenced
 * string (a remote error body, a monitor name) can't inject links or styling.
 */
interface TextRun {
  type: "TextRun";
  text: string;
  weight?: "Bolder";
  size?: "Medium" | "Large";
  color?: "Good" | "Attention" | "Warning";
  isSubtle?: boolean;
}

type CardElement =
  | { type: "RichTextBlock"; inlines: TextRun[]; spacing?: "Small" | "Medium" }
  | {
      type: "Container";
      style: "good" | "attention" | "warning";
      bleed: true;
      items: CardElement[];
    };

export interface AdaptiveCard {
  $schema: string;
  type: "AdaptiveCard";
  version: string;
  msteams: { width: "Full" };
  body: CardElement[];
  actions?: Array<{ type: "Action.OpenUrl"; title: string; url: string }>;
}

export interface TeamsMessage {
  type: "message";
  attachments: Array<{
    contentType: "application/vnd.microsoft.card.adaptive";
    contentUrl: null;
    content: AdaptiveCard;
  }>;
}

/** Card accent for an event: the same green, amber and red as the other channels. */
function cardStyle(p: NotificationPayload): "good" | "attention" | "warning" {
  const state = eventColorState(p.event);
  return state === "up" ? "good" : state === "degraded" ? "warning" : "attention";
}

const run = (text: string, extra: Partial<TextRun> = {}): TextRun => ({ type: "TextRun", text, ...extra });

export function toTeamsMessage(p: NotificationPayload): TeamsMessage {
  const style = cardStyle(p);
  const body: CardElement[] = [
    {
      type: "Container",
      style,
      bleed: true,
      items: [
        { type: "RichTextBlock", inlines: [run(truncate(p.title, TITLE_MAX), { weight: "Bolder", size: "Medium" })] },
      ],
    },
    { type: "RichTextBlock", spacing: "Medium", inlines: [run(truncate(p.body, BODY_MAX))] },
  ];
  for (const [label, value] of metaLines(p)) {
    body.push({
      type: "RichTextBlock",
      spacing: "Small",
      inlines: [run(`${label}: `, { weight: "Bolder" }), run(truncate(value, VALUE_MAX))],
    });
  }

  const card: AdaptiveCard = {
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    type: "AdaptiveCard",
    // 1.4 renders everywhere Teams does (desktop, web and mobile).
    version: "1.4",
    msteams: { width: "Full" },
    body,
  };
  if (p.url) card.actions = [{ type: "Action.OpenUrl", title: emailButtonLabel(p.event), url: p.url }];

  return {
    type: "message",
    attachments: [{ contentType: "application/vnd.microsoft.card.adaptive", contentUrl: null, content: card }],
  };
}

export function sendTeamsMessage(webhookUrl: string, message: TeamsMessage): Promise<SendResult> {
  return postJson(webhookUrl, message, "teams_error");
}
