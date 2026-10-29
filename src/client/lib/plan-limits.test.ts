import { describe, expect, it } from "vitest";
import { PLAN_LIMITS } from "../../shared/hosted-contract";
import {
  channelKindRefused,
  defaultIntervalMinutes,
  fastUsage,
  monitorLimitReached,
  planLimitMessage,
  planLimitTitle,
  statusPageLimitReached,
  type PlanState,
} from "./plan-limits";

const plan: PlanState = { plan: "hosted", limits: PLAN_LIMITS.hosted, upgradeUrl: "https://app.hosted.test/upgrade" };

describe("plan limit wording", () => {
  it("says nothing while there is room", () => {
    expect(monitorLimitReached(plan, 19)).toBeNull();
    expect(monitorLimitReached(null, 500)).toBeNull();
  });

  it("at the limit: all in use, with the server's sentence", () => {
    const limit = monitorLimitReached(plan, 20)!;
    expect(planLimitTitle(limit)).toBe("All 20 monitors in use");
    expect(planLimitMessage(limit)).toBe("Your plan includes 20 monitors. Remove one or upgrade to add more.");
    expect(limit.upgradeUrl).toBe(`${plan.upgradeUrl}?need=monitors`);
  });

  it("over the limit after a downgrade: how far over, and how many to remove", () => {
    const limit = monitorLimitReached(plan, 25)!;
    expect(planLimitTitle(limit)).toBe("25 of 20 monitors, over your plan");
    expect(planLimitMessage(limit)).toBe(
      "Your plan includes 20 monitors. The ones you have keep working; remove 6 or upgrade to add more.",
    );
    const pages = statusPageLimitReached({ ...plan, limits: PLAN_LIMITS.trial }, 2)!;
    expect(planLimitTitle(pages)).toBe("2 of 1 status pages, over your plan");
    expect(planLimitMessage(pages)).toContain("includes 1 status page. The ones you have keep working; remove 2");
  });

  it("names a channel kind the plan leaves out", () => {
    const limit = channelKindRefused({ ...plan, limits: PLAN_LIMITS.trial }, "discord")!;
    expect(planLimitTitle(limit)).toBe("Discord alerts aren't in your plan");
    expect(planLimitMessage(limit)).toBe(limit.message);
  });
});

describe("fast monitors", () => {
  const fastPlan: PlanState = { plan: "hosted_fast", limits: PLAN_LIMITS.hosted_fast, upgradeUrl: "https://app.hosted.test/upgrade" };
  const m = (id: string, intervalSeconds: number, createdAt: number, type = "http") => ({ id, type, intervalSeconds, createdAt });

  it("counts the other fast monitors, and which are kept after a downgrade", () => {
    const list = [m("a", 60, 1), m("b", 300, 2), m("c", 720, 3), m("d", 60, 4, "heartbeat"), m("e", 120, 5)];
    expect(fastUsage(fastPlan, list, null)).toEqual({ allowed: 5, others: 3, kept: false });
    expect(fastUsage(fastPlan, list, "b")).toEqual({ allowed: 5, others: 2, kept: true });
    const two = { ...fastPlan, limits: { ...PLAN_LIMITS.hosted_fast, fastMonitors: 2 } };
    expect(fastUsage(two, list, "e")).toEqual({ allowed: 2, others: 2, kept: false });
    expect(fastUsage(two, list, "a")).toMatchObject({ kept: true });
  });

  it("is nothing on a plan without fast checks, or a self-hosted install", () => {
    expect(fastUsage(plan, [m("a", 60, 1)], null)).toBeNull();
    expect(fastUsage(null, [m("a", 60, 1)], null)).toBeNull();
  });

  it("starts a new monitor at a minute while a fast monitor is free, otherwise at 12", () => {
    expect(defaultIntervalMinutes(fastPlan, { allowed: 5, others: 4, kept: false })).toBe(1);
    expect(defaultIntervalMinutes(fastPlan, { allowed: 5, others: 5, kept: false })).toBe(12);
    expect(defaultIntervalMinutes(plan)).toBe(12);
  });

  it("names the limit and links to more fast monitors", () => {
    const limit = { error: "plan_limit", limit: "fast_monitors", allowed: 5, requested: 6, plan: "hosted_fast", message: "x", upgradeUrl: "u" } as const;
    expect(planLimitTitle(limit)).toBe("All 5 fast monitors in use");
    expect(planLimitTitle({ ...limit, allowed: 0 })).toBe("Fast checks aren't in your plan");
  });
});
