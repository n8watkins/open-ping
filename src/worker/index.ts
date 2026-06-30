import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";
import type { AppEnv, Env } from "./types";
import { api } from "./routes/api";
import { auth } from "./routes/auth";
import { magicFlow } from "./routes/magic";
import { heartbeats } from "./routes/heartbeats";
import { runScheduled } from "./scheduler";

const app = new Hono<AppEnv>();

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
      scriptSrc: ["'self'"],
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
  // The mutable-clone middleware above handles the immutable ASSETS headers.
  return c.env.ASSETS.fetch(c.req.raw);
});

export default {
  fetch: app.fetch,
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runScheduled(controller, env));
  },
} satisfies ExportedHandler<Env>;
