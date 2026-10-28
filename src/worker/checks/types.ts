import type { MonitorState } from "../../shared/states";
import type { DomainCache } from "./domain";

/**
 * The raw result of a single probe attempt, shared by every executor
 * (http/dns/tcp/domain). Executors return this; the runner classifies it into a
 * `CheckOutcome`. `meta` carries type-specific detail (resolved DNS records,
 * domain expiry, …) that is persisted on the sample and surfaced in the UI.
 */
export interface ProbeResult {
  ok: boolean;
  /** Absent when the probe made no request (a domain check judged from its cached read). */
  durationMs?: number;
  /** Short machine code (e.g. "timeout", "dns_nxdomain", "tcp_refused"). */
  error?: string;
  /** Human-readable detail (safe - never contains secrets). */
  errorMessage?: string;
  /** True when the target responded but slower/closer-to-limit than desired. */
  degraded?: boolean;
  /** Type-specific structured detail persisted on the sample. */
  meta?: unknown;
  /**
   * Outbound requests the probe made, redirect hops included (Cloudflare
   * counts each one against the run's subrequest limit; lib/budget.ts).
   * Absent means the probe couldn't count them, and the runner charges its
   * worst case (`probeFetchLimit` in checks/runner.ts).
   */
  fetches?: number;
  /**
   * How a failed probe's confirmation re-check should go: "skip" when asking
   * again can't change the answer (RDAP says the domain expired, or the result
   * came from a cached read), "defer" when asking now would only be refused
   * again (a 429), so the confirmation waits for the next run.
   */
  recheck?: "skip" | "defer";
  /** A domain check's new cached read to store (monitor_state.domain_cache); absent leaves it as is. */
  domainCache?: DomainCache;
}

/** The classified result of one full check cycle for a monitor. */
export interface CheckOutcome {
  /** Resolved state for this cycle: up | degraded | down | suspended. */
  state: MonitorState;
  ok: boolean;
  durationMs?: number;
  statusCode?: number;
  /** Machine error code (e.g. "timeout", "status_out_of_range", "assertion_failed"). */
  error?: string;
  errorMessage?: string;
  /** Attempts performed (1-based count of the deciding attempt, or max on failure). */
  attempts: number;
  warmup: boolean;
  /** Succeeded only after a retry (the confirmation re-check passed: a blip). */
  retryRecovered: boolean;
  /**
   * What the confirmation re-check did, when the first check failed:
   * "confirmed" (it failed too), "cleared" (it passed, so no incident), or
   * "deferred" (the run had no budget left for it, or RDAP rate limited the
   * lookup so a re-check now would be refused too; the caller must not persist
   * this outcome and leaves the monitor due for the next run).
   * Absent when the first check passed or no re-check applied.
   */
  confirmation?: "confirmed" | "cleared" | "deferred";
  assertionFailures?: string[];
  /** Type-specific structured detail (resolved records, domain expiry, …). */
  meta?: unknown;
  /** A domain check's new cached read to store; absent leaves the stored one as is. */
  domainCache?: DomainCache;
  /** Outbound requests the whole cycle made: every probe, redirect hops included. */
  fetches: number;
  /** Epoch ms when the cycle completed. */
  at: number;
}
