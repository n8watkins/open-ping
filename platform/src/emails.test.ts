import { describe, expect, it } from "vitest";

import {
  deletionWarningEmail,
  recipientConfirmEmail,
  emailDate,
  passkeyAddedEmail,
  paymentFailedEmail,
  signInEmail,
  suspendedEmail,
  trialEndingEmail,
  welcomeEmail,
  type RenderedEmail,
} from "./emails";

const AT = Date.UTC(2026, 10, 12, 14, 3);
const TENANT = "https://acme.openping.test";
const BILLING = "https://app.openping.test/billing";
const ACCOUNT = "https://app.openping.test/account";

const all: Record<string, RenderedEmail> = {
  signIn: signInEmail({ code: "123456", link: "https://app.openping.test/sign-in/link?token=abc", newAccount: false }),
  signUp: signInEmail({ code: "654321", link: "https://app.openping.test/sign-in/link?token=def", newAccount: true }),
  passkey: passkeyAddedEmail({ label: "Phone", at: AT, accountUrl: ACCOUNT }),
  welcome: welcomeEmail({ tenantUrl: TENANT, trialEndsAt: AT, monitors: 5 }),
  trial3: trialEndingEmail({ tenantUrl: TENANT, endsAt: AT, daysLeft: 3, upgradeUrl: `${BILLING}/upgrade`, deleteAfterDays: 30 }),
  trial1: trialEndingEmail({ tenantUrl: TENANT, endsAt: AT, daysLeft: 1, upgradeUrl: `${BILLING}/upgrade`, deleteAfterDays: 30 }),
  paymentFailed: paymentFailedEmail({ tenantUrl: TENANT, billingUrl: BILLING, suspendAt: AT }),
  suspendedTrial: suspendedEmail({ tenantUrl: TENANT, reason: "trial_ended", billingUrl: BILLING, accountUrl: ACCOUNT, deleteAt: AT }),
  suspendedPayment: suspendedEmail({ tenantUrl: TENANT, reason: "payment", billingUrl: BILLING, accountUrl: ACCOUNT, deleteAt: AT }),
  suspendedOwner: suspendedEmail({ tenantUrl: TENANT, reason: "owner", billingUrl: BILLING, accountUrl: ACCOUNT, deleteAt: null }),
  confirm: recipientConfirmEmail({ tenantUrl: TENANT, confirmUrl: "https://app.openping.test/email/confirm?t=abc" }),
  deletion: deletionWarningEmail({ tenantUrl: TENANT, deleteAt: AT, billingUrl: BILLING, accountUrl: ACCOUNT }),
};

describe("the platform's emails", () => {
  it("are complete in both parts: the text says every link the HTML has", () => {
    for (const [name, e] of Object.entries(all)) {
      expect(e.html, name).toMatch(/^<!doctype html><html lang="en">/);
      expect(e.html, name).toContain(`<title>${e.subject.replace(/'/g, "&#39;")}</title>`);
      expect(e.html, name).toContain("<h1 ");
      for (const [, href] of e.html.matchAll(/href="([^"]+)"/g)) {
        const url = href!.replace(/&amp;/g, "&");
        if (!url.startsWith("mailto:")) expect(e.text, `${name}: ${url}`).toContain(url);
      }
      expect(e.text, name).toContain("support@n8builds.dev");
      expect(e.subject.length, name).toBeLessThan(80);
      expect(e.html + e.text, name).not.toMatch(/undefined|null|NaN|—/);
    }
  });

  it("put the code first, where a phone's notification shows it", () => {
    expect(all.signIn!.subject).toBe("123456 is your OpenPing sign-in code");
    expect(all.signIn!.text).toMatch(/^Sign in\n\nHere is your code to sign in to OpenPing Hosted\.\n\nCode: 123456\n/);
    expect(all.signUp!.text).toContain("finish signing up");
  });

  it("say the dates and what happens next", () => {
    expect(emailDate(AT)).toBe("Thursday, November 12, 2026");
    expect(all.trial3!.subject).toBe("Your OpenPing trial ends in 3 days");
    expect(all.trial1!.subject).toBe("Your OpenPing trial ends tomorrow");
    expect(all.trial3!.text).toContain("kept for 30 days, then deleted");
    expect(all.paymentFailed!.text).toContain("by Thursday, November 12, 2026, checks stop");
    expect(all.suspendedTrial!.subject).toBe("Your OpenPing trial has ended");
    expect(all.suspendedOwner!.text).not.toContain("Choose a plan");
    expect(all.deletion!.subject).toBe("Your OpenPing will be deleted on Thursday, November 12, 2026");
    expect(all.deletion!.text).toContain("download your export");
    expect(all.passkey!.text).toContain("2026-11-12 14:03 UTC");
  });

  it("escape what came from someone else", () => {
    const e = passkeyAddedEmail({ label: '<img src=x onerror="alert(1)">', at: AT, accountUrl: ACCOUNT });
    expect(e.html).not.toContain("<img");
    expect(e.html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
  });
});
