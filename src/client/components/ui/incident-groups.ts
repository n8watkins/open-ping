/**
 * Incidents that start within a few minutes of each other usually share one
 * cause (a host suspending every app at once, a network blip), so the
 * Overview's timeline shows them as one event. PURE.
 */

export interface IncidentLike {
  id: string;
  monitorId: string;
  monitorName: string | null;
  status: "open" | "resolved";
  startedAt: number;
  resolvedAt: number | null;
  durationSeconds: number | null;
  error: string | null;
}

export interface IncidentGroup {
  /** The first incident's id, for linking. */
  id: string;
  incidentIds: string[];
  monitors: { id: string; name: string }[];
  open: boolean;
  startedAt: number;
  /** Latest resolution, or null while any is still open. */
  resolvedAt: number | null;
  /** Longest incident in the group (an open one runs to `now`). */
  durationSeconds: number;
  /** The distinct causes, most common first. */
  causes: string[];
}

/** Incidents starting this close to the group's first one join it. */
export const GROUP_WINDOW_MS = 10 * 60 * 1000;

export function groupIncidents(incidents: IncidentLike[], now: number = Date.now()): IncidentGroup[] {
  const sorted = [...incidents].sort((a, b) => b.startedAt - a.startedAt);
  const groups: { anchor: number; items: IncidentLike[] }[] = [];
  for (const inc of sorted) {
    const g = groups.at(-1);
    if (g && g.anchor - inc.startedAt <= GROUP_WINDOW_MS) g.items.push(inc);
    else groups.push({ anchor: inc.startedAt, items: [inc] });
  }
  return groups.map(({ items }) => {
    const open = items.some((i) => i.status === "open");
    const causeCount = new Map<string, number>();
    for (const i of items) {
      if (i.error) causeCount.set(i.error, (causeCount.get(i.error) ?? 0) + 1);
    }
    const seen = new Set<string>();
    const monitors: { id: string; name: string }[] = [];
    for (const i of items) {
      if (seen.has(i.monitorId)) continue;
      seen.add(i.monitorId);
      monitors.push({ id: i.monitorId, name: i.monitorName ?? "Deleted monitor" });
    }
    monitors.sort((a, b) => a.name.localeCompare(b.name));
    const startedAt = Math.min(...items.map((i) => i.startedAt));
    return {
      id: items[items.length - 1]!.id,
      incidentIds: items.map((i) => i.id),
      monitors,
      open,
      startedAt,
      resolvedAt: open ? null : Math.max(...items.map((i) => i.resolvedAt ?? i.startedAt)),
      durationSeconds: Math.max(
        ...items.map((i) =>
          i.status === "open"
            ? Math.max(0, (now - i.startedAt) / 1000)
            : (i.durationSeconds ?? Math.max(0, ((i.resolvedAt ?? i.startedAt) - i.startedAt) / 1000)),
        ),
      ),
      causes: [...causeCount.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c),
    };
  });
}

/** A stored error code in plain words: "suspended" -> "Suspended by the host". */
export function describeCause(code: string): string {
  switch (code) {
    case "suspended":
      return "Suspended by the host";
    case "timeout":
      return "Timed out";
    case "network_error":
      return "Network error";
    case "dns_error":
      return "DNS lookup failed";
    case "tls_error":
      return "TLS error";
    case "heartbeat_missed":
      return "Missed heartbeat";
    case "status_out_of_range":
      return "Unexpected status code";
    case "assertion_failed":
      return "Content check failed";
    case "tcp_refused":
      return "Connection refused";
    case "tcp_timeout":
      return "Connection timed out";
    case "dns_nxdomain":
      return "Domain not found";
    case "domain_expired":
      return "Domain expired";
    default: {
      const http = /^http_(\d{3})$/.exec(code);
      if (http) return `HTTP ${http[1]}`;
      const words = code.replace(/_/g, " ");
      return words.charAt(0).toUpperCase() + words.slice(1);
    }
  }
}
