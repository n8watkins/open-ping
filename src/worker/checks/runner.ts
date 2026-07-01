import type { MonitorRecord } from "../db/monitors";
import type {
  Assertion,
  DnsConfig,
  DomainConfig,
  HttpConfig,
  TcpConfig,
} from "../../shared/schemas";
import type { CheckOutcome, ProbeResult } from "./types";
import { runHttpCheck } from "./http";
import { runDnsCheck } from "./dns";
import { runTcpCheck } from "./tcp";
import { runDomainCheck } from "./domain";
import { evaluateAssertions } from "./assertions";

/**
 * Runs one check cycle (PRD §8, §9) for any polled monitor type
 * (http/dns/tcp/domain): up to N attempts with a retry delay, warm-up handling,
 * HTTP assertion evaluation, and classification into up/degraded/down. Pure
 * orchestration — persistence is handled separately by checks/state.
 */

const DEFAULT_ATTEMPTS = 2;
const RETRY_DELAY_MS = 10_000;

export interface RunOptions {
  warmup?: boolean;
  attempts?: number;
  retryDelayMs?: number;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  now?: number;
}

/** A probe result plus the HTTP-only fields classification consults if present. */
type ClassifiableResult = ProbeResult & {
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
export function classifyCheck(input: ClassifyInput): Omit<CheckOutcome, "at"> {
  const { result, ok, succeededAttempt, maxAttempts, warmup, assertionFailures } = input;
  const retryRecovered = ok && succeededAttempt > 1;

  let state: CheckOutcome["state"];
  // A Render-suspended response is a definitive outage (the app is turned off),
  // so it is reported as `suspended` even during a warm-up cycle — there is no
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

/** Permanent-failure error codes that must not consume a retry. */
const PERMANENT_ERRORS = new Set(["blocked_url", "blocked_host"]);

export async function runMonitorCheck(
  monitor: MonitorRecord,
  opts: RunOptions = {},
): Promise<CheckOutcome> {
  const assertions = (monitor.assertions ?? []) as Assertion[];
  const warmup = opts.warmup ?? false;
  const maxAttempts = Math.max(1, opts.attempts ?? DEFAULT_ATTEMPTS);
  const retryDelayMs = opts.retryDelayMs ?? RETRY_DELAY_MS;
  const sleep = opts.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));

  let result: ClassifiableResult = { ok: false, durationMs: 0, error: "not_run" };
  let assertionFailures: string[] | undefined;
  let succeededAttempt = -1;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    assertionFailures = undefined;
    let ok: boolean;

    switch (monitor.type) {
      case "http": {
        const r = await runHttpCheck(monitor.config as HttpConfig, { warmup });
        result = r;
        ok = r.ok;
        // HTTP-only: content/JSON assertions run on a 2xx-ranged response body.
        if (ok && assertions.length) {
          const ar = evaluateAssertions(assertions, {
            body: r.body ?? "",
            statusCode: r.statusCode,
          });
          if (!ar.passed) {
            ok = false;
            assertionFailures = ar.failures;
          }
        }
        break;
      }
      case "dns":
        result = await runDnsCheck(monitor.config as DnsConfig);
        ok = result.ok;
        break;
      case "tcp":
        result = await runTcpCheck(monitor.config as TcpConfig);
        ok = result.ok;
        break;
      case "domain":
        result = await runDomainCheck(monitor.config as DomainConfig);
        ok = result.ok;
        break;
      default:
        // Heartbeat monitors are push-driven and never routed through here.
        throw new Error(
          `runMonitorCheck: unsupported monitor type "${monitor.type}"`,
        );
    }

    if (ok) {
      succeededAttempt = attempt;
      break;
    }
    // Permanent failures (SSRF-blocked URL/host) shouldn't waste a retry.
    if (result.error && PERMANENT_ERRORS.has(result.error)) break;
    if (attempt < maxAttempts) await sleep(retryDelayMs);
  }

  const outcome = classifyCheck({
    result,
    ok: succeededAttempt > 0,
    succeededAttempt,
    maxAttempts,
    warmup,
    assertionFailures,
  });

  return { ...outcome, meta: result.meta, at: opts.now ?? Date.now() };
}
