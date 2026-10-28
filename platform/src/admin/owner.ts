/**
 * Who may use the admin console, and how freshly they must have proved it.
 *
 * The owner is named in config (PLATFORM_OWNERS: account ids or emails),
 * never in code. Being the owner is not enough on its own: the session must
 * have started with one of the owner's pinned passkeys
 * (PLATFORM_OWNER_PASSKEYS: credential ids), and recently for any change.
 * Pinning is what makes the passkey matter: anyone with the owner's inbox
 * can sign in by email and register a passkey of their own, but only the
 * passkeys named in config open the console. Everyone else, signed in or
 * not, gets the platform's ordinary 404, so the console can't be found by
 * trying.
 */

import { normalizeEmail } from "../accounts";
import type { Session } from "../auth/sessions";
import type { PlatformEnv } from "../env";

/** A passkey sign-in older than this no longer opens the console. */
export const ADMIN_SESSION_MAX_AGE_MS = 12 * 3_600_000;
/** Every change asks for a passkey sign-in at most this old. */
export const ADMIN_REAUTH_MS = 10 * 60_000;

export interface Owners {
  ids: ReadonlySet<string>;
  emails: ReadonlySet<string>;
}

const ACCOUNT_ID_PATTERN = /^acc_[A-Za-z0-9_-]{1,64}$/;

/** PLATFORM_OWNERS, parsed. Anything that is neither an account id nor an email is ignored. */
export function parseOwners(value: string | undefined): Owners {
  const ids = new Set<string>();
  const emails = new Set<string>();
  for (const entry of (value ?? "").split(/[\s,]+/)) {
    if (!entry) continue;
    if (ACCOUNT_ID_PATTERN.test(entry)) ids.add(entry);
    else {
      const email = normalizeEmail(entry);
      if (email) emails.add(email);
    }
  }
  return { ids, emails };
}

export function isOwner(account: { id: string; email: string }, env: Pick<PlatformEnv, "PLATFORM_OWNERS">): boolean {
  const owners = parseOwners(env.PLATFORM_OWNERS);
  return owners.ids.has(account.id) || owners.emails.has(account.email.toLowerCase());
}

/** Credential ids look like base64url; anything else in PLATFORM_OWNER_PASSKEYS is ignored. */
const CREDENTIAL_ID_PATTERN = /^[A-Za-z0-9_-]{16,1366}$/;

export function parsePinnedPasskeys(value: string | undefined): ReadonlySet<string> {
  return new Set((value ?? "").split(/[\s,]+/).filter((id) => CREDENTIAL_ID_PATTERN.test(id)));
}

export type AdminAccess =
  /** Not the owner, or not signed in: the console doesn't exist. */
  | { kind: "none" }
  /**
   * The owner, but not with a pinned passkey in the last
   * ADMIN_SESSION_MAX_AGE_MS: `passkey` when the session isn't a fresh
   * passkey one at all, `unpinned` when its passkey isn't in
   * PLATFORM_OWNER_PASSKEYS (or is no longer on the account).
   */
  | { kind: "verify"; session: Session; reason: "passkey" | "unpinned" }
  /** The owner with a pinned passkey session; `recent` when it allows changes. */
  | { kind: "owner"; session: Session; recent: boolean };

type OwnerEnv = Pick<PlatformEnv, "PLATFORM_OWNERS" | "PLATFORM_OWNER_PASSKEYS">;

/** The session signed in with a pinned passkey of the owner's (not checked: that it is still on the account). */
function pinnedSession(session: Session, env: OwnerEnv): boolean {
  return session.method === "passkey" && session.passkeyCredential !== null && parsePinnedPasskeys(env.PLATFORM_OWNER_PASSKEYS).has(session.passkeyCredential);
}

export async function adminAccess(db: D1Database, session: Session | null, env: OwnerEnv, now: number): Promise<AdminAccess> {
  if (!session || !isOwner(session.account, env)) return { kind: "none" };
  const age = now - session.createdAt;
  if (session.method !== "passkey" || age < 0 || age > ADMIN_SESSION_MAX_AGE_MS) return { kind: "verify", session, reason: "passkey" };
  if (!pinnedSession(session, env)) return { kind: "verify", session, reason: "unpinned" };
  // A pinned passkey the account has since removed no longer counts.
  const onAccount = await db
    .prepare("SELECT 1 AS hit FROM account_identities WHERE account_id = ? AND kind = 'passkey' AND subject = ?")
    .bind(session.account.id, session.passkeyCredential)
    .first();
  if (!onAccount) return { kind: "verify", session, reason: "unpinned" };
  return { kind: "owner", session, recent: age <= ADMIN_REAUTH_MS };
}

/** True when any of the account's passkeys is pinned in PLATFORM_OWNER_PASSKEYS. */
export async function hasPinnedPasskey(db: D1Database, accountId: string, env: OwnerEnv): Promise<boolean> {
  const pinned = parsePinnedPasskeys(env.PLATFORM_OWNER_PASSKEYS);
  if (!pinned.size) return false;
  const rows = await db.prepare("SELECT subject FROM account_identities WHERE account_id = ? AND kind = 'passkey'").bind(accountId).all<{ subject: string }>();
  return rows.results.some((r) => pinned.has(r.subject));
}

/**
 * Whether this session may add or remove passkeys. Anyone may on their own
 * account, except the owner once a passkey of theirs is pinned: then only a
 * pinned passkey sign-in from the last ADMIN_REAUTH_MS may, so whoever holds
 * the inbox can't swap the owner's passkeys. Before anything is pinned the
 * owner adds their first passkey like anyone else (the bootstrap).
 */
export async function mayChangePasskeys(db: D1Database, session: Session, env: OwnerEnv, now: number): Promise<boolean> {
  if (!isOwner(session.account, env)) return true;
  if (!(await hasPinnedPasskey(db, session.account.id, env))) return true;
  const age = now - session.createdAt;
  return pinnedSession(session, env) && age >= 0 && age <= ADMIN_REAUTH_MS;
}
