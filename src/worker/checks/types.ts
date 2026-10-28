import type { MonitorState } from "../../shared/states";

/**
 * The raw result of a single probe attempt, shared by every executor
 * (http/dns/tcp/domain). Executors return this; the runner classifies it into a
 * `CheckOutcome`. `meta` carries type-specific detail (resolved DNS records,
 * domain expiry, …) that is persisted on the sample and surfaced in the UI.
 */
export interface ProbeResult {
  ok: boolean;
  durationMs: number;
  /** Short machine code (e.g. "timeout", "dns_nxdomain", "tcp_refused"). */
  error?: string;
  /** Human-readable detail (safe - never contains secrets). */
  errorMessage?: string;
  /** True when the target responded but slower/closer-to-limit than desired. */
  degraded?: boolean;
  /** Type-specific structured detail persisted on the sample. */
  meta?: unknown;
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
   * "deferred" (the run had no budget left for it; the caller must not persist
   * this outcome and leaves the monitor due for the next run).
   * Absent when the first check passed or no re-check applied.
   */
  confirmation?: "confirmed" | "cleared" | "deferred";
  assertionFailures?: string[];
  /** Type-specific structured detail (resolved records, domain expiry, …). */
  meta?: unknown;
  /** Epoch ms when the cycle completed. */
  at: number;
}
