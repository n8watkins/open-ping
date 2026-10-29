/**
 * "Sign in again first": what a change that an open inbox alone mustn't
 * make (showing the encryption key, changing the sign-in email, deleting the
 * account) asks of the session. A sign-in from the last 15 minutes, and,
 * when the account has a passkey, a passkey sign-in.
 */

import type { Session } from "./sessions";

export const FRESH_SIGN_IN_MS = 15 * 60_000;

export interface Freshness {
  fresh: boolean;
  /** The account has a passkey, so only a passkey sign-in counts. */
  hasPasskey: boolean;
}

export async function freshSignIn(db: D1Database, session: Session, now: number): Promise<Freshness> {
  const hasPasskey = (await db.prepare("SELECT 1 AS x FROM account_identities WHERE account_id = ? AND kind = 'passkey' LIMIT 1").bind(session.account.id).first()) !== null;
  return { hasPasskey, fresh: now - session.createdAt <= FRESH_SIGN_IN_MS && (!hasPasskey || session.method === "passkey") };
}
