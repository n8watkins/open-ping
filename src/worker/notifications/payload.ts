import type { MonitorRecord } from "../db/monitors";
import type { IncidentRecord } from "../db/incidents";
import { NOTIFY_EVENTS, type NotifyEvent } from "../../shared/notifications";
import {
  INCIDENT_UPDATE_LABELS,
  INCIDENT_UPDATE_STATUSES,
  type IncidentUpdateStatus,
} from "../../shared/incident-updates";
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
  /** Only on `incident_update`: the status update the admin posted. */
  update?: IncidentUpdateSummary;
}

/** The posted status update an `incident_update` notification carries. */
export interface IncidentUpdateSummary {
  id: string;
  status: IncidentUpdateStatus;
  /** The status as people read it, for example "Identified". */
  label: string;
  message: string;
  postedAt: number;
}

const NOTIFY_EVENT_SET = new Set<string>(NOTIFY_EVENTS);
const UPDATE_STATUS_SET = new Set<string>(INCIDENT_UPDATE_STATUSES);

function isUpdateSummary(value: unknown): value is IncidentUpdateSummary {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const u = value as Record<string, unknown>;
  return (
    typeof u.id === "string" &&
    typeof u.status === "string" &&
    UPDATE_STATUS_SET.has(u.status) &&
    typeof u.label === "string" &&
    typeof u.message === "string" &&
    typeof u.postedAt === "number" &&
    Number.isFinite(u.postedAt)
  );
}

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
    optionalString("incidentId") &&
    // An incident update must say what was posted; nothing else may carry one.
    (payload.event === "incident_update"
      ? isUpdateSummary(payload.update)
      : payload.update === undefined)
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
  incident_update: (n) => `📢 Incident update: ${n}`,
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

/**
 * The payload for a status update an admin posted to an incident: the title
 * names the monitor and the update's status, and the body is the message as
 * written. `state` follows the incident (open is "down", resolved is "up").
 */
export function buildIncidentUpdatePayload(
  monitor: Pick<MonitorRecord, "id" | "name">,
  incident: Pick<IncidentRecord, "id" | "status" | "httpStatus" | "error" | "durationSeconds">,
  update: { id: string; status: IncidentUpdateStatus; message: string; postedAt: number },
  appUrl?: string,
): NotificationPayload {
  const base = appUrl ? appUrl.replace(/\/$/, "") : undefined;
  const label = INCIDENT_UPDATE_LABELS[update.status];
  return {
    event: "incident_update",
    monitorId: monitor.id,
    monitorName: monitor.name,
    state: incident.status === "resolved" ? "up" : "down",
    title: `${EVENT_TITLE.incident_update(monitor.name)} - ${label}`,
    body: update.message,
    url: base ? `${base}/incidents?incident=${encodeURIComponent(incident.id)}` : undefined,
    statusCode: incident.httpStatus ?? null,
    error: incident.error ?? null,
    detectedAt: update.postedAt,
    durationSeconds: incident.durationSeconds ?? null,
    incidentId: incident.id,
    update: { id: update.id, status: update.status, label, message: update.message, postedAt: update.postedAt },
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
export const EVENT_PILL: Record<NotifyEvent, string> = {
  down: "Down",
  recovered: "Recovered",
  heartbeat_missed: "Missed heartbeat",
  flapping: "Flapping",
  degraded: "Degraded",
  maintenance_start: "Maintenance",
  maintenance_end: "Maintenance",
  incident_update: "Update",
  weekly: "Summary",
  test: "Test",
};

/** CTA label per event: incidents link to the monitor, test opens the app. */
export function emailButtonLabel(event: NotifyEvent): string {
  if (event === "test") return "Open OpenPing";
  if (event === "maintenance_start" || event === "maintenance_end") return "View monitor";
  return "View incident";
}

/** The status pill for a payload: an incident update shows its own status. */
export function pillLabel(p: NotificationPayload): string {
  return p.update?.label ?? EVENT_PILL[p.event];
}

/** What `detectedAt` means for this payload: when it was detected, or posted. */
export function timeLabel(p: NotificationPayload): "Detected" | "Posted" {
  return p.event === "incident_update" ? "Posted" : "Detected";
}

/** The labelled facts every rich channel shows under the message body. */
export function metaLines(p: NotificationPayload): Array<[string, string]> {
  const meta: Array<[string, string]> = [];
  if (p.update) {
    // The update speaks for the incident; the original error would only repeat the down alert.
    meta.push(["Status", p.update.label]);
  } else {
    if (p.statusCode) meta.push(["HTTP status", String(p.statusCode)]);
    if (p.error) meta.push(["Error", p.error]);
  }
  meta.push([timeLabel(p), new Date(p.detectedAt).toUTCString()]);
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

  // pre-line keeps the line breaks of an incident update's message.
  const bodyHtml =
    `<p style="margin:0 0 18px;font-family:${FONT};font-size:15px;line-height:1.6;color:#16233a;white-space:pre-line;">${escapeHtml(p.body)}</p>` +
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;background:#f7f9fc;border:1px solid #e3e9f2;border-radius:10px;padding:6px 16px;">${metaRows}</table>`;

  return renderEmailLayout({
    heading: stripLeadingEmoji(p.title),
    accent: colorState(p),
    statusLabel: pillLabel(p),
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
 * code blocks, block quotes, or masked links. Single pass - the backslashes we
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
export function eventColorState(event: NotifyEvent): string {
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
    case "incident_update":
      return "degraded"; // without its status; see colorState
    default:
      return "down"; // down, heartbeat_missed
  }
}

/** Accent color state for one update status: red, then amber, then green. */
const UPDATE_COLOR_STATE: Record<IncidentUpdateStatus, string> = {
  investigating: "down",
  identified: "degraded",
  monitoring: "degraded",
  resolved: "up",
};

/** The accent color state for a payload, using an incident update's own status. */
export function colorState(p: NotificationPayload): string {
  return p.update ? UPDATE_COLOR_STATE[p.update.status] : eventColorState(p.event);
}

export function toDiscordEmbed(p: NotificationPayload): DiscordEmbed {
  const fields: DiscordEmbed["fields"] = [];
  if (p.update) {
    fields.push({ name: "Status", value: p.update.label, inline: true });
  } else if (p.statusCode) {
    fields.push({ name: "HTTP status", value: String(p.statusCode), inline: true });
  }
  if (p.error && !p.update) {
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
    color: stateColor(colorState(p)),
    fields: fields.length ? fields : undefined,
    timestamp: new Date(p.detectedAt).toISOString(),
    footer: { text: "OpenPing" },
  };
}
