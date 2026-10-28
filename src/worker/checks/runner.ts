import type { MonitorRecord } from "../db/monitors";
import type {
  Assertion,
  DnsConfig,
  DomainConfig,
  HttpConfig,
  TcpConfig,
} from "../../shared/schemas";
import type { CheckOutcome, ProbeResult } from "./types";
import { MAX_REDIRECTS, runHttpCheck } from "./http";
import { runDnsCheck } from "./dns";
import { runTcpCheck } from "./tcp";
import { planDomainCheck, runDomainCheck, type DomainCache } from "./domain";
import { evaluateAssertions } from "./assertions";

/**
 * Runs one check cycle (PRD §8, §9) for any polled monitor type
 * (http/dns/tcp/domain): the check itself, then, if it failed, one
 * confirmation re-check a few seconds later, warm-up handling, HTTP assertion
 * evaluation, and classification into up/degraded/down. Pure orchestration -
 * persistence is handled separately by checks/state.
 *
 * Confirmation (docs/MONITOR_TYPES.md, "Confirm before alerting"): a failure
 * opens an incident and alerts only when a second check, made
 * CONFIRM_DELAY_MS later with the cache bypassed, fails too. If the second
 * check passes, the cycle counts as up and the sample is flagged as a blip
 * (retry_recovered). The caller decides whether a cycle confirms (the
 * monitor's setting, and not while it is already down, so an ongoing outage
 * costs one fetch per cycle and a recovery is seen on the first passing check)
 * and may refuse the re-check for lack of budget, which returns a `deferred`
 * outcome that the scheduler must not persist.
 */

/**
 * The most outbound requests one probe of this monitor can make, which is what
 * the run reserves for it before it starts (lib/budget.ts). Cloudflare counts
 * every redirect hop as its own subrequest:
 *   - http follows up to MAX_REDIRECTS hops itself (checks/http.ts) and reports
 *     the real count, so this worst case is only held while the check runs;
 *   - domain asks rdap.org, which redirects to the registry's RDAP server, and
 *     the runtime follows that hop, so it costs two; a cycle judged from the
 *     cached read (checks/domain.ts) costs none, which `domain` tells it;
 *   - dns and tcp make one request.
 */
export function probeFetchLimit(
  monitor: Pick<MonitorRecord, "type" | "config">,
  /** A domain monitor's cached read and the time the cycle is planned at. */
  domain?: { cache: DomainCache | null; now: number },
): number {
  switch (monitor.type) {
    case "http":
      return (monitor.config as HttpConfig).followRedirects ? 1 + MAX_REDIRECTS : 1;
    case "domain":
      return domain && !planDomainCheck(monitor.config as DomainConfig, domain.cache, domain.now).lookup
        ? 0
        : 2;
    default:
      return 1;
  }
}

/** Pause before the confirmation re-check. */
export const CONFIRM_DELAY_MS = 5_000;

export interface RunOptions {
  warmup?: boolean;
  /** Re-check once before reporting a failure (default true). */
  confirm?: boolean;
  /** Pause before the re-check (default CONFIRM_DELAY_MS). */
  confirmDelayMs?: number;
  /**
   * Asked right before the re-check; false means the run can't afford it, and
   * the outcome comes back with `confirmation: "deferred"`.
   */
  allowConfirm?: () => boolean;
  /** Domain monitors: the cached read (monitor_state.domain_cache). */
  domainCache?: DomainCache | null;
  /**
   * When the cycle was planned (default `now`): a domain check judges its
   * cache's freshness at this time, the same one `probeFetchLimit` reserved for.
   */
  plannedAt?: number;
  /** Domain monitors: ask RDAP even if the cached read is fresh (a manual test). */
  refreshDomain?: boolean;
  /** Awaited before each RDAP request, so one run spaces its lookups out. */
  paceLookup?: () => Promise<void>;
  /**
   * Runs the confirmation re-check somewhere else: from another Cloudflare
   * location (checks/region.ts). It resolves with that probe's result, where
   * it ran and the requests it cost this run, or `{ attempt: null, fetches }`
   * when it couldn't run there, in which case the re-check runs here as
   * before. The caller's `allowConfirm` reservation must cover both (the
   * scheduler holds a local re-check plus REMOTE_RECHECK_OVERHEAD). Absent
   * means re-check here.
   */
  remoteRecheck?: (monitor: MonitorRecord, opts: { warmup: boolean }) => Promise<RemoteRecheck>;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  now?: number;
}

/** What a re-check made from another location returned (RunOptions.remoteRecheck). */
export interface RemoteRecheck {
  /** The probe's result, or null when it couldn't run there. */
  attempt: ProbeAttempt | null;
  /** The Cloudflare data center (IATA code, such as "FRA") it ran in, when known. */
  colo?: string;
  /** Requests charged to this run for it, the hop itself included. */
  fetches: number;
}

/** A probe result plus the HTTP-only fields classification consults if present. */
export type ClassifiableResult = ProbeResult & {
  statusCode?: number;
  suspended?: boolean;
};

interface ClassifyInput {
  result: ClassifiableResult;
  ok: boolean;
  succeededAttempt: number; // 1-based, or -1 if all failed
  maxAttempts: number;
  warmup: boolean;
  assertionFailures?: string[];
}

/** Pure classification of attempt results into a CheckOutcome (sans timestamp). */
export function classifyCheck(input: ClassifyInput): Omit<CheckOutcome, "at" | "fetches"> {
  const { result, ok, succeededAttempt, maxAttempts, warmup, assertionFailures } = input;
  const retryRecovered = ok && succeededAttempt > 1;

  let state: CheckOutcome["state"];
  // A Render-suspended response is a definitive outage (the app is turned off),
  // so it is reported as `suspended` even during a warm-up cycle - there is no
  // cold start to grant grace for. A failed warm-up otherwise reports
  // `warming_up`, not `down`, granting one grace cycle (PRD §8 warm-up).
  if (!ok) state = result.suspended ? "suspended" : warmup ? "warming_up" : "down";
  else if (result.degraded) state = "degraded";
  else state = "up";

  const error = ok
    ? undefined
    : result.suspended
      ? "suspended"
      : assertionFailures && assertionFailures.length
        ? "assertion_failed"
        : result.error ?? "check_failed";

  return {
    state,
    ok,
    durationMs: result.durationMs,
    statusCode: result.statusCode,
    error,
    errorMessage: ok ? undefined : result.errorMessage,
    attempts: ok ? succeededAttempt : maxAttempts,
    warmup,
    retryRecovered,
    assertionFailures:
      assertionFailures && assertionFailures.length ? assertionFailures : undefined,
  };
}

/** Permanent-failure error codes that a re-check can't change. */
const PERMANENT_ERRORS = new Set(["blocked_url", "blocked_host"]);

/** One probe's result, with its HTTP assertions applied. */
export interface ProbeAttempt {
  result: ClassifiableResult;
  ok: boolean;
  assertionFailures?: string[];
}

/** One probe of the monitor's target, with HTTP assertions applied. */
export async function probe(
  monitor: MonitorRecord,
  opts: { warmup: boolean; fresh: boolean; run: RunOptions },
): Promise<ProbeAttempt> {
  switch (monitor.type) {
    case "http": {
      const r = await runHttpCheck(monitor.config as HttpConfig, {
        warmup: opts.warmup,
        ...(opts.fresh ? { noStore: true } : {}),
      });
      const assertions = (monitor.assertions ?? []) as Assertion[];
      // HTTP-only: content/JSON assertions run on a 2xx-ranged response body.
      if (r.ok && assertions.length) {
        const ar = evaluateAssertions(assertions, { body: r.body ?? "", statusCode: r.statusCode });
        if (!ar.passed) return { result: r, ok: false, assertionFailures: ar.failures };
      }
      return { result: r, ok: r.ok };
    }
    case "dns": {
      const r = await runDnsCheck(monitor.config as DnsConfig);
      return { result: r, ok: r.ok };
    }
    case "tcp": {
      const r = await runTcpCheck(monitor.config as TcpConfig);
      return { result: r, ok: r.ok };
    }
    case "domain": {
      const run = opts.run;
      const at = run.plannedAt ?? run.now;
      const r = await runDomainCheck(monitor.config as DomainConfig, {
        cache: run.domainCache ?? null,
        ...(at !== undefined ? { now: at } : {}),
        ...(run.refreshDomain ? { force: true } : {}),
        ...(run.paceLookup ? { pace: run.paceLookup } : {}),
      });
      return { result: r, ok: r.ok };
    }
    default:
      // Heartbeat monitors are push-driven and never routed through here.
      throw new Error(`runMonitorCheck: unsupported monitor type "${monitor.type}"`);
  }
}

export async function runMonitorCheck(
  monitor: MonitorRecord,
  opts: RunOptions = {},
): Promise<CheckOutcome> {
  const warmup = opts.warmup ?? false;
  const confirm = opts.confirm ?? true;
  const sleep = opts.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));

  const limit = probeFetchLimit(monitor);
  const first = await probe(monitor, { warmup, fresh: false, run: opts });
  let fetches = first.result.fetches ?? limit;
  let decided = first;
  let succeededAttempt = first.ok ? 1 : -1;
  let attempts = 1;
  let confirmation: CheckOutcome["confirmation"];
  let confirmedFrom: string | undefined;

  const confirmable =
    !first.ok &&
    confirm &&
    first.result.recheck !== "skip" &&
    !(first.result.error && PERMANENT_ERRORS.has(first.result.error));
  if (confirmable) {
    // "defer": a re-check now would be refused the same way (RDAP's 429).
    if (first.result.recheck === "defer" || (opts.allowConfirm && !opts.allowConfirm())) {
      confirmation = "deferred";
    } else {
      await sleep(opts.confirmDelayMs ?? CONFIRM_DELAY_MS);
      // From another location when the caller set that up; here when it
      // couldn't run there (the reservation covers both).
      let second: ProbeAttempt | null = null;
      if (opts.remoteRecheck) {
        const remote = await opts.remoteRecheck(monitor, { warmup });
        fetches += remote.fetches;
        second = remote.attempt;
        if (second && remote.colo) confirmedFrom = remote.colo;
      }
      if (!second) {
        second = await probe(monitor, { warmup, fresh: true, run: opts });
        fetches += second.result.fetches ?? limit;
      }
      decided = second;
      attempts = 2;
      if (decided.ok) succeededAttempt = 2;
      confirmation = decided.ok ? "cleared" : "confirmed";
    }
  }

  const outcome = classifyCheck({
    result: decided.result,
    ok: succeededAttempt > 0,
    succeededAttempt,
    maxAttempts: attempts,
    warmup,
    assertionFailures: decided.assertionFailures,
  });

  return {
    ...outcome,
    ...(confirmation ? { confirmation } : {}),
    ...(confirmedFrom ? { confirmedFrom } : {}),
    meta: decided.result.meta,
    ...(decided.result.domainCache ? { domainCache: decided.result.domainCache } : {}),
    fetches,
    at: opts.now ?? Date.now(),
  };
}
