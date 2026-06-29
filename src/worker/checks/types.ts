import type { MonitorState } from "../../shared/states";

/** The classified result of one full check cycle for a monitor. */
export interface CheckOutcome {
  /** Resolved state for this cycle: up | degraded | down. */
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
  /** Succeeded only after a retry. */
  retryRecovered: boolean;
  assertionFailures?: string[];
  /** Epoch ms when the cycle completed. */
  at: number;
}
