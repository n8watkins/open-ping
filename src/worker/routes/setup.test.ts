import { describe, expect, it } from "vitest";
import { checkSetupToken, setupSaveSchema } from "./setup";

describe("checkSetupToken", () => {
  it("accepts only an exact configured token", async () => {
    await expect(checkSetupToken("configured-secret", "configured-secret")).resolves.toBe(true);
    await expect(checkSetupToken("configured-secret", "wrong-secret")).resolves.toBe(false);
    await expect(checkSetupToken("configured-secret", undefined)).resolves.toBe(false);
    await expect(checkSetupToken(undefined, "configured-secret")).resolves.toBe(false);
  });
});

describe("setupSaveSchema", () => {
  it("accepts bounded setup values", () => {
    expect(
      setupSaveSchema.safeParse({
        step: 3,
        stepId: "admin",
        data: {
          appUrl: "https://status.example.com",
          timezone: "America/Los_Angeles",
          adminGithubLogin: "open-ping-admin",
          adminEmail: "admin@example.com",
        },
      }).success,
    ).toBe(true);
  });

  it.each([
    ["non-HTTPS production URL", { data: { appUrl: "http://status.example.com" } }],
    ["credentialed URL", { data: { appUrl: "https://user:pass@example.com" } }],
    ["URL with a path", { data: { appUrl: "https://example.com/open-ping" } }],
    ["invalid timezone", { data: { timezone: "Not/A_Zone" } }],
    ["invalid GitHub login", { data: { adminGithubLogin: "-invalid-" } }],
    ["invalid administrator email", { data: { adminEmail: "not-an-email" } }],
    ["unknown persisted field", { data: { unexpected: "value" } }],
    ["out-of-range step", { step: 99 }],
  ])("rejects %s", (_label, input) => {
    expect(setupSaveSchema.safeParse(input).success).toBe(false);
  });

  it("allows HTTP only for local development origins", () => {
    expect(setupSaveSchema.safeParse({ data: { appUrl: "http://localhost:5173" } }).success).toBe(true);
    expect(setupSaveSchema.safeParse({ data: { appUrl: "http://127.0.0.1:5173" } }).success).toBe(true);
  });

  it("allows either optional administrator identity field to be empty", () => {
    expect(
      setupSaveSchema.safeParse({
        step: 4,
        stepId: "admin",
        data: { adminGithubLogin: "open-ping-admin", adminEmail: "" },
      }).success,
    ).toBe(true);
    expect(
      setupSaveSchema.safeParse({
        step: 4,
        stepId: "admin",
        data: { adminGithubLogin: "", adminEmail: "admin@example.com" },
      }).success,
    ).toBe(true);
  });
});
