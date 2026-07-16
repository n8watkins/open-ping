import type { MonitorRecord } from "../db/monitors";
import type { IncidentRecord } from "../db/incidents";
import { NOTIFY_EVENTS, type NotifyEvent } from "../../shared/notifications";
import { stateColor, type DiscordEmbed } from "./channels/discord";
import {
  escapeHtml,
  renderEmailLayout,
  renderEmailText,
  stripLeadingEmoji,
} from "./email-layout";

/** Normalized notification payload carried through the outbox to every channel. */
export interface NotificationPayload {
  event: NotifyEvent;
  monitorId: string;
  monitorName: string;
  state: string;
  title: string;
  body: string;
  url?: string;
  statusCode?: number | null;
  error?: string | null;
  detectedAt: number;
  durationSeconds?: number | null;
  incidentId?: string;
}

const NOTIFY_EVENT_SET = new Set<string>(NOTIFY_EVENTS);

/** Validate untrusted payloads read from the durable notification outbox. */
export function isNotificationPayload(value: unknown): value is NotificationPayload {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const payload = value as Record<string, unknown>;
  if (
    typeof payload.event !== "string" ||
    !NOTIFY_EVENT_SET.has(payload.event) ||
    typeof payload.monitorId !== "string" ||
    typeof payload.monitorName !== "string" ||
    typeof payload.state !== "string" ||
    typeof payload.title !== "string" ||
    typeof payload.body !== "string" ||
    typeof payload.detectedAt !== "number" ||
    !Number.isFinite(payload.detectedAt)
  ) {
    return false;
  }

  const optionalString = (field: string): boolean =>
    payload[field] === undefined || typeof payload[field] === "string";
  const optionalNullableString = (field: string): boolean =>
    payload[field] === undefined ||
    payload[field] === null ||
    typeof payload[field] === "string";
  const optionalNullableNumber = (field: string): boolean =>
    payload[field] === undefined ||
    payload[field] === null ||
    (typeof payload[field] === "number" && Number.isFinite(payload[field]));

  return (
    optionalString("url") &&
    optionalNullableNumber("statusCode") &&
    optionalNullableString("error") &&
    optionalNullableNumber("durationSeconds") &&
    optionalString("incidentId")
  );
}

const EVENT_TITLE: Record<NotifyEvent, (name: string) => string> = {
  down: (n) => `🔴 ${n} is down`,
  recovered: (n) => `🟢 ${n} has recovered`,
  heartbeat_missed: (n) => `🔴 ${n} missed its heartbeat`,
  flapping: (n) => `🟠 ${n} is flapping`,
  degraded: (n) => `🟠 ${n} is degraded`,
  maintenance_start: (n) => `🔧 Maintenance started: ${n}`,
  maintenance_end: (n) => `🔧 Maintenance ended: ${n}`,
  weekly: () => `OpenPing weekly summary`,
  test: (n) => `✅ Test notification: ${n}`,
};

export function buildIncidentPayload(
  monitor: MonitorRecord,
  incident: IncidentRecord | null,
  event: NotifyEvent,
  appUrl?: string,
): NotificationPayload {
  const base = appUrl ? appUrl.replace(/\/$/, "") : undefined;
  const url = base ? `${base}/monitors/${monitor.id}` : undefined;
  const detectedAt = incident?.startedAt ?? Date.now();

  let body: string;
  if (event === "recovered") {
    const mins = incident?.durationSeconds != null ? Math.round(incident.durationSeconds / 60) : null;
    body = `${monitor.name} is back up${mins != null ? ` after ${mins} min of downtime` : ""}.`;
  } else if (event === "heartbeat_missed") {
    body = `${monitor.name} did not check in within its expected interval.`;
  } else if (event === "down") {
    body = `${monitor.name} is down${incident?.error ? ` (${incident.error})` : ""}.`;
  } else {
    body = `${monitor.name}: ${event}.`;
  }

  return {
    event,
    monitorId: monitor.id,
    monitorName: monitor.name,
    state: event === "recovered" ? "up" : "down",
    title: EVENT_TITLE[event](monitor.name),
    body,
    url,
    statusCode: incident?.httpStatus ?? null,
    error: incident?.error ?? null,
    detectedAt,
    durationSeconds: incident?.durationSeconds ?? null,
    incidentId: incident?.id,
  };
}

/** A synthetic payload for the "send test notification" action. */
export function buildTestPayload(channelName: string, appUrl?: string): NotificationPayload {
  const base = appUrl ? appUrl.replace(/\/$/, "") : undefined;
  return {
    event: "test",
    monitorId: "test",
    monitorName: channelName,
    state: "up",
    title: `✅ OpenPing test notification`,
    body: `This is a test notification from OpenPing for "${channelName}". If you received it, the channel works.`,
    url: base,
    detectedAt: Date.now(),
  };
}

// --- Renderers ---

// Single-quoted family name: interpolated into double-quoted style="" attrs.
const FONT =
  "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

/** Short uppercase pill label for the email status accent. */
const EVENT_PILL: Record<NotifyEvent, string> = {
  down: "Down",
  recovered: "Recovered",
  heartbeat_missed: "Missed heartbeat",
  flapping: "Flapping",
  degraded: "Degraded",
  maintenance_start: "Maintenance",
  maintenance_end: "Maintenance",
  weekly: "Summary",
  test: "Test",
};

/** CTA label per event: incidents link to the monitor, test opens the app. */
function emailButtonLabel(event: NotifyEvent): string {
  if (event === "test") return "Open OpenPing";
  if (event === "maintenance_start" || event === "maintenance_end") return "View monitor";
  return "View incident";
}

function metaLines(p: NotificationPayload): Array<[string, string]> {
  const meta: Array<[string, string]> = [];
  if (p.statusCode) meta.push(["HTTP status", String(p.statusCode)]);
  if (p.error) meta.push(["Error", p.error]);
  meta.push(["Detected", new Date(p.detectedAt).toUTCString()]);
  return meta;
}

export function toEmailText(p: NotificationPayload): string {
  const lines = [p.body, ""];
  for (const [label, value] of metaLines(p)) lines.push(`${label}: ${value}`);
  return renderEmailText({
    heading: stripLeadingEmoji(p.title),
    lines,
    button: p.url ? { label: emailButtonLabel(p.event), url: p.url } : undefined,
  });
}

export function toEmailHtml(p: NotificationPayload): string {
  const meta = metaLines(p);
  const metaRows = meta
    .map(
      ([label, value]) =>
        `<tr><td style="padding:6px 14px 6px 0;font-family:${FONT};font-size:13px;color:#5f6f87;white-space:nowrap;vertical-align:top;">${escapeHtml(label)}</td>` +
        `<td style="padding:6px 0;font-family:${FONT};font-size:13px;color:#16233a;font-weight:600;word-break:break-word;">${escapeHtml(value)}</td></tr>`,
    )
    .join("");

  const bodyHtml =
    `<p style="margin:0 0 18px;font-family:${FONT};font-size:15px;line-height:1.6;color:#16233a;">${escapeHtml(p.body)}</p>` +
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;background:#f7f9fc;border:1px solid #e3e9f2;border-radius:10px;padding:6px 16px;">${metaRows}</table>`;

  return renderEmailLayout({
    heading: stripLeadingEmoji(p.title),
    accent: eventColorState(p.event),
    statusLabel: EVENT_PILL[p.event],
    bodyHtml,
    button: p.url ? { label: emailButtonLabel(p.event), url: p.url } : undefined,
    preheader: p.body,
  });
}

// Discord embed length limits
// (https://discord.com/developers/docs/resources/channel#embed-limits). An
// over-limit embed is rejected with 400 → retried to death → the alert is lost.
const DISCORD_TITLE_MAX = 256;
const DISCORD_DESCRIPTION_MAX = 4096;
const DISCORD_FIELD_VALUE_MAX = 1024;

/** Truncate to `max` characters, marking any elision with an ellipsis. */
function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/**
 * Backslash-escape Discord markdown control characters so an attacker-influenced
 * string (notably a remote `error` body) can't inject bold/italics, spoilers,
 * code blocks, block quotes, or masked links. Single pass — the backslashes we
 * insert are not re-scanned, so there is no double-escaping.
 */
function escapeDiscordMarkdown(s: string): string {
  return s.replace(/[\\*_~`|>[\]]/g, "\\$&");
}

/**
 * Map a notification event to the monitor "state" used for the embed accent
 * color. `p.state` is collapsed to up/down for the webhook contract, which would
 * render flapping/degraded/maintenance with the red "down" color; derive the
 * color from the real event instead so those show amber (degraded) / green.
 */
function eventColorState(event: NotifyEvent): string {
  switch (event) {
    case "recovered":
    case "maintenance_end":
    case "test":
    case "weekly":
      return "up";
    case "flapping":
    case "degraded":
    case "maintenance_start":
      return "degraded"; // amber, not red
    default:
      return "down"; // down, heartbeat_missed
  }
}

export function toDiscordEmbed(p: NotificationPayload): DiscordEmbed {
  const fields: DiscordEmbed["fields"] = [];
  if (p.statusCode) fields.push({ name: "HTTP status", value: String(p.statusCode), inline: true });
  if (p.error) {
    fields.push({
      name: "Error",
      value: truncate(escapeDiscordMarkdown(p.error), DISCORD_FIELD_VALUE_MAX),
      inline: true,
    });
  }
  return {
    title: truncate(p.title, DISCORD_TITLE_MAX),
    // `body` embeds the (untrusted) error, so sanitize it too before truncating.
    description: truncate(escapeDiscordMarkdown(p.body), DISCORD_DESCRIPTION_MAX),
    url: p.url,
    color: stateColor(eventColorState(p.event)),
    fields: fields.length ? fields : undefined,
    timestamp: new Date(p.detectedAt).toISOString(),
    footer: { text: "OpenPing" },
  };
}
