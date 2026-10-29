/**
 * One holder at a time for an account's billing (billing_locks, migration
 * 0006). The webhook takes it before it fetches a subscription and keeps it
 * until the state is saved, and Checkout takes it while it expires the old
 * session and makes the new one. Without it, two deliveries for one
 * subscription could fetch in one order and save in the other, and the
 * stale copy, saved last, would win until the next event.
 *
 * Every write the holder makes checks its token (`holds`), so a holder that
 * stalls past BILLING_LOCK_MS and loses the lock changes nothing.
 */

export const BILLING_LOCK_MS = 60_000;

export interface BillingLock {
  accountId: string;
  token: string;
}

/** Thrown when another holder has the account: the caller answers "try again" (409 to Stripe). */
export class BillingBusyError extends Error {
  constructor(accountId: string) {
    super(`billing for ${accountId} is busy`);
    this.name = "BillingBusyError";
  }
}

/** Thrown when a write finds the lock gone (the holder stalled past it): nothing was changed. */
export class BillingLockLostError extends Error {
  constructor(accountId: string) {
    super(`billing lock for ${accountId} was lost`);
    this.name = "BillingLockLostError";
  }
}

export async function takeBillingLock(db: D1Database, accountId: string, now: number): Promise<BillingLock | null> {
  const token = crypto.randomUUID();
  const taken = await db
    .prepare(
      `INSERT INTO billing_locks (account_id, token, until) VALUES (?1, ?2, ?3)
       ON CONFLICT(account_id) DO UPDATE SET token = excluded.token, until = excluded.until WHERE billing_locks.until <= ?4`,
    )
    .bind(accountId, token, now + BILLING_LOCK_MS, now)
    .run();
  return (taken.meta.changes ?? 0) > 0 ? { accountId, token } : null;
}

export async function releaseBillingLock(db: D1Database, lock: BillingLock): Promise<void> {
  await db.prepare("DELETE FROM billing_locks WHERE account_id = ? AND token = ?").bind(lock.accountId, lock.token).run();
}

/** A WHERE condition true only while `lock` is held; bind HOLDS_BINDS(lock) after the statement's own values. */
export const HOLDS = "EXISTS (SELECT 1 FROM billing_locks WHERE account_id = ? AND token = ?)";
export const holdsBinds = (lock: BillingLock) => [lock.accountId, lock.token] as const;

/** Runs `fn` holding the account's billing lock, or throws BillingBusyError. */
export async function withBillingLock<T>(db: D1Database, accountId: string, now: number, fn: (lock: BillingLock) => Promise<T>): Promise<T> {
  const lock = await takeBillingLock(db, accountId, now);
  if (!lock) throw new BillingBusyError(accountId);
  try {
    return await fn(lock);
  } finally {
    await releaseBillingLock(db, lock).catch((error) => console.error("[billing] lock not released; it expires on its own", error));
  }
}
