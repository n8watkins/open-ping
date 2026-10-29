import type { MonitorSummary } from "../lib/types";
import { monitorTypeLabel } from "../lib/types";
import type { MonitorState } from "../../shared/states";

export type MonitorSortMode = "status" | "name" | "recent" | "uptime" | "response";

/** The per-monitor figures the uptime and response sorts read. */
export interface MonitorSortStats {
  uptime7d: number;
  typicalResponseMs: number | null;
}

const STATUS_PRIORITY: Record<MonitorState, number> = {
  down: 0,
  suspended: 1,
  degraded: 2,
  warming_up: 3,
  unknown: 4,
  cant_check: 4,
  maintenance: 5,
  scheduled_off: 6,
  paused: 7,
  up: 8,
};

export function filterAndSortMonitors(
  monitors: MonitorSummary[],
  query: string,
  status: "all" | MonitorState,
  sort: MonitorSortMode,
  stats: Record<string, MonitorSortStats> = {},
): MonitorSummary[] {
  const normalizedQuery = query.trim().toLowerCase();
  return monitors
    .filter((monitor) => {
      const haystack = [
        monitor.name,
        monitor.target,
        monitor.categoryName,
        monitorTypeLabel(monitor.type),
      ]
        .filter((value): value is string => Boolean(value))
        .join("\n")
        .toLowerCase();
      return (
        (!normalizedQuery || haystack.includes(normalizedQuery)) &&
        (status === "all" || monitor.state === status)
      );
    })
    .sort((a, b) => {
      if (sort === "name") return a.name.localeCompare(b.name);
      if (sort === "recent") {
        return (b.lastCheckedAt ?? 0) - (a.lastCheckedAt ?? 0);
      }
      if (sort === "uptime") {
        // Lowest 7-day uptime first; monitors without figures last.
        const ua = stats[a.id]?.uptime7d ?? Infinity;
        const ub = stats[b.id]?.uptime7d ?? Infinity;
        return ua - ub || a.name.localeCompare(b.name);
      }
      if (sort === "response") {
        // Slowest typical response first; monitors without one last.
        const ra = stats[a.id]?.typicalResponseMs ?? -1;
        const rb = stats[b.id]?.typicalResponseMs ?? -1;
        return rb - ra || a.name.localeCompare(b.name);
      }
      return (
        STATUS_PRIORITY[a.state] - STATUS_PRIORITY[b.state] ||
        a.name.localeCompare(b.name)
      );
    });
}

export interface MonitorGroup {
  key: string;
  label: string;
  monitors: MonitorSummary[];
}

export function groupMonitors(monitors: MonitorSummary[]): MonitorGroup[] {
  const groups = new Map<string, MonitorGroup>();
  for (const monitor of monitors) {
    const key = monitor.categoryId ?? "__uncategorized";
    const existing = groups.get(key);
    if (existing) {
      existing.monitors.push(monitor);
    } else {
      groups.set(key, {
        key,
        label: monitor.categoryName ?? "Uncategorized",
        monitors: [monitor],
      });
    }
  }
  return [...groups.values()].sort((a, b) => {
    if (a.key === "__uncategorized") return 1;
    if (b.key === "__uncategorized") return -1;
    return a.label.localeCompare(b.label);
  });
}
