import type { Context, MiddlewareHandler } from "hono";
import type { AppEnv, Env } from "../types";
import { findApiToken } from "../db/api-tokens";
import { hitRateLimit } from "../db/rate-limit";
import { CSRF_HEADER, getSession, touchSession } from "../lib/sessions";
import { timingSafeEqual } from "../lib/timing";
import { hasScope, insufficientScopeBody, routeAccess, type Scope } from "../lib/scopes";
import { SUPPORT_RESTRICTED, auditSupportChange, isSupportSession, recordSupportActivity, supportRestriction } from "../lib/support";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** REST calls each bearer token may make per minute (one D1 write each). */
export const API_TOKEN_RATE_LIMIT_PER_MINUTE = 120;

/**
 * Who a valid bearer token is: the API_TOKEN secret (always admin), or a
 * stored token by id with its scopes (lib/scopes.ts).
 */
export type ApiTokenIdentity =
  | { kind: "secret"; scopes: Scope[] }
  | { kind: "stored"; id: string; name: string; scopes: Scope[]; expiresAt: number | null };

/**
 * Who `authorization` (`Bearer <token>`) authenticates as, or null: the
 * API_TOKEN secret (compared in constant time), or a live token created under
 * Developers (looked up by hash; revoked and expired ones are null,
 * db/api-tokens.ts). The one bearer check behind the REST API's requireAuth
 * and the /mcp endpoint.
 */
export async function apiTokenIdentity(
  env: Env,
  authorization: string | undefined,
): Promise<ApiTokenIdentity | null> {
  if (!authorization || !/^bearer\s+/i.test(authorization)) return null;
  const bearer = authorization.replace(/^bearer\s+/i, "").trim();
  if (!bearer) return null;
  if (env.API_TOKEN && (await timingSafeEqual(bearer, env.API_TOKEN))) return { kind: "secret", scopes: ["admin"] };
  const stored = await findApiToken(env, bearer);
  return stored
    ? { kind: "stored", id: stored.id, name: stored.name, scopes: stored.scopes, expiresAt: stored.expiresAt }
    : null;
}

/** The admin id requireAuth records for a bearer token (also its rate limit key). */
export function apiTokenAdminId(who: ApiTokenIdentity): string {
  return who.kind === "secret" ? "api-token" : `api-token:${who.id}`;
}

/** A 403 for a token that lacks `needed` (or for any token on a session-only route). */
export function insufficientScope(c: Context<AppEnv>, needed: Scope | "session", detail?: string): Response {
  const scopes = c.get("token")?.scopes ?? [];
  if (needed !== "session") {
    c.header("WWW-Authenticate", `Bearer realm="OpenPing", error="insufficient_scope", scope="${needed}"`);
  }
  return c.json(insufficientScopeBody(needed, scopes, detail), 403);
}

/**
 * Whether the caller may do what needs `scope`: a browser session always may,
 * a token only with that scope (admin implies every scope).
 */
export function callerHasScope(c: Context<AppEnv>, scope: Scope): boolean {
  const token = c.get("token");
  return !token || hasScope(token.scopes, scope);
}

/**
 * The scope check for bearer tokens, run by requireAuth right after a token
 * authenticates. A route's access comes from the one table in lib/scopes.ts;
 * a route missing from it is admin only (DEFAULT DENY). Sessions pass.
 */
export const requireScope: MiddlewareHandler<AppEnv> = async (c, next) => {
  const token = c.get("token");
  if (!token) return next();
  const access = routeAccess(c.req.method, c.req.path) ?? "admin";
  if (access === "session") return insufficientScope(c, "session");
  if (access !== "token" && !hasScope(token.scopes, access)) return insufficientScope(c, access);
  return next();
};

/**
 * Require an authenticated session. For state-changing methods, also enforce a
 * synchronizer CSRF token (header must match the session's server-side secret).
 * SameSite=Lax cookies already block most cross-site requests; this is defense
 * in depth (PRD §13).
 */
export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  // API-token auth for CLI/automation: a Bearer token matching the API_TOKEN
  // secret (admin), or a token created under Developers (its scopes, checked
  // by requireScope). Bearer tokens aren't sent automatically by browsers, so
  // there's no CSRF surface - we intentionally skip the cookie/CSRF checks here.
  // Opt-in: only active when API_TOKEN is set or a token has been created.
  const bearer = await apiTokenIdentity(c.env, c.req.header("authorization"));
  if (bearer) {
    const adminId = apiTokenAdminId(bearer);
    // One counter per token, so a runaway script or agent is capped without
    // starving the owner's other clients.
    const limit = await hitRateLimit(c.env, `api:${adminId}`, API_TOKEN_RATE_LIMIT_PER_MINUTE);
    if (!limit.allowed) {
      c.header("Retry-After", String(limit.retryAfterSeconds));
      return c.json(
        {
          error: "rate_limited",
          message: `At most ${API_TOKEN_RATE_LIMIT_PER_MINUTE} API calls a minute per token; retry in ${limit.retryAfterSeconds}s.`,
        },
        429,
      );
    }
    c.set("admin", { id: adminId });
    c.set("token", bearer);
    return requireScope(c, next);
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
    email:
      session.identity_kind === "email" ||
      session.identity_kind === "hosted" ||
      session.identity_kind === "hosted_support"
        ? session.identity
        : undefined,
  });

  await touchSession(c.env, session);

  // OpenPing Hosted support (an hour-long hand-off sign-in): no credential or
  // destructive changes, and every change recorded where the customer sees it.
  const method = c.req.method.toUpperCase();
  if (isSupportSession(session) && !SAFE_METHODS.has(method)) {
    const path = c.req.path;
    const json = (c.req.header("content-type") ?? "").includes("json")
      ? await c.req.raw.clone().json().catch(() => undefined)
      : undefined;
    const refused = supportRestriction(method, path, json);
    if (refused) {
      await recordSupportActivity(c.env, { kind: "refused", identity: session.identity, method, path, status: 403 });
      await auditSupportChange(c, { method, path, status: 403, refused });
      return c.json(SUPPORT_RESTRICTED, 403);
    }
    await next();
    const status = c.res.status;
    if (status < 400) {
      await recordSupportActivity(c.env, { kind: "change", identity: session.identity, method, path, status });
      await auditSupportChange(c, { method, path, status });
    }
    return;
  }

  await next();
};
