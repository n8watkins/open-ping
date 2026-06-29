import { Hono } from "hono";
import type { AppEnv, Env } from "../types";
import { requireAuth } from "../middleware/auth";
import { getJSON } from "../db/settings";

/**
 * Diagnostics + usage-estimate API mounted at /api/diagnostics (PRD §19, §25).
 * Admin-only: surfaces scheduler health, table counts and OpenPing's *own*
 * usage estimates. The usage numbers are deliberately labelled as estimates —
 * Cloudflare's dashboard is the authoritative source for billing/limits.
 *
 * All routes require an authenticated session (auth middleware also enforces
 * CSRF on mutations — there are none here, but the guard is uniform).
 */
export const diagnostics = new Hono<AppEnv>();

diagnostics.use("*", requireAuth);

const VERSION = "0.1.0";

/** Cron fires every 12 minutes (PRD §25). */
const CRON_INTERVAL_MINUTES = 12;
const SECONDS_PER_DAY = 86400;
/** Default check cadence when no monitors exist to sample a real interval. */
const DEFAULT_INTERVAL_SECONDS = 720;
/** Very rough per-row footprint used only for a ballpark DB size estimate. */
const BYTES_PER_ROW = 256;

/** Retention horizons (informational; see PRD §22 history pipeline). */
interface RetentionConfig {
  /** How long raw samples are kept. */
  sampleHours: number;
  /** How long hourly summaries are kept. */
  hourlyDays: number;
  /** How long daily summaries are kept. */
  dailyDays: number;
}

const DEFAULT_RETENTION: RetentionConfig = {
  sampleHours: 24,
  hourlyDays: 35,
  dailyDays: 400,
};

/**
 * Pure helper: derive OpenPing's own usage estimates from current sizing.
 * No DB or runtime access so it is trivially unit-testable. These are
 * estimates only — authoritative usage lives in the Cloudflare dashboard.
 */
export function estimateUsage(input: {
  monitors: number;
  intervalSeconds: number;
  sampleRows: number;
  summaryRows: number;
  incidentRows: number;
}): {
  scheduledExecutionsPerDay: number;
  httpChecksPerDay: number;
  dbReadsPerDayEstimate: number;
  dbWritesPerDayEstimate: number;
  estimatedDbBytes: number;
  note: string;
} {
  const monitors = Math.max(0, input.monitors);
  const intervalSeconds =
    input.intervalSeconds > 0 ? input.intervalSeconds : DEFAULT_INTERVAL_SECONDS;
  const sampleRows = Math.max(0, input.sampleRows);
  const summaryRows = Math.max(0, input.summaryRows);
  const incidentRows = Math.max(0, input.incidentRows);

  // Cron runs every 12 min => 24*60/12 = 120 scheduled executions/day.
  const scheduledExecutionsPerDay = Math.round(
    (24 * 60) / CRON_INTERVAL_MINUTES,
  );

  // Each enabled monitor is checked once per interval.
  const checksPerMonitorPerDay = SECONDS_PER_DAY / intervalSeconds;
  const httpChecksPerDay = Math.round(monitors * checksPerMonitorPerDay);

  // Rough: every check reads its current state row; each scheduled execution
  // also reads the due-monitor set + a few config/lock rows.
  const dbReadsPerDayEstimate = Math.round(
    httpChecksPerDay + scheduledExecutionsPerDay * 4,
  );

  // Rough: every check writes a sample plus a state update (a small factor).
  const dbWritesPerDayEstimate = Math.round(httpChecksPerDay * 2);

  // Very rough ballpark; real row sizes vary with payload/error text.
  const estimatedDbBytes =
    (sampleRows + summaryRows + incidentRows) * BYTES_PER_ROW;

  return {
    scheduledExecutionsPerDay,
    httpChecksPerDay,
    dbReadsPerDayEstimate,
    dbWritesPerDayEstimate,
    estimatedDbBytes,
    note: "estimates only; see Cloudflare dashboard for authoritative usage",
  };
}

interface SchedulerRunRow {
  id: string;
  cron: string | null;
  started_at: number;
  finished_at: number | null;
  ok: number | null;
  monitors_checked: number | null;
  monitors_skipped: number | null;
  check_failures: number | null;
  notification_failures: number | null;
  duration_ms: number | null;
  error: string | null;
}

function mapRun(r: SchedulerRunRow) {
  return {
    id: r.id,
    cron: r.cron,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    ok: r.ok,
    monitorsChecked: r.monitors_checked,
    monitorsSkipped: r.monitors_skipped,
    checkFailures: r.check_failures,
    notificationFailures: r.notification_failures,
    durationMs: r.duration_ms,
    error: r.error,
  };
}

const RUN_COLUMNS =
  "id, cron, started_at, finished_at, ok, monitors_checked, monitors_skipped, check_failures, notification_failures, duration_ms, error";

async function countRows(
  env: Env,
  sql: string,
  binds: unknown[] = [],
): Promise<number> {
  const stmt = env.DB.prepare(sql);
  const row = await (binds.length ? stmt.bind(...binds) : stmt).first<{
    n: number;
  }>();
  return row?.n ?? 0;
}

async function gatherCounts(env: Env) {
  const [
    monitors,
    monitorsEnabled,
    incidentsOpen,
    samples,
    summaries,
    pushSubscriptions,
    channels,
    outboxPending,
    outboxDead,
  ] = await Promise.all([
    countRows(env, "SELECT COUNT(*) AS n FROM monitors"),
    countRows(env, "SELECT COUNT(*) AS n FROM monitors WHERE enabled = 1"),
    countRows(env, "SELECT COUNT(*) AS n FROM incidents WHERE status = 'open'"),
    countRows(env, "SELECT COUNT(*) AS n FROM samples"),
    countRows(env, "SELECT COUNT(*) AS n FROM summaries"),
    countRows(env, "SELECT COUNT(*) AS n FROM push_subscriptions"),
    countRows(env, "SELECT COUNT(*) AS n FROM notification_channels"),
    countRows(
      env,
      "SELECT COUNT(*) AS n FROM notification_outbox WHERE status = 'pending'",
    ),
    countRows(
      env,
      "SELECT COUNT(*) AS n FROM notification_outbox WHERE status = 'dead'",
    ),
  ]);

  return {
    monitors,
    monitorsEnabled,
    incidentsOpen,
    samples,
    summaries,
    pushSubscriptions,
    channels,
    outboxPending,
    outboxDead,
  };
}

diagnostics.get("/", async (c) => {
  const env = c.env;

  let dbOk = false;
  try {
    await env.DB.prepare("SELECT 1 AS one").first();
    dbOk = true;
  } catch {
    dbOk = false;
  }

  const [lastSuccessful, lastFailed, recent, counts] = await Promise.all([
    env.DB.prepare(
      `SELECT ${RUN_COLUMNS} FROM scheduler_runs WHERE ok = 1 ORDER BY started_at DESC LIMIT 1`,
    ).first<SchedulerRunRow>(),
    env.DB.prepare(
      `SELECT ${RUN_COLUMNS} FROM scheduler_runs WHERE ok = 0 ORDER BY started_at DESC LIMIT 1`,
    ).first<SchedulerRunRow>(),
    env.DB.prepare(
      `SELECT ${RUN_COLUMNS} FROM scheduler_runs ORDER BY started_at DESC LIMIT 20`,
    ).all<SchedulerRunRow>(),
    gatherCounts(env),
  ]);

  return c.json({
    version: VERSION,
    dbOk,
    lastSuccessfulRun: lastSuccessful ? mapRun(lastSuccessful) : null,
    lastFailedRun: lastFailed ? mapRun(lastFailed) : null,
    recentRuns: (recent.results ?? []).map(mapRun),
    counts,
  });
});

diagnostics.get("/usage", async (c) => {
  const env = c.env;

  const stored = await getJSON<Partial<RetentionConfig>>(env, "retention");
  const retention: RetentionConfig = { ...DEFAULT_RETENTION, ...(stored ?? {}) };

  const counts = await gatherCounts(env);

  // Representative cadence: the tightest interval among enabled monitors drives
  // the worst-case check volume. Falls back to the default when none exist.
  const intervalRow = await env.DB.prepare(
    "SELECT MIN(interval_seconds) AS n FROM monitors WHERE enabled = 1",
  ).first<{ n: number | null }>();
  const intervalSeconds = intervalRow?.n ?? DEFAULT_INTERVAL_SECONDS;

  const incidentRows = await countRows(
    env,
    "SELECT COUNT(*) AS n FROM incidents",
  );

  const usage = estimateUsage({
    monitors: counts.monitorsEnabled,
    intervalSeconds,
    sampleRows: counts.samples,
    summaryRows: counts.summaries,
    incidentRows,
  });

  return c.json({
    ...usage,
    intervalSeconds,
    retention,
    counts: { ...counts, incidents: incidentRows },
  });
});
