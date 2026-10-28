import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { secureHeaders } from "hono/secure-headers";
import type { AppEnv, Env } from "./types";
import { api } from "./routes/api";
import { auth } from "./routes/auth";
import { magicFlow } from "./routes/magic";
import { heartbeats } from "./routes/heartbeats";
import { feeds } from "./routes/feeds";
import { mcp, MCP_MAX_BODY_BYTES } from "./mcp/handler";
import { runScheduled } from "./scheduler";
import { homePage, withLandingHead } from "./lib/home-page";
import {
  BASE_SECURITY_HEADERS,
  cspDirectives,
  isWidgetPath,
  serializeCsp,
  STATIC_HTML_PAGES,
  widgetCspDirectives,
} from "./security-headers";

const app = new Hono<AppEnv>();
const isViteDev = (import.meta as ImportMeta & { env?: { DEV?: boolean } }).env?.DEV === true;

// ---------------------------------------------------------------------------
// Response security headers. The policy itself lives in ./security-headers.ts.
//
// secureHeaders() below locks every response down with `X-Frame-Options: DENY`
// + `frame-ancestors 'none'`, which is correct for the admin panel, login, API
// and the main status page (they must never be framed). The /embed widget is
// the one surface designed to be iframed from an external site, so for that
// path - and that path only - we drop X-Frame-Options and send the widget CSP,
// which differs only in frame-ancestors (WIDGET_FRAME_ANCESTORS).
//
// This middleware is registered FIRST so that, by Hono's onion ordering, its
// post-`next()` phase runs LAST - i.e. AFTER secureHeaders has written its
// headers - letting it override them on the already-mutable response (the
// clone middleware further below makes the ASSETS/redirect responses mutable).
const widgetCsp = serializeCsp(widgetCspDirectives({ viteDev: isViteDev }));

app.use("*", async (c, next) => {
  await next();
  if (!c.res || !isWidgetPath(c.req.path)) return;
  c.res.headers.delete("X-Frame-Options");
  c.res.headers.set("Content-Security-Policy", widgetCsp);
});

// Security headers on every response (admin SPA, public status page, JSON API).
// frame-ancestors/X-Frame-Options block clickjacking of the authenticated admin
// panel; nosniff + a tailored CSP are defense-in-depth for an app that renders
// admin- and heartbeat-supplied strings.
app.use(
  "*",
  secureHeaders({
    xFrameOptions: "DENY",
    xContentTypeOptions: BASE_SECURITY_HEADERS["X-Content-Type-Options"],
    referrerPolicy: BASE_SECURITY_HEADERS["Referrer-Policy"],
    strictTransportSecurity: BASE_SECURITY_HEADERS["Strict-Transport-Security"],
    contentSecurityPolicy: cspDirectives({ viteDev: isViteDev }),
  }),
);

// secureHeaders (above) sets headers in its post-`next()` phase, but several
// responses in this app have IMMUTABLE headers - Response.redirect() (OAuth /
// magic-link flows) and env.ASSETS.fetch() (the SPA / static assets) - and
// modifying those throws "Can't modify immutable headers" → 500. This inner
// middleware runs after the handler but BEFORE secureHeaders' post-phase, and
// replaces the response with a mutable clone so the security headers always apply
// regardless of where the response came from.
app.use("*", async (c, next) => {
  await next();
  if (c.res) c.res = new Response(c.res.body, c.res);
});

// Bound attacker-controlled request bodies before any route parses JSON. Public
// probe/auth/heartbeat endpoints need only tiny payloads; authenticated import
// and configuration routes get a larger ceiling for legitimate backups.
const SMALL_BODY_LIMIT = 32 * 1024;
const API_BODY_LIMIT = 5 * 1024 * 1024;
const payloadTooLarge = (c: Context) =>
  c.json({ error: "payload_too_large" }, 413);
app.use("/api/auth/magic/*", bodyLimit({ maxSize: SMALL_BODY_LIMIT, onError: payloadTooLarge }));
app.use("/api/tools/is-it-down", bodyLimit({ maxSize: SMALL_BODY_LIMIT, onError: payloadTooLarge }));
app.use("/api/events", bodyLimit({ maxSize: 1024, onError: payloadTooLarge }));
app.use("/api/waitlist", bodyLimit({ maxSize: SMALL_BODY_LIMIT, onError: payloadTooLarge }));
app.use("/hb/*", bodyLimit({ maxSize: SMALL_BODY_LIMIT, onError: payloadTooLarge }));
app.use("/mcp", bodyLimit({ maxSize: MCP_MAX_BODY_BYTES, onError: payloadTooLarge }));
app.use("/api/*", bodyLimit({ maxSize: API_BODY_LIMIT, onError: payloadTooLarge }));

// JSON API (auth, monitors, incidents, settings, …). Mounted before the SPA
// fallback so API routes never get swallowed by the asset handler.
app.route("/api", api);

// Browser-facing OAuth / magic-link redirect flows.
app.route("/auth", auth);
app.route("/auth/magic", magicFlow);

// Public heartbeat ingestion (called by external cron jobs / scripts).
app.route("/hb", heartbeats);

// RSS and Atom feeds of each status page (/status/feed.rss, /status/:slug/
// feed.atom, ...). Their paths have an extension, so the catch-all below would
// hand them to the assets binding, which has no such file.
app.route("/status", feeds);

// MCP server for AI clients (bearer API token only; see docs/MCP.md).
app.route("/mcp", mcp);

// OpenPing has no OAuth server. MCP clients probe these metadata documents
// after a 401; answer with a clean JSON 404 instead of the SPA's HTML shell.
app.all("/.well-known/*", async (c, next) => {
  if (c.req.path.startsWith("/.well-known/oauth-")) return c.json({ error: "not_found" }, 404);
  await next();
});

// Everything else: serve the built SPA. `not_found_handling: single-page-application`
// in wrangler.jsonc makes ASSETS return index.html for client-side routes.
// Unmatched /api paths must return JSON, not the HTML shell - Hono's route()
// merge means a sub-app's own notFound never fires for the parent, so guard here.
app.all("*", async (c) => {
  if (c.req.path === "/api" || c.req.path.startsWith("/api/")) {
    return c.json({ error: "not_found", path: c.req.path }, 404);
  }
  // Real files (anything with an extension, such as /sw.js or /index.html,
  // and the extensionless STATIC_HTML_PAGES) go to the assets binding as
  // requested, so it serves them, or redirects /index.html to /, as it would on
  // its own. The Worker still adds its security headers on the way out. In
  // development, so do Vite's own extensionless modules (/@vite/client,
  // /@react-refresh, /@id/...), which reach the Worker because every path runs
  // it first.
  const path = c.req.path;
  const lastSegment = path.slice(path.lastIndexOf("/") + 1);
  if (
    lastSegment.includes(".") ||
    (STATIC_HTML_PAGES as readonly string[]).includes(path) ||
    (isViteDev && path.startsWith("/@"))
  ) {
    return c.env.ASSETS.fetch(c.req.raw);
  }
  // Everything else is a client route: always ask the assets binding for the
  // HTML entry point. Passing the nested client route through (for example
  // `/monitors`) makes the Cloudflare Vite plugin serve its SPA fallback
  // without Vite's HTML transforms in dev. React Fast Refresh then aborts with
  // "can't detect preamble" and leaves a blank page on direct navigation. The
  // browser URL remains unchanged, so React Router still resolves the requested
  // route after the transformed shell loads.
  const entryUrl = new URL("/", c.req.url);
  const shell = await c.env.ASSETS.fetch(new Request(entryUrl, c.req.raw));
  // On the canonical install `/` is the marketing page: write its title,
  // description and link-preview tags into the shell (lib/home-page.ts).
  if (
    path === "/" &&
    homePage(c.env) === "landing" &&
    shell.ok &&
    (shell.headers.get("content-type") ?? "").includes("text/html")
  ) {
    const headers = new Headers(shell.headers);
    headers.delete("content-length");
    headers.delete("etag");
    return new Response(withLandingHead(await shell.text(), siteOrigin(c.env.APP_URL, c.req.url)), {
      status: shell.status,
      headers,
    });
  }
  return shell;
});

/** The install's public origin: APP_URL when it's a valid URL, else the request's. */
function siteOrigin(appUrl: string | undefined, requestUrl: string): string {
  if (appUrl) {
    try {
      const url = new URL(appUrl);
      if (url.protocol === "https:" || url.protocol === "http:") return url.origin;
    } catch {
      // Fall through to the request's origin.
    }
  }
  return new URL(requestUrl).origin;
}

export default {
  fetch: app.fetch,
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runScheduled(controller, env));
  },
} satisfies ExportedHandler<Env>;
