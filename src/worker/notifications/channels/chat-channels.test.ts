import { afterEach, describe, expect, it, vi } from "vitest";
import type { NotificationPayload } from "../payload";
import { parseRetryAfter, postJson } from "./http";
import { escapeSlackText, toSlackMessage } from "./slack";
import { toTeamsMessage } from "./teams";
import { escapeTelegramHtml, sendTelegramMessage, toTelegramMessage } from "./telegram";
import { mergeChannelSecrets, redactChannelConfig, secretFieldsFor } from "../../db/channels";

const HOSTILE = `<!channel> <https://evil.example|click> & <b>bold</b> "quoted" [x](https://evil.example)`;

function payload(over: Partial<NotificationPayload> = {}): NotificationPayload {
  return {
    event: "down",
    monitorId: "m1",
    monitorName: "Checkout",
    state: "down",
    title: "🔴 Checkout is down",
    body: "Checkout is down (HTTP 503).",
    url: "https://status.example.com/monitors/m1",
    statusCode: 503,
    error: "HTTP 503",
    detectedAt: Date.UTC(2026, 9, 28, 12, 0, 0),
    ...over,
  };
}

const ALL_EVENTS: Array<[NotificationPayload["event"], string]> = [
  ["down", "#ef4757"],
  ["heartbeat_missed", "#ef4757"],
  ["flapping", "#f5a524"],
  ["maintenance_start", "#f5a524"],
  ["recovered", "#2fbf6e"],
  ["maintenance_end", "#2fbf6e"],
  ["test", "#2fbf6e"],
];

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Slack message", () => {
  it("renders a coloured Block Kit attachment with the facts and an incident link", () => {
    const msg = toSlackMessage(payload());
    expect(msg.text).toBe("🔴 Checkout is down: Checkout is down (HTTP 503).");
    const [att] = msg.attachments;
    expect(att!.color).toBe("#ef4757");
    expect(att!.blocks[0]).toEqual({ type: "header", text: { type: "plain_text", text: "🔴 Checkout is down", emoji: true } });
    expect(att!.blocks[2]).toEqual({
      type: "section",
      fields: [
        { type: "mrkdwn", text: "*HTTP status*\n503" },
        { type: "mrkdwn", text: "*Error*\nHTTP 503" },
      ],
    });
    expect(JSON.stringify(att!.blocks[3])).toContain(`<!date^${Date.UTC(2026, 9, 28, 12) / 1000}^`);
    expect(att!.blocks.at(-1)).toMatchObject({
      type: "actions",
      elements: [{ type: "button", text: { text: "View incident" }, url: "https://status.example.com/monitors/m1" }],
    });
  });

  it.each(ALL_EVENTS)("colours %s as %s", (event, color) => {
    expect(toSlackMessage(payload({ event })).attachments[0]!.color).toBe(color);
  });

  it("escapes mrkdwn control characters so untrusted text can't ping or link", () => {
    expect(escapeSlackText(HOSTILE)).not.toMatch(/[<>]/);
    const msg = JSON.stringify(toSlackMessage(payload({ body: HOSTILE, error: HOSTILE })));
    expect(msg).not.toContain("<!channel>");
    expect(msg).not.toContain("<https://evil.example|");
    expect(msg).toContain("&lt;!channel&gt;");
  });

  it("stays inside Block Kit's length limits", () => {
    const long = "x".repeat(10_000);
    const [att] = toSlackMessage(payload({ title: long, body: long, error: long })).attachments;
    const header = att!.blocks[0] as { text: { text: string } };
    expect(header.text.text.length).toBe(150);
    expect((att!.blocks[1] as { text: { text: string } }).text.text.length).toBeLessThanOrEqual(3000);
  });

  it("omits the button and facts when there is nothing to show", () => {
    const [att] = toSlackMessage(payload({ url: undefined, statusCode: null, error: null })).attachments;
    expect(att!.blocks.map((b) => b.type)).toEqual(["header", "section", "context"]);
  });
});

describe("Teams Adaptive Card", () => {
  it("wraps an Adaptive Card in the Workflows message envelope", () => {
    const msg = toTeamsMessage(payload());
    expect(msg.type).toBe("message");
    const [att] = msg.attachments;
    expect(att).toMatchObject({ contentType: "application/vnd.microsoft.card.adaptive", contentUrl: null });
    const card = att!.content;
    expect(card).toMatchObject({ type: "AdaptiveCard", version: "1.4" });
    expect(card.body[0]).toMatchObject({ type: "Container", style: "attention" });
    expect(card.actions).toEqual([{ type: "Action.OpenUrl", title: "View incident", url: "https://status.example.com/monitors/m1" }]);
    const text = JSON.stringify(card.body);
    expect(text).toContain("HTTP status: ");
    expect(text).toContain("Detected: ");
  });

  it.each([
    ["recovered", "good"],
    ["flapping", "warning"],
    ["heartbeat_missed", "attention"],
    ["test", "good"],
  ] as const)("styles %s as %s", (event, style) => {
    expect(toTeamsMessage(payload({ event })).attachments[0]!.content.body[0]).toMatchObject({ style });
  });

  it("puts untrusted text only in TextRuns, which Teams never parses as Markdown", () => {
    const card = toTeamsMessage(payload({ body: HOSTILE, error: HOSTILE, title: HOSTILE })).attachments[0]!.content;
    const json = JSON.stringify(card);
    expect(json).not.toContain('"TextBlock"');
    expect(json).not.toContain('"FactSet"');
  });

  it("labels the test event's link as opening OpenPing", () => {
    expect(toTeamsMessage(payload({ event: "test" })).attachments[0]!.content.actions![0]!.title).toBe("Open OpenPing");
  });
});

describe("Telegram message", () => {
  it("escapes the four HTML entities Telegram knows", () => {
    expect(escapeTelegramHtml(`<a href="x">&</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;");
  });

  it("builds an HTML message with bold title, facts and a link", () => {
    const msg = toTelegramMessage("-100123", payload());
    expect(msg).toMatchObject({ chat_id: "-100123", parse_mode: "HTML", link_preview_options: { is_disabled: true } });
    expect(msg.text).toBe(
      [
        "<b>🔴 Checkout is down</b>",
        "Checkout is down (HTTP 503).",
        "",
        "<b>HTTP status:</b> 503",
        "<b>Error:</b> HTTP 503",
        "<b>Detected:</b> Wed, 28 Oct 2026 12:00:00 GMT",
        "",
        '<a href="https://status.example.com/monitors/m1">View incident</a>',
      ].join("\n"),
    );
  });

  it("never lets untrusted text open a tag", () => {
    const msg = toTelegramMessage("1", payload({ title: HOSTILE, body: HOSTILE, error: HOSTILE }));
    const tags = msg.text.match(/<[^>]*>/g) ?? [];
    expect(new Set(tags)).toEqual(new Set(["<b>", "</b>", '<a href="https://status.example.com/monitors/m1">', "</a>"]));
  });

  it("keeps an over-long error under Telegram's 4096 character limit", () => {
    const msg = toTelegramMessage("1", payload({ body: "&".repeat(5000), error: "<".repeat(5000) }));
    // Entities count as one character each once Telegram parses them.
    const parsed = msg.text.replace(/<[^>]+>/g, "").replace(/&(amp|lt|gt|quot);/g, "_");
    expect(parsed.length).toBeLessThan(4096);
  });
});

describe("delivery and rate limits", () => {
  it("parses Retry-After seconds and dates", () => {
    expect(parseRetryAfter("30")).toBe(30_000);
    expect(parseRetryAfter("1.5")).toBe(1_500);
    const now = Date.UTC(2026, 9, 28, 12);
    expect(parseRetryAfter("Wed, 28 Oct 2026 12:02:00 GMT", now)).toBe(120_000);
    for (const bad of [null, "", "soon", "0", "-4"]) expect(parseRetryAfter(bad)).toBeUndefined();
  });

  it("maps a Slack 429 to a retryable failure with the provider's delay", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("rate_limited", { status: 429, headers: { "Retry-After": "7" } }),
    );
    expect(await postJson("https://hooks.slack.com/services/a/b/c", {}, "slack_error")).toEqual({
      ok: false,
      status: 429,
      error: "slack_error: rate_limited",
      retryAfterMs: 7_000,
    });
  });

  it("never stores a webhook URL echoed back in an error", async () => {
    const url = `https://hooks.slack.com/services/a/b/${crypto.randomUUID()}`;
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(`${"x".repeat(190)} ${url}`, { status: 400 }));
    const result = await postJson(url, {}, "slack_error");
    // Redacted before the 200-character cut, so not even a prefix survives.
    expect(result.error).not.toContain("https://");
    expect(result.error).toContain("[webhook");
  });

  it("maps a network failure without leaking the request", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("fetch failed for https://secret.example"));
    expect(await postJson("https://hooks.slack.com/services/a/b/c", {}, "slack_error")).toEqual({
      ok: false,
      error: "network_error",
    });
  });

  it("reads Telegram's retry_after and never echoes the bot token", async () => {
    const token = `123456:${crypto.randomUUID().replaceAll("-", "")}`;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json(
        { ok: false, error_code: 429, description: `Too Many Requests: retry after 31 (${token})`, parameters: { retry_after: 31 } },
        { status: 429 },
      ),
    );
    const result = await sendTelegramMessage(token, toTelegramMessage("1", payload()));
    expect(fetchMock.mock.calls[0]![0]).toBe(`https://api.telegram.org/bot${token}/sendMessage`);
    expect(result).toMatchObject({ ok: false, status: 429, retryAfterMs: 31_000 });
    expect(result.error).toContain("telegram_error: Too Many Requests");
    expect(result.error).not.toContain(token);
  });

  it("reports a Telegram group that moved to a new chat id", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json(
        { ok: false, error_code: 400, description: "Bad Request: group chat was upgraded to a supergroup chat", parameters: { migrate_to_chat_id: -1009 } },
        { status: 400 },
      ),
    );
    const result = await sendTelegramMessage(`1:${"a".repeat(30)}`, toTelegramMessage("1", payload()));
    expect(result.error).toContain("now chat id -1009");
    expect(result.retryAfterMs).toBeUndefined();
  });

  it("treats Telegram's ok response as delivered", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ ok: true, result: {} }));
    expect(await sendTelegramMessage(`1:${"a".repeat(30)}`, toTelegramMessage("1", payload()))).toEqual({ ok: true, status: 200 });
  });
});

describe("secret handling", () => {
  it("marks every capability as secret", () => {
    expect(secretFieldsFor("slack")).toEqual(["url"]);
    expect(secretFieldsFor("teams")).toEqual(["url"]);
    expect(secretFieldsFor("telegram")).toEqual(["botToken"]);
  });

  it("redacts the bot token but keeps the chat id", () => {
    const botToken = `1:${crypto.randomUUID()}`;
    expect(redactChannelConfig("telegram", { botToken, chatId: "-100" })).toEqual({ botToken: "", chatId: "-100" });
    expect(redactChannelConfig("slack", { url: "https://hooks.slack.com/services/a/b/c" })).toEqual({ url: "" });
    expect(redactChannelConfig("teams", { url: "https://x.logic.azure.com/workflows/a" })).toEqual({ url: "" });
  });

  it("keeps the stored bot token when the form resubmits it blank", () => {
    const botToken = `1:${crypto.randomUUID()}`;
    expect(mergeChannelSecrets("telegram", { botToken: "", chatId: "-200" }, { botToken, chatId: "-100" })).toEqual({
      botToken,
      chatId: "-200",
    });
  });
});
