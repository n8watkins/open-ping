import type { Env } from "../types";

/**
 * Historical compaction (PRD §17). Check results land as recent `samples` (24h)
 * and are continuously folded into HOUR `summaries`. A periodic pass rolls
 * HOUR → DAY (kept 90d) and DAY → MONTH (kept indefinitely), then prunes the
 * expired tiers:
 *
 *   samples (24h) → hourly (90d) → daily (2y) → monthly (forever)
 *
 * Everything here is idempotent and safe to retry: per-sample accumulation is an
 * additive upsert keyed by (monitor_id, period, bucket_start); the rollup passes
 * recompute each derived bucket from its source rows and write absolute totals,
 * so running twice yields the same result. All time math is plain UTC epoch-ms —
 * no Node APIs, no timezone libraries.
 */

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const NINETY_DAYS_MS = 90 * DAY_MS;
const TWO_YEARS_MS = 730 * DAY_MS; // ~2 years; UTC days are exactly 86_400_000ms in epoch-ms

/** A summary's numeric accumulator columns — shared by samples, hour/day/month rows. */
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

/** Start of the month after the one containing `monthStart` (handles year wrap). */
function nextMonthStart(monthStart: number): number {
  const d = new Date(monthStart);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}

/**
 * Sum a set of summary rows into one total. Min/max ignore NULL inputs and stay
 * NULL when no row carries a latency. PURE — used by both rollup passes.
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
 * Fold a single check result into its HOUR summary bucket. Additive upsert keyed
 * by (monitor_id, period='hour', bucket_start): incrementing the existing row on
 * conflict, so it is safe under concurrent/retried writes. Latency only counts
 * when finite; min/max COALESCE the existing (possibly NULL) value.
 */
export async function recordCheckSample(
  env: Env,
  monitorId: string,
  s: {
    at: number;
    ok: boolean;
    durationMs?: number | null;
    retryRecovered?: boolean;
    monitoredSeconds: number;
    downSeconds: number;
  },
): Promise<void> {
  const bucket = bucketStart("hour", s.at);
  const id = `${monitorId}:hour:${bucket}`;
  const hasLatency = typeof s.durationMs === "number" && Number.isFinite(s.durationMs);
  const latency = hasLatency ? (s.durationMs as number) : null;

  await env.DB.prepare(
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
      latency ?? 0,
      latency,
      latency,
      s.monitoredSeconds,
      s.downSeconds,
    )
    .run();
}

/** SELECT-able subset of `summaries` used when re-aggregating a derived bucket. */
const TOTALS_COLUMNS =
  "checks, ok_checks, fail_checks, retry_recoveries, sum_latency_ms, " +
  "min_latency_ms, max_latency_ms, monitored_seconds, down_seconds";

/** Upsert a derived (day/month) bucket with absolute recomputed totals — idempotent. */
async function writeSummary(
  env: Env,
  monitorId: string,
  period: "day" | "month",
  bucket: number,
  totals: SummaryTotals,
): Promise<void> {
  const id = `${monitorId}:${period}:${bucket}`;
  await env.DB.prepare(
    `INSERT INTO summaries
       (id, monitor_id, period, bucket_start, checks, ok_checks, fail_checks,
        retry_recoveries, sum_latency_ms, min_latency_ms, max_latency_ms,
        monitored_seconds, down_seconds)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(monitor_id, period, bucket_start) DO UPDATE SET
       checks = excluded.checks,
       ok_checks = excluded.ok_checks,
       fail_checks = excluded.fail_checks,
       retry_recoveries = excluded.retry_recoveries,
       sum_latency_ms = excluded.sum_latency_ms,
       min_latency_ms = excluded.min_latency_ms,
       max_latency_ms = excluded.max_latency_ms,
       monitored_seconds = excluded.monitored_seconds,
       down_seconds = excluded.down_seconds`,
  )
    .bind(
      id,
      monitorId,
      period,
      bucket,
      totals.checks,
      totals.ok_checks,
      totals.fail_checks,
      totals.retry_recoveries,
      totals.sum_latency_ms,
      totals.min_latency_ms,
      totals.max_latency_ms,
      totals.monitored_seconds,
      totals.down_seconds,
    )
    .run();
}

interface DistinctBucket {
  monitor_id: string;
  bucket_start: number;
}

/**
 * Periodic compaction pass. Idempotent and resilient: a failure recomputing one
 * monitor/bucket is logged and skipped so the rest still run.
 *
 *  1. Recompute DAY summaries from their constituent HOUR rows.
 *  2. Recompute MONTH summaries from their constituent DAY rows.
 *  3. Prune expired tiers: samples > 24h, hour > 90d, day > 2y. Months kept forever.
 */
export async function rollupAndCompact(env: Env, now: number): Promise<void> {
  // (1) HOUR → DAY -----------------------------------------------------------
  try {
    const hourBuckets = await env.DB.prepare(
      `SELECT DISTINCT monitor_id, bucket_start FROM summaries
       WHERE period = 'hour' AND bucket_start >= ?`,
    )
      .bind(now - TWO_YEARS_MS)
      .all<DistinctBucket>();

    const days = new Map<string, { monitorId: string; dayStart: number }>();
    for (const r of hourBuckets.results ?? []) {
      const dayStart = bucketStart("day", r.bucket_start);
      days.set(`${r.monitor_id}:${dayStart}`, { monitorId: r.monitor_id, dayStart });
    }

    for (const { monitorId, dayStart } of days.values()) {
      try {
        const rows = await env.DB.prepare(
          `SELECT ${TOTALS_COLUMNS} FROM summaries
           WHERE monitor_id = ? AND period = 'hour'
             AND bucket_start >= ? AND bucket_start < ?`,
        )
          .bind(monitorId, dayStart, dayStart + DAY_MS)
          .all<SummaryTotals>();
        await writeSummary(env, monitorId, "day", dayStart, aggregateSummaries(rows.results ?? []));
      } catch (e) {
        console.error(`[rollups] day recompute failed monitor=${monitorId} day=${dayStart}`, e);
      }
    }
  } catch (e) {
    console.error("[rollups] hour→day pass failed", e);
  }

  // (2) DAY → MONTH ----------------------------------------------------------
  try {
    const dayBuckets = await env.DB.prepare(
      `SELECT DISTINCT monitor_id, bucket_start FROM summaries
       WHERE period = 'day' AND bucket_start >= ?`,
    )
      .bind(now - TWO_YEARS_MS)
      .all<DistinctBucket>();

    const months = new Map<string, { monitorId: string; monthStart: number }>();
    for (const r of dayBuckets.results ?? []) {
      const monthStart = bucketStart("month", r.bucket_start);
      months.set(`${r.monitor_id}:${monthStart}`, { monitorId: r.monitor_id, monthStart });
    }

    for (const { monitorId, monthStart } of months.values()) {
      try {
        const rows = await env.DB.prepare(
          `SELECT ${TOTALS_COLUMNS} FROM summaries
           WHERE monitor_id = ? AND period = 'day'
             AND bucket_start >= ? AND bucket_start < ?`,
        )
          .bind(monitorId, monthStart, nextMonthStart(monthStart))
          .all<SummaryTotals>();
        await writeSummary(env, monitorId, "month", monthStart, aggregateSummaries(rows.results ?? []));
      } catch (e) {
        console.error(`[rollups] month recompute failed monitor=${monitorId} month=${monthStart}`, e);
      }
    }
  } catch (e) {
    console.error("[rollups] day→month pass failed", e);
  }

  // (3) Prune ----------------------------------------------------------------
  try {
    await env.DB.prepare("DELETE FROM samples WHERE at < ?")
      .bind(now - DAY_MS)
      .run();
  } catch (e) {
    console.error("[rollups] sample prune failed", e);
  }
  try {
    await env.DB.prepare("DELETE FROM summaries WHERE period = 'hour' AND bucket_start < ?")
      .bind(now - NINETY_DAYS_MS)
      .run();
  } catch (e) {
    console.error("[rollups] hour prune failed", e);
  }
  try {
    await env.DB.prepare("DELETE FROM summaries WHERE period = 'day' AND bucket_start < ?")
      .bind(now - TWO_YEARS_MS)
      .run();
  } catch (e) {
    console.error("[rollups] day prune failed", e);
  }
}
