import type { MonitorRecord } from "../db/monitors";
import type { IncidentRecord } from "../db/incidents";
import type { NotifyEvent } from "../../shared/notifications";
import { stateColor, type DiscordEmbed } from "./channels/discord";

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

export function toEmailText(p: NotificationPayload): string {
  const lines = [p.body, ""];
  if (p.statusCode) lines.push(`HTTP status: ${p.statusCode}`);
  if (p.error) lines.push(`Error: ${p.error}`);
  lines.push(`Detected: ${new Date(p.detectedAt).toISOString()}`);
  if (p.url) lines.push(`\n${p.url}`);
  return lines.join("\n");
}

export function toEmailHtml(p: NotificationPayload): string {
  const rows: string[] = [`<p style="font-size:15px;margin:0 0 16px">${escapeHtml(p.body)}</p>`];
  const meta: string[] = [];
  if (p.statusCode) meta.push(`<strong>HTTP status:</strong> ${p.statusCode}`);
  if (p.error) meta.push(`<strong>Error:</strong> ${escapeHtml(p.error)}`);
  meta.push(`<strong>Detected:</strong> ${new Date(p.detectedAt).toUTCString()}`);
  rows.push(`<p style="font-size:13px;color:#64748b;line-height:1.6">${meta.join("<br>")}</p>`);
  if (p.url) {
    rows.push(
      `<p style="margin-top:20px"><a href="${escapeHtml(p.url)}" style="background:#6d8bff;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none;font-size:14px">View monitor</a></p>`,
    );
  }
  return `<div style="font-family:system-ui,sans-serif;max-width:520px;margin:0 auto;padding:24px">
    <h2 style="font-size:18px;margin:0 0 16px">${escapeHtml(p.title)}</h2>
    ${rows.join("\n")}
    <hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0">
    <p style="font-size:12px;color:#94a3b8">Sent by OpenPing</p>
  </div>`;
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

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
