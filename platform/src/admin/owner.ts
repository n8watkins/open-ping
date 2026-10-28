/**
 * Who may use the admin console, and how freshly they must have proved it.
 *
 * The owner is named in config (PLATFORM_OWNERS: account ids or emails),
 * never in code. Being the owner is not enough on its own: the console also
 * wants a session that started with a passkey, which proves the device as
 * well as the inbox, and a recent one before anything changes. Everyone
 * else, signed in or not, gets the platform's ordinary 404, so the console
 * can't be found by trying.
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

export type AdminAccess =
  /** Not the owner, or not signed in: the console doesn't exist. */
  | { kind: "none" }
  /** The owner, without a passkey sign-in in the last ADMIN_SESSION_MAX_AGE_MS. */
  | { kind: "verify"; session: Session }
  /** The owner with a passkey session; `recent` when it allows changes. */
  | { kind: "owner"; session: Session; recent: boolean };

export function adminAccess(session: Session | null, env: Pick<PlatformEnv, "PLATFORM_OWNERS">, now: number): AdminAccess {
  if (!session || !isOwner(session.account, env)) return { kind: "none" };
  const age = now - session.createdAt;
  if (session.method !== "passkey" || age < 0 || age > ADMIN_SESSION_MAX_AGE_MS) return { kind: "verify", session };
  return { kind: "owner", session, recent: age <= ADMIN_REAUTH_MS };
}
