import { describe, expect, it } from "vitest";
import { homePage, hostedSignupUrl, withLandingHead } from "./home-page";
import { LANDING_DESCRIPTION, LANDING_TITLE } from "../../shared/landing-meta";

describe("homePage", () => {
  it("defaults to the install's own status page", () => {
    for (const value of [undefined, "", "status", "Status", "marketing", "true"]) {
      expect(homePage({ HOME_PAGE: value })).toBe("status");
    }
  });

  it("shows the marketing page only when asked for by name", () => {
    expect(homePage({ HOME_PAGE: "landing" })).toBe("landing");
    expect(homePage({ HOME_PAGE: " Landing " })).toBe("landing");
  });
});

describe("hostedSignupUrl", () => {
  it("is null until the var holds a usable https address", () => {
    for (const value of [undefined, "", "http://app.example.com/sign-up", "nope"]) {
      expect(hostedSignupUrl({ HOSTED_SIGNUP_URL: value })).toBeNull();
    }
    expect(hostedSignupUrl({ HOSTED_SIGNUP_URL: "https://app.example.com/sign-up" })).toBe(
      "https://app.example.com/sign-up",
    );
  });
});

describe("withLandingHead", () => {
  const shell = [
    "<!doctype html>",
    "<html><head>",
    '<meta name="description" content="OpenPing: generic." />',
    "<title>OpenPing</title>",
    "</head><body></body></html>",
  ].join("\n");

  it("writes the landing title, description and preview tags into the shell", () => {
    const html = withLandingHead(shell, "https://openping.example");
    expect(html).toContain(`<title>${LANDING_TITLE}</title>`);
    expect(html).toContain(`<meta name="description" content="${LANDING_DESCRIPTION}" />`);
    expect(html).not.toContain("OpenPing: generic.");
    expect(html).toContain('<meta property="og:url" content="https://openping.example/" />');
    expect(html).toContain('<meta property="og:image" content="https://openping.example/landing/app-overview.webp" />');
    expect(html).toContain('<link rel="canonical" href="https://openping.example/" />');
    // Tags go inside the head, once.
    expect(html.indexOf("og:title")).toBeLessThan(html.indexOf("</head>"));
    expect(html.match(/og:title/g)).toHaveLength(1);
  });

  it("writes the launch title and description once Hosted is open", () => {
    const html = withLandingHead(shell, "https://openping.example", true);
    expect(html).toContain("<title>OpenPing: uptime monitoring that knows your hours</title>");
    expect(html).toContain("with a 14-day free trial and no card.");
    expect(html).not.toContain("waitlist");
  });

  it("escapes the origin it's given", () => {
    const html = withLandingHead(shell, 'https://x.example"><script>');
    expect(html).not.toContain("<script>");
  });
});
