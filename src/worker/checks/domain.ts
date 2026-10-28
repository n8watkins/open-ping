import type { DomainConfig } from "../../shared/schemas";
import type { ProbeResult } from "./types";
import { assertSafeUrl } from "../lib/ssrf";

/**
 * Domain-expiry check executor (docs/MONITOR_TYPES.md, "Domain expiry").
 *
 * The expiry date comes from the domain's RDAP record via rdap.org (which
 * 3xx-redirects to the authoritative registry RDAP server), read from its
 * `expiration` event: expired -> down, within `warnDays` -> degraded,
 * otherwise up.
 *
 * The date changes rarely, so it is cached on the monitor's state row
 * (monitor_state.domain_cache) and most cycles judge it from there without a
 * request. RDAP is asked again when the cached read gets old, sooner while the
 * domain is within `warnDays` (so a renewal shows up within the hour), and at
 * once when the cached date passes. A failed refresh (a rate limit, an RDAP
 * outage, a timeout) says nothing about the domain, so while a recent enough
 * read exists the cycle is judged from it and the failure only shows in the
 * sample's meta. Only with no usable read does a lookup failure count as a
 * failed check.
 *
 * SSRF/abuse handling: rdap.org is a FIXED constant (never user input), so this
 * is not an SSRF vector. We still re-validate the constructed URL with
 * `assertSafeUrl` as belt-and-suspenders. Redirects are followed by the runtime
 * (which caps the hop count); the target chain is the trusted RDAP bootstrap.
 */

const RDAP_BASE = "https://rdap.org/domain/";
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/** A cached read this old is refreshed. */
export const DOMAIN_REFRESH_MS = 6 * HOUR_MS;
/** ...or this old, while the domain is within `warnDays` of expiry. */
export const DOMAIN_REFRESH_SOON_MS = HOUR_MS;
/** A cached read older than this is no longer trusted when a refresh fails. */
export const DOMAIN_STALE_LIMIT_MS = 7 * DAY_MS;
/** After a failed refresh, the cache is used without asking again for this long (or Retry-After, if longer). */
export const DOMAIN_RETRY_MS = HOUR_MS;
/** The longest a Retry-After header can hold off the next refresh. */
export const DOMAIN_MAX_RETRY_AFTER_MS = 24 * HOUR_MS;

/** The last RDAP read of a domain monitor, stored as JSON on monitor_state.domain_cache. */
export interface DomainCache {
  /** The domain this read belongs to (lowercase); a different config domain ignores it. */
  domain: string;
  /** The expiration date read (epoch ms). */
  expiresAt: number;
  /** When it was read (epoch ms). */
  checkedAt: number;
  /** After a failed refresh: don't ask RDAP again before this (epoch ms). */
  retryAt?: number;
  /** The last failed refresh since the read, if any. */
  lastError?: DomainLookupError;
}

export interface DomainLookupError {
  code: string;
  message?: string;
  /** When the refresh failed (epoch ms). */
  at: number;
}

/** What a domain cycle shows on its sample (persisted as the sample's meta). */
export interface DomainMeta {
  expiresAt: string;
  daysUntil: number;
  /** When the expiry date was read from RDAP (epoch ms). */
  checkedAt: number;
  /** "rdap": read this cycle; "cache": judged from an earlier read. */
  source: "rdap" | "cache";
  /** Set when the latest refresh failed and the cycle used the earlier read. */
  lookupError?: DomainLookupError;
}

const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Reads monitor_state.domain_cache; anything unreadable counts as no cache. */
export function parseDomainCache(raw: string | null | undefined): DomainCache | null {
  if (!raw) return null;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (typeof o.domain !== "string" || !num(o.expiresAt) || !num(o.checkedAt)) return null;
  const cache: DomainCache = { domain: o.domain, expiresAt: o.expiresAt, checkedAt: o.checkedAt };
  if (num(o.retryAt)) cache.retryAt = o.retryAt;
  const e = o.lastError as Record<string, unknown> | undefined;
  if (e && typeof e === "object" && typeof e.code === "string" && num(e.at)) {
    cache.lastError = {
      code: e.code,
      at: e.at,
      ...(typeof e.message === "string" ? { message: e.message } : {}),
    };
  }
  return cache;
}

const cacheKey = (domain: string) => domain.trim().toLowerCase();

/**
 * Whether this cycle asks RDAP or judges the cached read. Pure: the scheduler
 * calls it to reserve the right number of fetches and the check calls it
 * again with the same inputs to act on it.
 *   - `lookup: false`: judge `cache`, no request.
 *   - `lookup: true`: ask RDAP; if that fails, `fallback` (when not null) is a
 *     recent enough read to judge instead.
 * `force` (a manual test) always asks.
 */
export type DomainPlan =
  | { lookup: false; cache: DomainCache }
  | { lookup: true; fallback: DomainCache | null };

export function planDomainCheck(
  config: Pick<DomainConfig, "domain" | "warnDays">,
  cache: DomainCache | null | undefined,
  now: number,
  force = false,
): DomainPlan {
  const usable =
    cache && cache.domain === cacheKey(config.domain) && now - cache.checkedAt < DOMAIN_STALE_LIMIT_MS
      ? cache
      : null;
  if (!usable) return { lookup: true, fallback: null };
  if (force) return { lookup: true, fallback: usable };
  // The cached date has passed since it was read: ask now, the domain may have
  // been renewed (registries often move the date only at the last minute).
  // Once a refresh after that has failed, the hold-off below applies again.
  const passed = usable.checkedAt < usable.expiresAt && now >= usable.expiresAt;
  const triedSince = usable.lastError != null && usable.lastError.at >= usable.expiresAt;
  if (passed && !triedSince) return { lookup: true, fallback: usable };
  // A refresh failed a moment ago: hold off as RDAP asked (Retry-After) or for
  // DOMAIN_RETRY_MS, judging the cached read meanwhile.
  if (usable.retryAt != null && now < usable.retryAt) return { lookup: false, cache: usable };
  const daysLeft = (usable.expiresAt - now) / DAY_MS;
  const maxAge = daysLeft <= config.warnDays ? DOMAIN_REFRESH_SOON_MS : DOMAIN_REFRESH_MS;
  return now - usable.checkedAt < maxAge
    ? { lookup: false, cache: usable }
    : { lookup: true, fallback: usable };
}

/** Pure: up / degraded / down for an expiry date. */
export function evaluateExpiry(
  config: Pick<DomainConfig, "domain" | "warnDays">,
  expiresAt: number,
  now: number,
): Pick<ProbeResult, "ok" | "degraded" | "error" | "errorMessage"> & {
  meta: Pick<DomainMeta, "expiresAt" | "daysUntil">;
} {
  const daysUntil = (expiresAt - now) / DAY_MS;
  const meta = { expiresAt: new Date(expiresAt).toISOString(), daysUntil: Math.floor(daysUntil) };
  if (daysUntil <= 0) {
    return {
      ok: false,
      error: "domain_expired",
      errorMessage: `${config.domain} expired on ${meta.expiresAt}`,
      meta,
    };
  }
  if (daysUntil <= config.warnDays) return { ok: true, degraded: true, meta };
  return { ok: true, meta };
}

/**
 * Reads a Retry-After header (seconds, or an HTTP date) as milliseconds from
 * `now`. Undefined when absent or unreadable.
 */
export function parseRetryAfter(value: string | null, now: number): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const at = Date.parse(trimmed);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

type RdapLookup =
  | { ok: true; expiresAt: number; durationMs: number }
  | { ok: false; durationMs: number; error: string; errorMessage: string; retryAfterMs?: number };

interface RdapEvent {
  eventAction?: string;
  eventDate?: string;
}
interface RdapResponse {
  events?: RdapEvent[];
}

/** One RDAP request for the domain's expiration date. */
async function lookupExpiry(config: DomainConfig, now: number): Promise<RdapLookup> {
  const url = `${RDAP_BASE}${encodeURIComponent(config.domain)}`;

  const safe = assertSafeUrl(url);
  if (!safe.ok) {
    return {
      ok: false,
      durationMs: 0,
      error: "blocked_url",
      errorMessage: `RDAP URL rejected by SSRF guard: ${safe.reason}`,
    };
  }

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, config.timeoutMs);
  const startedAt = Date.now();

  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      // RDAP servers (and the rdap.org redirector) commonly 403/406 requests that
      // don't advertise the RDAP media type or carry no User-Agent.
      headers: {
        accept: "application/rdap+json, application/json",
        "user-agent": "OpenPing/1.0 (+https://github.com/n8watkins/open-ping)",
      },
    });

    if (res.status === 429) {
      const retryAfterMs = parseRetryAfter(res.headers.get("retry-after"), now);
      await res.body?.cancel();
      return {
        ok: false,
        durationMs: Date.now() - startedAt,
        error: "rdap_rate_limited",
        errorMessage: `RDAP rate limited the lookup of ${config.domain} (HTTP 429)`,
        ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
      };
    }
    if (!res.ok) {
      await res.body?.cancel();
      return {
        ok: false,
        durationMs: Date.now() - startedAt,
        error: "rdap_error",
        errorMessage: `RDAP returned HTTP ${res.status} for ${config.domain}`,
      };
    }

    const json = (await res.json()) as RdapResponse;
    const durationMs = Date.now() - startedAt;
    const expDate = (json.events ?? []).find((e) => e.eventAction === "expiration")?.eventDate;
    const expMs = expDate ? Date.parse(expDate) : NaN;
    if (!expDate || Number.isNaN(expMs)) {
      return {
        ok: false,
        durationMs,
        error: "rdap_no_expiry",
        errorMessage: `No parseable expiration event for ${config.domain}`,
      };
    }
    return { ok: true, expiresAt: expMs, durationMs };
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    if (timedOut || (err instanceof Error && err.name === "AbortError")) {
      return {
        ok: false,
        durationMs,
        error: "rdap_timeout",
        errorMessage: `RDAP query exceeded ${config.timeoutMs}ms timeout`,
      };
    }
    return {
      ok: false,
      durationMs,
      error: "rdap_error",
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

export interface DomainCheckOptions {
  /** The monitor's cached read (monitor_state.domain_cache). */
  cache?: DomainCache | null;
  /** When the cycle was planned; freshness is judged at this time. */
  now?: number;
  /** Ask RDAP even when the cache is fresh (a manual test). */
  force?: boolean;
  /** Awaited before each RDAP request, so a run spaces its lookups out. */
  pace?: () => Promise<void>;
}

/** A result judged from a cached read: no request, no latency, nothing a re-check could change. */
function fromCache(
  config: DomainConfig,
  cache: DomainCache,
  now: number,
  lookupError: DomainLookupError | undefined,
): ProbeResult {
  const ev = evaluateExpiry(config, cache.expiresAt, now);
  const meta: DomainMeta = {
    ...ev.meta,
    checkedAt: cache.checkedAt,
    source: "cache",
    ...(lookupError ? { lookupError } : {}),
  };
  return { ...ev, meta, recheck: "skip" };
}

export async function runDomainCheck(
  config: DomainConfig,
  opts: DomainCheckOptions = {},
): Promise<ProbeResult> {
  const now = opts.now ?? Date.now();
  const plan = planDomainCheck(config, opts.cache, now, opts.force);
  if (!plan.lookup) {
    return { ...fromCache(config, plan.cache, now, plan.cache.lastError), fetches: 0 };
  }

  await opts.pace?.();
  const r = await lookupExpiry(config, now);

  if (r.ok) {
    const ev = evaluateExpiry(config, r.expiresAt, now);
    const meta: DomainMeta = { ...ev.meta, checkedAt: now, source: "rdap" };
    return {
      ...ev,
      durationMs: r.durationMs,
      meta,
      domainCache: { domain: cacheKey(config.domain), expiresAt: r.expiresAt, checkedAt: now },
      // RDAP itself says the domain expired; asking again 5 seconds later
      // can't change that.
      ...(ev.ok ? {} : { recheck: "skip" as const }),
    };
  }

  if (plan.fallback) {
    const lastError: DomainLookupError = { code: r.error, message: r.errorMessage, at: now };
    const holdMs = Math.min(
      Math.max(r.retryAfterMs ?? 0, DOMAIN_RETRY_MS),
      DOMAIN_MAX_RETRY_AFTER_MS,
    );
    return {
      ...fromCache(config, plan.fallback, now, lastError),
      domainCache: { ...plan.fallback, retryAt: now + holdMs, lastError },
    };
  }

  return {
    ok: false,
    durationMs: r.durationMs,
    error: r.error,
    errorMessage: r.errorMessage,
    // A rate limit would only answer the re-check with another 429: leave the
    // confirmation to the next run instead.
    ...(r.error === "rdap_rate_limited" ? { recheck: "defer" as const } : {}),
  };
}
