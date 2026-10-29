import { env } from "cloudflare:workers";
import { applyD1Migrations, createExecutionContext } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import worker from "../../src/worker/index";
import type { Env } from "../../src/worker/types";
import { landingMeta } from "../../src/shared/hosted-offer";

/**
 * The Hosted launch switch (HOSTED_SIGNUP_URL) as the landing page sees it:
 * the status answer the app reads before it renders `/`, and the title the
 * Worker writes into the page for crawlers and link previews.
 */

const ORIGIN = "https://openping.test";
const SIGNUP = "https://app.hosted.test/sign-up";

const SHELL =
  '<!doctype html><html><head><meta name="description" content="generic" /><title>OpenPing</title></head><body></body></html>';
const ASSETS = {
  fetch: async () => new Response(SHELL, { headers: { "content-type": "text/html; charset=utf-8" } }),
} as unknown as Fetcher;

function fetchWith(path: string, vars: Partial<Env>): Promise<Response> {
  const target = { ...env, ASSETS, ...vars } as Env;
  return Promise.resolve(worker.fetch(new Request(`${ORIGIN}${path}`), target, createExecutionContext()));
}

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

describe("the Hosted launch switch", () => {
  it("says nothing about Hosted sign-ups while the var is unset or unusable", async () => {
    for (const value of [undefined, "", "  ", "not a url", "http://app.hosted.test/sign-up", "javascript:alert(1)"]) {
      const status = await (await fetchWith("/api/auth/status", { HOSTED_SIGNUP_URL: value })).json<object>();
      expect(status).not.toHaveProperty("hostedSignupUrl");
      expect(status).toMatchObject({ homePage: "landing", waitlistEnabled: true });
    }
  });

  it("reports the sign-up page once it is set", async () => {
    const status = await (await fetchWith("/api/auth/status", { HOSTED_SIGNUP_URL: ` ${SIGNUP} ` })).json<object>();
    expect(status).toMatchObject({ homePage: "landing", hostedSignupUrl: SIGNUP });
  });

  it("serves the waitlist title at / until then, and the launch title after", async () => {
    const closed = await (await fetchWith("/", {})).text();
    expect(closed).toContain(`<title>${landingMeta(false).title}</title>`);

    const open = await (await fetchWith("/", { HOSTED_SIGNUP_URL: SIGNUP })).text();
    expect(open).toContain(`<title>${landingMeta(true).title}</title>`);
    expect(open).toContain("30-day free trial");
  });
});
