import type { MonitorState } from "../../shared/states";

/** Every monitor kind the client can render/label. */
export type MonitorType = "http" | "heartbeat" | "dns" | "tcp" | "domain";

const MONITOR_TYPE_LABELS: Record<MonitorType, string> = {
  http: "HTTP",
  heartbeat: "Heartbeat",
  dns: "DNS",
  tcp: "TCP",
  domain: "Domain",
};

/** Friendly display label for a monitor type (falls back to upper-casing). */
export function monitorTypeLabel(type: string): string {
  return MONITOR_TYPE_LABELS[type as MonitorType] ?? type.toUpperCase();
}

export interface MonitorSummary {
  id: string;
  name: string;
  type: MonitorType;
  state: MonitorState;
  paused: boolean;
  intervalSeconds: number;
  scheduleMode: string;
  lastCheckedAt: number | null;
  lastDurationMs: number | null;
  lastStatusCode: number | null;
  nextCheckAt: number | null;
  stateSince: number | null;
  uptime24h: number;
  publicVisible: boolean;
  categoryId?: string | null;
  categoryName?: string | null;
}

export interface Category {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
}

export interface StatusPage {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  enabled: boolean;
  isDefault: boolean;
  includeMode: "all" | "categories" | "monitors";
  categoryIds: string[];
  monitorIds: string[];
  theme: "dark" | "light" | "system";
  accent: string;
  logo: string | null;
  homepage: string | null;
  footer: string | null;
  attribution: boolean;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
}

export interface ChannelHealth {
  id: string;
  type: string;
  name: string | null;
  enabled: boolean;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  healthy: boolean;
}

export interface SchedulerRun {
  id: string;
  cron: string | null;
  startedAt: number;
  finishedAt: number | null;
  ok: number | null;
  monitorsChecked: number | null;
  checkFailures: number | null;
  notificationFailures: number | null;
  durationMs: number | null;
}

export interface OverviewResponse {
  counts: Record<string, number> & { openIncidents: number };
  monitors: MonitorSummary[];
  channels: ChannelHealth[];
  lastRun: SchedulerRun | null;
}

export interface IncidentSummary {
  id: string;
  status: "open" | "resolved";
  title: string | null;
  monitorName?: string;
  startedAt: number;
  resolvedAt: number | null;
  durationSeconds: number | null;
  error: string | null;
}
