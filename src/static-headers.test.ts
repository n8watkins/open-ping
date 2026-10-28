import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  BASE_SECURITY_HEADERS,
  CF_ANALYTICS_SCRIPT,
  cspDirectives,
  serializeCsp,
  STATIC_HTML_PAGES,
  WIDGET_FRAME_ANCESTORS,
  widgetCspDirectives,
} from "./worker/security-headers";

/*
 * Static assets can answer requests before the Worker (and its security
 * headers) runs. These checks keep that from opening a gap: every page must run
 * the Worker first, and whatever public/_headers adds to the files that don't
 * must agree with the policy in src/worker/security-headers.ts.
 */
const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

/** public/_headers as { "/pattern": { "Header-Name": "value" } }. */
function parseHeadersFile(text: string): Record<string, Record<string, string>> {
  const rules: Record<string, Record<string, string>> = {};
  let current: Record<string, string> | undefined;
  for (const line of text.split("\n")) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    if (!/^\s/.test(line)) {
      current = rules[line.trim()] = {};
      continue;
    }
    const match = /^\s+([^:]+):\s*(.*)$/.exec(line);
    expect(match, `a "Name: value" header line, got ${JSON.stringify(line)}`).not.toBeNull();
    expect(current, "a header line under a path").toBeDefined();
    current![match![1]!.trim()] = match![2]!.trim();
  }
  return rules;
}

/** wrangler.jsonc, whose comments are all whole lines. */
const wrangler = JSON.parse(read("../wrangler.jsonc").replace(/^\s*\/\/.*$/gm, "")) as {
  assets: { run_worker_first?: string[] | boolean };
};

describe("static asset security headers", () => {
  const rules = parseHeadersFile(read("../public/_headers"));

  it("only adds headers whose values match the Worker's policy", () => {
    expect(Object.keys(rules)).toEqual(["/*"]);
    expect(rules["/*"]).toEqual(BASE_SECURITY_HEADERS);
  });

  it("leaves CSP and framing to the Worker, which owns every HTML page", () => {
    const names = Object.values(rules).flatMap((r) => Object.keys(r).map((n) => n.toLowerCase()));
    expect(names).not.toContain("content-security-policy");
    expect(names).not.toContain("x-frame-options");
  });

  it("runs the Worker first for everything but the hashed bundles", () => {
    // An array here also means a request it doesn't match never reaches the
    // Worker (static assets answer it, with the SPA fallback if nothing
    // matches), so it must cover every page and API route.
    expect(wrangler.assets.run_worker_first).toEqual(["/*", "!/assets/*"]);
    // Only Vite's hashed output lives under /assets/, never a page of ours.
    expect(readdirSync(new URL("../public", import.meta.url))).not.toContain("assets");
  });

  it("lists every extensionless static HTML page, so the Worker serves the file", () => {
    const pages = readdirSync(new URL("../public", import.meta.url))
      .filter((name) => name.endsWith(".html"))
      .map((name) => `/${name.slice(0, -".html".length)}`);
    expect([...STATIC_HTML_PAGES].sort()).toEqual(pages.sort());
  });

  it("lets the landing page's waitlist form post where it's configured to", () => {
    const form = read("./client/components/landing/WaitlistForm.tsx");
    const url = /"(https:\/\/[^"]+\/api\/waitlist)"/.exec(form)?.[1];
    expect(url, "the waitlist form's default URL").toBeDefined();
    expect(cspDirectives().connectSrc).toContain(new URL(url!).origin);
  });
});

describe("the security policy", () => {
  it("allows no inline script in production, only this origin and Web Analytics", () => {
    expect(cspDirectives().scriptSrc).toEqual(["'self'", CF_ANALYTICS_SCRIPT]);
    expect(cspDirectives({ viteDev: true }).scriptSrc).toContain("'unsafe-inline'");
  });

  it("lets n8builds.dev and its subdomains frame the widget, and no one frame anything else", () => {
    expect(WIDGET_FRAME_ANCESTORS).toEqual(["https://n8builds.dev", "https://*.n8builds.dev"]);
    expect(cspDirectives().frameAncestors).toEqual(["'none'"]);
    expect(serializeCsp(widgetCspDirectives())).toBe(
      serializeCsp(cspDirectives()).replace(
        "frame-ancestors 'none'",
        "frame-ancestors https://n8builds.dev https://*.n8builds.dev",
      ),
    );
  });

  it("serialises directives the way browsers expect", () => {
    expect(serializeCsp(cspDirectives())).toBe(
      "default-src 'self'; base-uri 'self'; frame-ancestors 'none'; object-src 'none'; " +
        "script-src 'self' https://static.cloudflareinsights.com; style-src 'self' 'unsafe-inline'; " +
        "img-src 'self' data: https:; font-src 'self' data:; " +
        "connect-src 'self' https://cloudflareinsights.com https://openping.n8builds.dev; worker-src 'self'",
    );
  });
});
