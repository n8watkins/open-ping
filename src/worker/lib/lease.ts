import type { Env } from "../types";

/**
 * Lightweight execution lease + scheduler-run diagnostics (PRD §19). The lease
 * prevents overlapping scheduled runs from corrupting state. It uses the `locks`
 * table with a single atomic upsert: the conflict update only fires when the
 * existing lease has expired, so a live lease is never stolen.
 */

/** The lease upsert: takes the lease only if it is free or its holder's TTL expired. */
export function acquireLeaseStatement(
  env: Env,
  name: string,
  holder: string,
  now: number,
  ttlMs: number,
): D1PreparedStatement {
  const expiresAt = now + ttlMs;
  return env.DB.prepare(
    `INSERT INTO locks (name, holder, acquired_at, expires_at)
       VALUES (?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET
       holder = ?, acquired_at = ?, expires_at = ?
       WHERE locks.expires_at <= ?`,
  ).bind(name, holder, now, expiresAt, holder, now, expiresAt, now);
}

/** Who holds the lease now (read after the upsert to learn whether it won). */
export function leaseHolderStatement(env: Env, name: string): D1PreparedStatement {
  return env.DB.prepare("SELECT holder FROM locks WHERE name = ?").bind(name);
}

export function releaseLeaseStatement(env: Env, name: string, holder: string): D1PreparedStatement {
  return env.DB.prepare("DELETE FROM locks WHERE name = ? AND holder = ?").bind(name, holder);
}

export async function releaseLease(
  env: Env,
  name: string,
  holder: string,
): Promise<void> {
  await releaseLeaseStatement(env, name, holder).run();
}

export interface RunStats {
  ok: boolean;
  monitorsChecked: number;
  monitorsSkipped: number;
  checkFailures: number;
  notificationFailures: number;
  /**
   * D1 round trips the run made, its own run record included (a batch counts
   * as one, as D1 counts it). A cron run that checks nothing spends its whole
   * duration on these, so duration divided by this is the run's D1 latency.
   */
  d1Queries?: number;
  /** Confirmation re-checks made (checks/runner.ts). */
  confirmations?: number;
  /** Of those, how many passed: a blip that opened no incident. */
  confirmationsCleared?: number;
  /** Failed checks whose re-check waited for the next run for lack of budget. */
  confirmationsDeferred?: number;
  /** Every history rollup and retention statement of the run landed. */
  compacted?: boolean;
  error?: string;
}

/**
 * Write the run's start row, but only while `holder` holds the lease: batched
 * with the lease upsert, a run that loses the lease records nothing.
 */
export function recordRunStartStatement(
  env: Env,
  run: { id: string; startedAt: number },
  cron: string | null,
  lease: { name: string; holder: string },
): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO scheduler_runs (id, cron, started_at)
       SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM locks WHERE name = ? AND holder = ?)`,
  ).bind(run.id, cron, run.startedAt, lease.name, lease.holder);
}

/**
 * When the most recent run whose history rollups all landed started (the
 * rollups recompute only what changed since then, history/rollups.ts). A run
 * can finish fine while its rollups failed, so this is the `compacted` flag,
 * not the finish. Reads the started_at index from the newest end: a row or two
 * however many runs are kept, unless rollups kept failing.
 */
export function lastCompactedRunStatement(env: Env): D1PreparedStatement {
  return env.DB.prepare(
    "SELECT started_at FROM scheduler_runs WHERE compacted = 1 ORDER BY started_at DESC LIMIT 1",
  );
}

/** lastCompactedRunStatement's answer: epoch ms, or null when no run has one (a full pass). */
export function lastCompactedRunAt(result: D1Result | undefined): number | null {
  const at = (result?.results?.[0] as { started_at?: unknown } | undefined)?.started_at;
  return typeof at === "number" && Number.isFinite(at) ? at : null;
}

/** The run's finish row: its outcome, counts and wall-clock duration. */
export function recordRunFinishStatement(
  env: Env,
  id: string,
  startedAt: number,
  stats: RunStats,
  finishedAt: number = Date.now(),
): D1PreparedStatement {
  return env.DB.prepare(
    `UPDATE scheduler_runs SET
       finished_at = ?, ok = ?, monitors_checked = ?, monitors_skipped = ?,
       check_failures = ?, notification_failures = ?, duration_ms = ?, d1_queries = ?,
       confirmations = ?, confirmations_cleared = ?, confirmations_deferred = ?, error = ?,
       compacted = ?
     WHERE id = ?`,
  ).bind(
    finishedAt,
    stats.ok ? 1 : 0,
    stats.monitorsChecked,
    stats.monitorsSkipped,
    stats.checkFailures,
    stats.notificationFailures,
    finishedAt - startedAt,
    stats.d1Queries ?? null,
    stats.confirmations ?? 0,
    stats.confirmationsCleared ?? 0,
    stats.confirmationsDeferred ?? 0,
    stats.error ?? null,
    stats.compacted ? 1 : 0,
    id,
  );
}
