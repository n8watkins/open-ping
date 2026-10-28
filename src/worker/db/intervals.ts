import type { Env } from "../types";
import { newId } from "../lib/ids";
import type { MonitorState } from "../../shared/states";

/**
 * Evolving status intervals (PRD §17). A run of unchanged status is stored as a
 * single, growing `status_intervals` row (ended_at IS NULL while open). Each
 * check extends the open interval in place; a *new* interval only begins on a
 * state change (or a schedule/maintenance boundary, which surfaces as a state
 * change here). This keeps history compact: one row per contiguous state, with
 * rolled-up check/latency aggregates, instead of one row per sample.
 *
 * Timestamps are epoch milliseconds. Latency is only aggregated when a finite
 * `latencyMs` is supplied - states like `scheduled_off` or a missed heartbeat
 * carry no measured latency and must not pollute min/sum/max.
 */

/** Latency + check aggregates carried on a status interval row. */
interface LatencyAgg {
  checks: number;
  okChecks: number;
  sumLatencyMs: number;
  minLatencyMs: number | null;
  maxLatencyMs: number | null;
}

/** Aggregates for a brand-new interval before any sample is folded in. */
const ZERO_AGG: LatencyAgg = {
  checks: 0,
  okChecks: 0,
  sumLatencyMs: 0,
  minLatencyMs: null,
  maxLatencyMs: null,
};

/**
 * Pure decision: given the currently-open interval (or null) and the incoming
 * state, what should happen?
 *   - no open interval        → "open"   (insert a fresh open interval)
 *   - open, same state        → "extend" (fold the sample into the open row)
 *   - open, different state   → "split"  (close the old, open a new one)
 */
export function decideIntervalAction(
  current: { state: MonitorState } | null,
  incomingState: MonitorState,
): "open" | "extend" | "split" {
  if (current == null) return "open";
  return current.state === incomingState ? "extend" : "split";
}

/**
 * Pure merge of one sample's outcome into existing aggregates. Latency stats are
 * only touched when `latencyMs` is a finite number; otherwise only the check
 * counters advance. Handles null min/max (first measured sample seeds both).
 */
export function mergeLatency(
  agg: LatencyAgg,
  opts: { latencyMs?: number; ok?: boolean },
): LatencyAgg {
  const next: LatencyAgg = {
    checks: agg.checks + 1,
    okChecks: agg.okChecks + (opts.ok ? 1 : 0),
    sumLatencyMs: agg.sumLatencyMs,
    minLatencyMs: agg.minLatencyMs,
    maxLatencyMs: agg.maxLatencyMs,
  };
  const l = opts.latencyMs;
  if (typeof l === "number" && Number.isFinite(l)) {
    next.sumLatencyMs = agg.sumLatencyMs + l;
    next.minLatencyMs = agg.minLatencyMs == null ? l : Math.min(agg.minLatencyMs, l);
    next.maxLatencyMs = agg.maxLatencyMs == null ? l : Math.max(agg.maxLatencyMs, l);
  }
  return next;
}

/**
 * The interval update for one check/state observation, as statements a caller
 * can batch with its other writes (they must run in this order, in one batch):
 *
 *  1. extend: fold the sample into the open interval when its state matches;
 *  2. close: end an open interval whose state differs (a state change);
 *  3. open: start a fresh interval, seeded with this sample, when none is open
 *     any more. Its reason is `opts.reason`, else "state_change" when step 2
 *     just closed one, else none (the monitor's first interval).
 *
 * The SQL does what decideIntervalAction and mergeLatency describe without
 * reading the row first, so a check's interval costs no round trip of its own.
 * Latency is folded in only when `latencyMs` is a finite number.
 */
export function intervalStatements(
  env: Env,
  monitorId: string,
  state: MonitorState,
  at: number,
  opts: { latencyMs?: number | null; ok?: boolean; reason?: string } = {},
): D1PreparedStatement[] {
  const l = typeof opts.latencyMs === "number" && Number.isFinite(opts.latencyMs) ? opts.latencyMs : null;
  const ok = opts.ok ? 1 : 0;
  const first = mergeLatency(ZERO_AGG, { ...(l != null ? { latencyMs: l } : {}), ok: opts.ok ?? false });
  return [
    env.DB.prepare(
      `UPDATE status_intervals
          SET checks = checks + 1,
              ok_checks = ok_checks + ?3,
              sum_latency_ms = sum_latency_ms + COALESCE(?4, 0),
              min_latency_ms = CASE WHEN ?4 IS NULL THEN min_latency_ms
                                    ELSE MIN(COALESCE(min_latency_ms, ?4), ?4) END,
              max_latency_ms = CASE WHEN ?4 IS NULL THEN max_latency_ms
                                    ELSE MAX(COALESCE(max_latency_ms, ?4), ?4) END
        WHERE monitor_id = ?1 AND ended_at IS NULL AND state = ?2`,
    ).bind(monitorId, state, ok, l),
    env.DB.prepare(
      `UPDATE status_intervals SET ended_at = ?3
        WHERE monitor_id = ?1 AND ended_at IS NULL AND state <> ?2`,
    ).bind(monitorId, state, at),
    env.DB.prepare(
      `INSERT INTO status_intervals (
          id, monitor_id, state, started_at, ended_at,
          checks, ok_checks, sum_latency_ms, min_latency_ms, max_latency_ms, reason
        )
        SELECT ?1, ?2, ?3, ?4, NULL, ?5, ?6, ?7, ?8, ?9,
               COALESCE(?10, CASE WHEN EXISTS (
                 SELECT 1 FROM status_intervals WHERE monitor_id = ?2 AND ended_at = ?4
               ) THEN 'state_change' END)
         WHERE NOT EXISTS (
           SELECT 1 FROM status_intervals WHERE monitor_id = ?2 AND ended_at IS NULL
         )`,
    ).bind(
      newId("ivl"),
      monitorId,
      state,
      at,
      first.checks,
      first.okChecks,
      first.sumLatencyMs,
      first.minLatencyMs,
      first.maxLatencyMs,
      opts.reason ?? null,
    ),
  ];
}

/**
 * Record a check/state observation against the evolving interval timeline
 * (intervalStatements, in one round trip). Extends the open interval when the
 * state is unchanged; closes it and opens a new one on a state change (default
 * reason "state_change"); opens a first interval when none is currently open.
 */
export async function updateStatusInterval(
  env: Env,
  monitorId: string,
  state: MonitorState,
  at: number,
  opts: { latencyMs?: number; ok?: boolean; reason?: string } = {},
): Promise<void> {
  await env.DB.batch(intervalStatements(env, monitorId, state, at, opts));
}
