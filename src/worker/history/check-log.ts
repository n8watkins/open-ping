import type { MonitorState } from "../../shared/states";

/**
 * The hour summary's check log (`summaries.check_log`, migration 0027).
 *
 * A check is kept for the 24-hour views (the monitor page's recent checks and
 * response times, the 24-hour chart, the Overview's last 28 checks) in one of
 * two places, never both:
 *
 *  - a passing check that changed nothing but its numbers (no state change,
 *    no error, not a warm-up, not a blip a re-check cleared, no beat message)
 *    is appended to its hour summary's `check_log`, in the same upsert that
 *    counts it, so it costs no row of its own;
 *  - every other check writes a full `samples` row, as all of them used to.
 *
 * D1 bills each row written with its index entries: a sample row cost 3 rows
 * written, and its delete a day later another, on every check
 * (docs/HOSTED_PLAN.md, "Cost per customer, measured"). Readers merge the two
 * sources ({@link mergeChecks}), so every view shows the same checks either
 * way. The upkeep clears an hour's log once the whole hour is past the sample
 * retention (history/rollups.ts), as it deletes old samples.
 *
 * The format is plain text, so an append is a string concatenation in SQL:
 * entries are separated by ";", and each is
 * `<ms after the hour's start>,<duration ms>,<status code>,<state>`, with an
 * empty field for a missing duration or status code. A logged check is always
 * a passing one (`ok`), in a passing state (up or degraded).
 */

/** One check kept in a check log. */
export interface LoggedCheck {
  at: number;
  state: MonitorState;
  durationMs: number | null;
  statusCode: number | null;
}

const ENTRY_SEPARATOR = ";";

const field = (n: number | null | undefined): string =>
  typeof n === "number" && Number.isFinite(n) ? String(n) : "";

/** One check's entry, for the hour starting at `hourStart`. PURE. */
export function checkLogEntry(hourStart: number, c: LoggedCheck): string {
  return [c.at - hourStart, field(c.durationMs), field(c.statusCode), c.state].join(",");
}

/**
 * The checks an hour's log holds, oldest first as appended. Malformed entries
 * are skipped (a log is only ever written by {@link checkLogEntry}). PURE.
 */
export function parseCheckLog(hourStart: number, log: string | null | undefined): LoggedCheck[] {
  if (!log) return [];
  const out: LoggedCheck[] = [];
  for (const entry of log.split(ENTRY_SEPARATOR)) {
    const [offset, duration, status, state] = entry.split(",");
    const at = Number(offset);
    if (!offset || !Number.isFinite(at) || !state) continue;
    out.push({
      at: hourStart + at,
      state: state as MonitorState,
      durationMs: duration ? Number(duration) : null,
      statusCode: status ? Number(status) : null,
    });
  }
  return out;
}

/** SQL for the number of entries in a `check_log` column (0 when NULL). */
export const CHECK_LOG_LENGTH_SQL = `CASE WHEN check_log IS NULL OR check_log = '' THEN 0
  ELSE length(check_log) - length(replace(check_log, '${ENTRY_SEPARATOR}', '')) + 1 END`;

/**
 * The SET expression that appends `excluded.check_log` (one entry, or NULL for
 * a check that has a sample row) to a summary's log in its upsert.
 */
export const APPEND_CHECK_LOG_SQL = `check_log = CASE
         WHEN excluded.check_log IS NULL THEN check_log
         WHEN check_log IS NULL THEN excluded.check_log
         ELSE check_log || '${ENTRY_SEPARATOR}' || excluded.check_log
       END`;

/** A check as a 24-hour view lists it, from a sample row or a log entry. */
export interface ListedCheck {
  at: number;
  ok: number;
  state: MonitorState;
  durationMs: number | null;
  statusCode: number | null;
  error: string | null;
  /** A sample row's meta (JSON text); a logged check has none of its own. */
  meta?: string | null;
  /** True for a logged check (its details beyond these are the monitor's latest). */
  logged?: boolean;
}

/** The hour rows' logged checks within [from, to], as listed checks. PURE. */
export function loggedChecks(
  rows: readonly { bucket_start: number; check_log?: string | null }[],
  from: number,
  to: number,
): ListedCheck[] {
  const out: ListedCheck[] = [];
  for (const r of rows) {
    for (const c of parseCheckLog(Number(r.bucket_start), r.check_log)) {
      if (c.at < from || c.at > to) continue;
      out.push({ ...c, ok: 1, error: null, logged: true });
    }
  }
  return out;
}

/** Sample rows and logged checks as one list, oldest first. PURE. */
export function mergeChecks<T extends { at: number }>(samples: readonly T[], logged: readonly T[]): T[] {
  return [...samples, ...logged].sort((a, b) => a.at - b.at);
}
