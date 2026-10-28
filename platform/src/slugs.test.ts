import { describe, expect, it } from "vitest";

import { RESERVED_SLUGS, SLUG_MAX_LENGTH, isValidSlug, normalizeSlug, slugProblem } from "./slugs";

describe("slugs", () => {
  it("accepts ordinary names", () => {
    for (const slug of ["acme", "acme-corp", "a1b", "bravo-2", "x".repeat(SLUG_MAX_LENGTH)]) {
      expect(slugProblem(slug), slug).toBeNull();
    }
  });

  it("refuses names that are too short or too long", () => {
    expect(slugProblem("ab")).toBe("length");
    expect(slugProblem("")).toBe("length");
    expect(slugProblem("x".repeat(SLUG_MAX_LENGTH + 1))).toBe("length");
  });

  it("refuses anything that isn't a plain hostname label", () => {
    for (const slug of [
      "Acme", // not normalized
      "1acme", // starts with a digit
      "-acme",
      "acme-",
      "ac--me", // double dash, which also keeps out punycode (xn--)
      "xn--acme",
      "ac_me",
      "ac.me",
      "ac me",
      "acmé",
      "acme​", // zero-width space
    ]) {
      expect(slugProblem(slug), JSON.stringify(slug)).toBe("characters");
    }
  });

  it("refuses reserved names", () => {
    for (const slug of [
      "app", "www", "api", "admin", "status", "support", "billing", "staging", "mail", "stripe",
      "webhooks", "mta-sts", "autodiscover", "paypal", "google", "undefined",
    ]) {
      expect(slugProblem(slug), slug).toBe("reserved");
    }
  });

  it("refuses names that read as the product or the platform", () => {
    for (const slug of ["openping", "openping-support", "my-openping", "t-abc", "tenant-abc", "tenants"]) {
      expect(slugProblem(slug), slug).toBe("reserved");
    }
  });

  it("keeps every reserved name lowercase and otherwise valid-looking, so none is dead weight", () => {
    for (const slug of RESERVED_SLUGS) {
      expect(slug).toBe(slug.toLowerCase());
      expect(slug).toMatch(/^[a-z0-9-]+$/);
    }
  });

  it("normalizes what a customer typed before checking it", () => {
    expect(normalizeSlug("  Acme-Corp ")).toBe("acme-corp");
    expect(isValidSlug(normalizeSlug("  Acme-Corp "))).toBe(true);
  });
});
