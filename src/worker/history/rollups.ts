import type { Env } from "../types";
import type { LabeledStatement } from "../lib/batch";

/**
 * Historical compaction (PRD §17). Check results land as recent `samples` and
 * are continuously folded into HOUR `summaries`. A periodic pass rolls
 * HOUR → DAY and DAY → MONTH, then prunes the expired tiers. Retention horizons
 * are read from the `retention` setting (and reported by routes/diagnostics):
 *
 *   samples (sampleHours) → hourly (hourlyDays) → daily (dailyDays) → monthly (forever)
 *
 * A derived bucket is recomputed only while ALL of its source rows are still
 * retained; once its sources age past their horizon the bucket is "sealed" at
 * its last full value, so pruning the sources can never silently shrink it.
 * Per-sample accumulation is an additive upsert keyed by (monitor_id, period,
 * bucket_start); derived passes write absolute recomputed totals. All time math
 * is plain UTC epoch-ms - no Node APIs, no timezone libraries.
 */

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** Retention horizons. Defaults MUST match DEFAULT_RETENTION in routes/diagnostics. */
export interface RetentionConfig {
  sampleHours: number;
  hourlyDays: number;
  dailyDays: number;
}
const DEFAULT_RETENTION: RetentionConfig = {
  sampleHours: 24,
  // 64 days keeps every hour of last month (in any timezone) until this month
  // ends, so the monthly uptime report (reports/monthly.ts) never has to
  // prorate a UTC day row at the month's edges.
  hourlyDays: 64,
  dailyDays: 400,
};

/** A summary's numeric accumulator columns - shared by samples, hour/day/month rows. */
export interface SummaryTotals {
  checks: number;
  ok_checks: number;
  fail_checks: number;
  retry_recoveries: number;
  sum_latency_ms: number;
  min_latency_ms: number | null;
  max_latency_ms: number | null;
  monitored_seconds: number;
  down_seconds: number;
}

/**
 * UTC bucket start in epoch ms for the given period. PURE.
 *  - hour:  floored to the top of the hour
 *  - day:   UTC midnight
 *  - month: first day of the month at 00:00 UTC
 */
export function bucketStart(period: "hour" | "day" | "month", at: number): number {
  const d = new Date(at);
  switch (period) {
    case "hour":
      return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours());
    case "day":
      return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    case "month":
      return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  }
}

/**
 * Sum a set of summary rows into one total. Min/max ignore NULL inputs and stay
 * NULL when no row carries a latency. PURE - used by both rollup passes.
 */
export function aggregateSummaries(rows: SummaryTotals[]): SummaryTotals {
  const out: SummaryTotals = {
    checks: 0,
    ok_checks: 0,
    fail_checks: 0,
    retry_recoveries: 0,
    sum_latency_ms: 0,
    min_latency_ms: null,
    max_latency_ms: null,
    monitored_seconds: 0,
    down_seconds: 0,
  };
  for (const r of rows) {
    out.checks += r.checks;
    out.ok_checks += r.ok_checks;
    out.fail_checks += r.fail_checks;
    out.retry_recoveries += r.retry_recoveries;
    out.sum_latency_ms += r.sum_latency_ms;
    out.monitored_seconds += r.monitored_seconds;
    out.down_seconds += r.down_seconds;
    if (r.min_latency_ms != null) {
      out.min_latency_ms =
        out.min_latency_ms == null ? r.min_latency_ms : Math.min(out.min_latency_ms, r.min_latency_ms);
    }
    if (r.max_latency_ms != null) {
      out.max_latency_ms =
        out.max_latency_ms == null ? r.max_latency_ms : Math.max(out.max_latency_ms, r.max_latency_ms);
    }
  }
  return out;
}

/**
 * Latency (ms) a single check contributes to `sum_latency_ms`. Only OK checks
 * contribute, so the weekly `avgResponseMs = sum_latency_ms / ok_checks` divides
 * a numerator and denominator that cover the SAME set of checks. A non-finite or
 * absent duration contributes 0. PURE - exported for unit testing.
 */
export function okLatencyMs(ok: boolean, durationMs?: number | null): number {
  if (!ok) return 0;
  return typeof durationMs === "number" && Number.isFinite(durationMs)
    ? durationMs
    : 0;
}

/**
 * Fold a single check result into its HOUR summary bucket. Additive upsert keyed
 * by (monitor_id, period='hour', bucket_start): incrementing the existing row on
 * conflict, so it is safe under concurrent/retried writes. min/max track every
 * responding check (COALESCE the existing, possibly NULL value); sum_latency_ms
 * counts only OK checks so the weekly average divides over a consistent set.
 */
export async function recordCheckSample(env: Env, monitorId: string, s: CheckSampleTotals): Promise<void> {
  await checkSampleStatement(env, monitorId, s).run();
}

export interface CheckSampleTotals {
  at: number;
  ok: boolean;
  durationMs?: number | null;
  retryRecovered?: boolean;
  monitoredSeconds: number;
  downSeconds: number;
}

/** The hour-bucket upsert for one check, as a statement, so a caller can batch it. */
export function checkSampleStatement(env: Env, monitorId: string, s: CheckSampleTotals): D1PreparedStatement {
  const bucket = bucketStart("hour", s.at);
  const id = `${monitorId}:hour:${bucket}`;
  const hasLatency = typeof s.durationMs === "number" && Number.isFinite(s.durationMs);
  const latency = hasLatency ? (s.durationMs as number) : null;

  return env.DB.prepare(
    `INSERT INTO summaries
       (id, monitor_id, period, bucket_start, checks, ok_checks, fail_checks,
        retry_recoveries, sum_latency_ms, min_latency_ms, max_latency_ms,
        monitored_seconds, down_seconds)
     VALUES (?, ?, 'hour', ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(monitor_id, period, bucket_start) DO UPDATE SET
       checks = checks + 1,
       ok_checks = ok_checks + excluded.ok_checks,
       fail_checks = fail_checks + excluded.fail_checks,
       retry_recoveries = retry_recoveries + excluded.retry_recoveries,
       sum_latency_ms = sum_latency_ms + excluded.sum_latency_ms,
       min_latency_ms = CASE
         WHEN excluded.min_latency_ms IS NULL THEN min_latency_ms
         ELSE MIN(COALESCE(min_latency_ms, excluded.min_latency_ms), excluded.min_latency_ms)
       END,
       max_latency_ms = CASE
         WHEN excluded.max_latency_ms IS NULL THEN max_latency_ms
         ELSE MAX(COALESCE(max_latency_ms, excluded.max_latency_ms), excluded.max_latency_ms)
       END,
       monitored_seconds = monitored_seconds + excluded.monitored_seconds,
       down_seconds = down_seconds + excluded.down_seconds`,
  )
    .bind(
      id,
      monitorId,
      bucket,
      s.ok ? 1 : 0,
      s.ok ? 0 : 1,
      s.retryRecovered ? 1 : 0,
      okLatencyMs(s.ok, s.durationMs), // sum_latency_ms: OK checks only
      latency, // min_latency_ms: any responding check
      latency, // max_latency_ms: any responding check
      s.monitoredSeconds,
      s.downSeconds,
    );
}

/** SELECT-able subset of `summaries` used when re-aggregating a derived bucket. */
const TOTALS_COLUMNS =
  "checks, ok_checks, fail_checks, retry_recoveries, sum_latency_ms, " +
  "min_latency_ms, max_latency_ms, monitored_seconds, down_seconds";

/** The same totals as aggregateSummaries, in SQL (MIN/MAX skip NULLs, as there). */
const SUM_TOTALS =
  "SUM(checks), SUM(ok_checks), SUM(fail_checks), SUM(retry_recoveries), SUM(sum_latency_ms), " +
  "MIN(min_latency_ms), MAX(max_latency_ms), SUM(monitored_seconds), SUM(down_seconds)";

const TOTALS = TOTALS_COLUMNS.split(", ");

/**
 * Overwrite a derived bucket with its recomputed totals (idempotent), and only
 * when they changed: D1 bills every row an upsert writes, and most buckets a
 * pass recomputes come out exactly as they were.
 */
const UPSERT_TOTALS = `ON CONFLICT(monitor_id, period, bucket_start) DO UPDATE SET
  ${TOTALS.map((c) => `${c} = excluded.${c}`).join(", ")}
  WHERE ${TOTALS.map((c) => `summaries.${c} IS NOT excluded.${c}`).join(" OR ")}`;

/**
 * Restricts a statement to the monitors that exist, so SQLite reaches the rows
 * through the (monitor_id, ...) indexes instead of scanning the whole table:
 * D1 bills every row a query reads. Every history row belongs to a monitor
 * (deleting one deletes its history), so this never leaves a row out.
 */
const KNOWN_MONITORS = "monitor_id IN (SELECT id FROM monitors)";

/** How long a sent or dead notification delivery is kept, for Diagnostics. */
const OUTBOX_KEEP_DAYS = 30;

/** The `retention` setting over the defaults (a partial or unset setting keeps the rest). */
export function resolveRetention(stored: Partial<RetentionConfig> | null | undefined): RetentionConfig {
  return { ...DEFAULT_RETENTION, ...(stored ?? {}) };
}

/**
 * The periodic compaction pass as statements, so the scheduler can send them in
 * the same D1 round trip as its other end-of-run work (lib/batch.ts). Each is
 * one set-based statement for every monitor at once, so the pass costs the same
 * however many monitors and buckets there are.
 *
 *  1. Recompute DAY summaries from their constituent HOUR rows.
 *  2. Recompute MONTH summaries from their constituent DAY rows.
 *  3. Prune expired tiers per the retention horizons: samples > 24h, hour > 64d,
 *     day > 400d by default (overridable via the `retention` setting). Months
 *     are kept forever. Closed status intervals and scheduler-run diagnostics
 *     past the daily horizon go too (open intervals are always kept), and
 *     notification deliveries OUTBOX_KEEP_DAYS after they were sent or gave up.
 *
 * A derived bucket is recomputed only while ALL of its source rows are still
 * retained; older buckets are sealed at their last full value, so the prune in
 * the same pass can never shrink them. Days and months are UTC, as bucketStart.
 *
 * `since` is when the previous pass ran (the last finished run's start), or
 * null to recompute every bucket still open. Hour rows only change for the hour
 * a check or a beat lands in, so a pass recomputes only the days and months
 * that may have changed since then (and always the last day, so one failed
 * pass is made up by the next), and writes only the buckets that really
 * changed. Recomputing every open bucket on every run read and rewrote about
 * 80 rows per monitor, which on a two-month-old install of 20 monitors went
 * past the Free plan's daily D1 limits.
 */
export function compactionStatements(
  env: Env,
  now: number,
  retention: RetentionConfig,
  since: number | null = null,
): LabeledStatement[] {
  const sampleMs = retention.sampleHours * HOUR_MS;
  const hourlyMs = retention.hourlyDays * DAY_MS;
  const dailyMs = retention.dailyDays * DAY_MS;
  const window = compactionWindow(now, retention, since);
  return [
    {
      label: "hour→day pass",
      stmt: env.DB.prepare(
        `INSERT INTO summaries (id, monitor_id, period, bucket_start, ${TOTALS_COLUMNS})
         SELECT monitor_id || ':day:' || day_start, monitor_id, 'day', day_start, ${SUM_TOTALS}
           FROM (SELECT *, bucket_start - (bucket_start % ${DAY_MS}) AS day_start
                   FROM summaries WHERE ${KNOWN_MONITORS} AND period = 'hour' AND bucket_start >= ?2)
          WHERE day_start >= ?1
          GROUP BY monitor_id, day_start
         ${UPSERT_TOTALS}`,
      ).bind(now - hourlyMs, window.days),
    },
    {
      label: "day→month pass",
      stmt: env.DB.prepare(
        `INSERT INTO summaries (id, monitor_id, period, bucket_start, ${TOTALS_COLUMNS})
         SELECT monitor_id || ':month:' || month_start, monitor_id, 'month', month_start, ${SUM_TOTALS}
           FROM (SELECT *,
                        CAST(strftime('%s', bucket_start / 1000, 'unixepoch', 'start of month') AS INTEGER) * 1000
                          AS month_start
                   FROM summaries WHERE ${KNOWN_MONITORS} AND period = 'day' AND bucket_start >= ?2)
          WHERE month_start >= ?1
          GROUP BY monitor_id, month_start
         ${UPSERT_TOTALS}`,
      ).bind(now - dailyMs, window.months),
    },
    {
      label: "sample prune",
      stmt: env.DB.prepare(`DELETE FROM samples WHERE ${KNOWN_MONITORS} AND at < ?`).bind(now - sampleMs),
    },
    {
      label: "hour prune",
      stmt: env.DB.prepare(`DELETE FROM summaries WHERE ${KNOWN_MONITORS} AND period = 'hour' AND bucket_start < ?`).bind(
        now - hourlyMs,
      ),
    },
    {
      label: "day prune",
      stmt: env.DB.prepare(`DELETE FROM summaries WHERE ${KNOWN_MONITORS} AND period = 'day' AND bucket_start < ?`).bind(
        now - dailyMs,
      ),
    },
    {
      label: "interval prune",
      stmt: env.DB.prepare(
        `DELETE FROM status_intervals WHERE ${KNOWN_MONITORS} AND ended_at IS NOT NULL AND ended_at < ?`,
      ).bind(now - dailyMs),
    },
    {
      // ~120 rows/day; only recent runs are read.
      label: "run-record prune",
      stmt: env.DB.prepare("DELETE FROM scheduler_runs WHERE started_at < ?").bind(now - dailyMs),
    },
    {
      // Finished deliveries only: pending and failed rows are still being
      // retried. The alert cooldown reads minutes back, far inside this.
      label: "outbox prune",
      stmt: env.DB.prepare(
        "DELETE FROM notification_outbox WHERE status IN ('sent', 'dead') AND updated_at < ?",
      ).bind(now - OUTBOX_KEEP_DAYS * DAY_MS),
    },
  ];
}

/**
 * The oldest hour row (`days`) and day row (`months`) a pass reads, from when
 * the previous pass ran: the start of the day and month it ran in, or of the
 * day before now when that is earlier, and never before the oldest bucket the
 * pass may still recompute (older ones are sealed). PURE.
 */
export function compactionWindow(
  now: number,
  retention: RetentionConfig,
  since: number | null,
): { days: number; months: number } {
  const hourlyFloor = now - retention.hourlyDays * DAY_MS;
  const dailyFloor = now - retention.dailyDays * DAY_MS;
  if (since === null || !Number.isFinite(since)) return { days: hourlyFloor, months: dailyFloor };
  const from = Math.min(since, now - DAY_MS);
  return {
    days: Math.max(hourlyFloor, bucketStart("day", from)),
    months: Math.max(dailyFloor, bucketStart("month", from)),
  };
}
