import { describe, expect, it } from "vitest";
import {
  buildCertExpiringPayload,
  buildIncidentPayload,
  buildIncidentUpdatePayload,
  isNotificationPayload,
  metaLines,
  toDiscordEmbed,
  toEmailHtml,
  toEmailText,
  type NotificationPayload,
} from "./payload";
import { toSlackMessage } from "./channels/slack";
import { toTeamsMessage } from "./channels/teams";
import { toTelegramMessage } from "./channels/telegram";
import { channelWantsEvent, CHANNEL_KINDS } from "../../shared/notifications";
import type { IncidentUpdateStatus } from "../../shared/incident-updates";
import type { MonitorRecord } from "../db/monitors";
import type { IncidentRecord } from "../db/incidents";

const POSTED = Date.UTC(2026, 9, 28, 14, 5, 0);
const MONITOR = { id: "mon_1", name: "Checkout API" };
const INCIDENT = {
  id: "inc_1",
  status: "open" as const,
  httpStatus: 503,
  error: "HTTP 503",
  durationSeconds: null,
};

function updatePayload(status: IncidentUpdateStatus = "identified", message = "A bad deploy; rolling it back."): NotificationPayload {
  return buildIncidentUpdatePayload(
    MONITOR,
    INCIDENT,
    { id: "iup_1", status, message, postedAt: POSTED },
    "https://status.example.com/",
  );
}

describe("incident update payload", () => {
  it("carries the update, links to the incident and follows the incident's state", () => {
    const p = updatePayload();
    expect(p).toEqual({
      event: "incident_update",
      monitorId: "mon_1",
      monitorName: "Checkout API",
      state: "down",
      title: "📢 Incident update: Checkout API - Identified",
      body: "A bad deploy; rolling it back.",
      url: "https://status.example.com/incidents?incident=inc_1",
      statusCode: 503,
      error: "HTTP 503",
      detectedAt: POSTED,
      durationSeconds: null,
      incidentId: "inc_1",
      update: {
        id: "iup_1",
        status: "identified",
        label: "Identified",
        message: "A bad deploy; rolling it back.",
        postedAt: POSTED,
      },
    });
    expect(isNotificationPayload(p)).toBe(true);
    const resolved = buildIncidentUpdatePayload(MONITOR, { ...INCIDENT, status: "resolved" }, p.update!, undefined);
    expect(resolved.state).toBe("up");
    expect(resolved.url).toBeUndefined();
  });

  it("fails closed on a missing or malformed update, and on an update attached to another event", () => {
    const p = updatePayload();
    expect(isNotificationPayload({ ...p, update: undefined })).toBe(false);
    expect(isNotificationPayload({ ...p, update: { ...p.update, status: "fixed" } })).toBe(false);
    expect(isNotificationPayload({ ...p, update: { ...p.update, postedAt: "now" } })).toBe(false);
    expect(isNotificationPayload({ ...p, update: [p.update] })).toBe(false);
    const down = buildIncidentPayload(
      { ...MONITOR } as MonitorRecord,
      { ...INCIDENT, startedAt: POSTED } as IncidentRecord,
      "down",
    );
    expect(isNotificationPayload(down)).toBe(true);
    expect(isNotificationPayload({ ...down, update: p.update })).toBe(false);
  });

  it("shows the update's status and when it was posted instead of the original error", () => {
    expect(metaLines(updatePayload())).toEqual([
      ["Status", "Identified"],
      ["Posted", new Date(POSTED).toUTCString()],
    ]);
  });

  it("goes to every channel by default except the admin's own push devices", () => {
    for (const kind of CHANNEL_KINDS) {
      expect(channelWantsEvent(kind, "incident_update", null)).toBe(kind !== "push");
    }
    expect(channelWantsEvent("slack", "incident_update", ["down", "recovered"])).toBe(false);
    expect(channelWantsEvent("push", "incident_update", ["incident_update"])).toBe(true);
  });
});

describe("incident update on each channel", () => {
  const COLORS: Array<[IncidentUpdateStatus, string, number]> = [
    ["investigating", "#ef4757", 0xef4757],
    ["identified", "#f5a524", 0xf5a524],
    ["monitoring", "#f5a524", 0xf5a524],
    ["resolved", "#2fbf6e", 0x2fbf6e],
  ];

  it.each(COLORS)("colours %s as %s on Slack and Discord", (status, hex, int) => {
    expect(toSlackMessage(updatePayload(status)).attachments[0]!.color).toBe(hex);
    expect(toDiscordEmbed(updatePayload(status)).color).toBe(int);
  });

  it("Slack: the message, the status pill, the posted time and a View incident button", () => {
    const msg = toSlackMessage(updatePayload());
    const blocks = msg.attachments[0]!.blocks;
    expect(blocks.map((b) => b.type)).toEqual(["header", "section", "section", "context", "actions"]);
    expect(blocks[2]).toEqual({ type: "section", fields: [{ type: "mrkdwn", text: "*Status*\nIdentified" }] });
    const context = JSON.stringify(blocks[3]);
    expect(context).toContain("Identified · Posted <!date^");
    expect(blocks[4]).toMatchObject({
      elements: [{ text: { text: "View incident" }, url: "https://status.example.com/incidents?incident=inc_1" }],
    });
    // The admin's message is escaped like any other untrusted text.
    const hostile = JSON.stringify(toSlackMessage(updatePayload("monitoring", "<!channel> look")));
    expect(hostile).not.toContain("<!channel>");
  });

  it("Teams: the status in the facts and an amber header for Identified", () => {
    const card = toTeamsMessage(updatePayload()).attachments[0]!.content;
    expect(card.body[0]).toMatchObject({ type: "Container", style: "warning" });
    expect(JSON.stringify(card.body)).toContain('"text":"Status: "');
    expect(card.actions).toEqual([
      { type: "Action.OpenUrl", title: "View incident", url: "https://status.example.com/incidents?incident=inc_1" },
    ]);
  });

  it("Telegram: an escaped HTML message with the status and a link", () => {
    const msg = toTelegramMessage("-100123", updatePayload("monitoring", "Fix is out <b>now</b>"));
    expect(msg.text).toContain("<b>📢 Incident update: Checkout API - Monitoring</b>");
    expect(msg.text).toContain("Fix is out &lt;b&gt;now&lt;/b&gt;");
    expect(msg.text).toContain("<b>Status:</b> Monitoring");
    expect(msg.text).toContain("<b>Posted:</b> ");
    expect(msg.text).not.toContain("HTTP 503");
  });

  it("Discord: the status as a field, not the original error", () => {
    const embed = toDiscordEmbed(updatePayload());
    expect(embed.fields).toEqual([{ name: "Status", value: "Identified", inline: true }]);
    expect(embed.timestamp).toBe(new Date(POSTED).toISOString());
  });

  it("Email: the status pill, the message with its line breaks and the posted time", () => {
    const p = updatePayload("resolved", "Back to normal.\nA write-up <soon>.");
    const html = toEmailHtml(p);
    expect(html).toContain("Resolved");
    expect(html).toContain("white-space:pre-line");
    expect(html).toContain("Back to normal.\nA write-up &lt;soon&gt;.</p>");
    const text = toEmailText(p);
    expect(text).toContain("Incident update: Checkout API - Resolved");
    expect(text).toContain("Status: Resolved");
    expect(text).toContain("Posted: ");
    expect(text).toContain("https://status.example.com/incidents?incident=inc_1");
  });
});

describe("buildCertExpiringPayload", () => {
  const warning = { daysUntil: 14, validTo: Date.UTC(2026, 10, 11, 23, 59, 59), host: "example.com" };
  const p = buildCertExpiringPayload({ id: "mon_c", name: "Shop TLS" }, warning, POSTED, "https://ping.test/");

  it("says when the certificate expires, links the monitor and validates", () => {
    expect(p).toMatchObject({
      event: "cert_expiring",
      state: "up",
      title: "🟠 Shop TLS: certificate expires in 14 days",
      url: "https://ping.test/monitors/mon_c",
      detectedAt: POSTED,
    });
    expect(p.body).toBe(
      "The SSL certificate for example.com expires in 14 days, on Wed, 11 Nov 2026. Renew it before then, or visitors will see a security warning.",
    );
    expect(isNotificationPayload(p)).toBe(true);
  });

  it("renders amber on every channel, with a View monitor button", () => {
    expect(toEmailHtml(p)).toContain("View monitor");
    expect(toEmailText(p)).toContain("expires in 14 days");
    expect(toDiscordEmbed(p).title).toContain("certificate expires");
    expect(toSlackMessage(p)).toBeTruthy();
    expect(toTeamsMessage(p)).toBeTruthy();
    expect(toTelegramMessage("42", p).text).toContain("View monitor");
  });

  it("goes to every channel kind by default", () => {
    for (const kind of CHANNEL_KINDS) expect(channelWantsEvent(kind, "cert_expiring", null)).toBe(true);
  });

  it("says tomorrow and today", () => {
    expect(buildCertExpiringPayload(MONITOR, { ...warning, daysUntil: 1 }, POSTED).title).toContain("expires tomorrow");
    expect(buildCertExpiringPayload(MONITOR, { ...warning, daysUntil: 0 }, POSTED).title).toContain("expires today");
  });
});
