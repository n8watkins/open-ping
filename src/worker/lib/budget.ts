/**
 * What one cron run may spend, by Cloudflare Workers plan (docs/FREE_TIER.md).
 *
 * Cloudflare caps every Worker invocation, the scheduled one included:
 *   - Free: 50 subrequests (outbound fetches) and 50 D1 queries per
 *     invocation (a `db.batch()` counts as one query);
 *   - Paid: 10,000 subrequests and 1,000 D1 queries.
 * A run that goes past a cap fails with "Too many API requests by single Worker
 * invocation", so the scheduler budgets each run: D1 queries are counted as
 * they happen (countingD1), outbound fetches are reserved at each check's worst
 * case and charged what it really made (redirect hops included) and one per
 * notification, and work that doesn't fit waits for the next tick.
 *
 * Sources (checked 2026-10-27): developers.cloudflare.com/workers/platform/limits/
 * and developers.cloudflare.com/d1/platform/limits/.
 */
import type { Env } from "../types";

export type WorkersPlan = "free" | "paid";

export interface PlanBudget {
  plan: WorkersPlan;
  /** D1 queries the run may make in total. */
  d1Queries: number;
  /** Outbound fetches the run may make in total. */
  subrequests: number;
  /** Hard ceiling on polled checks per run, whatever the budget says. */
  maxChecks: number;
}

/**
 * The plan limits, with a margin kept back (Cloudflare may count a few requests
 * we can't see, such as an RDAP registry redirecting again beyond the one hop a
 * domain check expects).
 */
export const PLAN_BUDGETS: Record<WorkersPlan, PlanBudget> = {
  free: { plan: "free", d1Queries: 46, subrequests: 45, maxChecks: 200 },
  paid: { plan: "paid", d1Queries: 950, subrequests: 9_000, maxChecks: 200 },
};

/**
 * The plan this install runs on: `WORKERS_PLAN` ("free" or "paid", set in
 * wrangler.jsonc vars). Unset or unknown means Free, the safe assumption: a
 * Paid install that keeps the default only checks fewer monitors per run.
 */
export function planBudget(env: Pick<Env, "WORKERS_PLAN">): PlanBudget {
  return env.WORKERS_PLAN === "paid" ? PLAN_BUDGETS.paid : PLAN_BUDGETS.free;
}

/** Running totals for one invocation. */
export interface UsageCounter {
  d1: number;
}

/**
 * Wraps a D1 binding so every query it runs is counted: each `first`, `run`,
 * `all` or `raw` on a statement is one, and a whole `batch` is one (as D1
 * counts it). Statements are unwrapped before they reach `batch`, so D1 only
 * ever sees its own objects.
 */
export function countingD1(db: D1Database, counter: UsageCounter): D1Database {
  const real = new WeakMap<object, D1PreparedStatement>();

  const wrapStatement = (stmt: D1PreparedStatement): D1PreparedStatement => {
    const proxy = new Proxy(stmt, {
      get(target, prop, receiver) {
        if (prop === "bind") {
          return (...values: unknown[]) => wrapStatement(target.bind(...values));
        }
        if (prop === "first" || prop === "run" || prop === "all" || prop === "raw") {
          const fn = Reflect.get(target, prop, receiver) as (...a: unknown[]) => unknown;
          return (...args: unknown[]) => {
            counter.d1++;
            return fn.apply(target, args);
          };
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    real.set(proxy, stmt);
    return proxy;
  };

  return new Proxy(db, {
    get(target, prop) {
      if (prop === "prepare") {
        return (query: string) => wrapStatement(target.prepare(query));
      }
      if (prop === "batch") {
        return (statements: D1PreparedStatement[]) => {
          counter.d1++;
          return target.batch(statements.map((s) => real.get(s) ?? s));
        };
      }
      if (prop === "exec") {
        return (query: string) => {
          counter.d1++;
          return target.exec(query);
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/**
 * What one polled check holds of the run's budget.
 *
 * D1: a check makes no query of its own. The scheduler collects every check's
 * writes (state, sample, rollup, interval, incident and alert) and sends them
 * with the end-of-run work in one batch, after one shared read batch for the
 * checks that may open or resolve an incident (checks/state.ts), so a run's
 * round trips don't grow with its checks (test/integration/
 * scheduler-writes.test.ts). Each check still keeps one query back, for good:
 * if that batch fails, the run retries each monitor's writes as their own
 * batch, and this is what pays for it (deeper retries stop when the run is out
 * of budget; lib/batch.ts runWritePlan).
 *
 * Fetches: a check reserves the most its probe can make (checks/runner.ts
 * `probeFetchLimit`, redirect hops included, since Cloudflare counts each hop),
 * and is charged what it really made when it ends. A check that would
 * confirm a failure also holds its re-check's worst case while it runs, so the
 * re-check is never refused for lack of fetches once the check started; the
 * hold is released when the check passes, so a passing check is still charged
 * only what it made.
 */
export const CHECK_COST = { d1: 1, subrequests: 1 } as const;

/**
 * Most D1 queries the weekly summary makes when it is due
 * (notifications/weekly.ts; measured in test/integration/scheduler-email-budget.test.ts).
 */
export const WEEKLY_SUMMARY_D1 = 9;

/** Most D1 queries the monthly report makes when it tries (notifications/monthly.ts). */
export const MONTHLY_REPORT_D1 = 2;

/**
 * What a run keeps back for the work after its checks: the shared read batch,
 * the batch of writes and end-of-run work, the weekly summary or the monthly
 * report (one email job per run), and the batch that records the finish.
 * Retries after a failed batch are paid from what is left and stop when it
 * runs out (lib/batch.ts), and the emails are skipped, to catch up on a later
 * run, when retries left too little for them.
 */
export const TAIL_RESERVE = { d1: 3 + Math.max(WEEKLY_SUMMARY_D1, MONTHLY_REPORT_D1) } as const;

/**
 * D1 queries a typical notification delivery spends, for sizing how many a
 * run claims: a channel's mark and result plus its read, or a Web Push
 * device's subscription, mark and result. Each delivery is then charged its
 * own worst case before it goes (notifications/dispatcher.ts deliveryD1Cost:
 * the once-per-pass channel, VAPID and email_from reads, and a possible
 * failure mark), and what doesn't fit waits for the next run.
 */
export const NOTIFICATION_D1_COST = 3;

/**
 * Deliveries a run always keeps room for, so a run that fills up with checks
 * can still send the alerts its failures queue (the rest wait for the next run).
 */
export const NOTIFICATION_RESERVE = 3;

/**
 * One started check's hold on the run's budget (RunBudget.startCheck).
 */
export interface CheckTicket {
  /**
   * Takes the check's confirmation re-check (another probe's worst case): the
   * fetches it held from the start, or, for a check started without that hold,
   * a new reservation if one still fits. False when it doesn't; the scheduler
   * then leaves that monitor due for the next run instead of alerting on an
   * unconfirmed failure.
   */
  tryConfirm(): boolean;
  /**
   * Ends the check, charging the fetches it really made (redirect hops
   * included). Without a count, as when the check threw, it is charged
   * everything it reserved.
   */
  end(fetchesSpent?: number): void;
}

/**
 * Tracks one run against its plan budget. Checks run in parallel, so each one
 * reserves its worst case before it starts and gives the reservation back when
 * it ends, keeping only what it really spent; the real D1 count comes from
 * countingD1.
 */
export class RunBudget {
  private committedD1 = 0;
  private reservedFetches = 0;
  private fetches = 0;
  private checks = 0;
  private inFlight = 0;
  private waiters: (() => void)[] = [];

  constructor(
    readonly limits: PlanBudget,
    private readonly usage: UsageCounter,
  ) {}

  private fetchesFit(n: number): boolean {
    return this.fetches + this.reservedFetches + n <= this.limits.subrequests;
  }

  /**
   * Starts a check whose probe makes at most `probeFetches` requests, holding
   * `confirmFetches` more for its confirmation re-check, if both still fit
   * beside the tail and notification reserves.
   */
  tryStartCheck(
    probeFetches: number = CHECK_COST.subrequests,
    confirmFetches = 0,
    /** False starts it without the re-check's hold; tryConfirm then reserves `confirmFetches` if it still fits. */
    holdConfirm = true,
  ): CheckTicket | null {
    if (this.checks >= this.limits.maxChecks) return null;
    const hold = holdConfirm ? confirmFetches : 0;
    const d1After =
      this.usage.d1 + this.committedD1 + CHECK_COST.d1 + TAIL_RESERVE.d1 + NOTIFICATION_RESERVE * NOTIFICATION_D1_COST;
    const fetchesFit = this.fetchesFit(probeFetches + hold + NOTIFICATION_RESERVE);
    if (d1After > this.limits.d1Queries || !fetchesFit) return null;
    // Kept for the whole run: the check's writes go out at the end (CHECK_COST).
    this.committedD1 += CHECK_COST.d1;
    this.reservedFetches += probeFetches + hold;
    this.checks++;
    this.inFlight++;

    let reserved = probeFetches + hold;
    let held = hold > 0;
    // What a re-check reserves when it wasn't held: the re-check's own size
    // (a re-check from another region holds more than the first probe).
    const later = confirmFetches > 0 ? confirmFetches : probeFetches;
    let ended = false;
    return {
      tryConfirm: () => {
        if (ended) return false;
        if (held) {
          held = false;
          return true;
        }
        if (!this.fetchesFit(later)) return false;
        this.reservedFetches += later;
        reserved += later;
        return true;
      },
      end: (fetchesSpent?: number) => {
        if (ended) return;
        ended = true;
        this.reservedFetches -= reserved;
        this.fetches += fetchesSpent ?? reserved;
        this.inFlight--;
        for (const wake of this.waiters.splice(0)) wake();
      },
    };
  }

  /**
   * Starts a check, waiting for running ones to finish when only their
   * worst-case reservations are in the way (most checks spend less, which frees
   * room). Once nothing is running and the re-check's hold still doesn't fit,
   * the check starts without it if its own probe fits (its re-check is then
   * reserved only if it fails and room is left, else deferred to the next
   * run), so the end of a run's budget isn't left unused. Null once nothing is
   * running and even that doesn't fit.
   */
  async startCheck(probeFetches: number = CHECK_COST.subrequests, confirmFetches = 0): Promise<CheckTicket | null> {
    for (;;) {
      const ticket = this.tryStartCheck(probeFetches, confirmFetches);
      if (ticket) return ticket;
      if (this.inFlight === 0) return confirmFetches > 0 ? this.tryStartCheck(probeFetches, confirmFetches, false) : null;
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }

  /** Outbound fetches counted so far (finished checks only). */
  get fetchesUsed(): number {
    return this.fetches;
  }
  /**
   * How many notifications fit in what's left (one fetch each), keeping the
   * checks' retry room and the tail reserve. Call it once the checks are done.
   */
  notificationAllowance(max: number): number {
    const d1Left = this.limits.d1Queries - this.usage.d1 - this.committedD1 - TAIL_RESERVE.d1;
    const byD1 = Math.floor(d1Left / NOTIFICATION_D1_COST);
    const byFetch = this.limits.subrequests - this.fetches;
    return Math.max(0, Math.min(max, byD1, byFetch));
  }

  get d1Used(): number {
    return this.usage.d1;
  }

  /**
   * True while one more D1 query still leaves `keep` queries for what must come
   * after it (the run record, the deliveries already claimed). Retry paths ask
   * this before each round trip, so a failing batch can never push the run
   * past its plan's limit.
   */
  canSpendD1(keep = 1): boolean {
    return this.usage.d1 + 1 + keep <= this.limits.d1Queries;
  }
}
