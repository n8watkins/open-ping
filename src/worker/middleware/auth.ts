import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../types";
import { CSRF_HEADER, getSession, touchSession } from "../lib/sessions";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Require an authenticated session. For state-changing methods, also enforce a
 * synchronizer CSRF token (header must match the session's server-side secret).
 * SameSite=Lax cookies already block most cross-site requests; this is defense
 * in depth (PRD §13).
 */
export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "unauthorized" }, 401);

  if (!SAFE_METHODS.has(c.req.method.toUpperCase())) {
    const provided = c.req.header(CSRF_HEADER);
    if (!provided || provided !== session.csrf_secret) {
      return c.json({ error: "csrf_failed" }, 403);
    }
  }

  c.set("session", session);
  c.set("admin", {
    id: session.id,
    login: session.identity_kind === "github" ? session.identity : undefined,
    email: session.identity_kind === "email" ? session.identity : undefined,
  });

  await touchSession(c.env, session);
  await next();
};
