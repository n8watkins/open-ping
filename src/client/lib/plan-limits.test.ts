import { describe, expect, it } from "vitest";
import { PLAN_LIMITS } from "../../shared/hosted-contract";
import { channelKindRefused, monitorLimitReached, planLimitMessage, planLimitTitle, statusPageLimitReached, type PlanState } from "./plan-limits";

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
    expect(limit.upgradeUrl).toBe(plan.upgradeUrl);
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
