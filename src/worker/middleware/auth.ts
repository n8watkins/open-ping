import type { MiddlewareHandler } from "hono";
import type { AppEnv, Env } from "../types";
import { findApiToken } from "../db/api-tokens";
import { CSRF_HEADER, getSession, touchSession } from "../lib/sessions";
import { timingSafeEqual } from "../lib/timing";
import { SUPPORT_RESTRICTED, auditSupportChange, isSupportSession, recordSupportActivity, supportRestriction } from "../lib/support";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Who a valid bearer token is: the API_TOKEN secret, or a stored token by id. */
export type ApiTokenIdentity = { kind: "secret" } | { kind: "stored"; id: string; name: string };

/**
 * Who `authorization` (`Bearer <token>`) authenticates as, or null: the
 * API_TOKEN secret (compared in constant time), or a token created under
 * Developers (looked up by its SHA-256 hash, db/api-tokens.ts). The one bearer
 * check behind the REST API's requireAuth and the /mcp endpoint.
 */
export async function apiTokenIdentity(
  env: Env,
  authorization: string | undefined,
): Promise<ApiTokenIdentity | null> {
  if (!authorization || !/^bearer\s+/i.test(authorization)) return null;
  const bearer = authorization.replace(/^bearer\s+/i, "").trim();
  if (!bearer) return null;
  if (env.API_TOKEN && (await timingSafeEqual(bearer, env.API_TOKEN))) return { kind: "secret" };
  const stored = await findApiToken(env, bearer);
  return stored ? { kind: "stored", id: stored.id, name: stored.name } : null;
}

/** The admin id requireAuth records for a bearer token. */
export function apiTokenAdminId(who: ApiTokenIdentity): string {
  return who.kind === "secret" ? "api-token" : `api-token:${who.id}`;
}

/**
 * Require an authenticated session. For state-changing methods, also enforce a
 * synchronizer CSRF token (header must match the session's server-side secret).
 * SameSite=Lax cookies already block most cross-site requests; this is defense
 * in depth (PRD §13).
 */
export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  // API-token auth for CLI/automation: a Bearer token matching the API_TOKEN
  // secret, or a token created under Developers, grants admin. Bearer tokens
  // aren't sent automatically by browsers, so there's no CSRF surface - we
  // intentionally skip the cookie/CSRF checks here.
  // Opt-in: only active when API_TOKEN is set or a token has been created.
  const bearer = await apiTokenIdentity(c.env, c.req.header("authorization"));
  if (bearer) {
    c.set("admin", { id: apiTokenAdminId(bearer) });
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
