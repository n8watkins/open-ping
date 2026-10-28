import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../types";
import { CSRF_HEADER, getSession, touchSession } from "../lib/sessions";
import { timingSafeEqual } from "../lib/timing";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * True when `authorization` is `Bearer <API_TOKEN>` and API_TOKEN is set,
 * compared in constant time. The one bearer check behind the REST API's
 * requireAuth and the /mcp endpoint.
 */
export async function hasValidApiToken(
  env: { API_TOKEN?: string },
  authorization: string | undefined,
): Promise<boolean> {
  if (!env.API_TOKEN || !authorization || !/^bearer\s+/i.test(authorization)) return false;
  const bearer = authorization.replace(/^bearer\s+/i, "").trim();
  return bearer.length > 0 && (await timingSafeEqual(bearer, env.API_TOKEN));
}

/**
 * Require an authenticated session. For state-changing methods, also enforce a
 * synchronizer CSRF token (header must match the session's server-side secret).
 * SameSite=Lax cookies already block most cross-site requests; this is defense
 * in depth (PRD §13).
 */
export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  // API-token auth for CLI/automation: a Bearer token matching the API_TOKEN
  // secret grants admin. Bearer tokens aren't sent automatically by browsers, so
  // there's no CSRF surface - we intentionally skip the cookie/CSRF checks here.
  // Opt-in: only active when API_TOKEN is configured.
  if (await hasValidApiToken(c.env, c.req.header("authorization"))) {
    c.set("admin", { id: "api-token" });
    await next();
    return;
  }

  const session = await getSession(c);
  if (!session) return c.json({ error: "unauthorized" }, 401);

  if (!SAFE_METHODS.has(c.req.method.toUpperCase())) {
    const provided = c.req.header(CSRF_HEADER);
    if (!provided || !(await timingSafeEqual(provided, session.csrf_secret))) {
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
