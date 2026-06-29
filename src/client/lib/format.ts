/**
 * Pure presentational formatting helpers shared across dashboard pages.
 * No data fetching, no side effects — safe to unit test and reuse anywhere.
 */

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * Human-friendly relative time. Past: "just now", "5m ago", "3h ago",
 * "2d ago". Future: "in 5m". Timestamps are epoch milliseconds.
 */
export function formatRelativeTime(ts: number, now: number = Date.now()): string {
  const diffMs = now - ts;
  const absSec = Math.abs(diffMs) / 1000;

  if (absSec < MINUTE) return "just now";

  let core: string;
  if (absSec < HOUR) {
    core = `${Math.round(absSec / MINUTE)}m`;
  } else if (absSec < DAY) {
    core = `${Math.round(absSec / HOUR)}h`;
  } else {
    core = `${Math.round(absSec / DAY)}d`;
  }

  return diffMs < 0 ? `in ${core}` : `${core} ago`;
}

/**
 * Compact duration from a number of seconds: "45s", "12m", "3h 5m", "2d 4h".
 * The two most significant units are shown; trailing zero units are dropped.
 */
export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));

  if (total < MINUTE) return `${total}s`;

  const minutes = Math.floor(total / MINUTE);
  if (minutes < 60) return `${minutes}m`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const remMin = minutes % 60;
    return remMin ? `${hours}h ${remMin}m` : `${hours}h`;
  }

  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours ? `${days}d ${remHours}h` : `${days}d`;
}

/**
 * Latency in milliseconds: "182 ms" under a second, "1.20 s" at/above it.
 * Nullish input renders an em dash placeholder.
 */
export function formatMs(ms: number | null | undefined): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

/** Percentage with fixed decimals: formatPct(99.95) -> "99.95%". */
export function formatPct(value: number, digits: number = 2): string {
  return `${value.toFixed(digits)}%`;
}

/** Locale-aware absolute date + time for a given epoch-ms timestamp. */
export function formatDateTime(ts: number): string {
  return new Date(ts).toLocaleString();
}
