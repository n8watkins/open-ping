import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { LandingPage } from "./Landing";
import { hostedOffer } from "../lib/hosted-offer";

/**
 * The landing page in both states of the Hosted launch switch
 * (HOSTED_SIGNUP_URL, shared/hosted-offer.ts), rendered to HTML the way a
 * first paint shows it.
 */

const SIGNUP = "https://app.openping.example/sign-up";

// Build-time constant (vite.config.ts): the GitHub star count. Set before the
// describe blocks below render the page while collecting.
vi.stubGlobal("__OP_STARS__", 12);

function render(hostedSignupUrl?: string): string {
  const page = createElement(LandingPage, { offer: hostedOffer(hostedSignupUrl ? { hostedSignupUrl } : null) });
  return renderToStaticMarkup(createElement(MemoryRouter, null, page));
}

/** Visible text only, with tags stripped and whitespace collapsed. */
function text(html: string): string {
  return html
    .replace(/<style>[\s\S]*?<\/style>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
}

describe("the landing page while Hosted is a waitlist (switch unset)", () => {
  const html = render();
  const copy = text(html);

  it("keeps today's headline, waitlist and planned wording", () => {
    expect(copy).toContain("Uptime monitoring on your own Cloudflare");
    expect(copy).toContain("A hosted version is coming.");
    expect(copy).toContain("Not open yet");
    expect(copy).toContain("Join the Hosted waitlist");
    expect(copy).toContain("Join the waitlist");
    expect(copy).toContain("Hosted (planned)");
    expect(copy).toContain("Planned, not open yet.");
    expect(html).toContain('id="waitlist-email"');
  });

  it("changes only the numbers it already showed (D13), and makes no new claims before Hosted opens", () => {
    expect(copy).toContain("Optional 1-minute checks for $24 a year more");
    expect(copy).toContain("$24 a year; 1-minute checks $24 a year more");
    expect(copy).toContain("Every 12 minutes, or every minute with the add-on");
    expect(copy).not.toContain("$12");
    // The packs and the 5-monitor add-on wording are for the open page only.
    expect(copy).not.toMatch(/packs? of|up to 120|on 5 monitors/i);
  });

  it("says nothing about a trial and links nowhere outside the waitlist for Hosted", () => {
    expect(copy).not.toMatch(/free trial|Start a|no card/i);
    expect(copy).not.toContain("Can I move between Hosted and self-hosted?");
    expect(html).not.toContain("/sign-up");
    expect(html).not.toContain("/sign-in");
  });

  it("states today's facts: passkey sign-in for self-host, and no Hosted address before one is chosen", () => {
    expect(copy).toContain("who signs in with a passkey, GitHub or an email link");
    expect(copy).toContain("Passkey, GitHub or an email link, for you as the only admin");
    expect(copy).toContain("Sign in with a passkey, GitHub or an email link");
    expect(copy).toContain("Hosted accounts will have an address of their own");
    expect(copy).not.toContain("app.openping.n8builds.dev");
  });

  it("puts the free path first, before Pricing", () => {
    expect(html.indexOf('id="how-it-works"')).toBeLessThan(html.indexOf('id="pricing"'));
    expect(copy.indexOf("Run it yourself")).toBeLessThan(copy.indexOf("Let me run it"));
  });
});

describe("the landing page once Hosted opens (switch set)", () => {
  const html = render(SIGNUP);
  const copy = text(html);

  it("leads with the free trial and the launch headline", () => {
    expect(copy).toContain("Uptime monitoring that knows your hours");
    expect(copy).toContain("Start a free trial");
    expect(copy).toContain("30-day free trial");
    expect(copy).toContain("5 monitors for 30 days. No card needed.");
    expect(copy.indexOf("Let me run it")).toBeLessThan(copy.indexOf("Run it yourself"));
  });

  it("sends every trial button to the sign-up page, and Log in to the sign-in page", () => {
    // Header (desktop and phone), hero, pricing card, FAQ and the closing call to action.
    expect(html.match(new RegExp(`href="${SIGNUP}"`, "g"))?.length).toBe(6);
    expect(html).toContain('href="https://app.openping.example/sign-in"');
    expect(copy).toContain("Log in");
  });

  it("drops the waitlist and the planned wording", () => {
    expect(html).not.toContain('id="waitlist-email"');
    expect(copy).not.toMatch(/waitlist|Not open yet|\(planned\)|Planned, not open yet|is coming/i);
  });

  it("prices the plan and the trial as decided (D5)", () => {
    expect(copy).toContain("$24 a year");
    expect(copy).toContain("Optional 1-minute checks on 5 monitors for $24 a year more");
    expect(copy).toContain("Up to 120 monitors with packs of 25, $24 a year each");
    expect(copy).toContain("20, or up to 120 with packs of 25 ($24 a year each)");
    expect(copy).toContain("20 monitors, checked every 12 minutes");
    expect(copy).toContain("2 status pages and every alert channel");
    expect(copy).toContain("Free for 30 days with 5 monitors, 1 status page and email alerts. No card needed");
    expect(copy).toContain("support@n8builds.dev");
    expect(copy).toContain("app.openping.example");
  });

  it("explains both paths and that installs stay apart", () => {
    expect(copy).toContain("Self-hosted: free");
    expect(copy).toContain("Hosted: $24 a year");
    expect(copy).toContain("Independent and private");
    expect(copy).toContain("Deploy free to your Cloudflare");
  });

  it("answers moving between Hosted and self-hosted in the FAQ", () => {
    expect(copy).toContain("Can I move between Hosted and self-hosted?");
    expect(copy).toContain("How does the free trial work?");
    expect(copy).toContain("Export your data from one and import it into the other");
  });

  it("moves the two ways to run it right after the hero", () => {
    expect(html.indexOf('id="pricing"')).toBeLessThan(html.indexOf('id="schedule-aware"'));
    expect(html.indexOf('id="features"')).toBeLessThan(html.indexOf('id="how-it-works"'));
  });

  it("adds a Hosted column to the comparison with the SaaS tools", () => {
    expect(copy).toContain("OpenPing (self-hosted)");
    expect(copy).toContain("20, up to 120 with packs of 25");
  });
});

describe("a sign-up URL that isn't usable", () => {
  it("leaves the page exactly as the waitlist", () => {
    expect(render("http://app.openping.example/sign-up")).toBe(render());
  });
});
