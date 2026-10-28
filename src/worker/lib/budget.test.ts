import { describe, expect, it } from "vitest";
import {
  CHECK_COST,
  NOTIFICATION_D1_COST,
  NOTIFICATION_RESERVE,
  PLAN_BUDGETS,
  planBudget,
  RunBudget,
  TAIL_RESERVE,
} from "./budget";

describe("planBudget", () => {
  it("assumes the Free plan unless told it's Paid", () => {
    expect(planBudget({}).plan).toBe("free");
    expect(planBudget({ WORKERS_PLAN: "something" }).plan).toBe("free");
    expect(planBudget({ WORKERS_PLAN: "paid" }).plan).toBe("paid");
  });

  it("keeps the Free budget under Cloudflare's 50 per invocation", () => {
    expect(PLAN_BUDGETS.free.d1Queries).toBeLessThan(50);
    expect(PLAN_BUDGETS.free.subrequests).toBeLessThan(50);
  });
});

describe("RunBudget", () => {
  it("starts checks while their worst case fits beside the tail and notification reserves", () => {
    const usage = { d1: 1 };
    const budget = new RunBudget(PLAN_BUDGETS.free, usage);
    let started = 0;
    for (let t = budget.tryStartCheck(); t; t = budget.tryStartCheck()) {
      t.end(1);
      started++;
    }
    // A check makes no D1 query of its own (its writes share the run's batch),
    // but keeps one for good, for retrying them if that batch fails.
    const kept = TAIL_RESERVE.d1 + NOTIFICATION_RESERVE * NOTIFICATION_D1_COST;
    expect(1 + started * CHECK_COST.d1 + kept).toBeLessThanOrEqual(PLAN_BUDGETS.free.d1Queries);
    expect(1 + (started + 1) * CHECK_COST.d1 + kept).toBeGreaterThan(PLAN_BUDGETS.free.d1Queries);
    // About three times the eight a Free run fitted when each check wrote on its own.
    expect(started).toBeGreaterThanOrEqual(24);
  });

  it("waits for a running check to free room, then refuses once nothing is running", async () => {
    const usage = { d1: 1 };
    const budget = new RunBudget({ ...PLAN_BUDGETS.free, subrequests: 4 + NOTIFICATION_RESERVE + 1 }, usage);
    const a = budget.tryStartCheck(2)!;
    const b = budget.tryStartCheck(2)!;
    expect(budget.tryStartCheck(2)).toBeNull();
    const next = budget.startCheck(2);
    // A check finishes having spent less than its reservation: room opens up.
    a.end(1);
    const started = await next;
    expect(started).not.toBeNull();
    // Spend the budget and finish every running check: with nothing running, a
    // check that doesn't fit is refused instead of waiting forever.
    usage.d1 = PLAN_BUDGETS.free.d1Queries;
    for (const t of [b, started!]) t.end(1);
    await expect(budget.startCheck()).resolves.toBeNull();
  });

  it("reserves a confirmation re-check's fetches only when asked, and refuses one that doesn't fit", () => {
    const tight = { ...PLAN_BUDGETS.free, subrequests: 4 + NOTIFICATION_RESERVE };
    const budget = new RunBudget(tight, { d1: 0 });
    const a = budget.tryStartCheck(2)!; // 2 fetches reserved
    const b = budget.tryStartCheck(2)!; // 4
    expect(a.tryConfirm()).toBe(true); // 6: the first check's re-check
    expect(b.tryConfirm()).toBe(false); // the second check's: no room
    a.end(2);
    b.end(1);
    expect(budget.fetchesUsed).toBe(3);
  });

  it("holds a re-check from the start when asked, so a failure can always be confirmed", () => {
    const tight = { ...PLAN_BUDGETS.free, subrequests: 2 + NOTIFICATION_RESERVE };
    const budget = new RunBudget(tight, { d1: 0 });
    const a = budget.tryStartCheck(1, 1)!;
    expect(a).not.toBeNull();
    // The hold is taken: nothing else fits beside it.
    expect(budget.tryStartCheck(1)).toBeNull();
    expect(a.tryConfirm()).toBe(true);
    // A passing check gives the unused hold back: it is charged what it made.
    a.end(1);
    expect(budget.fetchesUsed).toBe(1);
    expect(budget.tryStartCheck(1)).not.toBeNull();
  });

  it("keeps D1 room for every started check, and lets retries spend only what is left", () => {
    const usage = { d1: 1 };
    const budget = new RunBudget(PLAN_BUDGETS.free, usage);
    budget.tryStartCheck()!.end(1);
    // The ended check's query stays kept for its writes' retry.
    expect(budget.notificationAllowance(25)).toBe(
      Math.floor((PLAN_BUDGETS.free.d1Queries - 1 - CHECK_COST.d1 - TAIL_RESERVE.d1) / NOTIFICATION_D1_COST),
    );
    usage.d1 = PLAN_BUDGETS.free.d1Queries - 3;
    expect(budget.canSpendD1(1)).toBe(true);
    expect(budget.canSpendD1(2)).toBe(true);
    expect(budget.canSpendD1(3)).toBe(false);
  });

  it("counts a passing check as one fetch, leaving room for alerts", () => {
    const budget = new RunBudget(PLAN_BUDGETS.free, { d1: 0 });
    budget.tryStartCheck()!.end(1);
    expect(budget.fetchesUsed).toBe(CHECK_COST.subrequests);
  });

  it("reserves a redirecting check's worst case and charges what it really fetched", () => {
    const tight = { ...PLAN_BUDGETS.free, subrequests: 10 + NOTIFICATION_RESERVE };
    const budget = new RunBudget(tight, { d1: 0 });
    // A check that may follow five redirects holds six fetches while it runs...
    const first = budget.tryStartCheck(6)!;
    expect(first).not.toBeNull();
    // ...so a second one can't start beside it (6 + 6 > 10, beside the alerts' room).
    expect(budget.tryStartCheck(6)).toBeNull();
    // It really followed three redirects: four fetches count, the rest is freed.
    first.end(4);
    expect(budget.fetchesUsed).toBe(4);
    const second = budget.tryStartCheck(6)!;
    expect(second).not.toBeNull();
    // Its re-check would need six more: 4 + 6 + 6 > 10.
    expect(second.tryConfirm()).toBe(false);
    second.end(6);
    expect(budget.fetchesUsed).toBe(10);
    // What the checks couldn't take: the room kept for alerts.
    expect(budget.notificationAllowance(25)).toBe(NOTIFICATION_RESERVE);
  });

  it("charges a check that ended without a count everything it reserved", () => {
    const budget = new RunBudget(PLAN_BUDGETS.free, { d1: 0 });
    const t = budget.tryStartCheck(6)!;
    expect(t.tryConfirm()).toBe(true);
    t.end();
    t.end(); // ending twice changes nothing
    expect(budget.fetchesUsed).toBe(12);
  });

  it("only allows the notifications that fit", () => {
    const usage = { d1: 40 };
    const budget = new RunBudget(PLAN_BUDGETS.free, usage);
    expect(budget.notificationAllowance(25)).toBe(0);
    usage.d1 = 10;
    expect(budget.notificationAllowance(25)).toBeGreaterThan(0);
    expect(budget.notificationAllowance(3)).toBe(3);
  });
});

describe("RunBudget.startCheck at the end of a run", () => {
  it("starts the last check without its re-check's hold when only the hold doesn't fit", async () => {
    // A probe that may make four requests (redirects), and room for one.
    const tight = { ...PLAN_BUDGETS.free, subrequests: 4 + NOTIFICATION_RESERVE };
    const budget = new RunBudget(tight, { d1: 0 });
    const t = await budget.startCheck(4, 4);
    expect(t).not.toBeNull();
    // No hold: a failure's re-check doesn't fit, so it would be deferred.
    expect(t!.tryConfirm()).toBe(false);
    t!.end(4);
    await expect(budget.startCheck(4, 4)).resolves.toBeNull();
  });

  it("sizes a later re-check by the re-check, not the first probe", async () => {
    // The first probe may make 1 request and its re-check (from another
    // region, checks/region.ts) up to 4: room for the probe, not the re-check.
    const tight = { ...PLAN_BUDGETS.free, subrequests: 1 + NOTIFICATION_RESERVE };
    const budget = new RunBudget(tight, { d1: 0 });
    const t = (await budget.startCheck(1, 4))!;
    expect(t).not.toBeNull();
    expect(t.tryConfirm()).toBe(false);
    t.end(1);
  });

  it("can take a second re-check once the held one is used, if it fits", () => {
    const budget = new RunBudget({ ...PLAN_BUDGETS.free, subrequests: 9 + NOTIFICATION_RESERVE }, { d1: 0 });
    const t = budget.tryStartCheck(1, 4)!;
    expect(t.tryConfirm()).toBe(true); // the hold
    expect(t.tryConfirm()).toBe(true); // 4 more: 9 in all
    expect(t.tryConfirm()).toBe(false);
    t.end(6);
    expect(budget.fetchesUsed).toBe(6);
  });
});
