import { describe, it, expect } from "vitest";
import worker from "./index";
import type { Env } from "./types";
import {
  BASE_SECURITY_HEADERS,
  cspDirectives,
  serializeCsp,
  widgetCspDirectives,
} from "./security-headers";

// Vitest runs with Vite's DEV flag on, so the Worker sends its dev CSP here.
const viteDev = (import.meta as ImportMeta & { env?: { DEV?: boolean } }).env?.DEV === true;
const pageCsp = serializeCsp(cspDirectives({ viteDev }));
const widgetCsp = serializeCsp(widgetCspDirectives({ viteDev }));

/**
 * Simulate a Cloudflare ASSETS / `fetch()` response: readable body, but with
 * IMMUTABLE headers (any mutation throws). Returning one of these directly is
 * what made the global secureHeaders middleware throw "Can't modify immutable
 * headers" and 500 every direct-loaded client route (regression guard).
 */
function immutableAssetResponse(): Response {
  const res = new Response("<!doctype html><title>spa</title>", {
    status: 200,
    headers: { "content-type": "text/html" },
  });
  const block = () => {
    throw new TypeError("Can't modify immutable headers");
  };
  res.headers.set = block as never;
  res.headers.append = block as never;
  res.headers.delete = block as never;
  return res;
}

function makeEnv(onAssetFetch?: (request: Request) => void): Env {
  return {
    ASSETS: {
      fetch: async (request: Request) => {
        onAssetFetch?.(request);
        return immutableAssetResponse();
      },
    },
  } as unknown as Env;
}

const ctx = {
  waitUntil() {},
  passThroughOnException() {},
} as unknown as ExecutionContext;

describe("worker fetch — SPA fallback + secureHeaders", () => {
  it("serves a direct-loaded client route (/status) as 200 with security headers", async () => {
    let assetUrl = "";
    const res = await worker.fetch!(
      new Request("https://example.com/status"),
      makeEnv((request) => {
        assetUrl = request.url;
      }),
      ctx,
    );
    // Before the fix this threw on the immutable ASSETS headers → 500.
    expect(res.status).toBe(200);
    // Nested SPA routes must load the root entry so Vite applies its HTML
    // transforms (including the React refresh preamble) during development.
    expect(assetUrl).toBe("https://example.com/");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("content-security-policy")).toContain(
      "frame-ancestors 'none'",
    );
  });

  it("serves the plain app shell at / unless HOME_PAGE is landing", async () => {
    const res = await worker.fetch!(new Request("https://example.com/"), makeEnv(), ctx);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("<!doctype html><title>spa</title>");
  });

  it("writes the landing page's title and preview tags into / on a landing install", async () => {
    const env = { ...makeEnv(), HOME_PAGE: "landing", APP_URL: "https://openping.example" } as Env;
    const res = await worker.fetch!(new Request("https://example.com/"), env, ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    const html = await res.text();
    expect(html).toContain("<title>OpenPing: uptime monitoring on your own Cloudflare</title>");
    // (withLandingHead's own tests cover the preview tags in a full shell.)

    // Only the root: every other client route keeps the generic shell.
    const other = await worker.fetch!(new Request("https://example.com/install"), env, ctx);
    expect(await other.text()).toBe("<!doctype html><title>spa</title>");
  });

  it("lets Cloudflare Web Analytics load and report, and nothing else", async () => {
    const res = await worker.fetch!(new Request("https://example.com/"), makeEnv(), ctx);
    const csp = res.headers.get("content-security-policy") ?? "";
    const directive = (name: string) =>
      csp.split(";").map((d) => d.trim()).find((d) => d.startsWith(`${name} `)) ?? "";
    expect(directive("script-src")).toContain("https://static.cloudflareinsights.com");
    // Cloudflare's analytics reporter, and the canonical install for the Hosted waitlist form.
    expect(directive("connect-src")).toBe("connect-src 'self' https://cloudflareinsights.com https://openping.n8builds.dev");
    // No wildcard hosts crept in.
    expect(directive("script-src")).not.toContain("*");
  });

  it("widens framing for the /embed widget ONLY (drops XFO, relaxes frame-ancestors)", async () => {
    const res = await worker.fetch!(
      new Request("https://example.com/embed"),
      makeEnv(),
      ctx,
    );
    expect(res.status).toBe(200);
    // X-Frame-Options is removed so the iframe can load cross-origin.
    expect(res.headers.get("x-frame-options")).toBeNull();
    // frame-ancestors is relaxed to n8builds.dev and its subdomains (a `*.`
    // wildcard never matches the bare domain, so it is listed too); the rest of
    // the CSP (script-src 'self', etc.) is preserved.
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("frame-ancestors https://n8builds.dev https://*.n8builds.dev;");
    expect(csp).not.toContain("frame-ancestors 'none'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toBe(widgetCsp);
    expect(csp.replace(/frame-ancestors [^;]*/, "frame-ancestors 'none'")).toBe(pageCsp);
  });

  it("frames nested widget paths the same way, and nothing that only starts with /embed", async () => {
    const nested = await worker.fetch!(new Request("https://example.com/embed/api"), makeEnv(), ctx);
    expect(nested.headers.get("content-security-policy")).toBe(widgetCsp);
    const lookalike = await worker.fetch!(new Request("https://example.com/embedded"), makeEnv(), ctx);
    expect(lookalike.headers.get("x-frame-options")).toBe("DENY");
    expect(lookalike.headers.get("content-security-policy")).toBe(pageCsp);
  });

  it("gives every response the one policy, including the real files it passes through", async () => {
    for (const path of ["/", "/index.html", "/offline", "/offline.html", "/sw.js", "/status", "/login", "/monitors/1"]) {
      const res = await worker.fetch!(new Request(`https://example.com${path}`), makeEnv(), ctx);
      expect(res.headers.get("content-security-policy"), path).toBe(pageCsp);
      expect(res.headers.get("x-frame-options"), path).toBe("DENY");
      for (const [name, value] of Object.entries(BASE_SECURITY_HEADERS)) {
        expect(res.headers.get(name), `${path} ${name}`).toBe(value);
      }
    }
  });

  it("hands real files to the assets binding as requested, and client routes the SPA entry", async () => {
    const asked: Record<string, string> = {};
    for (const path of ["/", "/index.html", "/offline", "/offline.html", "/sw.js", "/landing/status-page.webp", "/@vite/client", "/status", "/embed/api"]) {
      await worker.fetch!(
        new Request(`https://example.com${path}`),
        makeEnv((request) => {
          asked[path] = new URL(request.url).pathname;
        }),
        ctx,
      );
    }
    expect(asked).toEqual({
      "/": "/",
      "/index.html": "/index.html",
      "/offline": "/offline",
      "/offline.html": "/offline.html",
      "/sw.js": "/sw.js",
      "/landing/status-page.webp": "/landing/status-page.webp",
      // Vitest runs as Vite dev, where Vite's own modules pass through too.
      "/@vite/client": "/@vite/client",
      "/status": "/",
      "/embed/api": "/",
    });
  });

  it("returns JSON 404 for an unmatched /api route (never the SPA shell)", async () => {
    const res = await worker.fetch!(
      new Request("https://example.com/api/does-not-exist"),
      makeEnv(),
      ctx,
    );
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({
      error: "not_found",
      path: "/api/does-not-exist",
    });
  });

  it("rejects oversized bodies on public endpoints before route parsing", async () => {
    const oversized = JSON.stringify({ value: "x".repeat(33 * 1024) });
    for (const path of ["/api/auth/magic/request", "/api/tools/is-it-down", "/hb/token"]) {
      const res = await worker.fetch!(
        new Request(`https://example.com${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: oversized,
        }),
        makeEnv(),
        ctx,
      );
      expect(res.status).toBe(413);
      expect(await res.json()).toEqual({ error: "payload_too_large" });
    }
  });

  it("OAuth start 302-redirects (Response.redirect headers are also immutable)", async () => {
    // The GitHub OAuth start returns Response.redirect(), whose headers are
    // immutable just like ASSETS — this 500'd before the mutable-clone fix.
    const env = {
      GITHUB_CLIENT_ID: "Ov23test",
      APP_URL: "https://example.com",
      DB: {
        prepare: () => ({
          bind: () => ({
            first: async () => ({ count: 1 }),
            run: async () => ({}),
          }),
        }),
      },
    } as unknown as Env;
    const res = await worker.fetch!(
      new Request("https://example.com/auth/github/start"),
      env,
      ctx,
    );
    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("github.com/login/oauth/authorize");
    expect(location).toContain("client_id=Ov23test");
    expect(res.headers.get("x-frame-options")).toBe("DENY"); // headers still applied
    // The state cookie MUST survive the redirect (Response.redirect dropped it,
    // breaking login with "state_invalid"); c.redirect preserves it.
    expect(res.headers.get("set-cookie") ?? "").toContain("op_oauth_state=");
  });

  it("rate-limits OAuth starts before creating a state token", async () => {
    let stateInsertAttempted = false;
    const env = {
      GITHUB_CLIENT_ID: "Ov23test",
      APP_URL: "https://example.com",
      DB: {
        prepare: (sql: string) => {
          if (sql.includes("auth_tokens")) stateInsertAttempted = true;
          return {
            bind: () => ({
              first: async () => ({ count: 21 }),
              run: async () => ({}),
            }),
          };
        },
      },
    } as unknown as Env;

    const res = await worker.fetch!(
      new Request("https://example.com/auth/github/start", {
        headers: { "cf-connecting-ip": "203.0.113.10" },
      }),
      env,
      ctx,
    );

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      "https://example.com/login?error=rate_limited",
    );
    expect(res.headers.get("retry-after")).toBeTruthy();
    expect(stateInsertAttempted).toBe(false);
  });
});
