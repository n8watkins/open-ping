import type { Env } from "../types";
import { newId } from "./ids";

/**
 * Lightweight execution lease + scheduler-run diagnostics (PRD §19). The lease
 * prevents overlapping scheduled runs from corrupting state. It uses the `locks`
 * table with a single atomic upsert: the conflict update only fires when the
 * existing lease has expired, so a live lease is never stolen.
 */

export async function acquireLease(
  env: Env,
  name: string,
  ttlMs: number,
): Promise<string | null> {
  const holder = newId("lease");
  const now = Date.now();
  const expiresAt = now + ttlMs;

  await env.DB.prepare(
    `INSERT INTO locks (name, holder, acquired_at, expires_at)
       VALUES (?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET
       holder = ?, acquired_at = ?, expires_at = ?
       WHERE locks.expires_at <= ?`,
  )
    .bind(name, holder, now, expiresAt, holder, now, expiresAt, now)
    .run();

  const row = await env.DB.prepare("SELECT holder FROM locks WHERE name = ?")
    .bind(name)
    .first<{ holder: string }>();
  return row?.holder === holder ? holder : null;
}

export async function releaseLease(
  env: Env,
  name: string,
  holder: string,
): Promise<void> {
  await env.DB.prepare("DELETE FROM locks WHERE name = ? AND holder = ?")
    .bind(name, holder)
    .run();
}

export interface RunStats {
  ok: boolean;
  monitorsChecked: number;
  monitorsSkipped: number;
  checkFailures: number;
  notificationFailures: number;
  error?: string;
}

export async function recordRunStart(env: Env, cron: string | null): Promise<{ id: string; startedAt: number }> {
  const id = newId("run");
  const startedAt = Date.now();
  await env.DB.prepare(
    "INSERT INTO scheduler_runs (id, cron, started_at) VALUES (?, ?, ?)",
  )
    .bind(id, cron, startedAt)
    .run();
  return { id, startedAt };
}

export async function recordRunFinish(
  env: Env,
  id: string,
  startedAt: number,
  stats: RunStats,
): Promise<void> {
  const finishedAt = Date.now();
  await env.DB.prepare(
    `UPDATE scheduler_runs SET
       finished_at = ?, ok = ?, monitors_checked = ?, monitors_skipped = ?,
       check_failures = ?, notification_failures = ?, duration_ms = ?, error = ?
     WHERE id = ?`,
  )
    .bind(
      finishedAt,
      stats.ok ? 1 : 0,
      stats.monitorsChecked,
      stats.monitorsSkipped,
      stats.checkFailures,
      stats.notificationFailures,
      finishedAt - startedAt,
      stats.error ?? null,
      id,
    )
    .run();
}
