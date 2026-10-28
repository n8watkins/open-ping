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
 * Most a single polled check may spend in D1: measured at about 5 queries for
 * a passing check and 9 for one that opens an incident (test/integration/
 * scheduler-budget.test.ts), plus one for an alert channel's queued delivery.
 * Its fetches depend on the monitor: a check reserves the most its probe can
 * make (checks/runner.ts `probeFetchLimit`, redirect hops included, since
 * Cloudflare counts each hop), and is charged what it really made when it ends.
 * A failed check's confirmation re-check asks for its own reservation with
 * `tryConfirm`, so a run doesn't hold back a second probe for every check when
 * most of them pass.
 */
export const CHECK_COST = { d1: 10, subrequests: 1 } as const;

/** What a run keeps back for the work after its checks. Normally that is two
 * batches (the end-of-run work, then the run record and the lease), but if the
 * end-of-run batch fails its ten statements are retried one by one
 * (lib/batch.ts), and the weekly summary may need a few reads, so the reserve
 * covers that worst case. */
export const TAIL_RESERVE = { d1: 12 } as const;

/** D1 queries one notification delivery spends (mark sent or failed, plus slack). */
export const NOTIFICATION_D1_COST = 2;

/**
 * One started check's hold on the run's budget (RunBudget.startCheck).
 */
export interface CheckTicket {
  /**
   * Reserves the check's confirmation re-check (another probe's worst case).
   * False when the run can't afford it beside the other running checks'
   * reservations; the scheduler then leaves that monitor due for the next run
   * instead of alerting on an unconfirmed failure.
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
  private reservedD1 = 0;
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
   * Starts a check whose probe makes at most `probeFetches` requests, if its
   * worst case still fits beside the tail reserve.
   */
  tryStartCheck(probeFetches: number = CHECK_COST.subrequests): CheckTicket | null {
    if (this.checks >= this.limits.maxChecks) return null;
    const d1After = this.usage.d1 + this.reservedD1 + CHECK_COST.d1 + TAIL_RESERVE.d1;
    if (d1After > this.limits.d1Queries || !this.fetchesFit(probeFetches)) return null;
    this.reservedD1 += CHECK_COST.d1;
    this.reservedFetches += probeFetches;
    this.checks++;
    this.inFlight++;

    let reserved = probeFetches;
    let ended = false;
    return {
      tryConfirm: () => {
        if (ended || !this.fetchesFit(probeFetches)) return false;
        this.reservedFetches += probeFetches;
        reserved += probeFetches;
        return true;
      },
      end: (fetchesSpent?: number) => {
        if (ended) return;
        ended = true;
        this.reservedD1 -= CHECK_COST.d1;
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
   * room). Null once nothing is running and it still doesn't fit.
   */
  async startCheck(probeFetches: number = CHECK_COST.subrequests): Promise<CheckTicket | null> {
    for (;;) {
      const ticket = this.tryStartCheck(probeFetches);
      if (ticket) return ticket;
      if (this.inFlight === 0) return null;
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }

  /** Outbound fetches counted so far (finished checks only). */
  get fetchesUsed(): number {
    return this.fetches;
  }
  /** How many notifications fit in what's left (one fetch each). */
  notificationAllowance(max: number): number {
    const d1Left = this.limits.d1Queries - this.usage.d1 - TAIL_RESERVE.d1 - 1; // -1: claiming them
    const byD1 = Math.floor(d1Left / NOTIFICATION_D1_COST);
    const byFetch = this.limits.subrequests - this.fetches;
    return Math.max(0, Math.min(max, byD1, byFetch));
  }

  get d1Used(): number {
    return this.usage.d1;
  }
}
