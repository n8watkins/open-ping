import { MONITOR_STATES, type MonitorState } from "../../shared/states";

export interface SummaryCountRow {
  monitor_id: string;
  checks: number;
  ok_checks: number;
}

export interface RecentCheckRow {
  monitor_id: string;
  at: number;
  ok: number | boolean;
  state: unknown;
}

export interface RecentCheck {
  at: number;
  state: MonitorState;
}

export interface IncidentAnalyticsInput {
  recentIncidentStarts: number[];
  openIncidents: number;
  latestResolvedAt: number | null;
  earliestMonitorCreatedAt: number | null;
  now: number;
}

export interface OverviewAnalytics {
  overallUptime24h: number;
  mtbfSeconds24h: number | null;
  incidents24h: number;
  withoutIncidentSeconds: number | null;
}

const knownStates = new Set<string>(MONITOR_STATES);

/** Validate persisted sample state and recover safely from corrupt legacy rows. */
export function normalizeSampleState(state: unknown, ok: number | boolean): MonitorState {
  if (typeof state === "string" && knownStates.has(state)) {
    return state as MonitorState;
  }
  return ok === true || ok === 1 ? "up" : "down";
}

/** Group a bulk sample query into oldest-to-newest histories for each monitor. */
export function groupRecentChecks(
  rows: RecentCheckRow[],
  limit = 28,
): Map<string, RecentCheck[]> {
  const grouped = new Map<string, RecentCheck[]>();
  for (const row of rows) {
    const checks = grouped.get(row.monitor_id) ?? [];
    checks.push({ at: row.at, state: normalizeSampleState(row.state, row.ok) });
    grouped.set(row.monitor_id, checks);
  }

  for (const [monitorId, checks] of grouped) {
    checks.sort((a, b) => a.at - b.at);
    if (checks.length > limit) grouped.set(monitorId, checks.slice(-limit));
  }
  return grouped;
}

/** Calculate uptime across monitors weighted by the number of actual checks. */
export function computeOverallUptime(rows: SummaryCountRow[]): number {
  let checks = 0;
  let okChecks = 0;
  for (const row of rows) {
    const rowChecks = Math.max(0, Number(row.checks) || 0);
    const rowOkChecks = Math.min(
      rowChecks,
      Math.max(0, Number(row.ok_checks) || 0),
    );
    checks += rowChecks;
    okChecks += rowOkChecks;
  }
  return checks > 0 ? (okChecks / checks) * 100 : 100;
}

/** Derive the incident analytics displayed by the monitoring overview. */
export function computeIncidentOverview(
  input: IncidentAnalyticsInput,
): Omit<OverviewAnalytics, "overallUptime24h"> {
  const starts = input.recentIncidentStarts
    .filter(Number.isFinite)
    .sort((a, b) => a - b);

  let mtbfSeconds24h: number | null = null;
  if (starts.length >= 2) {
    let gapMs = 0;
    for (let i = 1; i < starts.length; i += 1) {
      gapMs += starts[i]! - starts[i - 1]!;
    }
    mtbfSeconds24h = gapMs / (starts.length - 1) / 1000;
  }

  let withoutIncidentSeconds: number | null = null;
  if (input.openIncidents > 0) {
    withoutIncidentSeconds = 0;
  } else {
    const since = input.latestResolvedAt ?? input.earliestMonitorCreatedAt;
    if (since != null) {
      withoutIncidentSeconds = Math.max(0, Math.floor((input.now - since) / 1000));
    }
  }

  return {
    mtbfSeconds24h,
    incidents24h: starts.length,
    withoutIncidentSeconds,
  };
}
