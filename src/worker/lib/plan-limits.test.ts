import { describe, expect, it } from "vitest";

import { PLAN_LIMITS } from "../../shared/hosted-contract";
import { createMonitorSchema, intervalSecondsOf, type CreateMonitorInput } from "../../shared/schemas";
import { importedCheckInterval, withCheckInterval, type HostedPlan } from "./plan-limits";

const urls = {
  account: "https://app.example.test/account",
  billing: "https://app.example.test/billing",
  upgrade: "https://app.example.test/upgrade",
  signIn: "https://app.example.test/sign-in",
  signOut: "https://app.example.test/sign-out",
};
const plan = (id: keyof typeof PLAN_LIMITS, over: Partial<HostedPlan["limits"]> = {}): HostedPlan => ({
  plan: id,
  limits: { ...PLAN_LIMITS[id], ...over },
  urls,
});
/** The interval a resolved input stores. */
const interval = (input: CreateMonitorInput) => intervalSecondsOf(input);
const http = (extra: Record<string, unknown> = {}) =>
  createMonitorSchema.parse({ type: "http", name: "Site", config: { url: "https://example.com/" }, ...extra });

describe("withCheckInterval", () => {
  it("is always 12 minutes on a plain install", () => {
    expect(interval(withCheckInterval(http({ intervalSeconds: 60 }), undefined))).toBe(720);
    expect(interval(withCheckInterval(http(), undefined))).toBe(720);
  });

  it("keeps what was sent on Hosted, or the stored one on an edit, or the default on a create", () => {
    expect(interval(withCheckInterval(http({ intervalSeconds: 60 }), plan("hosted_fast")))).toBe(60);
    expect(interval(withCheckInterval(http(), plan("hosted_fast"), { type: "http", intervalSeconds: 120 }))).toBe(120);
    expect(interval(withCheckInterval(http(), plan("hosted_fast")))).toBe(720);
    expect(interval(withCheckInterval(http(), plan("trial", { minIntervalMinutes: 30 })))).toBe(1800);
  });

  it("leaves a heartbeat alone", () => {
    const hb = createMonitorSchema.parse({ type: "heartbeat", name: "Job", config: { intervalSeconds: 60 } });
    expect(withCheckInterval(hb, undefined)).toBe(hb);
  });
});

describe("importedCheckInterval", () => {
  it("restores a monitor faster than the plan at the plan's shortest", () => {
    expect(interval(importedCheckInterval(http({ intervalSeconds: 60 }), plan("hosted")))).toBe(720);
    expect(interval(importedCheckInterval(http({ intervalSeconds: 60 }), plan("hosted_fast")))).toBe(60);
    expect(interval(importedCheckInterval(http({ intervalSeconds: 60 }), undefined))).toBe(720);
  });
});
