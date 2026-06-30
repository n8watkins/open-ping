import { describe, it, expect } from "vitest";
import {
  renderEmailLayout,
  renderEmailText,
  escapeHtml,
  stripLeadingEmoji,
  accentFor,
  EMAIL_ACCENTS,
} from "./email-layout";

describe("renderEmailLayout", () => {
  it("produces a self-contained, branded HTML document", () => {
    const html = renderEmailLayout({ heading: "Hello", bodyHtml: "<p>body</p>" });
    expect(html.startsWith("<!doctype html>")).toBe(true);
    // Brand wordmark with the accent on "Ping".
    expect(html).toContain("Open<span");
    expect(html).toContain("Ping</span>");
    // Footer tagline.
    expect(html).toContain("self-hosted uptime monitoring");
    // Email-client-safe: no <style> blocks and no external stylesheets.
    expect(html).not.toContain("<style");
    expect(html).not.toContain("<link");
    // Heading + body content carried through.
    expect(html).toContain("Hello");
    expect(html).toContain("<p>body</p>");
  });

  it("renders the status pill and accent rail for the chosen state", () => {
    const html = renderEmailLayout({
      heading: "Down",
      bodyHtml: "x",
      accent: "down",
      statusLabel: "Down",
    });
    expect(html).toContain(accentFor("down").bar); // red rail
    expect(html).toContain(accentFor("down").pillText);
  });

  it("renders an accent CTA button linking to the given url", () => {
    const html = renderEmailLayout({
      heading: "h",
      bodyHtml: "b",
      button: { label: "View incident", url: "https://ping.example/monitors/1" },
    });
    expect(html).toContain('href="https://ping.example/monitors/1"');
    expect(html).toContain("View incident");
    expect(html).toContain("#6d8bff"); // brand accent on the button
  });

  it("escapes the heading and preheader", () => {
    const html = renderEmailLayout({
      heading: "<b>x</b>",
      bodyHtml: "ok",
      preheader: 'a "quote" & <tag>',
    });
    expect(html).toContain("&lt;b&gt;x&lt;/b&gt;");
    expect(html).toContain("&amp;");
    expect(html).not.toContain("<b>x</b>");
  });

  it("omits the pill and button when not provided", () => {
    const html = renderEmailLayout({ heading: "h", bodyHtml: "b" });
    expect(html).not.toContain("border-radius:999px");
    expect(html.toLowerCase()).not.toContain("<a ");
  });
});

describe("renderEmailText", () => {
  it("includes heading, lines, a button URL and the brand footer", () => {
    const text = renderEmailText({
      heading: "Sign in",
      lines: ["line one", "line two"],
      button: { label: "Sign in", url: "https://x/y" },
    });
    expect(text).toContain("Sign in");
    expect(text).toContain("line one");
    expect(text).toContain("Sign in: https://x/y");
    expect(text).toContain("OpenPing — self-hosted uptime monitoring");
  });
});

describe("helpers", () => {
  it("escapeHtml neutralizes markup characters", () => {
    expect(escapeHtml('<a href="x">&')).toBe("&lt;a href=&quot;x&quot;&gt;&amp;");
  });

  it("stripLeadingEmoji removes a leading status emoji but keeps the text", () => {
    expect(stripLeadingEmoji("🔴 API is down")).toBe("API is down");
    expect(stripLeadingEmoji("🟢 API has recovered")).toBe("API has recovered");
    expect(stripLeadingEmoji("No emoji here")).toBe("No emoji here");
  });

  it("accentFor falls back to neutral for unknown states", () => {
    expect(accentFor("nope")).toBe(EMAIL_ACCENTS.neutral);
    expect(accentFor(undefined)).toBe(EMAIL_ACCENTS.neutral);
    expect(accentFor("up")).toBe(EMAIL_ACCENTS.up);
  });
});
