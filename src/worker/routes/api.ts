import { Hono } from "hono";
import type { AppEnv } from "../types";
import { apiAuth } from "./api-auth";
import { setup } from "./setup";

export const api = new Hono<AppEnv>();

api.route("/auth", apiAuth);
api.route("/setup", setup);

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
//   api.route("/monitors", monitors)
//   api.route("/incidents", incidents)
//   api.route("/settings", settings)
//   api.route("/notifications", notifications)
//
// Note: unmatched /api/* paths are handled by the top-level catch-all in
// index.ts (Hono's route() merge means a sub-app notFound never fires here).
