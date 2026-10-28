import { describe, expect, it } from "vitest";
import {
  HOSTED_PLAN_LIMITS,
  HOSTED_TRIAL_LIMITS,
  hostedSignInUrl,
  landingMeta,
  parseHostedSignupUrl,
} from "./hosted-offer";

describe("parseHostedSignupUrl", () => {
  it("keeps Hosted closed when the var is unset, blank or not a URL", () => {
    for (const value of [undefined, null, "", "   ", "app.example.com/sign-up", "/sign-up", "not a url"]) {
      expect(parseHostedSignupUrl(value)).toBeNull();
    }
  });

  it("accepts only https, or plain http to a local platform", () => {
    expect(parseHostedSignupUrl(" https://app.example.com/sign-up ")).toBe("https://app.example.com/sign-up");
    expect(parseHostedSignupUrl("http://localhost:5390/sign-up")).toBe("http://localhost:5390/sign-up");
    expect(parseHostedSignupUrl("http://127.0.0.1:5390/sign-up")).toBe("http://127.0.0.1:5390/sign-up");
    for (const value of [
      "http://app.example.com/sign-up",
      "javascript:alert(1)",
      "data:text/html,hi",
      "ftp://app.example.com/",
      "https://user:pass@app.example.com/sign-up",
    ]) {
      expect(parseHostedSignupUrl(value)).toBeNull();
    }
  });
});

describe("hostedSignInUrl", () => {
  it("points at the platform's sign-in page beside the sign-up page", () => {
    expect(hostedSignInUrl("https://app.example.com/sign-up?ref=landing")).toBe("https://app.example.com/sign-in");
  });
});

describe("landingMeta", () => {
  it("keeps today's title and description while Hosted is a waitlist", () => {
    const meta = landingMeta(false);
    expect(meta.title).toBe("OpenPing: uptime monitoring on your own Cloudflare");
    expect(meta.description).toContain("join the waitlist for OpenPing Hosted");
    expect(meta.description).not.toMatch(/trial/);
  });

  it("names the price and the trial once Hosted opens", () => {
    const meta = landingMeta(true);
    expect(meta.title).toBe("OpenPing: uptime monitoring that knows your hours");
    expect(meta.description).toContain("$24 a year");
    expect(meta.description).toContain("14-day free trial and no card");
    expect(meta.description).not.toMatch(/waitlist/);
  });
});

describe("the plan facts the page prints", () => {
  it("match the limits the platform enforces (docs/HOSTED_PLAN.md)", () => {
    expect(HOSTED_TRIAL_LIMITS).toMatchObject({ monitors: 5, statusPages: 1, minIntervalMinutes: 12 });
    expect(HOSTED_PLAN_LIMITS).toMatchObject({ monitors: 20, statusPages: 2, minIntervalMinutes: 12 });
  });
});
