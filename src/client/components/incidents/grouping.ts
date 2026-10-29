/**
 * Incident grouping for the Incidents page. PURE: no React, no fetching.
 *
 * When one cause takes several monitors down together (a host suspends every
 * app, a shared database fails), each monitor opens its own incident in the
 * same scheduler run. Listing them one by one buries the story under
 * near-identical rows, so the page folds incidents that start within a few
 * minutes of each other into one "event".
 *
 * Grouping runs in the browser over the page of incidents the list API
 * returned (up to 500, newest first). The API, the MCP tools, the CLI and the
 * CSV/JSON exports keep returning plain incidents, and grouping costs no extra
 * D1 queries. A single administrator's history is small enough that one page
 * covers it; when it doesn't, only an event straddling the page edge could
 * split, and the page says how many incidents it is showing.
 */

/** The incident fields grouping and labelling read. */
export interface GroupableIncident {
  id: string;
  monitorId?: string;
  monitorName?: string | null;
  status: "open" | "resolved";
  title: string | null;
  startedAt: number;
  resolvedAt: number | null;
  durationSeconds: number | null;
  error: string | null;
  rootCause?: string | null;
  httpStatus?: number | null;
}

/** One or more incidents that started together. */
export interface IncidentEvent<T extends GroupableIncident = GroupableIncident> {
  /** Stable key: the id of the event's first incident. */
  key: string;
  /** Members, by monitor name. */
  incidents: T[];
  startedAt: number;
  /** When the last member recovered; null while any member is open. */
  endedAt: number | null;
  open: boolean;
  /** Time at least one member was down (overlaps counted once), to `now` if open. */
  downtimeSeconds: number;
  /** The shared cause label, "Mixed causes", or null when none is known. */
  cause: string | null;
}

/** Incidents starting within this long of an event's first incident join it. */
export const GROUP_WINDOW_MS = 5 * 60 * 1000;

/** Readable names for the machine error codes the checks record. */
const CAUSE_LABELS: Record<string, string> = {
  suspended: "Render suspended the app",
  timeout: "Timeout",
  tcp_timeout: "Timeout",
  dns_timeout: "DNS timeout",
  rdap_timeout: "Lookup timeout",
  network_error: "Network error",
  dns_error: "DNS lookup failed",
  dns_nxdomain: "Domain not found",
  dns_no_records: "No DNS records",
  dns_mismatch: "DNS record changed",
  tls_error: "TLS error",
  too_many_redirects: "Too many redirects",
  blocked_url: "Blocked address",
  blocked_host: "Blocked address",
  response_too_slow: "Too slow",
  assertion_failed: "Check assertion failed",
  heartbeat_missed: "Missed heartbeat",
  tcp_refused: "Connection refused",
  domain_expired: "Domain expired",
  cert_expired: "Certificate expired",
  cert_not_yet_valid: "Certificate not valid yet",
  cert_connect_failed: "Couldn't connect",
  cert_timeout: "Certificate read timed out",
  cert_closed: "Connection closed",
  cert_unreadable: "Certificate unreadable",
  cert_handshake_failed: "TLS handshake refused",
  rdap_error: "Lookup failed",
  rdap_no_expiry: "No expiry date",
  rdap_rate_limited: "Lookup rate limited",
  check_failed: "Check failed",
};

/**
 * A stored error code in plain words: "suspended" -> "Render suspended the
 * app", "timeout" -> "Timeout". An unknown code reads as its words
 * ("weird_code" -> "Weird code"); "http_503" reads as "HTTP 503".
 */
export function describeCause(code: string): string {
  const known = CAUSE_LABELS[code];
  if (known) return known;
  if (code === "status_out_of_range") return "Unexpected status";
  const http = /^http_(\d{3})$/.exec(code);
  if (http) return `HTTP ${http[1]}`;
  const words = code.replace(/_/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * A short, human cause for an incident, or null when none is known. A root
 * cause the owner typed wins; then the recorded error code; then the HTTP
 * status ("HTTP 503"). A status-code failure, or a code with no label of its
 * own, reads as its HTTP status when there is one.
 */
export function causeLabel(inc: GroupableIncident): string | null {
  const http = inc.httpStatus != null ? `HTTP ${inc.httpStatus}` : null;
  for (const raw of [inc.rootCause, inc.error]) {
    const value = raw?.trim();
    if (!value) continue;
    if (/^[a-z0-9_]+$/.test(value)) {
      // A machine code.
      if (CAUSE_LABELS[value]) return CAUSE_LABELS[value];
      return http ?? describeCause(value);
    }
    // Free text (an owner-written root cause, or an error message): keep it
    // short enough for a title line.
    return value.length > 60 ? `${value.slice(0, 57).trimEnd()}...` : value;
  }
  return http;
}

/** When an incident ended, or null while it is open. */
function incidentEnd(inc: GroupableIncident): number | null {
  if (inc.status === "open") return null;
  if (inc.resolvedAt != null) return inc.resolvedAt;
  return inc.startedAt + (inc.durationSeconds ?? 0) * 1000;
}

/** Total length of a set of [start, end) intervals, overlaps counted once. */
export function unionSeconds(intervals: [number, number][]): number {
  const sorted = [...intervals].sort((a, b) => a[0] - b[0]);
  let total = 0;
  let curStart: number | null = null;
  let curEnd = 0;
  for (const [start, end] of sorted) {
    if (end <= start) continue;
    if (curStart === null || start > curEnd) {
      if (curStart !== null) total += curEnd - curStart;
      curStart = start;
      curEnd = end;
    } else if (end > curEnd) {
      curEnd = end;
    }
  }
  if (curStart !== null) total += curEnd - curStart;
  return Math.round(total / 1000);
}

function buildEvent<T extends GroupableIncident>(members: T[], now: number): IncidentEvent<T> {
  const incidents = [...members].sort((a, b) =>
    (a.monitorName ?? "").localeCompare(b.monitorName ?? "") || a.startedAt - b.startedAt,
  );
  const open = incidents.some((i) => i.status === "open");
  const ends = incidents.map(incidentEnd);
  const causes = new Set(incidents.map(causeLabel).filter((c): c is string => c != null));
  return {
    key: incidents.reduce((first, i) => (i.startedAt < first.startedAt ? i : first)).id,
    incidents,
    startedAt: Math.min(...incidents.map((i) => i.startedAt)),
    endedAt: open ? null : Math.max(...(ends as number[])),
    open,
    downtimeSeconds: unionSeconds(
      incidents.map((i, n) => [i.startedAt, ends[n] ?? Math.max(now, i.startedAt)]),
    ),
    cause: causes.size === 0 ? null : causes.size === 1 ? [...causes][0]! : "Mixed causes",
  };
}

/**
 * Fold incidents into events: walking in start order, an incident joins the
 * current event when it starts within `windowMs` of the event's FIRST incident
 * (an anchor, so a slow drip of incidents can't chain into one endless event)
 * and its monitor isn't already in it (a monitor flapping twice is two events).
 * Events come back newest first.
 */
export function groupIncidents<T extends GroupableIncident>(
  list: T[],
  opts: { windowMs?: number; now?: number } = {},
): IncidentEvent<T>[] {
  const windowMs = opts.windowMs ?? GROUP_WINDOW_MS;
  const now = opts.now ?? Date.now();
  const sorted = [...list].sort((a, b) => a.startedAt - b.startedAt);
  const groups: T[][] = [];
  let current: T[] = [];
  let anchor = 0;
  for (const inc of sorted) {
    const monitorKey = inc.monitorId ?? inc.monitorName ?? inc.id;
    const sameMonitor = current.some(
      (m) => (m.monitorId ?? m.monitorName ?? m.id) === monitorKey,
    );
    if (current.length > 0 && inc.startedAt - anchor <= windowMs && !sameMonitor) {
      current.push(inc);
    } else {
      if (current.length > 0) groups.push(current);
      current = [inc];
      anchor = inc.startedAt;
    }
  }
  if (current.length > 0) groups.push(current);
  return groups.map((g) => buildEvent(g, now)).sort((a, b) => b.startedAt - a.startedAt);
}

export type EventSort = "newest" | "oldest" | "longest";

/** Order events for display. */
export function sortEvents<T extends GroupableIncident>(
  events: IncidentEvent<T>[],
  sort: EventSort,
): IncidentEvent<T>[] {
  const out = [...events];
  if (sort === "oldest") out.sort((a, b) => a.startedAt - b.startedAt);
  else if (sort === "longest") {
    out.sort((a, b) => b.downtimeSeconds - a.downtimeSeconds || b.startedAt - a.startedAt);
  } else out.sort((a, b) => b.startedAt - a.startedAt);
  return out;
}

/** Headline figures for a set of events. */
export interface EventSummary {
  events: number;
  incidents: number;
  open: number;
  downtimeSeconds: number;
  longestSeconds: number;
}

export function summarizeEvents(events: IncidentEvent[]): EventSummary {
  return {
    events: events.length,
    incidents: events.reduce((n, e) => n + e.incidents.length, 0),
    open: events.filter((e) => e.open).length,
    downtimeSeconds: events.reduce((n, e) => n + e.downtimeSeconds, 0),
    longestSeconds: events.reduce((n, e) => Math.max(n, e.downtimeSeconds), 0),
  };
}

/** A calendar month of events, for the section headers. */
export interface MonthSection<T extends GroupableIncident = GroupableIncident> {
  /** "2026-10". */
  key: string;
  /** "October 2026". */
  label: string;
  events: IncidentEvent<T>[];
  downtimeSeconds: number;
}

/**
 * Split already-sorted events into consecutive month sections by start time,
 * in the viewer's timezone unless `timeZone` pins it (tests do).
 */
export function sectionByMonth<T extends GroupableIncident>(
  events: IncidentEvent<T>[],
  opts: { locale?: string; timeZone?: string } = {},
): MonthSection<T>[] {
  const keyFmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: opts.timeZone,
    year: "numeric",
    month: "2-digit",
  });
  const labelFmt = new Intl.DateTimeFormat(opts.locale, {
    timeZone: opts.timeZone,
    year: "numeric",
    month: "long",
  });
  const sections: MonthSection<T>[] = [];
  for (const event of events) {
    const key = keyFmt.format(event.startedAt);
    const last = sections[sections.length - 1];
    if (last && last.key === key) {
      last.events.push(event);
      last.downtimeSeconds += event.downtimeSeconds;
    } else {
      sections.push({
        key,
        label: labelFmt.format(event.startedAt),
        events: [event],
        downtimeSeconds: event.downtimeSeconds,
      });
    }
  }
  return sections;
}

/** The headline for an event row: "3 monitors down" or the incident's own title. */
export function eventTitle(event: IncidentEvent): string {
  if (event.incidents.length > 1) return `${event.incidents.length} monitors down`;
  const inc = event.incidents[0]!;
  return inc.title ?? `${inc.monitorName ?? "Monitor"} is down`;
}

/** "Echo, GeminiGPT and Scout" (at most `max` names, then "+N more"). */
export function monitorNames(event: IncidentEvent, max = 4): string {
  const names = event.incidents.map((i) => i.monitorName ?? "Deleted monitor");
  if (names.length <= max) {
    if (names.length <= 2) return names.join(" and ");
    return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  }
  return `${names.slice(0, max).join(", ")} +${names.length - max} more`;
}
