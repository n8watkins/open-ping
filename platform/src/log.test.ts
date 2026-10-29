import { afterEach, describe, expect, it } from "vitest";

import { captureLogs, errorText, isSecretName, log, logLine, scrubText, type LogLine } from "./log";

let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
});

describe("the platform's log lines", () => {
  it("are one flat object with the event and level first, so Workers Logs indexes every field", () => {
    expect(logLine("info", "schedule.batch", { runs: 3, errors: 0, tenant: "abc", ok: true })).toEqual({
      event: "schedule.batch",
      level: "info",
      runs: 3,
      errors: 0,
      tenant: "abc",
      ok: true,
    });
  });

  it("never write a field that looks like a secret, whatever a call site passes", () => {
    const line = logLine("error", "billing.checkout_failed", {
      apiKey: "sk_live_123",
      api_key: "re_123",
      token: "abc",
      leaseToken: "def",
      STRIPE_WEBHOOK_SECRET: "whsec_1",
      password: "p",
      cookie: "__Host-s=1",
      authorization: "Bearer x",
      MASTER_KEY: "k",
      key: "x",
      signingKey: "y",
      jwt: "z",
      privateKey: "q",
      emailKey: "payment_failed:in_1",
      account: "acc_1",
    });
    for (const name of ["apiKey", "api_key", "token", "leaseToken", "STRIPE_WEBHOOK_SECRET", "password", "cookie", "authorization", "MASTER_KEY", "key", "signingKey", "jwt", "privateKey"]) {
      expect(line[name]).toBe("[redacted]");
    }
    // Ids and the billing email's key are not secrets.
    expect(line.emailKey).toBe("payment_failed:in_1");
    expect(line.account).toBe("acc_1");
  });

  it("redact every secret-like name, and only those", () => {
    for (const name of [
      "authHeader", "authorization", "credentials", "credential", "sessionId", "session", "csrf", "csrfToken", "xsrf", "code", "oauth_code",
      "stripeKey", "webhookSig", "signature", "otp", "otpCode", "passphrase", "password", "passwd", "apiKey", "api_key", "MASTER_KEY",
      "privateKey", "signingKey", "jwt", "bearer", "cookie", "token", "refreshToken", "secret", "clientSecret", "key", "keyId",
    ]) {
      expect(isSecretName(name), name).toBe(true);
    }
    for (const name of ["tenant", "account", "run", "outcome", "error", "errorCode", "emailKey", "state", "status", "kind", "category", "version", "release", "stripeEvent", "providerId", "missing", "detail", "runs", "maxLagMs"]) {
      expect(isSecretName(name), name).toBe(false);
    }
  });

  it("redact by name at every depth before an object is flattened, so a nested secret never reaches the text", () => {
    const line = logLine("error", "billing.webhook_failed", {
      nested: { token: "tok_123", inner: { authHeader: "Bearer abc", list: [{ sessionId: "s1", ok: 1 }] }, n: 1 },
      list: [{ credentials: "user:pass" }],
    });
    expect(line.nested).toBe('{"token":"[redacted]","inner":{"authHeader":"[redacted]","list":[{"sessionId":"[redacted]","ok":1}]},"n":1}');
    expect(line.list).toBe('[{"credentials":"[redacted]"}]');
    for (const leak of ["tok_123", "abc", "s1", "user:pass"]) expect(JSON.stringify(line)).not.toContain(leak);
  });

  it("scrub secret-shaped values wherever they are, error messages included", () => {
    const cases: [string, string][] = [
      ["GET https://app.x.test/sign-in/link?token=abc123&next=/a", "GET https://app.x.test/sign-in/link?token=[redacted]&next=/a"],
      ["/email/confirm?t=xyz", "/email/confirm?t=[redacted]"],
      ["/auth/github/callback?code=c0de&state=st4te", "/auth/github/callback?code=[redacted]&state=[redacted]"],
      ["/api/check?secret=s3cret", "/api/check?secret=[redacted]"],
      ["POST /hb/AbC_123-xyz", "POST /hb/[redacted]"],
      ["Authorization: Bearer eyJ.abc", "Authorization: Bearer [redacted]"],
      ["token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig", "token [redacted-jwt]"],
      ["key sk_live_51Habc and sk_test_99 and rk_live_x1", "key [redacted-key] and [redacted-key] and [redacted-key]"],
      ["whsec_abcDEF123= set", "[redacted-key] set"],
      ["opk_9f8e7d6c5b4a used", "[redacted-key] used"],
      ["resend re_123abc_XYZ9 refused", "resend [redacted-key] refused"],
      ["to customer@example.com rejected", "to [email] rejected"],
    ];
    for (const [input, out] of cases) expect(scrubText(input), input).toBe(out);
    expect(errorText(new Error("fetch https://x.test/sign-in/link?token=abc failed for a@b.co"))).toBe("fetch https://x.test/sign-in/link?token=[redacted] failed for [email]");
    const line = logLine("error", "mail.tenant_not_sent", { detail: "mail provider answered 422 validation_error: to: bob@example.com is invalid", error: new Error("sk_live_abc leaked") });
    expect(line.detail).toBe("mail provider answered 422 validation_error: to: [email] is invalid");
    expect(line.error).toBe("[redacted-key] leaked");
    expect(logLine("info", "x.y", { ids: ["a@b.co", 1] }).ids).toEqual(["[email]", 1]);
  });

  it("turn errors into their message, cut long text, flatten objects and keep lists short", () => {
    const line = logLine("error", "provision.step_failed", {
      error: new Error("D1 said\nno"),
      long: "x".repeat(1000),
      nested: { token: "secret-inside", n: 1 },
      list: Array.from({ length: 80 }, (_, i) => i),
      skipped: undefined,
      none: null,
    });
    expect(line.error).toBe("D1 said no");
    expect((line.long as string).length).toBe(300);
    expect(line.nested).toBe('{"token":"[redacted]","n":1}');
    expect(line.list).toHaveLength(50);
    expect("skipped" in line).toBe(false);
    expect(line.none).toBeNull();
    expect(errorText("plain")).toBe("plain");
  });

  it("can't have their event or level overwritten, and keep an event name in the one format", () => {
    expect(logLine("warn", "mail.send_failed", { event: "x", level: "info" })).toEqual({ event: "mail.send_failed", level: "warn" });
    expect(logLine("info", "Not An Event").event).toBe("invalid.not_an_event");
  });

  it("go to the console method of their level", () => {
    const lines: LogLine[] = [];
    restore = captureLogs((l) => lines.push(l));
    log.info("cron.tick");
    log.warn("health.degraded", { problems: ["a"] });
    log.error("dispatch.tenant_threw", { tenant: "t" });
    expect(lines.map((l) => [l.event, l.level])).toEqual([
      ["cron.tick", "info"],
      ["health.degraded", "warn"],
      ["dispatch.tenant_threw", "error"],
    ]);
  });
});
