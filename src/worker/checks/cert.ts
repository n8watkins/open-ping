import type { CertConfig } from "../../shared/schemas";
import type { ProbeResult } from "./types";
import { assertSafeHost, assertSafeUrl, isIPv4 } from "../lib/ssrf";
import {
  ALERT_PROTOCOL_VERSION,
  certificateCovers,
  readCertificate,
  type CertificateInfo,
  type TlsReadResult,
} from "./tls";

/**
 * SSL certificate check executor (docs/MONITOR_TYPES.md, "SSL certificate").
 *
 * Reads the certificate a server serves with a hand-written TLS 1.2 handshake
 * over a plain TCP socket (checks/tls.ts, docs/SSL_EXPIRY_SPIKE.md) and judges
 * its expiry: expired (or not valid yet) -> down, within the largest of
 * `warnDays` -> degraded, otherwise up. Each threshold in `warnDays` sends one
 * "certificate expires soon" alert as it is crossed (`certWarning`).
 *
 * Two answers are neither up nor down, because they say nothing about the
 * certificate, only that it can't be read from a Worker. They put the monitor
 * in the neutral `cant_check` state, never open an incident and never alert:
 *   - the host is behind Cloudflare's proxy: Workers may not open TCP sockets
 *     to Cloudflare's own IP ranges (about a fifth of hosts, every Render app);
 *   - the server only speaks TLS 1.3 (or otherwise refuses the TLS 1.2 hello),
 *     where the certificate travels encrypted.
 *
 * Like the domain monitor (checks/domain.ts), the read is cached on the
 * monitor's state row (monitor_state.cert_cache) and most cycles are judged
 * from it with no connection: a certificate changes rarely. It is read again
 * once a day, every hour within the warning window (so a renewal clears the
 * warning within the hour), at once when the cached expiry passes, and when
 * the host or port changes. A failed read (a timeout, a refused connection)
 * says nothing about the certificate, so while a recent read exists the cycle
 * is judged from it and the failure only shows in the sample's meta. Only with
 * no usable read does a failed read count as a failed check.
 *
 * SSRF: the host is checked with `assertSafeHost` before dialing, as for TCP
 * monitors, and the runtime refuses internal destinations regardless.
 */

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/** A cached read this old is read again. */
export const CERT_REFRESH_MS = 24 * HOUR_MS;
/** ...or this old, while the certificate is within the warning window or expired. */
export const CERT_REFRESH_SOON_MS = HOUR_MS;
/** A cached read older than this is no longer trusted when a read fails. */
export const CERT_STALE_LIMIT_MS = 7 * DAY_MS;
/** After a failed read, the cache is used without reading again for this long. */
export const CERT_RETRY_MS = HOUR_MS;

/** Why a certificate can't be read from a Worker. */
export type CantCheckReason = "cloudflare" | "tls13_only" | "refused";

/** The plain-words explanation shown for each reason. */
export const CANT_CHECK_MESSAGES: Record<CantCheckReason, string> = {
  cloudflare:
    "This host is behind Cloudflare's proxy. Cloudflare doesn't let Workers open connections to its own network, so OpenPing can't see the certificate from here. Cloudflare issues and renews that certificate itself.",
  tls13_only:
    "This server only accepts TLS 1.3, which sends the certificate encrypted, so OpenPing can't read it from a Worker. Your site isn't affected.",
  refused:
    "This server turned down the TLS 1.2 handshake OpenPing uses to read certificates, so the certificate can't be read from here. Your site isn't necessarily affected.",
};

/** What one read of the server found. */
export type CertRead =
  | { kind: "cert"; cert: CertificateInfo; chainLength: number }
  | { kind: "cant_check"; reason: CantCheckReason; detail: string };

/** The last read of a certificate monitor, stored as JSON on monitor_state.cert_cache. */
export interface CertCache {
  /** The host (lowercase, no trailing dot) and port this read belongs to; another config ignores it. */
  host: string;
  port: number;
  /** When it was read (epoch ms). */
  checkedAt: number;
  read: CertRead;
  /** After a failed read: don't read again before this (epoch ms). */
  retryAt?: number;
  /** The last failed read since this one, if any. */
  lastError?: CertLookupError;
  /**
   * The smallest warning threshold already alerted for the certificate that
   * expires at `validTo`. Written with the alert itself (checks/state.ts), so
   * a lost alert is sent again on the next cycle and a sent one never twice.
   */
  warned?: { validTo: number; days: number };
}

export interface CertLookupError {
  code: string;
  message?: string;
  /** When the read failed (epoch ms). */
  at: number;
}

/** A warning threshold this cycle crossed, to alert once (notifications cert_expiring). */
export interface CertWarning {
  /** The threshold crossed (one of config.warnDays). */
  threshold: number;
  /** Whole days left. */
  daysUntil: number;
  /** The certificate's expiry (epoch ms). */
  validTo: number;
  host: string;
}

/** What a certificate cycle shows on its sample (persisted as the sample's meta). */
export interface CertMeta {
  host: string;
  port: number;
  /** "tls": read this cycle; "cache": judged from an earlier read. */
  source: "tls" | "cache";
  /** When the certificate was read (epoch ms). */
  checkedAt: number;
  /** The certificate's expiry (ISO) and whole days left, when it was read. */
  expiresAt?: string;
  daysUntil?: number;
  validFrom?: string;
  /** "Let's Encrypt (R11)": the issuer's organization and name. */
  issuer?: string;
  /** False when the certificate doesn't name the host (browsers would refuse it). */
  coversHost?: boolean;
  /** Why the certificate can't be read from a Worker. */
  cantCheck?: { reason: CantCheckReason; message: string; detail: string };
  /** Set when the latest read failed and the cycle used the earlier read. */
  lookupError?: CertLookupError;
}

const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const str = (v: unknown): v is string => typeof v === "string";
const strOrNull = (v: unknown): v is string | null => v === null || typeof v === "string";

function parseCertInfo(v: unknown): CertificateInfo | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (
    !strOrNull(o.subject) ||
    !strOrNull(o.issuerOrg) ||
    !strOrNull(o.issuerName) ||
    !num(o.validFrom) ||
    !num(o.validTo) ||
    !Array.isArray(o.sans) ||
    !num(o.sanCount) ||
    !str(o.serial)
  ) {
    return null;
  }
  return {
    subject: o.subject,
    issuerOrg: o.issuerOrg,
    issuerName: o.issuerName,
    validFrom: o.validFrom,
    validTo: o.validTo,
    sans: o.sans.filter(str),
    sanCount: o.sanCount,
    serial: o.serial,
  };
}

const REASONS = new Set<string>(["cloudflare", "tls13_only", "refused"]);

/** Reads monitor_state.cert_cache; anything unreadable counts as no cache. */
export function parseCertCache(raw: string | null | undefined): CertCache | null {
  if (!raw) return null;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (!str(o.host) || !num(o.port) || !num(o.checkedAt) || !o.read || typeof o.read !== "object") return null;
  const r = o.read as Record<string, unknown>;
  let read: CertRead;
  if (r.kind === "cert") {
    const cert = parseCertInfo(r.cert);
    if (!cert) return null;
    read = { kind: "cert", cert, chainLength: num(r.chainLength) ? r.chainLength : 1 };
  } else if (r.kind === "cant_check" && str(r.reason) && REASONS.has(r.reason)) {
    read = { kind: "cant_check", reason: r.reason as CantCheckReason, detail: str(r.detail) ? r.detail : "" };
  } else {
    return null;
  }
  const cache: CertCache = { host: o.host, port: o.port, checkedAt: o.checkedAt, read };
  if (num(o.retryAt)) cache.retryAt = o.retryAt;
  const e = o.lastError as Record<string, unknown> | undefined;
  if (e && typeof e === "object" && str(e.code) && num(e.at)) {
    cache.lastError = { code: e.code, at: e.at, ...(str(e.message) ? { message: e.message } : {}) };
  }
  const w = o.warned as Record<string, unknown> | undefined;
  if (w && typeof w === "object" && num(w.validTo) && num(w.days)) cache.warned = { validTo: w.validTo, days: w.days };
  return cache;
}

/** The host as the cache keys it. */
export const certHostKey = (host: string) => host.trim().replace(/\.$/, "").toLowerCase();

/** Whole days left before `validTo` (negative once expired). */
export const daysLeft = (validTo: number, now: number) => Math.floor((validTo - now) / DAY_MS);

/** The largest threshold: the warning window starts there. */
const windowDays = (warnDays: number[]) => Math.max(...warnDays);

/**
 * Whether this cycle reads the server or judges the cached read. Pure: the
 * scheduler calls it to reserve the right number of fetches and the check
 * calls it again with the same inputs to act on it (as planDomainCheck).
 * `force` (a manual test) always reads.
 */
export type CertPlan =
  | { read: false; cache: CertCache }
  | { read: true; fallback: CertCache | null };

export function planCertCheck(
  config: Pick<CertConfig, "host" | "port" | "warnDays">,
  cache: CertCache | null | undefined,
  now: number,
  force = false,
): CertPlan {
  const usable =
    cache &&
    cache.host === certHostKey(config.host) &&
    cache.port === config.port &&
    now - cache.checkedAt < CERT_STALE_LIMIT_MS
      ? cache
      : null;
  if (!usable) return { read: true, fallback: null };
  if (force) return { read: true, fallback: usable };
  const read = usable.read;
  if (read.kind === "cert") {
    // The cached expiry passed since it was read: read now, it may have been
    // renewed at the last minute. Once a read after that failed, the hold-off
    // below applies again.
    const { validTo } = read.cert;
    const passed = usable.checkedAt < validTo && now >= validTo;
    const triedSince = usable.lastError != null && usable.lastError.at >= validTo;
    if (passed && !triedSince) return { read: true, fallback: usable };
  }
  if (usable.retryAt != null && now < usable.retryAt) return { read: false, cache: usable };
  const soon = read.kind === "cert" && daysLeft(read.cert.validTo, now) <= windowDays(config.warnDays);
  const maxAge = soon ? CERT_REFRESH_SOON_MS : CERT_REFRESH_MS;
  return now - usable.checkedAt < maxAge ? { read: false, cache: usable } : { read: true, fallback: usable };
}

/** The issuer as people read it: "Let's Encrypt (R11)". */
export function issuerLabel(cert: Pick<CertificateInfo, "issuerOrg" | "issuerName">): string | undefined {
  const { issuerOrg: o, issuerName: n } = cert;
  if (o && n && o !== n) return `${o} (${n})`;
  return o ?? n ?? undefined;
}

/**
 * The threshold this cycle crosses, if it hasn't been alerted yet for this
 * certificate: the smallest of `warnDays` at or above the days left. None once
 * expired (the down alert covers that). Pure.
 */
export function certWarningFor(
  warnDays: number[],
  host: string,
  validTo: number,
  now: number,
  warned: CertCache["warned"],
): CertWarning | null {
  if (validTo <= now) return null;
  const days = daysLeft(validTo, now);
  const crossed = warnDays.filter((t) => days <= t);
  if (!crossed.length) return null;
  const threshold = Math.min(...crossed);
  if (warned && warned.validTo === validTo && warned.days <= threshold) return null;
  return { threshold, daysUntil: days, validTo, host: certHostKey(host) };
}

/** Pure: the result of a cycle for a read (live or cached). */
export function evaluateCertRead(
  config: CertConfig,
  read: CertRead,
  now: number,
  warned: CertCache["warned"],
): Pick<ProbeResult, "ok" | "degraded" | "error" | "errorMessage" | "cantCheck" | "recheck"> & {
  meta: Omit<CertMeta, "source" | "checkedAt">;
  certWarning?: CertWarning;
} {
  const host = certHostKey(config.host);
  const base = { host, port: config.port };
  if (read.kind === "cant_check") {
    return {
      ok: true,
      cantCheck: true,
      meta: { ...base, cantCheck: { reason: read.reason, message: CANT_CHECK_MESSAGES[read.reason], detail: read.detail } },
    };
  }
  const { cert } = read;
  const days = daysLeft(cert.validTo, now);
  const issuer = issuerLabel(cert);
  const meta = {
    ...base,
    expiresAt: new Date(cert.validTo).toISOString(),
    daysUntil: days,
    validFrom: new Date(cert.validFrom).toISOString(),
    ...(issuer ? { issuer } : {}),
    coversHost: certificateCovers(cert, host),
  };
  // Asking again a few seconds later can't change a date the server sent.
  if (cert.validTo <= now) {
    return {
      ok: false,
      error: "cert_expired",
      errorMessage: `The certificate for ${host} expired on ${meta.expiresAt}`,
      recheck: "skip",
      meta,
    };
  }
  if (cert.validFrom > now) {
    return {
      ok: false,
      error: "cert_not_yet_valid",
      errorMessage: `The certificate for ${host} is not valid until ${meta.validFrom}`,
      recheck: "skip",
      meta,
    };
  }
  const warning = certWarningFor(config.warnDays, host, cert.validTo, now, warned);
  return {
    ok: true,
    ...(days <= windowDays(config.warnDays) ? { degraded: true } : {}),
    meta,
    ...(warning ? { certWarning: warning } : {}),
  };
}

// ---------------------------------------------------------------------------
// Cloudflare's network
// ---------------------------------------------------------------------------

/**
 * Cloudflare's IPv4 ranges (https://www.cloudflare.com/ips-v4, checked
 * 2026-10-28). Used only as a second opinion when a connection fails without
 * the runtime's own "cannot connect" message, so a change in that wording
 * can't turn a Cloudflare-fronted host into an outage.
 */
const CLOUDFLARE_IPV4 = [
  "173.245.48.0/20",
  "103.21.244.0/22",
  "103.22.200.0/22",
  "103.31.4.0/22",
  "141.101.64.0/18",
  "108.162.192.0/18",
  "190.93.240.0/20",
  "188.114.96.0/20",
  "197.234.240.0/22",
  "198.41.128.0/17",
  "162.158.0.0/15",
  "104.16.0.0/13",
  "104.24.0.0/14",
  "172.64.0.0/13",
  "131.0.72.0/22",
];

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p) || Number(p) > 255) return null;
    n = n * 256 + Number(p);
  }
  return n;
}

/** Whether an IPv4 address is in Cloudflare's ranges. */
export function isCloudflareIPv4(ip: string): boolean {
  const n = ipv4ToInt(ip);
  if (n === null) return false;
  return CLOUDFLARE_IPV4.some((cidr) => {
    const [base, bits] = cidr.split("/");
    const size = 2 ** (32 - Number(bits));
    const start = ipv4ToInt(base!)!;
    return n >= start && n < start + size;
  });
}

/**
 * The message the runtime gives when a Worker connects to Cloudflare's own
 * IPs: "proxy request failed, cannot connect to the specified address"
 * (measured 2026-10-28, docs/SSL_EXPIRY_SPIKE.md).
 */
export const CLOUDFLARE_BLOCK_MESSAGE = /cannot connect to the specified address|proxy request failed/i;

const RESOLVER = "https://cloudflare-dns.com/dns-query";

/** Resolves the host's A records over DNS-over-HTTPS; null when that fails. */
async function resolveIPv4(host: string, timeoutMs: number): Promise<string[] | null> {
  const url = `${RESOLVER}?name=${encodeURIComponent(host)}&type=A`;
  if (!assertSafeUrl(url).ok) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { accept: "application/dns-json" }, signal: controller.signal });
    if (!res.ok) {
      await res.body?.cancel();
      return null;
    }
    const json = (await res.json()) as { Answer?: { type: number; data: string }[] };
    return (json.Answer ?? []).filter((a) => a.type === 1).map((a) => a.data);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------

/**
 * How the check reads a certificate. A seam for tests: the integration suite
 * replaces `read` with a fake TLS reader (workerd has no fake sockets).
 */
export const tlsReader = {
  read: (host: string, port: number, timeoutMs: number): Promise<TlsReadResult> => readCertificate(host, port, timeoutMs),
};

/** Fatal TLS alerts that mean a misconfigured server, not one we can't read: handshake_failure, unrecognized_name. */
const FAILED_READ_ALERTS = new Set([40, 112]);

/** The longest the Cloudflare second opinion (one DNS lookup) may take. */
const RESOLVE_TIMEOUT_MS = 5_000;

type ReadOutcome =
  | { ok: true; read: CertRead; durationMs: number; fetches: number }
  | { ok: false; error: string; errorMessage: string; durationMs: number; fetches: number };

/** One read of the server's certificate, classified. */
async function readServer(config: CertConfig, host: string): Promise<ReadOutcome> {
  const r = await tlsReader.read(host, config.port, config.timeoutMs);
  if (r.ok) return { ok: true, read: { kind: "cert", cert: r.cert, chainLength: r.chainLength }, durationMs: r.durationMs, fetches: 1 };
  if (r.kind === "alert") {
    // handshake_failure and unrecognized_name to a broad TLS 1.2 hello that
    // names the host mean the server is misconfigured for that name (no
    // certificate for it, no usable cipher): a failed read, which alerts once
    // confirmed. The spike saw no hello refused this way; a TLS 1.3-only
    // server answers protocol_version instead.
    if (r.alert !== undefined && FAILED_READ_ALERTS.has(r.alert)) {
      return {
        ok: false,
        error: "cert_handshake_failed",
        errorMessage: `${host}:${config.port}: ${r.message}`,
        durationMs: r.durationMs,
        fetches: 1,
      };
    }
    const reason: CantCheckReason = r.alert === ALERT_PROTOCOL_VERSION ? "tls13_only" : "refused";
    return { ok: true, read: { kind: "cant_check", reason, detail: r.message }, durationMs: r.durationMs, fetches: 1 };
  }
  if (r.kind === "connect_failed") {
    if (CLOUDFLARE_BLOCK_MESSAGE.test(r.message)) {
      return { ok: true, read: { kind: "cant_check", reason: "cloudflare", detail: r.message }, durationMs: r.durationMs, fetches: 1 };
    }
    // A second opinion: is the host on Cloudflare's network anyway?
    const ips = await resolveIPv4(host, RESOLVE_TIMEOUT_MS);
    if (ips?.some(isCloudflareIPv4)) {
      return { ok: true, read: { kind: "cant_check", reason: "cloudflare", detail: r.message }, durationMs: r.durationMs, fetches: 2 };
    }
    return {
      ok: false,
      error: "cert_connect_failed",
      errorMessage: `Couldn't connect to ${host}:${config.port}: ${r.message}`,
      durationMs: r.durationMs,
      fetches: 2,
    };
  }
  const code = { timeout: "cert_timeout", closed: "cert_closed", malformed: "cert_unreadable" }[r.kind];
  return { ok: false, error: code, errorMessage: `${host}:${config.port}: ${r.message}`, durationMs: r.durationMs, fetches: 1 };
}

export interface CertCheckOptions {
  /** The monitor's cached read (monitor_state.cert_cache). */
  cache?: CertCache | null;
  /** When the cycle was planned; freshness is judged at this time. */
  now?: number;
  /** Read the server even when the cache is fresh (a manual test). */
  force?: boolean;
}

/** A result judged from a cached read: no connection, no latency, nothing a re-check could change. */
function fromCache(config: CertConfig, cache: CertCache, now: number, lookupError: CertLookupError | undefined): ProbeResult {
  const { meta, certWarning, ...ev } = evaluateCertRead(config, cache.read, now, cache.warned);
  const full: CertMeta = { ...meta, source: "cache", checkedAt: cache.checkedAt, ...(lookupError ? { lookupError } : {}) };
  return { ...ev, meta: full, recheck: "skip", ...(certWarning ? { certWarning } : {}) };
}

/**
 * The most outbound requests one certificate probe makes: the connection, and
 * a DNS lookup when the connection fails without saying why (the Cloudflare
 * second opinion). Zero when the cycle is judged from the cache.
 */
export const CERT_PROBE_FETCHES = 2;

export async function runCertCheck(config: CertConfig, opts: CertCheckOptions = {}): Promise<ProbeResult> {
  const now = opts.now ?? Date.now();
  const host = certHostKey(config.host);

  // Canonicalize as the HTTP and TCP paths do (WHATWG URL parsing), so a
  // numeric or shorthand IP form (127.1, 0x7f.0.0.1, 0177.0.0.1) can't slip
  // past the SSRF guard; the schema already refuses IP literals, and an IP
  // that gets here anyway is refused too, since SNI can't name it.
  let canonical: string;
  try {
    canonical = new URL(`http://${host}`).hostname;
  } catch {
    canonical = "";
  }
  const safe = !canonical
    ? { ok: false as const, reason: "not a valid host name" }
    : isIPv4(canonical) || canonical.startsWith("[")
      ? { ok: false as const, reason: "an IP address can't be checked (SNI needs a host name)" }
      : assertSafeHost(canonical);
  if (!safe.ok) {
    return {
      ok: false,
      durationMs: 0,
      error: "blocked_host",
      errorMessage: `Target rejected by SSRF guard: ${safe.reason}`,
      fetches: 0,
    };
  }

  const plan = planCertCheck(config, opts.cache, now, opts.force);
  if (!plan.read) return { ...fromCache(config, plan.cache, now, plan.cache.lastError), fetches: 0 };

  const r = await readServer(config, host);
  if (r.ok) {
    // The warned marker belongs to a certificate: keep it while it's the same one.
    const prevWarned = plan.fallback?.warned;
    const validTo = r.read.kind === "cert" ? r.read.cert.validTo : null;
    const warned = prevWarned && prevWarned.validTo === validTo ? prevWarned : undefined;
    const { meta, certWarning, ...ev } = evaluateCertRead(config, r.read, now, warned);
    const full: CertMeta = { ...meta, source: "tls", checkedAt: now };
    return {
      ...ev,
      durationMs: r.durationMs,
      meta: full,
      fetches: r.fetches,
      certCache: { host, port: config.port, checkedAt: now, read: r.read, ...(warned ? { warned } : {}) },
      ...(certWarning ? { certWarning } : {}),
    };
  }

  if (plan.fallback) {
    const lastError: CertLookupError = { code: r.error, message: r.errorMessage, at: now };
    return {
      ...fromCache(config, plan.fallback, now, lastError),
      fetches: r.fetches,
      certCache: { ...plan.fallback, retryAt: now + CERT_RETRY_MS, lastError },
    };
  }

  return { ok: false, durationMs: r.durationMs, error: r.error, errorMessage: r.errorMessage, fetches: r.fetches };
}

/** What the monitor page shows of the last read (GET /api/monitors/:id/detail `certificate`). */
export interface CertificateDetail {
  host: string;
  port: number;
  /** When it was read (epoch ms). */
  checkedAt: number;
  certificate?: {
    subject: string | null;
    issuer: string | null;
    validFrom: number;
    validTo: number;
    daysUntil: number;
    sans: string[];
    sanCount: number;
    serial: string;
    chainLength: number;
    coversHost: boolean;
  };
  cantCheck?: { reason: CantCheckReason; message: string; detail: string };
  /** The latest read failed, so the page shows this earlier one. */
  lookupError?: CertLookupError;
}

/** The detail of the cached read, or null when there is none for this host and port. */
export function certificateDetail(config: CertConfig, cache: CertCache | null, now: number): CertificateDetail | null {
  if (!cache || cache.host !== certHostKey(config.host) || cache.port !== config.port) return null;
  const base = {
    host: cache.host,
    port: cache.port,
    checkedAt: cache.checkedAt,
    ...(cache.lastError ? { lookupError: cache.lastError } : {}),
  };
  const read = cache.read;
  if (read.kind === "cant_check") {
    return { ...base, cantCheck: { reason: read.reason, message: CANT_CHECK_MESSAGES[read.reason], detail: read.detail } };
  }
  const c = read.cert;
  return {
    ...base,
    certificate: {
      subject: c.subject,
      issuer: issuerLabel(c) ?? null,
      validFrom: c.validFrom,
      validTo: c.validTo,
      daysUntil: daysLeft(c.validTo, now),
      sans: c.sans,
      sanCount: c.sanCount,
      serial: c.serial,
      chainLength: read.chainLength,
      coversHost: certificateCovers(c, cache.host),
    },
  };
}
