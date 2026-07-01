import type { DomainConfig } from "../../shared/schemas";
import type { ProbeResult } from "./types";
import { assertSafeUrl } from "../lib/ssrf";

/**
 * Domain-expiry check executor. Queries the domain's RDAP record via rdap.org
 * (which 3xx-redirects to the authoritative registry RDAP server) and classifies
 * on the `expiration` event date: expired → down, within `warnDays` → degraded,
 * otherwise up.
 *
 * SSRF/abuse handling: rdap.org is a FIXED constant (never user input), so this
 * is not an SSRF vector. We still re-validate the constructed URL with
 * `assertSafeUrl` as belt-and-suspenders. Redirects are followed by the runtime
 * (which caps the hop count); the target chain is the trusted RDAP bootstrap.
 */

const RDAP_BASE = "https://rdap.org/domain/";
const DAY_MS = 86_400_000;

interface RdapEvent {
  eventAction?: string;
  eventDate?: string;
}
interface RdapResponse {
  events?: RdapEvent[];
}

export async function runDomainCheck(config: DomainConfig): Promise<ProbeResult> {
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
    const durationMs = Date.now() - startedAt;

    if (!res.ok) {
      return {
        ok: false,
        durationMs,
        error: "rdap_error",
        errorMessage: `RDAP returned HTTP ${res.status} for ${config.domain}`,
      };
    }

    const json = (await res.json()) as RdapResponse;
    const expEvent = (json.events ?? []).find(
      (e) => e.eventAction === "expiration",
    );
    const expDate = expEvent?.eventDate;
    const expMs = expDate ? Date.parse(expDate) : NaN;

    if (!expDate || Number.isNaN(expMs)) {
      return {
        ok: false,
        durationMs,
        error: "rdap_no_expiry",
        errorMessage: `No parseable expiration event for ${config.domain}`,
      };
    }

    const daysUntil = (expMs - Date.now()) / DAY_MS;
    const meta = {
      expiresAt: new Date(expMs).toISOString(),
      daysUntil: Math.floor(daysUntil),
    };

    if (daysUntil <= 0) {
      return {
        ok: false,
        durationMs,
        error: "domain_expired",
        errorMessage: `${config.domain} expired on ${meta.expiresAt}`,
        meta,
      };
    }
    if (daysUntil <= config.warnDays) {
      return { ok: true, durationMs, degraded: true, meta };
    }
    return { ok: true, durationMs, meta };
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
