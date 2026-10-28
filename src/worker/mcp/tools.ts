import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import type { Env } from "../types";
import { MONITOR_TYPES, type MonitorState } from "../../shared/states";
import { getSetting } from "../db/settings";
import {
  deleteMonitor,
  getMonitor,
  listMonitors,
  rotateHeartbeatToken,
  setPaused,
  type MonitorRecord,
} from "../db/monitors";
import { listChannels } from "../db/channels";
import { listCategories } from "../db/categories";
import { listStatusPages } from "../db/status-pages";
import {
  createMaintenanceWindow,
  deleteMaintenanceWindow,
  endMaintenanceWindow,
  getMaintenanceWindow,
  isWindowActiveAt,
  listMaintenanceWindows,
  nextRecurringOccurrence,
  type MaintenanceWindow,
} from "../db/maintenance";
import { buildOverview, monitorTarget } from "../routes/overview";
import { buildDiagnostics } from "../routes/diagnostics";
import { rekeyStatus } from "../lib/rekey";
import { listIncidents, type IncidentWithMonitor, type IncidentWithUpdates } from "../routes/incidents";
import { postIncidentUpdate } from "../notifications/enqueue";
import {
  INCIDENT_UPDATE_LABELS,
  INCIDENT_UPDATE_STATUSES,
  MAX_UPDATE_MESSAGE,
} from "../db/incident-updates";
import { monthlyReportFor } from "../routes/reports";
import { redactChannel } from "../routes/channels";
import { maintenanceCreateSchema } from "../routes/maintenance";
import type { FirstCheckResult } from "../checks/first-check";
import { patchStatusPage } from "../routes/status-pages";
import type { HostedPlan } from "../lib/plan-limits";
import {
  createMonitorAndCheck,
  listMonitorUptime,
  patchMonitor,
  presentCreatedMonitor,
  type MonitorWriteResult,
} from "../routes/monitors";
import {
  describeIssues,
  duration,
  fail,
  iso,
  ok,
  pct,
  redactMonitorForMcp,
  type ToolResult,
} from "./format";

/** How post_incident_update reports the alerts it queued. */
function alertSentence(requested: boolean, queued: number, error?: string): string {
  if (!requested) return "No alerts were sent (notify was false).";
  if (error) return "The update is posted, but its alerts could not be queued; check the diagnostics.";
  if (queued === 0) return "No notification channel takes incident updates for this monitor, so no alerts were queued.";
  return `Queued ${queued} alert${queued === 1 ? "" : "s"}; they go out with the next check run, within 12 minutes.`;
}

/** What every tool can see about the request it serves. */
export interface ToolContext {
  env: Env;
  /** Origin of the MCP request, used to build heartbeat and status URLs. */
  origin: string;
  /** The request's waitUntil, so a slow first check of a new monitor can finish. */
  waitUntil?: (p: Promise<unknown>) => void;
  /** The tenant's plan in hosted mode (lib/plan-limits.ts); absent on a plain install. */
  plan?: HostedPlan;
  /** Hosted mode: tell the platform the monitor count changed (a create or delete). */
  usageChanged?: () => void;
}

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false };

/** A JSON object of any shape; the real validation runs after (createMonitorSchema etc.). */
const anyObject = () => z.looseObject({});

const monitorId = z.string().min(1).max(64).describe("Monitor id (mon_...), from list_monitors.");
const confirm = z
  .boolean()
  .optional()
  .describe("Must be true. Only set it after the user has explicitly agreed to this change.");

/** Overall state from the per-state counts, worst first. */
export function overallState(counts: Record<string, number>): string {
  if ((counts.total ?? 0) === 0) return "no_monitors";
  if ((counts.down ?? 0) + (counts.suspended ?? 0) > 0) return "down";
  if ((counts.degraded ?? 0) > 0) return "degraded";
  if ((counts.maintenance ?? 0) > 0) return "maintenance";
  if ((counts.up ?? 0) > 0) return "operational";
  // Nothing is being checked right now: every monitor is off-hours or paused.
  if ((counts.scheduled_off ?? 0) + (counts.paused ?? 0) === counts.total) return "all_off";
  return "no_data";
}

/** "1 down, 4 up, 2 scheduled off" in a fixed, worst-first order. */
function stateCounts(counts: Record<string, number>): string {
  const order: MonitorState[] = [
    "down", "suspended", "degraded", "maintenance", "warming_up", "up",
    "scheduled_off", "paused", "unknown",
  ];
  const parts = order
    .filter((s) => (counts[s] ?? 0) > 0)
    .map((s) => `${counts[s]} ${s.replace("_", " ")}`);
  return parts.length ? parts.join(", ") : "none";
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Weekday numbers as names, runs of three or more collapsed: [1,2,3,4,5] -> "Mon-Fri". */
export function weekdayText(days: number[]): string {
  const sorted = [...new Set(days)].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j]! + 1) j++;
    if (j - i >= 2) parts.push(`${DAY_NAMES[sorted[i]!]}-${DAY_NAMES[sorted[j]!]}`);
    else for (let k = i; k <= j; k++) parts.push(DAY_NAMES[sorted[k]!]!);
    i = j + 1;
  }
  return parts.join(",");
}

function scheduleSummary(m: MonitorRecord): string {
  const s = m.schedule;
  if (s.mode === "always") return "24/7";
  if (s.mode === "business_hours") {
    return `business hours ${weekdayText(s.weekdays)} ${s.start}-${s.end} (${s.timezone})`;
  }
  return `custom (${s.timezone})`;
}

function incidentLine(i: IncidentWithMonitor, zone: string, now: number): string {
  const lasted =
    i.durationSeconds ?? Math.floor(((i.resolvedAt ?? now) - i.startedAt) / 1000);
  const what = [i.httpStatus ? `HTTP ${i.httpStatus}` : null, i.error ? `"${i.error.slice(0, 120)}"` : null]
    .filter(Boolean)
    .join(" ");
  return (
    `- ${i.id} ${i.status} ${i.monitorName ?? i.monitorId}: started ${iso(i.startedAt, zone)}` +
    (i.resolvedAt ? `, resolved ${iso(i.resolvedAt, zone)}` : "") +
    `, ${duration(lasted)}${what ? `, ${what}` : ""}`
  );
}

/** An incident's line plus one indented line per status update, newest first. */
function incidentWithUpdatesLines(i: IncidentWithUpdates, zone: string, now: number): string[] {
  return [
    incidentLine(i, zone, now) + (i.public ? " (public)" : ""),
    ...i.updates.map(
      (u) => `  - ${INCIDENT_UPDATE_LABELS[u.status]} at ${iso(u.postedAt, zone)}: ${u.message.slice(0, 300)} [${u.id}]`,
    ),
  ];
}

function maintenanceStatus(w: MaintenanceWindow, now: number): "active" | "upcoming" | "ended" {
  if (isWindowActiveAt(w, now)) return "active";
  if (now >= w.endsAt) return "ended";
  if (w.recurrence) return nextRecurringOccurrence(w, now) ? "upcoming" : "ended";
  return "upcoming";
}

/** Turn an ISO 8601 time (or "now") into epoch ms; NaN when unparseable. */
export function parseTime(value: string, now: number): number {
  if (value.trim().toLowerCase() === "now") return now;
  return Date.parse(value);
}

/** One sentence on a new monitor's first check (checks/first-check.ts). */
export function firstCheckText(r: FirstCheckResult | undefined): string {
  if (!r) return "Its first check runs within about 12 minutes.";
  switch (r.status) {
    case "checked":
      return r.ok
        ? `First check: ${r.state}${r.durationMs != null ? ` in ${r.durationMs} ms` : ""}.`
        : `First check failed (${r.error ?? "check_failed"}${r.errorMessage ? `: ${r.errorMessage}` : ""}); it shows warming_up and is checked again on the next run, which alerts if it still fails.`;
    case "scheduled_off":
      return "It is outside its schedule now, so it shows scheduled_off until its hours start.";
    case "maintenance":
      return "A maintenance window covers it now, so it shows maintenance.";
    case "running":
      return "Its first check is still running; get_monitor shows the result in a few seconds.";
    case "skipped":
      return r.reason === "disabled"
        ? "It is disabled, so it isn't checked."
        : "Its first check runs within about 12 minutes.";
  }
}

function writeFailure(r: Extract<MonitorWriteResult, { ok: false }>): ToolResult {
  if (r.error === "plan_limit") {
    return fail(`${r.body.message} Upgrade: ${r.body.upgradeUrl}`, { planLimit: r.body });
  }
  if (r.error === "not_found") return fail("No monitor has that id. Call list_monitors to find it.");
  if (r.error === "type_immutable") return fail("A monitor's type cannot change; create a new monitor instead.");
  return fail(`Invalid monitor: ${describeIssues(r.issues ?? [])}`, { issues: r.issues ?? [] });
}

/** Register every OpenPing tool on `server`. */
export function registerTools(server: McpServer, ctx: ToolContext): void {
  const { env } = ctx;
  let zonePromise: Promise<string> | undefined;
  /** The install's timezone (Settings), read at most once per request. */
  const zone = () =>
    (zonePromise ??= getSetting(env, "timezone").then((tz) => tz || "UTC").catch(() => "UTC"));

  // ------------------------------------------------------------------ read

  server.registerTool(
    "get_status",
    {
      title: "Get status",
      description:
        "Overall health of this OpenPing install: every monitor's current state, last check, latency and 24h uptime, the open incidents, and the latest scheduler run. Start here.",
      annotations: READ,
    },
    async () => {
      const now = Date.now();
      const [overview, open, tz] = await Promise.all([
        buildOverview(env, now),
        listIncidents(env, { status: "open", limit: "20" }),
        zone(),
      ]);
      const counts = overview.counts as Record<string, number>;
      const overall = overallState(counts);
      const run = overview.lastRun as Record<string, unknown> | null;
      const lines = [
        `OpenPing: ${overall.replaceAll("_", " ").toUpperCase()} - ${stateCounts(counts)} (${overview.monitors.length} monitors), ${overview.counts.openIncidents} open incident(s). Times in ${tz}.`,
        run
          ? `Last scheduler run: ${iso(run.startedAt as number, tz)}, ${run.ok ? "ok" : "FAILED"}, ${run.monitorsChecked ?? 0} checked, ${run.checkFailures ?? 0} check failures, ${run.durationMs ?? "?"} ms.`
          : "No scheduler run recorded yet.",
      ];
      if (overview.monitors.length) lines.push("Monitors:");
      for (const m of overview.monitors) {
        lines.push(
          `- ${m.state} ${m.name} [${m.id}] ${m.type}${m.target ? ` ${m.target}` : ""}` +
            ` - since ${iso(m.stateSince, tz) ?? "-"}, last check ${iso(m.lastCheckedAt, tz) ?? "never"}` +
            (m.lastDurationMs != null ? `, ${m.lastDurationMs} ms` : "") +
            (m.lastStatusCode != null ? `, HTTP ${m.lastStatusCode}` : "") +
            (m.lastCheckedAt != null ? `, 24h ${pct(m.uptime24h)}` : ""),
        );
      }
      if (open.incidents.length) {
        lines.push("Open incidents:");
        for (const i of open.incidents) lines.push(incidentLine(i, tz, now));
      }
      return ok(lines.join("\n"), {
        overall,
        timezone: tz,
        counts: overview.counts,
        monitors: overview.monitors.map(({ recentChecks: _r, ...m }) => m),
        openIncidents: open.incidents.map((i) => ({
          id: i.id,
          monitorId: i.monitorId,
          monitorName: i.monitorName,
          startedAt: i.startedAt,
          httpStatus: i.httpStatus,
          error: i.error,
          title: i.title,
        })),
        lastRun: run,
      }, tz);
    },
  );

  server.registerTool(
    "list_monitors",
    {
      title: "List monitors",
      description: "Every monitor with its id, type, target, schedule, paused flag and current state. Use get_monitor for the full configuration.",
      inputSchema: z.object({
        type: z.enum(MONITOR_TYPES).optional().describe("Only monitors of this type."),
      }),
      annotations: READ,
    },
    async ({ type }) => {
      const [all, states, tz] = await Promise.all([
        listMonitors(env),
        env.DB.prepare("SELECT monitor_id, state, last_checked_at FROM monitor_state").all<{
          monitor_id: string;
          state: MonitorState;
          last_checked_at: number | null;
        }>(),
        zone(),
      ]);
      const byId = new Map((states.results ?? []).map((s) => [s.monitor_id, s]));
      const list = all
        .filter((m) => !type || m.type === type)
        .map((m) => ({
          id: m.id,
          name: m.name,
          type: m.type,
          target: monitorTarget(m),
          state: m.paused ? "paused" : (byId.get(m.id)?.state ?? "unknown"),
          enabled: m.enabled,
          paused: m.paused,
          schedule: scheduleSummary(m),
          intervalSeconds: m.intervalSeconds,
          categoryId: m.categoryId,
          publicVisible: m.public.visible,
          lastCheckedAt: byId.get(m.id)?.last_checked_at ?? null,
        }));
      const text = list.length
        ? [`${list.length} monitor(s):`, ...list.map((m) =>
            `- ${m.id} ${m.state} ${m.name} (${m.type}${m.target ? ` ${m.target}` : ""}), ${m.schedule}${m.enabled ? "" : ", disabled"}`,
          )].join("\n")
        : "No monitors yet. Create one with create_monitor.";
      return ok(text, { monitors: list }, tz);
    },
  );

  server.registerTool(
    "get_monitor",
    {
      title: "Get monitor",
      description:
        "One monitor's full configuration and current state. Credentials, header values, request bodies and heartbeat tokens are blanked; they cannot be read back.",
      inputSchema: z.object({ id: monitorId }),
      annotations: READ,
    },
    async ({ id }) => {
      const [m, state, tz] = await Promise.all([
        getMonitor(env, id),
        env.DB.prepare(
          `SELECT state, state_since AS stateSince, last_checked_at AS lastCheckedAt,
                  last_success_at AS lastSuccessAt, last_duration_ms AS lastDurationMs,
                  last_status_code AS lastStatusCode, last_error AS lastError,
                  consecutive_failures AS consecutiveFailures, next_check_at AS nextCheckAt,
                  active_incident_id AS activeIncidentId
           FROM monitor_state WHERE monitor_id = ?`,
        ).bind(id).first<Record<string, unknown>>(),
        zone(),
      ]);
      if (!m) return fail("No monitor has that id. Call list_monitors to find it.");
      const monitor = redactMonitorForMcp(m);
      const text = [
        `${m.name} [${m.id}] ${m.type}, ${m.paused ? "paused" : (state?.state ?? "unknown")}, ${m.enabled ? "enabled" : "disabled"}, ${scheduleSummary(m)}.`,
        state
          ? `Last check ${iso(state.lastCheckedAt as number, tz) ?? "never"}` +
            (state.lastDurationMs != null ? `, ${state.lastDurationMs} ms` : "") +
            (state.lastStatusCode != null ? `, HTTP ${state.lastStatusCode}` : "") +
            (state.lastError ? `, error "${String(state.lastError).slice(0, 200)}"` : "") +
            `; next check ${iso(state.nextCheckAt as number, tz) ?? "-"}.`
          : "Never checked.",
        `config: ${JSON.stringify(monitor.config)}`,
        `schedule: ${JSON.stringify(m.schedule)}`,
        `notify: ${JSON.stringify(m.notify)}; public: ${JSON.stringify(m.public)}`,
        ...(m.type === "http" ? [`assertions: ${JSON.stringify(m.assertions)}`] : []),
      ].join("\n");
      return ok(text, { monitor, state: state ?? null }, tz);
    },
  );

  server.registerTool(
    "list_incidents",
    {
      title: "List incidents",
      description:
        "Incidents, newest first, optionally only open or resolved ones, for one monitor, or since a time. Each includes its status updates (the public timeline), newest first, and whether it is shown on the public status page.",
      inputSchema: z.object({
        status: z.enum(["open", "resolved", "all"]).default("all"),
        monitorId: monitorId.optional(),
        since: z.string().max(64).optional().describe("ISO 8601 time; only incidents that started at or after it."),
        limit: z.number().int().min(1).max(100).default(20),
      }),
      annotations: READ,
    },
    async ({ status, monitorId: mid, since, limit }) => {
      const now = Date.now();
      let from: string | undefined;
      if (since) {
        const ms = parseTime(since, now);
        if (!Number.isFinite(ms)) return fail(`"since" is not an ISO 8601 time: ${since}`);
        from = String(ms);
      }
      const [page, tz] = await Promise.all([
        listIncidents(env, {
          status: status === "all" ? undefined : status,
          monitorId: mid,
          from,
          limit: String(limit),
        }),
        zone(),
      ]);
      const text = page.incidents.length
        ? [`${page.incidents.length} of ${page.total} incident(s):`, ...page.incidents.flatMap((i) => incidentWithUpdatesLines(i, tz, now))].join("\n")
        : "No incidents match.";
      return ok(text, page, tz);
    },
  );

  server.registerTool(
    "get_uptime",
    {
      title: "Get uptime",
      description:
        "Uptime % per monitor over 24h, 7d, 30d and 90d, from the hourly and daily rollups. Off-hours time is never counted. A window with 0 checks has no data.",
      inputSchema: z.object({ monitorId: monitorId.optional().describe("Only this monitor.") }),
      annotations: READ,
    },
    async ({ monitorId: mid }) => {
      const [uptime, tz] = await Promise.all([listMonitorUptime(env), zone()]);
      const monitors = uptime.monitors.filter((m) => !mid || m.id === mid);
      if (mid && !monitors.length) return fail("No monitor has that id. Call list_monitors to find it.");
      const cell = (w: { uptimePct: number; checks: number }) => (w.checks ? pct(w.uptimePct) : "no data");
      const text = monitors.length
        ? ["Uptime (24h / 7d / 30d / 90d):", ...monitors.map((m) =>
            `- ${m.name} [${m.id}]: ${cell(m.d1)} / ${cell(m.d7)} / ${cell(m.d30)} / ${cell(m.d90)}`,
          )].join("\n")
        : "No monitors yet.";
      return ok(text, { windows: uptime.windows, monitors }, tz);
    },
  );

  server.registerTool(
    "get_monthly_report",
    {
      title: "Get monthly uptime report",
      description:
        "Uptime report for one calendar month in the install's timezone: per monitor uptime %, downtime minutes, monitored minutes, incident count and average response time, plus totals. Off-hours are never counted. Computed from the rollups. Defaults to last month; the current month is reported so far (partial).",
      inputSchema: z.object({
        month: z
          .string()
          .regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Use YYYY-MM, e.g. 2026-10.")
          .optional()
          .describe("YYYY-MM; defaults to the previous calendar month."),
      }),
      annotations: READ,
    },
    async ({ month }) => {
      const [r, tz] = await Promise.all([monthlyReportFor(env, month), zone()]);
      if (!r.ok) return fail(r.message);
      const rep = r.report;
      const p = (v: number | null) => (v == null ? "no data" : pct(v));
      const text = [
        `Uptime report for ${rep.month} (${rep.timezone})${rep.partial ? ", so far" : ""}: ${p(rep.totals.uptimePct)} overall, ${rep.totals.downtimeMinutes} min down, ${rep.totals.incidents} incident(s).`,
        ...(rep.monitors.length ? ["Per monitor (uptime, downtime, monitored, incidents, avg response):"] : ["No monitors."]),
        ...rep.monitors.map(
          (m) =>
            `- ${m.name} [${m.id}]: ${p(m.uptimePct)}, ${m.downtimeMinutes} min down, ${m.monitoredMinutes} min monitored, ${m.incidents} incident(s), ${m.avgResponseMs == null ? "-" : `${m.avgResponseMs} ms`}`,
        ),
      ].join("\n");
      return ok(text, { report: { ...rep, from: iso(rep.from, tz), to: iso(rep.to, tz) } }, tz);
    },
  );

  server.registerTool(
    "get_diagnostics",
    {
      title: "Get diagnostics",
      description: "Scheduler health: recent cron runs (checked, skipped, failures, duration, D1 queries) and table counts.",
      inputSchema: z.object({ runs: z.number().int().min(1).max(20).default(10).describe("How many recent runs.") }),
      annotations: READ,
    },
    async ({ runs }) => {
      const [d, tz] = await Promise.all([buildDiagnostics(env), zone()]);
      const recentRuns = d.recentRuns.slice(0, runs);
      const c = d.counts;
      const text = [
        `Database ${d.dbOk ? "ok" : "UNREACHABLE"}. ${c.monitors} monitors (${c.monitorsEnabled} enabled), ${c.incidentsOpen} open incidents, ${c.samples} samples, ${c.summaries} summaries, outbox ${c.outboxPending} pending / ${c.outboxDead} dead.`,
        `Last successful run: ${iso(d.lastSuccessfulRun?.startedAt, tz) ?? "never"}; last failed run: ${iso(d.lastFailedRun?.startedAt, tz) ?? "never"}.`,
        ...(recentRuns.length ? ["Recent runs:"] : []),
        ...recentRuns.map((r) =>
          `- ${iso(r.startedAt, tz)} ${r.ok ? "ok" : r.ok === 0 ? "FAILED" : "running"}, ${r.monitorsChecked ?? 0} checked, ${r.monitorsSkipped ?? 0} skipped, ${r.checkFailures ?? 0} check failures, ${r.durationMs ?? "?"} ms, ${r.d1Queries ?? "?"} D1 queries${r.error ? `, error "${r.error.slice(0, 200)}"` : ""}`,
        ),
      ].join("\n");
      return ok(text, { ...d, recentRuns }, tz);
    },
  );

  server.registerTool(
    "get_key_status",
    {
      title: "Get encryption key status",
      description:
        "MASTER_KEY rotation status: current and previous key ids, protected values per storage class by key, values no key can open (by location, never values), and whether MASTER_KEY_PREVIOUS is safe to delete.",
      inputSchema: z.object({}),
      annotations: READ,
    },
    async () => {
      const [s, tz] = await Promise.all([rekeyStatus(env), zone()]);
      const text = [
        s.summary,
        `Current key id: ${s.currentKeyId ?? "not configured"}; previous key: ${
          !s.previousKey.configured ? "not set" : s.previousKey.valid ? s.previousKey.keyId : "INVALID"
        }.`,
        ...s.classes.map(
          (c) =>
            `- ${c.label}: ${c.current} current, ${c.previous} previous key, ${c.legacy} legacy format, ${c.unsealed} not encrypted, ${c.unreadable} unreadable`,
        ),
        ...s.unreadable.map((u) => `- unreadable: ${u.class} ${u.id} ${u.field} (${u.reason})`),
      ].join("\n");
      return ok(text, { ...s }, tz);
    },
  );

  server.registerTool(
    "list_channels",
    {
      title: "List notification channels",
      description: "Notification channels (email, Discord, Slack, Microsoft Teams, Telegram, webhook, push) with delivery health. Webhook URLs, webhook secrets and Telegram bot tokens are blanked.",
      annotations: READ,
    },
    async () => {
      const [list, tz] = await Promise.all([listChannels(env), zone()]);
      const channels = list.map(redactChannel);
      const text = channels.length
        ? [`${channels.length} channel(s):`, ...channels.map((ch) => {
            const healthy = ch.lastFailureAt == null || (ch.lastSuccessAt != null && ch.lastSuccessAt >= ch.lastFailureAt);
            return `- ${ch.id} ${ch.type} ${ch.name ?? ""}${ch.enabled ? "" : " (disabled)"}, ${healthy ? "healthy" : `failing: ${ch.lastError ?? "unknown error"}`}`;
          })].join("\n")
        : "No notification channels.";
      return ok(text, { channels }, tz);
    },
  );

  server.registerTool(
    "list_status_pages",
    {
      title: "List status pages",
      description: "Public status pages with their slug, URL, enabled flag and which monitors they show.",
      annotations: READ,
    },
    async () => {
      const [list, tz] = await Promise.all([listStatusPages(env), zone()]);
      const statusPages = list.map((p) => ({
        ...p,
        url: `${ctx.origin}/status${p.isDefault ? "" : `/${p.slug}`}`,
      }));
      const text = statusPages.length
        ? [`${statusPages.length} status page(s):`, ...statusPages.map((p) =>
            `- ${p.id} "${p.name}" ${p.url}${p.isDefault ? " (default)" : ""}, ${p.enabled ? "enabled" : "disabled"}, shows ${p.includeMode === "all" ? "all public monitors" : `selected ${p.includeMode}`}`,
          )].join("\n")
        : "No status pages.";
      return ok(text, { statusPages }, tz);
    },
  );

  server.registerTool(
    "list_categories",
    { title: "List categories", description: "Monitor categories (groups) with their slugs.", annotations: READ },
    async () => {
      const [categories, tz] = await Promise.all([listCategories(env), zone()]);
      const text = categories.length
        ? [`${categories.length} categor${categories.length === 1 ? "y" : "ies"}:`, ...categories.map((c) => `- ${c.id} ${c.name} (${c.slug})`)].join("\n")
        : "No categories.";
      return ok(text, { categories }, tz);
    },
  );

  server.registerTool(
    "list_maintenance",
    {
      title: "List maintenance windows",
      description: "Maintenance windows, which suppress incidents and alerts while active. Each is marked active, upcoming or ended.",
      inputSchema: z.object({ status: z.enum(["active", "upcoming", "ended", "all"]).default("all") }),
      annotations: READ,
    },
    async ({ status }) => {
      const now = Date.now();
      const [list, tz] = await Promise.all([listMaintenanceWindows(env), zone()]);
      const windows = list
        .map((w) => ({ ...w, status: maintenanceStatus(w, now) }))
        .filter((w) => status === "all" || w.status === status);
      const text = windows.length
        ? [`${windows.length} window(s):`, ...windows.map((w) =>
            `- ${w.id} ${w.status} "${w.title ?? "Maintenance"}" ${w.scope === "global" ? "all monitors" : `monitors ${w.monitorIds?.join(",")}`}, ${iso(w.startsAt, tz)} to ${iso(w.endsAt, tz)}` +
              (w.recurrence ? `, weekly on day ${w.recurrence.weekday} at ${w.recurrence.start} UTC for ${w.recurrence.durationMinutes}m` : ""),
          )].join("\n")
        : "No maintenance windows match.";
      return ok(text, { windows }, tz);
    },
  );

  // ----------------------------------------------------------------- write

  const monitorFields = {
    name: z.string().max(120).optional().describe("Display name, 1-120 characters."),
    enabled: z.boolean().optional(),
    confirmFailures: z
      .enum(["retry", "off"])
      .optional()
      .describe(
        'Polled monitors: "retry" (default) re-checks a failure once, 5 seconds later, and alerts only if that fails too; "off" alerts on the first failed check.',
      ),
    schedule: anyObject()
      .optional()
      .describe(
        'When to check. {"mode":"always"} (default), {"mode":"business_hours","weekdays":[1,2,3,4,5],"start":"08:00","end":"17:00","timezone":"America/Los_Angeles"} (0=Sunday), or {"mode":"custom",...}. Off-hours never count as downtime.',
      ),
    notify: anyObject().optional().describe('{"channels":["<channel id>"]} from list_channels.'),
    public: anyObject()
      .optional()
      .describe('Status page settings, e.g. {"visible":true,"name":"API","showUptime":true}.'),
    categoryId: z.string().max(64).nullable().optional().describe("Category id from list_categories, or null."),
    assertions: z
      .array(anyObject())
      .max(50)
      .optional()
      .describe('HTTP only, e.g. [{"kind":"contains","value":"ok"}].'),
  };

  server.registerTool(
    "create_monitor",
    {
      title: "Create monitor",
      description: [
        "Create a monitor. Validated exactly like the web editor. Polled monitors run every 12 minutes.",
        'http config: {"url":"https://...","method":"GET","expectedStatus":{"min":200,"max":399},"timeoutMs":60000}.',
        'heartbeat config: {"intervalSeconds":3600,"graceSeconds":300}; the result has the ping URL, shown only this once.',
        'dns: {"hostname":"example.com","recordType":"A"}. tcp: {"host":"db.example.com","port":5432}. domain: {"domain":"example.com","warnDays":30}.',
      ].join(" "),
      inputSchema: z.object({
        type: z.enum(MONITOR_TYPES),
        ...monitorFields,
        name: z.string().max(120).describe("Display name, 1-120 characters."),
        config: anyObject().describe("Type-specific settings (see the description)."),
      }),
      annotations: { ...WRITE, idempotentHint: false },
    },
    async (args) => {
      const r = await createMonitorAndCheck(env, args, ctx.waitUntil, ctx.plan);
      if (!r.ok) return writeFailure(r);
      ctx.usageChanged?.();
      const tz = await zone();
      const created = presentCreatedMonitor(r.monitor);
      const monitor = { ...redactMonitorForMcp(r.monitor), heartbeatToken: created.heartbeatToken };
      const pingUrl = created.heartbeatToken ? `${ctx.origin}/hb/${created.heartbeatToken}` : null;
      const text =
        `Created ${monitor.type} monitor "${monitor.name}" [${monitor.id}], ${scheduleSummary(r.monitor)}. ` +
        (monitor.type === "heartbeat"
          ? `It expects a ping every ${duration(r.monitor.intervalSeconds)} (plus ${duration(r.monitor.graceSeconds)} grace).`
          : firstCheckText(r.firstCheck)) +
        (pingUrl ? `\nHeartbeat ping URL (shown only now; store it securely): ${pingUrl}` : "");
      return ok(
        text,
        { monitor, firstCheck: r.firstCheck ?? null, ...(pingUrl ? { heartbeatUrl: pingUrl } : {}) },
        tz,
      );
    },
  );

  server.registerTool(
    "update_monitor",
    {
      title: "Update monitor",
      description:
        "Change some of a monitor's settings; fields you leave out keep their value. config and public are merged key by key (set a config key to null to remove it); schedule, notify and assertions are replaced whole. Stored credentials are kept unless you send new ones. The type cannot change.",
      inputSchema: z.object({
        id: monitorId,
        ...monitorFields,
        config: anyObject().optional().describe("Config keys to change, e.g. {\"url\":\"https://...\"}."),
      }),
      annotations: { ...WRITE, idempotentHint: true },
    },
    async ({ id, ...patch }) => {
      const r = await patchMonitor(env, id, patch, ctx.plan);
      if (!r.ok) return writeFailure(r);
      const tz = await zone();
      return ok(`Updated "${r.monitor.name}" [${r.monitor.id}].`, { monitor: redactMonitorForMcp(r.monitor) }, tz);
    },
  );

  for (const [name, paused] of [["pause_monitor", true], ["resume_monitor", false]] as const) {
    server.registerTool(
      name,
      {
        title: paused ? "Pause monitor" : "Resume monitor",
        description: paused
          ? "Stop checking a monitor and stop its alerts until resumed. Paused time is not downtime."
          : "Start checking a paused monitor again.",
        inputSchema: z.object({ id: monitorId }),
        annotations: { ...WRITE, idempotentHint: true },
      },
      async ({ id }) => {
        const m = await setPaused(env, id, paused);
        if (!m) return fail("No monitor has that id. Call list_monitors to find it.");
        return ok(`${paused ? "Paused" : "Resumed"} "${m.name}" [${m.id}].`, { monitor: redactMonitorForMcp(m) }, await zone());
      },
    );
  }

  server.registerTool(
    "create_maintenance_window",
    {
      title: "Create maintenance window",
      description:
        "Schedule maintenance: while active, the covered monitors show Maintenance and open no incidents or alerts. Give endsAt or durationMinutes. Times are ISO 8601 with an offset, or \"now\".",
      inputSchema: z.object({
        title: z.string().max(200).optional(),
        scope: z.enum(["global", "monitors"]).default("global").describe("global covers every monitor."),
        monitorIds: z.array(z.string().max(64)).max(200).optional().describe("Required when scope is monitors."),
        startsAt: z.string().max(64).default("now"),
        endsAt: z.string().max(64).optional(),
        durationMinutes: z.number().int().min(1).max(525600).optional(),
        recurrence: z
          .object({
            type: z.literal("weekly"),
            weekday: z.number().int().min(0).max(6),
            start: z.string(),
            durationMinutes: z.number().int().positive(),
          })
          .nullable()
          .optional()
          .describe("Weekly repeat (UTC weekday 0=Sunday, start HH:MM UTC) between startsAt and endsAt."),
        publicMessage: z.string().max(2000).optional().describe("Shown on the public status page."),
        privateNotes: z.string().max(2000).optional(),
      }),
      annotations: { ...WRITE, idempotentHint: false },
    },
    async ({ startsAt, endsAt, durationMinutes, ...rest }) => {
      const now = Date.now();
      const start = parseTime(startsAt, now);
      if (!Number.isFinite(start)) return fail(`startsAt is not an ISO 8601 time: ${startsAt}`);
      let end: number;
      if (endsAt !== undefined) {
        end = parseTime(endsAt, now);
        if (!Number.isFinite(end)) return fail(`endsAt is not an ISO 8601 time: ${endsAt}`);
      } else if (durationMinutes !== undefined) {
        end = start + durationMinutes * 60_000;
      } else {
        return fail("Give endsAt or durationMinutes.");
      }
      const parsed = maintenanceCreateSchema.safeParse({ ...rest, startsAt: start, endsAt: end });
      if (!parsed.success) {
        return fail(`Invalid maintenance window: ${describeIssues(parsed.error.issues)}`, { issues: parsed.error.issues });
      }
      const window = await createMaintenanceWindow(env, parsed.data);
      const tz = await zone();
      return ok(
        `Created maintenance window ${window.id} "${window.title ?? "Maintenance"}", ${iso(window.startsAt, tz)} to ${iso(window.endsAt, tz)} (${maintenanceStatus(window, now)}).`,
        { window: { ...window, status: maintenanceStatus(window, now) } },
        tz,
      );
    },
  );

  server.registerTool(
    "post_incident_update",
    {
      title: "Post incident update",
      description:
        "Add a status update to an incident's timeline: investigating, identified, monitoring or resolved, with a message. It shows on the public status page and its RSS/Atom feeds only while the incident is public. It describes the incident and does not open or close it. Write it for the public. It also alerts the incident's monitor's notification channels (sent with the next check run, within 12 minutes) unless notify is false.",
      inputSchema: z.object({
        id: z.string().min(1).max(64).describe("Incident id (inc_...), from list_incidents."),
        status: z.enum(INCIDENT_UPDATE_STATUSES),
        message: z.string().min(1).max(MAX_UPDATE_MESSAGE).describe("What happened or what is being done, for the public."),
        notify: z
          .boolean()
          .optional()
          .describe("Alert the monitor's notification channels about this update. Default true; false posts it quietly."),
      }),
      annotations: { ...WRITE, idempotentHint: false },
    },
    async ({ id, status, message, notify }) => {
      const trimmed = message.trim();
      if (!trimmed) return fail("The message is empty.");
      const r = await postIncidentUpdate(env, id, { status, message: trimmed, notify });
      if (!r.ok) {
        return fail(
          r.error === "not_found"
            ? "No incident has that id. Call list_incidents to find it."
            : "This incident already has the most updates allowed (100).",
        );
      }
      const tz = await zone();
      const visible = await env.DB.prepare("SELECT public FROM incidents WHERE id = ?")
        .bind(id)
        .first<{ public: number }>();
      return ok(
        `Posted "${INCIDENT_UPDATE_LABELS[status]}" to incident ${id} at ${iso(r.update.postedAt, tz)}.` +
          (visible?.public ? "" : " The incident is not public, so the update is not on the status page yet.") +
          " " +
          alertSentence(notify !== false, r.alertsQueued, r.alertsError),
        { update: r.update, alertsQueued: r.alertsQueued, ...(r.alertsError ? { alertsError: r.alertsError } : {}) },
        tz,
      );
    },
  );

  server.registerTool(
    "end_maintenance_window",
    {
      title: "End maintenance window",
      description:
        "End an active maintenance window now (a weekly one also stops recurring). Ending one that is over does nothing; one that has not started must be deleted instead.",
      inputSchema: z.object({ id: z.string().min(1).max(64).describe("Window id (mw_...), from list_maintenance.") }),
      annotations: { ...WRITE, idempotentHint: true },
    },
    async ({ id }) => {
      const r = await endMaintenanceWindow(env, id);
      if (!r) return fail("No maintenance window has that id. Call list_maintenance to find it.");
      if (r.outcome === "not_started") {
        return fail("This window has not started yet. To cancel it, call delete_maintenance_window.");
      }
      const tz = await zone();
      return ok(
        r.outcome === "ended"
          ? `Ended maintenance window ${id} at ${iso(r.window.endsAt, tz)}.`
          : `Maintenance window ${id} had already ended at ${iso(r.window.endsAt, tz)}; nothing changed.`,
        { outcome: r.outcome, window: r.window },
        tz,
      );
    },
  );

  server.registerTool(
    "update_status_page",
    {
      title: "Update status page",
      description:
        "Change some of a status page's settings; fields you leave out keep their value and null clears an optional text field. Fields: name, description, slug, enabled, includeMode (all|categories|monitors), categoryIds, monitorIds, theme (dark|light|system), accent (#hex), logo, homepage, footer, attribution, sortOrder.",
      inputSchema: z.object({
        id: z.string().min(1).max(64).describe("Status page id (sp_...), from list_status_pages."),
        name: z.string().max(120).optional(),
        description: z.string().max(1000).nullable().optional(),
        slug: z.string().max(64).optional(),
        enabled: z.boolean().optional(),
        includeMode: z.enum(["all", "categories", "monitors"]).optional(),
        categoryIds: z.array(z.string().max(64)).max(200).optional(),
        monitorIds: z.array(z.string().max(64)).max(1000).optional(),
        theme: z.enum(["dark", "light", "system"]).optional(),
        accent: z.string().max(16).optional(),
        logo: z.string().max(2048).nullable().optional(),
        homepage: z.string().max(2048).nullable().optional(),
        footer: z.string().max(2000).nullable().optional(),
        attribution: z.boolean().optional(),
        sortOrder: z.number().int().optional(),
      }),
      annotations: { ...WRITE, idempotentHint: true },
    },
    async ({ id, ...patch }) => {
      const r = await patchStatusPage(env, id, patch);
      if (!r.ok) {
        if (r.error === "not_found") return fail("No status page has that id. Call list_status_pages to find it.");
        if (r.error === "slug_conflict") return fail(r.message ?? "Another status page already uses that slug.");
        return fail(`Invalid status page: ${describeIssues(r.issues ?? [])}`, { issues: r.issues ?? [] });
      }
      const p = r.statusPage;
      const url = `${ctx.origin}/status${p.isDefault ? "" : `/${p.slug}`}`;
      return ok(`Updated status page "${p.name}" (${url}).`, { statusPage: { ...p, url } }, await zone());
    },
  );

  // ----------------------------------------------------------- destructive

  const needsConfirm = (consequence: string) =>
    fail(`Not done: ${consequence} Ask the user to confirm, then call again with confirm: true.`);

  server.registerTool(
    "delete_monitor",
    {
      title: "Delete monitor",
      description:
        "Permanently delete a monitor and all of its history, incidents and queued alerts. Cannot be undone. Requires confirm: true, which you may only set after the user explicitly agrees. To stop checks temporarily, use pause_monitor.",
      inputSchema: z.object({ id: monitorId, confirm }),
      annotations: DESTRUCTIVE,
    },
    async ({ id, confirm: yes }) => {
      if (yes !== true) return needsConfirm("deleting a monitor removes its history for good.");
      const m = await getMonitor(env, id);
      if (!m) return fail("No monitor has that id. Call list_monitors to find it.");
      await deleteMonitor(env, id);
      ctx.usageChanged?.();
      return ok(`Deleted monitor "${m.name}" [${id}] and its history.`, { deleted: { id, name: m.name } }, await zone());
    },
  );

  server.registerTool(
    "delete_maintenance_window",
    {
      title: "Delete maintenance window",
      description:
        "Permanently delete a maintenance window (to cancel one that has not started, or remove an old one). Cannot be undone. Requires confirm: true, which you may only set after the user explicitly agrees.",
      inputSchema: z.object({ id: z.string().min(1).max(64).describe("Window id (mw_...)."), confirm }),
      annotations: DESTRUCTIVE,
    },
    async ({ id, confirm: yes }) => {
      if (yes !== true) return needsConfirm("a deleted maintenance window cannot be restored.");
      const w = await getMaintenanceWindow(env, id);
      if (!w) return fail("No maintenance window has that id. Call list_maintenance to find it.");
      await deleteMaintenanceWindow(env, id);
      return ok(`Deleted maintenance window ${id}.`, { deleted: { id, title: w.title } }, await zone());
    },
  );

  server.registerTool(
    "rotate_heartbeat_token",
    {
      title: "Rotate heartbeat token",
      description:
        "Replace a heartbeat monitor's ping URL with a new one, shown only in this result. The old URL stops working at once, so every job that pings it must be updated. Requires confirm: true, which you may only set after the user explicitly agrees.",
      inputSchema: z.object({ id: monitorId, confirm }),
      annotations: { ...DESTRUCTIVE, idempotentHint: false },
    },
    async ({ id, confirm: yes }) => {
      if (yes !== true) return needsConfirm("rotating the token stops the current ping URL from working.");
      const token = await rotateHeartbeatToken(env, id);
      if (!token) return fail("No heartbeat monitor has that id. Call list_monitors with type heartbeat.");
      const heartbeatUrl = `${ctx.origin}/hb/${token}`;
      return ok(
        `New heartbeat ping URL for ${id} (shown only now; store it securely): ${heartbeatUrl}`,
        { id, heartbeatToken: token, heartbeatUrl },
        await zone(),
      );
    },
  );
}
