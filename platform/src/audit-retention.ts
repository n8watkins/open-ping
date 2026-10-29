/**
 * How long the account history (`audit_events`) is kept, as the privacy
 * policy says (section 4): two years, then deleted, except the security
 * record of an account that still exists, which is kept as long as it is:
 * when it was made (and the Terms it accepted), each support sign-in, each
 * time its encryption key was shown, and each sign-in method added or
 * removed. Once that account is gone, those go too, two years after they
 * happened.
 *
 * The cron runs `auditCleanup` hourly: a bounded delete over the partial
 * index of expiring rows (migration 0012), and once a day the kept rows of
 * accounts that no longer exist.
 */

export const AUDIT_KEEP_DAYS = 730;
const DAY_MS = 86_400_000;
/** At most this many rows per statement, so one run stays short however far behind it is. */
export const AUDIT_DELETE_BATCH = 1_000;

/** The actions kept while their account exists. The migration's partial indexes repeat this list exactly. */
export const KEPT_ACTIONS = [
  "account.created",
  "support.handoff_issued",
  "tenant.master_key_revealed",
  "passkey.added",
  "passkey.removed",
  "github.linked",
  "github.unlinked",
] as const;

const KEPT_ACTIONS_SQL = `(${KEPT_ACTIONS.map((a) => `'${a}'`).join(", ")})`;

export const EXPIRED_EVENTS_SQL = `DELETE FROM audit_events WHERE id IN (
  SELECT id FROM audit_events INDEXED BY idx_audit_events_expiring
  WHERE at < ?1 AND action NOT IN ${KEPT_ACTIONS_SQL} LIMIT ${AUDIT_DELETE_BATCH})`;

export const ORPHANED_KEPT_EVENTS_SQL = `DELETE FROM audit_events WHERE id IN (
  SELECT e.id FROM audit_events e INDEXED BY idx_audit_events_kept
  WHERE e.at < ?1 AND e.action IN ${KEPT_ACTIONS_SQL}
    AND (e.account_id IS NULL OR NOT EXISTS (SELECT 1 FROM accounts a WHERE a.id = e.account_id))
  LIMIT ${AUDIT_DELETE_BATCH})`;

/** The statements for this hour: the expired rows always, the kept rows of accounts gone once a day (03:07 UTC). */
export function auditCleanup(db: D1Database, now: number): D1PreparedStatement[] {
  const before = now - AUDIT_KEEP_DAYS * DAY_MS;
  const statements = [db.prepare(EXPIRED_EVENTS_SQL).bind(before)];
  if (new Date(now).getUTCHours() === 3) statements.push(db.prepare(ORPHANED_KEPT_EVENTS_SQL).bind(before));
  return statements;
}
