import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";
import type { AppEnv, Env } from "./types";
import { api } from "./routes/api";
import { auth } from "./routes/auth";
import { magicFlow } from "./routes/magic";
import { heartbeats } from "./routes/heartbeats";
import { runScheduled } from "./scheduler";

const app = new Hono<AppEnv>();
const isViteDev = (import.meta as ImportMeta & { env?: { DEV?: boolean } }).env?.DEV === true;

// ---------------------------------------------------------------------------
// Embeddable status widget: framing override (scoped to /embed ONLY).
//
// secureHeaders() below locks every response down with `X-Frame-Options: DENY`
// + `frame-ancestors 'none'`, which is correct for the admin panel, login,
// API and the main status page (they must never be framed). The /embed widget
// is the one surface designed to be iframed from an external site, so for that
// path — and that path only — we drop X-Frame-Options and relax the CSP's
// frame-ancestors to allow n8builds.dev subdomains. All other CSP directives
// (script-src 'self', etc.) are preserved.
//
// This middleware is registered FIRST so that, by Hono's onion ordering, its
// post-`next()` phase runs LAST — i.e. AFTER secureHeaders has written its
// headers — letting it override them on the already-mutable response (the
// clone middleware further below makes the ASSETS/redirect responses mutable).
//
// To widen embedding to another host, add origins to ALLOWED_FRAME_ANCESTORS
// (space-separated, e.g. "https://*.n8builds.dev https://example.com").
const WIDGET_PATH = "/embed";
const ALLOWED_FRAME_ANCESTORS = "https://*.n8builds.dev";

function isWidgetPath(path: string): boolean {
  return path === WIDGET_PATH || path.startsWith(`${WIDGET_PATH}/`);
}

app.use("*", async (c, next) => {
  await next();
  if (!c.res || !isWidgetPath(c.req.path)) return;
  c.res.headers.delete("X-Frame-Options");
  const csp = c.res.headers.get("Content-Security-Policy");
  c.res.headers.set(
    "Content-Security-Policy",
    csp
      ? csp.replace(/frame-ancestors[^;]*/i, `frame-ancestors ${ALLOWED_FRAME_ANCESTORS}`)
      : `frame-ancestors ${ALLOWED_FRAME_ANCESTORS}`,
  );
});

// Security headers on every response (admin SPA, public status page, JSON API).
// frame-ancestors/X-Frame-Options block clickjacking of the authenticated admin
// panel; nosniff + a tailored CSP are defense-in-depth for an app that renders
// admin- and heartbeat-supplied strings. The CSP suits the Vite/React/Tailwind
// build (external hashed scripts, inline style attributes, same-origin XHR,
// external/data: images for the status-page logo); tune if you add origins.
app.use(
  "*",
  secureHeaders({
    xFrameOptions: "DENY",
    xContentTypeOptions: "nosniff",
    referrerPolicy: "no-referrer",
    contentSecurityPolicy: {
      defaultSrc: ["'self'"],
      baseUri: ["'self'"],
      frameAncestors: ["'none'"],
      objectSrc: ["'none'"],
      // Vite injects an inline React Fast Refresh preamble into transformed
      // HTML during local development. Permit that development-only script so
      // direct SPA routes can boot; production builds contain no inline script
      // and retain the strict self-only policy.
      scriptSrc: isViteDev ? ["'self'", "'unsafe-inline'"] : ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "https:"],
      fontSrc: ["'self'", "data:"],
      connectSrc: ["'self'"],
      workerSrc: ["'self'"],
    },
  }),
);

// secureHeaders (above) sets headers in its post-`next()` phase, but several
// responses in this app have IMMUTABLE headers — Response.redirect() (OAuth /
// magic-link flows) and env.ASSETS.fetch() (the SPA / static assets) — and
// modifying those throws "Can't modify immutable headers" → 500. This inner
// middleware runs after the handler but BEFORE secureHeaders' post-phase, and
// replaces the response with a mutable clone so the security headers always apply
// regardless of where the response came from.
app.use("*", async (c, next) => {
  await next();
  if (c.res) c.res = new Response(c.res.body, c.res);
});

// JSON API (auth, monitors, incidents, settings, …). Mounted before the SPA
// fallback so API routes never get swallowed by the asset handler.
app.route("/api", api);

// Browser-facing OAuth / magic-link redirect flows.
app.route("/auth", auth);
app.route("/auth/magic", magicFlow);

// Public heartbeat ingestion (called by external cron jobs / scripts).
app.route("/hb", heartbeats);

// Everything else: serve the built SPA. `not_found_handling: single-page-application`
// in wrangler.jsonc makes ASSETS return index.html for client-side routes.
// Unmatched /api paths must return JSON, not the HTML shell — Hono's route()
// merge means a sub-app's own notFound never fires for the parent, so guard here.
app.all("*", (c) => {
  if (c.req.path === "/api" || c.req.path.startsWith("/api/")) {
    return c.json({ error: "not_found", path: c.req.path }, 404);
  }
  // Always ask the assets binding for the HTML entry point. Passing the nested
  // client route through (for example `/monitors`) makes the Cloudflare Vite
  // plugin serve its SPA fallback without Vite's HTML transforms in dev. React
  // Fast Refresh then aborts with "can't detect preamble" and leaves a blank
  // page on direct navigation. The browser URL remains unchanged, so React
  // Router still resolves the requested route after the transformed shell loads.
  const entryUrl = new URL("/", c.req.url);
  return c.env.ASSETS.fetch(new Request(entryUrl, c.req.raw));
});

export default {
  fetch: app.fetch,
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runScheduled(controller, env));
  },
} satisfies ExportedHandler<Env>;
