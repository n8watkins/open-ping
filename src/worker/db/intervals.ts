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
 * `latencyMs` is supplied — states like `scheduled_off` or a missed heartbeat
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

/** Raw shape of the columns we read back from `status_intervals`. */
interface IntervalRow {
  id: string;
  state: MonitorState;
  started_at: number;
  checks: number;
  ok_checks: number;
  sum_latency_ms: number;
  min_latency_ms: number | null;
  max_latency_ms: number | null;
}

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

/** Fetch the full open interval row (ended_at IS NULL) for a monitor, if any. */
async function getOpenRow(
  env: Env,
  monitorId: string,
): Promise<IntervalRow | null> {
  return env.DB.prepare(
    `SELECT id, state, started_at, checks, ok_checks,
            sum_latency_ms, min_latency_ms, max_latency_ms
       FROM status_intervals
      WHERE monitor_id = ? AND ended_at IS NULL
      ORDER BY started_at DESC
      LIMIT 1`,
  )
    .bind(monitorId)
    .first<IntervalRow>();
}

/** Small public helper: the currently-open interval for a monitor, or null. */
export async function getOpenInterval(
  env: Env,
  monitorId: string,
): Promise<{ id: string; state: MonitorState; startedAt: number } | null> {
  const row = await getOpenRow(env, monitorId);
  if (!row) return null;
  return { id: row.id, state: row.state as MonitorState, startedAt: row.started_at };
}

/**
 * Record a check/state observation against the evolving interval timeline.
 * Extends the open interval when the state is unchanged; closes it and opens a
 * new one on a state change (default reason "state_change"); opens a first
 * interval when none is currently open.
 */
export async function updateStatusInterval(
  env: Env,
  monitorId: string,
  state: MonitorState,
  at: number,
  opts: { latencyMs?: number; ok?: boolean; reason?: string } = {},
): Promise<void> {
  const open = await getOpenRow(env, monitorId);
  const action = decideIntervalAction(open, state);

  if (action === "extend" && open) {
    const merged = mergeLatency(
      {
        checks: open.checks,
        okChecks: open.ok_checks,
        sumLatencyMs: open.sum_latency_ms,
        minLatencyMs: open.min_latency_ms,
        maxLatencyMs: open.max_latency_ms,
      },
      opts,
    );
    await env.DB.prepare(
      `UPDATE status_intervals
          SET checks = ?, ok_checks = ?, sum_latency_ms = ?,
              min_latency_ms = ?, max_latency_ms = ?
        WHERE id = ?`,
    )
      .bind(
        merged.checks,
        merged.okChecks,
        merged.sumLatencyMs,
        merged.minLatencyMs,
        merged.maxLatencyMs,
        open.id,
      )
      .run();
    return;
  }

  // "open" or "split": fold the first sample into a fresh interval, closing the
  // previous one first when splitting. Batched so a split is atomic.
  const agg = mergeLatency(ZERO_AGG, opts);
  const reason = opts.reason ?? (action === "split" ? "state_change" : null);
  const insert = env.DB.prepare(
    `INSERT INTO status_intervals (
        id, monitor_id, state, started_at, ended_at,
        checks, ok_checks, sum_latency_ms, min_latency_ms, max_latency_ms, reason
      ) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    newId("ivl"),
    monitorId,
    state,
    at,
    agg.checks,
    agg.okChecks,
    agg.sumLatencyMs,
    agg.minLatencyMs,
    agg.maxLatencyMs,
    reason,
  );

  if (action === "split" && open) {
    await env.DB.batch([
      env.DB.prepare("UPDATE status_intervals SET ended_at = ? WHERE id = ?").bind(
        at,
        open.id,
      ),
      insert,
    ]);
  } else {
    await insert.run();
  }
}
