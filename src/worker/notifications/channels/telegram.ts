/**
 * Telegram alerts through the Bot API's `sendMessage`, formatted with
 * `parse_mode: "HTML"`. Pure delivery: no DB access, no retry loop.
 *
 * The bot token is a full credential and is part of the request URL, so it is
 * never written into an error, a log line or a response. Telegram answers
 * `{ ok: false, error_code, description, parameters: { retry_after } }` on
 * failure; a 429's `retry_after` seconds are passed to the outbox.
 * https://core.telegram.org/bots/api#sendmessage, https://core.telegram.org/bots/faq#my-bot-is-hitting-limits-how-do-i-avoid-this
 */

import type { NotificationPayload } from "../payload";
import { emailButtonLabel, metaLines } from "../payload";
import { SEND_TIMEOUT_MS, parseRetryAfter, redactSecret, truncate, type SendResult } from "./http";

export const TELEGRAM_API_ORIGIN = "https://api.telegram.org";

/** Telegram's limit is 4096 characters after entities are parsed; stay well under. */
const TITLE_MAX = 256;
const BODY_MAX = 2000;
const VALUE_MAX = 500;

/**
 * Escape text for Telegram's HTML parse mode. Only `<`, `>`, `&` and `"` have
 * named entities there, and these four are all that is needed: with them
 * escaped, untrusted text can't open a tag or break out of an `href`.
 * https://core.telegram.org/bots/api#html-style
 */
export function escapeTelegramHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export interface TelegramMessage {
  chat_id: string;
  text: string;
  parse_mode: "HTML";
  link_preview_options: { is_disabled: true };
}

export function toTelegramMessage(chatId: string, p: NotificationPayload): TelegramMessage {
  const lines = [
    `<b>${escapeTelegramHtml(truncate(p.title, TITLE_MAX))}</b>`,
    escapeTelegramHtml(truncate(p.body, BODY_MAX)),
    "",
    ...metaLines(p).map(([label, value]) => `<b>${escapeTelegramHtml(label)}:</b> ${escapeTelegramHtml(truncate(value, VALUE_MAX))}`),
  ];
  if (p.url) {
    lines.push("", `<a href="${escapeTelegramHtml(p.url)}">${escapeTelegramHtml(emailButtonLabel(p.event))}</a>`);
  }
  return {
    chat_id: chatId,
    text: lines.join("\n"),
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
  };
}

interface TelegramError {
  ok?: boolean;
  error_code?: number;
  description?: string;
  parameters?: { retry_after?: number; migrate_to_chat_id?: number };
}

export async function sendTelegramMessage(botToken: string, message: TelegramMessage): Promise<SendResult> {
  let res: Response;
  try {
    res = await fetch(`${TELEGRAM_API_ORIGIN}/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
  } catch {
    // Never surface the exception: it can carry the request URL, which holds the token.
    return { ok: false, error: "network_error" };
  }

  let parsed: TelegramError | null;
  try {
    parsed = (await res.json()) as TelegramError;
  } catch {
    parsed = null;
  }
  if (res.ok && parsed?.ok !== false) return { ok: true, status: res.status };

  let error = "telegram_error";
  const description = typeof parsed?.description === "string" ? parsed.description : "";
  if (description) error = `telegram_error: ${description.slice(0, 200)}`;
  const migrated = parsed?.parameters?.migrate_to_chat_id;
  if (typeof migrated === "number") error += ` (the group is now chat id ${migrated})`;

  // Belt and braces: an error never carries the token, even if Telegram echoed it.
  error = redactSecret(error, botToken, "[bot token]");
  const result: SendResult = { ok: false, status: res.status, error };
  const retryAfter = parsed?.parameters?.retry_after;
  if (typeof retryAfter === "number" && Number.isFinite(retryAfter) && retryAfter > 0) {
    result.retryAfterMs = Math.ceil(retryAfter * 1000);
  } else {
    const header = parseRetryAfter(res.headers.get("Retry-After"));
    if (header !== undefined) result.retryAfterMs = header;
  }
  return result;
}
