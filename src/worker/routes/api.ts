import { Hono } from "hono";
import type { AppEnv } from "../types";
import { apiAuth } from "./api-auth";
import { setup } from "./setup";
import { monitors } from "./monitors";
import { categories } from "./categories";
import { statusPages } from "./status-pages";
import { channels } from "./channels";
import { push } from "./push";
import { magicApi } from "./magic";
import { passkeyAuth, passkeysAdmin } from "./passkeys";
import { overview } from "./overview";
import { incidents } from "./incidents";
import { diagnostics } from "./diagnostics";
import { settings } from "./settings";
import { maintenance } from "./maintenance";
import { publicStatus } from "./public";
import { data } from "./data";
import { isItDown } from "./is-it-down";
import { waitlist } from "./waitlist";
import { rekey } from "./rekey";
import { reports } from "./reports";
import { events } from "./events";

export const api = new Hono<AppEnv>();

api.route("/auth", apiAuth);
api.route("/auth/magic", magicApi);
api.route("/auth/passkeys", passkeyAuth);
api.route("/passkeys", passkeysAdmin);
api.route("/setup", setup);
api.route("/overview", overview);
api.route("/monitors", monitors);
api.route("/categories", categories);
api.route("/status-pages", statusPages);
api.route("/channels", channels);
api.route("/incidents", incidents);
api.route("/diagnostics", diagnostics);
api.route("/settings", settings);
api.route("/maintenance", maintenance);
api.route("/data", data);
api.route("/push", push);
api.route("/admin/rekey", rekey);
api.route("/reports", reports);

// Public, UNAUTHENTICATED status-page data (redacted).
api.route("/public", publicStatus);

// Public, UNAUTHENTICATED "is it down?" checker (SSRF-guarded + rate-limited).
api.route("/tools/is-it-down", isItDown);

// The OpenPing Hosted waitlist: public sign-up, admin list and CSV export.
// Only accepts entries where WAITLIST_ENABLED is "true" (the canonical install).
api.route("/waitlist", waitlist);

// Landing page click counts (HOME_PAGE="landing" installs only): a public,
// allow-listed counter and the admin totals Settings shows.
api.route("/events", events);

/** Liveness/readiness probe. Reports whether core wiring is present. */
api.get("/health", (c) => {
  return c.json({
    ok: true,
    name: "OpenPing",
    version: "0.1.0",
    time: new Date().toISOString(),
    db: typeof c.env.DB?.prepare === "function",
  });
});

// Route groups added in later phases:
//   api.route("/incidents", incidents)
//   api.route("/settings", settings)
//   api.route("/notifications", notifications)
//
// Note: unmatched /api/* paths are handled by the top-level catch-all in
// index.ts (Hono's route() merge means a sub-app notFound never fires here).
