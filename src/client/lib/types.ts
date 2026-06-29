import type { MonitorState } from "../../shared/states";

export interface MonitorSummary {
  id: string;
  name: string;
  type: "http" | "heartbeat";
  state: MonitorState;
  paused: boolean;
  scheduleMode: string;
  lastCheckedAt: number | null;
  lastDurationMs: number | null;
  lastStatusCode: number | null;
  nextCheckAt: number | null;
  stateSince: number | null;
  uptime24h: number;
  publicVisible: boolean;
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
