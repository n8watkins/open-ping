/**
 * SSL certificate monitor helpers shared by the worker and the editor
 * (docs/MONITOR_TYPES.md, "SSL certificate"). Plain functions with no
 * dependencies, so the client can use them without pulling in the schemas.
 */

/** The warning thresholds a certificate monitor starts with: 30, 14 and 7 days before expiry. */
export const CERT_DEFAULT_WARN_DAYS: readonly number[] = [30, 14, 7];

/**
 * What a typed target means: a bare host name, or a pasted URL or `host:port`,
 * from which the host (lowercase, no trailing dot) and any port are taken.
 */
export function parseCertTarget(input: string): { host: string; port?: number } {
  const raw = input.trim();
  if (!raw) return { host: "" };
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const url = new URL(withScheme);
    const host = url.hostname.replace(/\.$/, "").toLowerCase();
    return url.port ? { host, port: Number(url.port) } : { host };
  } catch {
    return { host: raw.toLowerCase() };
  }
}

/**
 * The thresholds as typed ("30, 14, 7"): whole numbers, largest first,
 * without repeats. Anything that isn't a number is kept as NaN, so the
 * server's validation names it instead of it silently disappearing.
 */
export function parseWarnDays(input: string): number[] {
  const days = input
    .split(/[\s,;]+/)
    .filter(Boolean)
    .map((d) => (/^\d+$/.test(d) ? Number(d) : Number.NaN));
  const numbers = [...new Set(days.filter((d) => !Number.isNaN(d)))].sort((a, b) => b - a);
  return days.some(Number.isNaN) ? [...numbers, Number.NaN] : numbers;
}
