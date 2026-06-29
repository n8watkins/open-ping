import { Hono } from "hono";
import type { AppEnv, Env } from "./types";
import { api } from "./routes/api";
import { auth } from "./routes/auth";
import { magicFlow } from "./routes/magic";
import { heartbeats } from "./routes/heartbeats";
import { runScheduled } from "./scheduler";

const app = new Hono<AppEnv>();

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
  return c.env.ASSETS.fetch(c.req.raw);
});

export default {
  fetch: app.fetch,
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runScheduled(controller, env));
  },
} satisfies ExportedHandler<Env>;
