import { describe, expect, it } from "vitest";
import { CHECK_COST, PLAN_BUDGETS, planBudget, RunBudget, TAIL_RESERVE, type CheckTicket } from "./budget";

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
    const running: CheckTicket[] = [];
    for (let t = budget.tryStartCheck(); t; t = budget.tryStartCheck()) running.push(t);
    const next = budget.startCheck();
    // A check finishes having spent less than its reservation: room opens up.
    usage.d1 += 4;
    running.shift()!.end(1);
    const started = await next;
    expect(started).not.toBeNull();
    // Spend the budget and finish every running check: with nothing running, a
    // check that doesn't fit is refused instead of waiting forever.
    usage.d1 = PLAN_BUDGETS.free.d1Queries;
    for (const t of [...running, started!]) t.end(1);
    await expect(budget.startCheck()).resolves.toBeNull();
  });

  it("reserves a confirmation re-check's fetches only when asked, and refuses one that doesn't fit", () => {
    const tight = { ...PLAN_BUDGETS.free, subrequests: 3 };
    const budget = new RunBudget(tight, { d1: 0 });
    const a = budget.tryStartCheck()!; // 1 fetch reserved
    const b = budget.tryStartCheck()!; // 2
    expect(a.tryConfirm()).toBe(true); // 3: the first check's re-check
    expect(b.tryConfirm()).toBe(false); // the second check's: no room
    a.end(2);
    b.end(1);
    expect(budget.fetchesUsed).toBe(3);
  });

  it("counts a passing check as one fetch, leaving room for alerts", () => {
    const budget = new RunBudget(PLAN_BUDGETS.free, { d1: 0 });
    budget.tryStartCheck()!.end(1);
    expect(budget.fetchesUsed).toBe(CHECK_COST.subrequests);
  });

  it("reserves a redirecting check's worst case and charges what it really fetched", () => {
    const tight = { ...PLAN_BUDGETS.free, subrequests: 10 };
    const budget = new RunBudget(tight, { d1: 0 });
    // A check that may follow five redirects holds six fetches while it runs...
    const first = budget.tryStartCheck(6)!;
    expect(first).not.toBeNull();
    // ...so a second one can't start beside it (6 + 6 > 10).
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
    expect(budget.notificationAllowance(25)).toBe(0);
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
