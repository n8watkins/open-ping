/**
 * How long the account history (`audit_events`) is kept, as the privacy
 * policy says (section 4): two years, then deleted, except the security
 * record of an account that still exists, kept as long as it is: when it was
 * made (and the Terms it accepted), each change of its email, each support
 * sign-in, each time its encryption key was shown, and each sign-in method
 * added or removed.
 *
 * Those rows carry `kept = 1`, set on insert by a trigger (migration 0012);
 * deleting an account clears the mark on its rows, and they then expire two
 * years after they happened, like the rest. The cron's hourly cleanup
 * (`auditCleanup`) deletes in bounded batches over the partial index of
 * unmarked rows, until a batch comes back short or its time is up.
 */

export const AUDIT_KEEP_DAYS = 730;
const DAY_MS = 86_400_000;
/** Rows per statement, so one statement stays short. */
export const AUDIT_DELETE_BATCH = 1_000;
/** One cleanup stops starting new batches after this long, and catches up in the next hour. */
export const AUDIT_CLEANUP_BUDGET_MS = 20_000;

/** The actions kept while their account exists: the trigger's list in migration 0012, exactly (a test checks). */
export const KEPT_ACTIONS = [
  "account.created",
  "account.email_changed",
  "support.handoff_issued",
  "tenant.master_key_revealed",
  "passkey.added",
  "passkey.removed",
  "github.linked",
  "github.unlinked",
] as const;

export const EXPIRED_EVENTS_SQL = `DELETE FROM audit_events WHERE id IN (
  SELECT id FROM audit_events INDEXED BY idx_audit_events_expiring
  WHERE kept = 0 AND at < ?1 LIMIT ${AUDIT_DELETE_BATCH})`;

/**
 * Deletes what has expired, a batch at a time, until a batch is short (all
 * caught up) or `budgetMs` has passed. Answers the rows deleted.
 */
export async function auditCleanup(db: D1Database, now: number, clock: () => number = Date.now, budgetMs = AUDIT_CLEANUP_BUDGET_MS): Promise<number> {
  const before = now - AUDIT_KEEP_DAYS * DAY_MS;
  const start = clock();
  let deleted = 0;
  for (;;) {
    const result = await db.prepare(EXPIRED_EVENTS_SQL).bind(before).run();
    const n = result.meta.changes ?? 0;
    deleted += n;
    if (n < AUDIT_DELETE_BATCH || clock() - start >= budgetMs) return deleted;
  }
}
