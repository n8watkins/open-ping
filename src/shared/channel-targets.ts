/**
 * Destination validation for the chat-app alert channels (Slack, Microsoft
 * Teams, Telegram). Shared by the API (create/update validation), the
 * dispatcher (checked again before every delivery, so a stored or hand-edited
 * config can never send a capability somewhere else) and the Integrations form.
 *
 * Each provider only accepts its own hosts, so these channels can never be
 * pointed at an arbitrary server: anything else belongs in a generic webhook.
 * The allowed patterns, with sources, are documented in docs/ALERT_CHANNELS.md.
 */

export type TargetCheck = { ok: true } | { ok: false; reason: string };

/** Slack incoming webhooks (commercial Slack and GovSlack). */
export const SLACK_WEBHOOK_HOSTS: readonly string[] = ["hooks.slack.com", "hooks.slack-gov.com"];

/**
 * Microsoft Teams Workflows ("When a Teams webhook request is received")
 * trigger hosts. Power Automate moved these to `<environment>.environment.api.
 * powerplatform.com` in 2025; flows on Azure Logic Apps keep `*.logic.azure.com`.
 * Checked on 2026-10-28 against Microsoft Learn (see docs/ALERT_CHANNELS.md).
 */
export const TEAMS_WEBHOOK_HOST_SUFFIXES: readonly string[] = [
  ".environment.api.powerplatform.com",
  ".logic.azure.com",
];

const MAX_URL = 2048;

/** Common rules: an https URL on the default port, without embedded credentials. */
function parseHttps(raw: string): URL | TargetCheck {
  if (raw.length > MAX_URL) return { ok: false, reason: "too_long" };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "invalid_url" };
  }
  if (url.protocol !== "https:") return { ok: false, reason: "not_https" };
  if (url.username || url.password) return { ok: false, reason: "embedded_credentials" };
  if (url.port && url.port !== "443") return { ok: false, reason: "bad_port" };
  return url;
}

/** `https://hooks.slack.com/services/T.../B.../...` (an incoming webhook). */
export function checkSlackWebhookUrl(raw: string): TargetCheck {
  const url = parseHttps(raw);
  if (!(url instanceof URL)) return url;
  if (!SLACK_WEBHOOK_HOSTS.includes(url.hostname)) return { ok: false, reason: "not_slack_host" };
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts[0] !== "services" || parts.length < 4) return { ok: false, reason: "not_slack_webhook" };
  return { ok: true };
}

/**
 * A Teams Workflows webhook: a Microsoft-hosted trigger host and a path that
 * names the workflow (`.../workflows/<id>/triggers/manual/paths/invoke`, with
 * or without the newer `/powerautomate/automations/direct[/cu/NN]` prefix).
 */
export function checkTeamsWebhookUrl(raw: string): TargetCheck {
  const url = parseHttps(raw);
  if (!(url instanceof URL)) return url;
  const host = url.hostname;
  const allowed = TEAMS_WEBHOOK_HOST_SUFFIXES.some(
    (suffix) => host.endsWith(suffix) && host.length > suffix.length,
  );
  if (!allowed) return { ok: false, reason: "not_teams_host" };
  if (!url.pathname.includes("/workflows/")) return { ok: false, reason: "not_teams_workflow" };
  return { ok: true };
}

/** `<bot id>:<secret>`, as BotFather prints it. */
export const TELEGRAM_BOT_TOKEN_RE = /^[0-9]{1,20}:[A-Za-z0-9_-]{20,100}$/;

/** A numeric chat id (groups and channels are negative) or a public `@channelname`. */
export const TELEGRAM_CHAT_ID_RE = /^(-?[0-9]{1,20}|@[A-Za-z][A-Za-z0-9_]{3,31})$/;

export function checkTelegramBotToken(raw: string): TargetCheck {
  return TELEGRAM_BOT_TOKEN_RE.test(raw) ? { ok: true } : { ok: false, reason: "invalid_bot_token" };
}

export function checkTelegramChatId(raw: string): TargetCheck {
  return TELEGRAM_CHAT_ID_RE.test(raw) ? { ok: true } : { ok: false, reason: "invalid_chat_id" };
}

/** Plain-language messages for the reasons above (API issues and the form). */
export const TARGET_REASON_MESSAGES: Record<string, string> = {
  too_long: "The URL is too long.",
  invalid_url: "Enter a full URL starting with https://.",
  not_https: "The URL must start with https://.",
  embedded_credentials: "The URL must not contain a user name or password.",
  bad_port: "The URL must use the standard https port.",
  not_slack_host: "A Slack webhook URL starts with https://hooks.slack.com/services/.",
  not_slack_webhook: "A Slack webhook URL looks like https://hooks.slack.com/services/T000/B000/XXXX.",
  not_teams_host:
    "A Teams Workflows URL is on environment.api.powerplatform.com (or logic.azure.com for Azure Logic Apps).",
  not_teams_workflow: "Copy the full URL from the workflow's \"When a Teams webhook request is received\" trigger.",
  invalid_bot_token: "A bot token looks like 123456789:AA... (copy it from BotFather).",
  invalid_chat_id: "A chat id is a number such as -1001234567890, or a public @channelname.",
};

export function targetMessage(check: TargetCheck): string | null {
  return check.ok ? null : (TARGET_REASON_MESSAGES[check.reason] ?? check.reason);
}
