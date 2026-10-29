import { describe, expect, it } from "vitest";
import { attentionDetail, degradedTitle } from "./attention";

const m = (type: "http" | "cert" | "domain", state: "degraded" | "down" | "suspended", lastDurationMs: number | null = 80) => ({
  type,
  state,
  lastDurationMs,
  lastStatusCode: null,
});

describe("attentionDetail", () => {
  it("says a certificate or domain expires, instead of how fast it answered", () => {
    expect(attentionDetail(m("cert", "degraded"))).toBe("Certificate expires soon");
    expect(attentionDetail(m("domain", "degraded"))).toBe("Domain expires soon");
    expect(attentionDetail(m("cert", "down"))).toBe("Certificate expired or couldn't be read");
  });
  it("keeps the HTTP wording", () => {
    expect(attentionDetail(m("http", "degraded"))).toBe("Responding in 80 ms");
    expect(attentionDetail(m("http", "suspended"))).toBe("Suspended by the host");
    expect(attentionDetail(m("http", "down", null))).toBe("Not responding");
  });
});

describe("degradedTitle", () => {
  it("names expiry warnings for what they are", () => {
    expect(degradedTitle([{ type: "cert" }], 1)).toBe("1 certificate expires soon");
    expect(degradedTitle([{ type: "cert" }, { type: "cert" }], 2)).toBe("2 certificates expire soon");
    expect(degradedTitle([{ type: "cert" }, { type: "domain" }], 2)).toBe("2 renewals due soon");
  });
  it("says slow or degraded once any other monitor is degraded", () => {
    expect(degradedTitle([{ type: "cert" }, { type: "http" }], 2)).toBe("2 monitors are slow or degraded");
    expect(degradedTitle([], 1)).toBe("1 monitor is slow or degraded");
  });
});
