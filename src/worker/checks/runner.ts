import type { MonitorRecord } from "../db/monitors";
import type { HttpConfig, Assertion } from "../../shared/schemas";
import type { HttpCheckResult } from "./http";
import type { CheckOutcome } from "./types";
import { runHttpCheck } from "./http";
import { evaluateAssertions } from "./assertions";

/**
 * Runs one HTTP check cycle (PRD §8, §9): up to N attempts with a retry delay,
 * warm-up handling, assertion evaluation, and classification into up/degraded/down.
 * Pure orchestration — persistence is handled separately by checks/state.
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

interface ClassifyInput {
  result: HttpCheckResult;
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

export async function runMonitorCheck(
  monitor: MonitorRecord,
  opts: RunOptions = {},
): Promise<CheckOutcome> {
  const config = monitor.config as HttpConfig;
  const assertions = (monitor.assertions ?? []) as Assertion[];
  const warmup = opts.warmup ?? false;
  const maxAttempts = Math.max(1, opts.attempts ?? DEFAULT_ATTEMPTS);
  const retryDelayMs = opts.retryDelayMs ?? RETRY_DELAY_MS;
  const sleep = opts.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));

  let result: HttpCheckResult = { ok: false, durationMs: 0, error: "not_run" };
  let assertionFailures: string[] | undefined;
  let succeededAttempt = -1;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    result = await runHttpCheck(config, { warmup });
    assertionFailures = undefined;
    let ok = result.ok;

    if (ok && assertions.length) {
      const ar = evaluateAssertions(assertions, {
        body: result.body ?? "",
        statusCode: result.statusCode,
      });
      if (!ar.passed) {
        ok = false;
        assertionFailures = ar.failures;
      }
    }

    if (ok) {
      succeededAttempt = attempt;
      break;
    }
    // Permanent failures (e.g. SSRF-blocked target) shouldn't waste a retry.
    if (result.error === "blocked_url") break;
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

  return { ...outcome, at: opts.now ?? Date.now() };
}
