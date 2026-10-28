import { describe, expect, it } from "vitest";
import { CHECK_COST, PLAN_BUDGETS, planBudget, RunBudget, TAIL_RESERVE } from "./budget";

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
  it("starts checks while their worst case fits beside the tail reserve", () => {
    const usage = { d1: 6 };
    const budget = new RunBudget(PLAN_BUDGETS.free, usage);
    let started = 0;
    while (budget.tryStartCheck()) started++;
    expect(6 + started * CHECK_COST.d1 + TAIL_RESERVE.d1).toBeLessThanOrEqual(PLAN_BUDGETS.free.d1Queries);
    expect(started).toBeGreaterThan(0);
  });

  it("waits for a running check to free room, then refuses once nothing is running", async () => {
    const usage = { d1: 6 };
    const budget = new RunBudget(PLAN_BUDGETS.free, usage);
    let running = 0;
    while (budget.tryStartCheck()) running++;
    const next = budget.startCheck();
    // A check finishes having spent less than its reservation: room opens up.
    usage.d1 += 4;
    budget.endCheck();
    await expect(next).resolves.toBe(true);
    // Spend the budget and finish every running check: with nothing running, a
    // check that doesn't fit is refused instead of waiting forever.
    usage.d1 = PLAN_BUDGETS.free.d1Queries;
    for (let i = 0; i < running; i++) budget.endCheck();
    await expect(budget.startCheck()).resolves.toBe(false);
  });

  it("reserves a confirmation re-check's fetch only when asked, and refuses one that doesn't fit", () => {
    const tight = { ...PLAN_BUDGETS.free, subrequests: 3 };
    const budget = new RunBudget(tight, { d1: 0 });
    expect(budget.tryStartCheck()).toBe(true); // 1 fetch reserved
    expect(budget.tryStartCheck()).toBe(true); // 2
    expect(budget.tryConfirm()).toBe(true); // 3: the first check's re-check
    expect(budget.tryConfirm()).toBe(false); // the second check's: no room
    budget.endCheck(1);
    budget.endCheck(0);
    expect(budget.fetchesUsed).toBe(3);
  });

  it("counts a passing check as one fetch, leaving room for alerts", () => {
    const budget = new RunBudget(PLAN_BUDGETS.free, { d1: 0 });
    expect(budget.tryStartCheck()).toBe(true);
    budget.endCheck();
    expect(budget.fetchesUsed).toBe(CHECK_COST.subrequests);
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
