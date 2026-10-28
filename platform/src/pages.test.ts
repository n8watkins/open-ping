import { describe, expect, it } from "vitest";

import {
  PAGE_HEADERS,
  appHomePage,
  escapeHtml,
  tenantNotFoundPage,
  tenantProvisioningPage,
  tenantSuspendedPage,
  tenantUnavailablePage,
  unknownHostPage,
} from "./pages";

describe("platform pages", () => {
  it("escapes everything they echo", () => {
    expect(escapeHtml(`<a href="x" onclick='y'>&</a>`)).toBe("&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;&lt;/a&gt;");
  });

  it("never echo markup from the host into the 404 page", async () => {
    const html = await tenantNotFoundPage(`<img src=x onerror=alert(1)>`, "https://app.openping.test").text();
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });

  it("all carry the same strict headers, no scripts, and the support address", async () => {
    for (const res of [
      tenantNotFoundPage("acme.openping.test", "https://app.openping.test"),
      tenantSuspendedPage("https://app.openping.test/account"),
      tenantProvisioningPage(),
      tenantUnavailablePage(),
      unknownHostPage(),
      appHomePage(),
    ]) {
      for (const [name, value] of Object.entries(PAGE_HEADERS)) expect(res.headers.get(name)).toBe(value);
      const html = await res.text();
      expect(html).toMatch(/^<!doctype html>/);
      expect(html).toContain('<meta name="viewport"');
      expect(html).not.toMatch(/<script/i);
      expect(html).toContain("support@n8builds.dev");
      expect(html).not.toContain("\u2014");
    }
  });

  it("use OpenPing's dark tokens by default and its light palette on request", async () => {
    const html = await unknownHostPage().text();
    expect(html).toContain("--canvas: #0b1220");
    expect(html).toContain("--surface: #111b2e");
    expect(html).toContain("--accent: #6d8bff");
    expect(html).toContain("@media (prefers-color-scheme: light)");
  });
});
