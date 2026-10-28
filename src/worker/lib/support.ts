import type { Context } from "hono";
import type { AppEnv, Env, SessionRow } from "../types";
import { HOSTED_ERRORS } from "../../shared/hosted-contract";

/**
 * What a support sign-in may do (docs/hosted/CONTRACT.md, section 7).
 *
 * When the owner of OpenPing Hosted signs in to a customer's OpenPing to help
 * (an `hosted_support` session, one hour), they can look at everything and
 * fix monitors, pages and channels, but nothing that changes who can sign in
 * or that can't be undone: those stay the customer's. Every change support
 * makes, and every one refused, is kept in `support_activity` (migration
 * 0021), which the customer sees in Settings > Sign-in & security, and is
 * reported to the platform's audit log too.
 */

/** The answer to a refused change, for the app to show as is. */
export const SUPPORT_RESTRICTED = {
  error: HOSTED_ERRORS.supportRestricted,
  message: "A support sign-in can't do this. The account owner can, from their own sign-in.",
} as const;

/** Settings support may not change: where the install lives, who mail comes from, how long history is kept. */
const RESTRICTED_SETTINGS = new Set(["app_url", "email_from", "vapid_subject", "retention"]);

/** Paths (under /api) where support may change nothing at all. */
const RESTRICTED_PREFIXES = [
  "/api/passkeys", // the customer's own passkeys
  "/api/api-tokens", // tokens that act as the customer
  "/api/admin/rekey", // the encryption key
  "/api/data", // import (replaces data)
  "/api/push/generate-vapid", // push keys
];

/** Exactly these paths are refused too. */
const RESTRICTED_PATHS = new Set([
  "/api/auth/logout-all", // signs every one of the customer's sessions out
]);

/**
 * Why support may not make this change, or null when it may. `body` is the
 * request's JSON when it has one (only settings look at it).
 */
export function supportRestriction(method: string, path: string, body: unknown): string | null {
  const m = method.toUpperCase();
  // Deleting anything can't be undone by support.
  if (m === "DELETE") return "delete";
  if (RESTRICTED_PATHS.has(path)) return "sessions";
  if (RESTRICTED_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`))) return "credentials";
  if (path === "/api/settings") {
    const settings = body && typeof body === "object" ? (body as { settings?: unknown }).settings : undefined;
    if (settings && typeof settings === "object") {
      const keys = Object.keys(settings as Record<string, unknown>);
      const hit = keys.find((k) => RESTRICTED_SETTINGS.has(k));
      if (hit) return `setting:${hit}`;
    }
  }
  return null;
}

export const isSupportSession = (session: Pick<SessionRow, "identity_kind"> | undefined) => session?.identity_kind === "hosted_support";

export type SupportActivityKind = "signed_in" | "change" | "refused";

export interface SupportActivity {
  id: number;
  at: number;
  kind: SupportActivityKind;
  identity: string;
  method: string | null;
  path: string | null;
  status: number | null;
}

/** Ids in a path are kept (they say what changed); anything past 200 characters isn't. */
const shortPath = (path: string) => path.slice(0, 200);

/** Records one row in the customer's support log. Never throws: a failed write is logged. */
export async function recordSupportActivity(
  env: Env,
  row: { kind: SupportActivityKind; identity: string; method?: string; path?: string; status?: number },
): Promise<void> {
  try {
    await env.DB.prepare("INSERT INTO support_activity (at, kind, identity, method, path, status) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(Date.now(), row.kind, row.identity, row.method ?? null, row.path ? shortPath(row.path) : null, row.status ?? null)
      .run();
  } catch (error) {
    console.error("[support] could not record support activity", error);
  }
}

/** The latest support activity, newest first, for Settings. */
export async function listSupportActivity(env: Env, limit = 50): Promise<SupportActivity[]> {
  const { results } = await env.DB.prepare(
    "SELECT id, at, kind, identity, method, path, status FROM support_activity ORDER BY id DESC LIMIT ?",
  )
    .bind(limit)
    .all<SupportActivity>();
  return results ?? [];
}

/**
 * Reports a support change (or refusal) to the platform's audit log as
 * well, through this request's capability. Best effort: the tenant's own
 * row is the record the customer sees.
 */
export async function auditSupportChange(
  c: Context<AppEnv>,
  detail: { method: string; path: string; status: number; refused?: string },
): Promise<void> {
  const platform = c.get("hosted")?.platform;
  if (!platform) return;
  try {
    await platform.audit({
      action: detail.refused ? "support.refused" : "support.change",
      actor: "support",
      detail: { method: detail.method, path: shortPath(detail.path), status: detail.status, ...(detail.refused ? { reason: detail.refused } : {}) },
      at: Date.now(),
    });
  } catch (error) {
    console.error("[support] could not report a support change to the platform", error);
  }
}
