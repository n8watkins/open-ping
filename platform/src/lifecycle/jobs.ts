/**
 * The lifecycle jobs (build plan, B7; decisions D8 and D11): what happens
 * to a tenant as time passes, from the cron, every few minutes.
 *
 *   welcome             once its OpenPing is ready
 *   trial ending        3 days and 1 day before the trial ends
 *   (a failed payment is billing's email: src/billing/webhook.ts)
 *   suspended           once each time billing suspends it (the trial
 *                       ended unpaid, or the payment lapsed); its checks
 *                       stop and its pages go offline (billing, B5, does that)
 *   deletion warning    a week before deletion
 *   deletion            30 days after billing suspended it, and at least a
 *                       week after the warning went out: an export of its
 *                       database to R2 first, and only once that export is
 *                       done and read back from the bucket, the teardown
 *
 * Nothing is deleted without its export: a deletion whose export fails
 * waits, tries a new export later, and is in the audit log for the owner.
 * A tenant billing lets go of (a payment) leaves the suspended list, so its
 * clock stops by itself. The owner's own suspension never deletes anything.
 *
 * Every email is claimed in lifecycle_notices before it is sent, and the
 * claim is dropped if the send fails, so each goes out once; the mail
 * provider's idempotency key covers a send whose answer was lost.
 */

import { PLAN_LIMITS } from "../../../src/shared/hosted-contract";
import {
  deletionWarningEmail,
  suspendedEmail,
  trialEndingEmail,
  welcomeEmail,
  type RenderedEmail,
} from "../emails";
import { appOrigin, tenantOrigin } from "../hosts";
import { PLATFORM_REPLY_TO, type Mailer } from "../mail";
import { runProvisioning, type ProvisioningDeps } from "../provisioning";
import { forgetTenant, hostedUrls } from "../tenants";
import type { BillingTenant, BillingView, Unnotified } from "./billing-view";
import { OPEN_EXPORTS_SQL, advanceExport, expireExports, exportVerificationProblem, latestExport, requestExport, type ExportDeps, type ExportOutcome } from "./exports";
import { log } from "../log";

const DAY = 86_400_000;
/** Decision D8: data is kept this long after billing suspends a tenant. */
export const DELETE_AFTER_MS = 30 * DAY;
/** The deletion warning goes out this long before, and deletion waits at least this long after it. */
export const WARNING_BEFORE_MS = 7 * DAY;
/** Trial emails, days before the end. */
export const TRIAL_NOTICE_DAYS = [3, 1] as const;
/** A tenant ready longer ago than this gets no welcome (one that was ready before the welcome existed). */
export const WELCOME_WINDOW_MS = 7 * DAY;
/** A deletion whose export failed starts a new one after this long. */
export const EXPORT_RETRY_AFTER_MS = 6 * 3_600_000;
/** The cron runs the jobs every this many minutes. */
export const LIFECYCLE_EVERY_MINUTES = 5;
/** Tenants each kind of job looks at per run. */
const BATCH = 50;

export type NoticeKind = "welcome" | "trial_ending_3" | "trial_ending_1" | "suspended" | "deletion_warning";

export interface LifecycleDeps {
  db: D1Database;
  billing: BillingView;
  /** The platform's mailer, or null while mail is off (then no email is claimed, and none is lost). */
  mailer: Mailer | null;
  hostedDomain: string;
  /** Exports and the teardown need Cloudflare; null while provisioning's settings are missing. */
  exports: Omit<ExportDeps, "db" | "now"> | null;
  provisioning: ProvisioningDeps | null;
  now?: () => number;
}

export interface LifecycleReport {
  sent: Partial<Record<NoticeKind, number>>;
  exports: ExportOutcome[];
  deleted: string[];
  /** Deletions due but waiting: for the export, or for the warning to have gone out a week before. */
  waiting: { tenantId: string; why: string }[];
  expired: number;
}

async function audit(db: D1Database, tenant: Pick<BillingTenant, "tenantId" | "accountId">, action: string, detail: Record<string, unknown>, now: number) {
  await db
    .prepare("INSERT INTO audit_events (at, account_id, tenant_id, actor, action, detail) VALUES (?, ?, ?, 'system', ?, ?)")
    .bind(now, tenant.accountId, tenant.tenantId, action, JSON.stringify(detail))
    .run();
}

/** A claim older than this was left by a run that died before the mail provider answered; it is taken again. */
export const NOTICE_CLAIM_STALE_MS = 10 * 60_000;
/** How long one lifecycle run holds its lock (longer than a run takes, short enough that a dead one frees it). */
export const LIFECYCLE_LOCK_MS = 10 * 60_000;

/** When a suspended tenant is deleted: 30 days after the suspension, and never sooner than a week after its warning was sent. */
export function deletionTime(suspendedAt: number, warningSentAt: number | null): number | null {
  if (warningSentAt === null) return null;
  return Math.max(suspendedAt + DELETE_AFTER_MS, warningSentAt + WARNING_BEFORE_MS);
}

/**
 * One run of the jobs, under a lock, so the cron's overlapping minutes never
 * run two at once (two exports of one tenant, two claims of one email).
 * Answers null when another run holds the lock.
 */
export async function lifecycleTick(deps: LifecycleDeps): Promise<LifecycleReport | null> {
  const now = deps.now ?? Date.now;
  const token = crypto.randomUUID();
  const locked = await deps.db
    .prepare(
      `INSERT INTO lifecycle_locks (name, until, token) VALUES ('tick', ?1, ?2)
       ON CONFLICT(name) DO UPDATE SET until = excluded.until, token = excluded.token WHERE lifecycle_locks.until <= ?3`,
    )
    .bind(now() + LIFECYCLE_LOCK_MS, token, now())
    .run();
  if ((locked.meta.changes ?? 0) === 0) return null;
  try {
    return await runJobs(deps);
  } finally {
    await deps.db.prepare("DELETE FROM lifecycle_locks WHERE name = 'tick' AND token = ?").bind(token).run();
  }
}

async function runJobs(deps: LifecycleDeps): Promise<LifecycleReport> {
  const now = deps.now ?? Date.now;
  const db = deps.db;
  const report: LifecycleReport = { sent: {}, exports: [], deleted: [], waiting: [], expired: 0 };
  const app = appOrigin(deps.hostedDomain);
  const links = (t: BillingTenant) => ({ tenantUrl: tenantOrigin(t.slug, deps.hostedDomain), ...hostedUrls(t.slug, deps.hostedDomain), exportUrl: `${app}/account/export` });
  const skip = (kind: NoticeKind, cycle: Unnotified["cycle"]): Unnotified => ({ kind, cycle, staleBefore: now() - NOTICE_CLAIM_STALE_MS });

  /**
   * Claims the notice as sending (or takes over a dead run's stale claim),
   * sends it, and marks it sent once the provider took it; a failed send
   * drops the claim, so the next run tries again.
   */
  async function notice(t: BillingTenant, kind: NoticeKind, cycle: string, render: () => RenderedEmail): Promise<boolean> {
    if (!deps.mailer) return false;
    const claimed = await db
      .prepare(
        `INSERT INTO lifecycle_notices (tenant_id, kind, cycle, state, claimed_at) VALUES (?1, ?2, ?3, 'sending', ?4)
         ON CONFLICT (tenant_id, kind, cycle) DO UPDATE SET claimed_at = excluded.claimed_at
         WHERE lifecycle_notices.state = 'sending' AND lifecycle_notices.claimed_at < ?5`,
      )
      .bind(t.tenantId, kind, cycle, now(), now() - NOTICE_CLAIM_STALE_MS)
      .run();
    if ((claimed.meta.changes ?? 0) === 0) return false;
    const email = render();
    const result = await deps.mailer.send({
      to: t.email,
      ...email,
      category: kind,
      tenantId: t.tenantId,
      replyTo: PLATFORM_REPLY_TO,
      // A retaken claim whose first send did go out is one email at Resend.
      idempotencyKey: `lifecycle-${t.tenantId}-${kind}-${cycle}`,
    });
    if (!result.ok) {
      await db.prepare("DELETE FROM lifecycle_notices WHERE tenant_id = ? AND kind = ? AND cycle = ? AND state = 'sending'").bind(t.tenantId, kind, cycle).run();
      log.error("lifecycle.email_not_sent", { tenant: t.tenantId, kind, error: result.error });
      return false;
    }
    await db.prepare("UPDATE lifecycle_notices SET state = 'sent', sent_at = ? WHERE tenant_id = ? AND kind = ? AND cycle = ?").bind(now(), t.tenantId, kind, cycle).run();
    report.sent[kind] = (report.sent[kind] ?? 0) + 1;
    log.info("lifecycle.email_sent", { tenant: t.tenantId, kind });
    await audit(db, t, "lifecycle.email_sent", { kind }, now());
    return true;
  }

  // --- Emails ---------------------------------------------------------------

  for (const t of await deps.billing.newlyReady(now() - WELCOME_WINDOW_MS, BATCH, skip("welcome", "once"))) {
    await notice(t, "welcome", "once", () =>
      welcomeEmail({ tenantUrl: links(t).tenantUrl, trialEndsAt: t.status === "trial" ? t.trialEndsAt : null, monitors: PLAN_LIMITS.trial.monitors }),
    );
  }

  // The 1-day email first, then the 3-day one for trials further out, each
  // list leaving out the tenants that already have theirs.
  const oneDay = await deps.billing.trialsEnding(now(), now() + TRIAL_NOTICE_DAYS[1] * DAY, BATCH, skip("trial_ending_1", "trial_ends_at"));
  const threeDays = (await deps.billing.trialsEnding(now() + TRIAL_NOTICE_DAYS[1] * DAY, now() + TRIAL_NOTICE_DAYS[0] * DAY, BATCH, skip("trial_ending_3", "trial_ends_at"))).map(
    (t) => ({ t, days: 3 as const }),
  );
  for (const { t, days } of [...oneDay.map((t) => ({ t, days: 1 as const })), ...threeDays]) {
    await notice(t, days === 1 ? "trial_ending_1" : "trial_ending_3", String(t.trialEndsAt), () =>
      trialEndingEmail({ tenantUrl: links(t).tenantUrl, endsAt: t.trialEndsAt!, daysLeft: days, upgradeUrl: links(t).upgrade, deleteAfterDays: DELETE_AFTER_MS / DAY }),
    );
  }

  // A failed payment is billing's to tell (src/billing/webhook.ts emails it
  // with Stripe's next try, once per invoice and attempt), so lifecycle doesn't.

  for (const t of await deps.billing.suspended(now(), BATCH, skip("suspended", "suspended_at"))) {
    const reason = await deps.billing.suspensionReason(t);
    await notice(t, "suspended", String(t.suspendedAt), () =>
      suspendedEmail({ tenantUrl: links(t).tenantUrl, reason, billingUrl: links(t).billing, accountUrl: links(t).exportUrl, deleteAt: t.suspendedAt! + DELETE_AFTER_MS }),
    );
  }

  for (const t of await deps.billing.suspended(now() - (DELETE_AFTER_MS - WARNING_BEFORE_MS), BATCH, skip("deletion_warning", "suspended_at"))) {
    const deleteAt = Math.max(t.suspendedAt! + DELETE_AFTER_MS, now() + WARNING_BEFORE_MS);
    await notice(t, "deletion_warning", String(t.suspendedAt), () =>
      deletionWarningEmail({ tenantUrl: links(t).tenantUrl, deleteAt, billingUrl: links(t).billing, accountUrl: links(t).exportUrl }),
    );
  }

  // --- Exports, and the deletions waiting on them ---------------------------

  if (deps.exports) {
    const exportDeps: ExportDeps = { ...deps.exports, db, now };
    // Past their 30 days, warned a week or more ago, and not waiting on an export.
    const due = await deps.billing.dueForDeletion(now() - DELETE_AFTER_MS, now() - WARNING_BEFORE_MS, now() - EXPORT_RETRY_AFTER_MS, BATCH);
    for (const t of due) {
      const exp = await latestExport(db, t.tenantId, "deletion", t.suspendedAt!);
      if (!exp || exp.state === "failed") {
        if (exp) await audit(db, t, "lifecycle.export_retried", { previous: exp.id, error: exp.error }, now());
        await requestExport(db, { tenantId: t.tenantId, accountId: t.accountId, slug: t.slug, reason: "deletion", now: now() });
        report.waiting.push({ tenantId: t.tenantId, why: exp ? `its export failed (${exp.error ?? "no reason"}); a new one has been asked for` : "its export has just been asked for" });
        continue;
      }
      // Done on the row isn't enough: the files must read back as the same OpenPing dump.
      const problem = await exportVerificationProblem(db, deps.exports.bucket, exp);
      if (problem) {
        await db.prepare("UPDATE tenant_exports SET state = 'failed', error = ?, finished_at = ? WHERE id = ?").bind(problem, now(), exp.id).run();
        await audit(db, t, "lifecycle.export_failed", { export: exp.id, error: problem }, now());
        report.waiting.push({ tenantId: t.tenantId, why: `its export can't be trusted: ${problem}` });
        continue;
      }
      if (!deps.provisioning) {
        report.waiting.push({ tenantId: t.tenantId, why: "provisioning is off" });
        continue;
      }
      // Still suspended by billing, by this same suspension: a payment that
      // landed a moment ago wins, and nothing is marked.
      const marked = await db
        .prepare(
          `UPDATE tenants SET provision_state = 'deleting', provision_attempts = 0, provision_error = NULL, provision_next_at = NULL,
             provision_paused_at = NULL, updated_at = ?1
           WHERE id = ?2 AND status = 'suspended' AND suspended_at = ?3 AND provision_state <> 'deleting'`,
        )
        .bind(now(), t.tenantId, t.suspendedAt)
        .run();
      if ((marked.meta.changes ?? 0) === 0) continue;
      forgetTenant(t.slug);
      await audit(db, t, "tenant.deletion_started", { export: exp.id, suspendedAt: t.suspendedAt, bytes: exp.bytes }, now());
      // The teardown deletes the escrowed key; the export keeps its own copy (export_keys).
      await runProvisioning(deps.provisioning, t.tenantId, { force: true }).catch((error) => log.error("lifecycle.teardown_failed", { tenant: t.tenantId, error }));
      report.deleted.push(t.tenantId);
    }

    // Suspended past their time but not warned yet (mail was off): said, so the owner sees it.
    const unwarned = await db
      .prepare(
        `SELECT t.id FROM tenants t WHERE t.status = 'suspended' AND t.suspended_at <= ? AND t.provision_state <> 'deleting'
           AND NOT EXISTS (SELECT 1 FROM lifecycle_notices n WHERE n.tenant_id = t.id AND n.kind = 'deletion_warning' AND n.cycle = CAST(t.suspended_at AS TEXT) AND n.state = 'sent')
         LIMIT ?`,
      )
      .bind(now() - DELETE_AFTER_MS, BATCH)
      .all<{ id: string }>();
    for (const r of unwarned.results) report.waiting.push({ tenantId: r.id, why: "its deletion warning hasn't gone out yet" });

    const open = await db.prepare(OPEN_EXPORTS_SQL).bind(now(), 10).all<{ id: string }>();
    for (const { id } of open.results) {
      const row = await db.prepare("SELECT slug FROM tenant_exports WHERE id = ?").bind(id).first<{ slug: string }>();
      const outcome = await advanceExport(exportDeps, id, { tenantUrl: tenantOrigin(row?.slug ?? "", deps.hostedDomain), accountUrl: `${app}/account/export` });
      report.exports.push(outcome);
      if (outcome.kind === "failed") log.error("lifecycle.export_failed", { ...outcome });
    }
    report.expired = await expireExports(exportDeps);
  }

  for (const w of report.waiting) log.warn("lifecycle.deletion_waiting", { ...w });
  return report;
}
