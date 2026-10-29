/**
 * The lifecycle jobs (build plan, B7; decisions D8 and D11): what happens
 * to a tenant as time passes, from the cron, every few minutes.
 *
 *   welcome             once its OpenPing is ready
 *   trial ending        3 days and 1 day before the trial ends
 *   payment failed      once each time billing has it past due
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
  paymentFailedEmail,
  suspendedEmail,
  trialEndingEmail,
  welcomeEmail,
  type RenderedEmail,
} from "../emails";
import { appOrigin, tenantOrigin } from "../hosts";
import { PLATFORM_REPLY_TO, type Mailer } from "../mail";
import { runProvisioning, type ProvisioningDeps } from "../provisioning";
import { forgetTenant, hostedUrls } from "../tenants";
import type { BillingTenant, BillingView } from "./billing-view";
import { OPEN_EXPORTS_SQL, advanceExport, expireExports, exportIsStored, latestExport, requestExport, type ExportDeps, type ExportOutcome } from "./exports";

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

export type NoticeKind = "welcome" | "trial_ending_3" | "trial_ending_1" | "payment_failed" | "suspended" | "deletion_warning";

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

/** When the warning for this suspension went out, or null. */
async function warnedAt(db: D1Database, tenantId: string, cycle: string): Promise<number | null> {
  const row = await db
    .prepare("SELECT sent_at FROM lifecycle_notices WHERE tenant_id = ? AND kind = 'deletion_warning' AND cycle = ?")
    .bind(tenantId, cycle)
    .first<{ sent_at: number }>();
  return row?.sent_at ?? null;
}

/** When a suspended tenant is deleted: 30 days after the suspension, and never sooner than a week after its warning. */
export function deletionTime(suspendedAt: number, warningSentAt: number | null): number | null {
  if (warningSentAt === null) return null;
  return Math.max(suspendedAt + DELETE_AFTER_MS, warningSentAt + WARNING_BEFORE_MS);
}

export async function lifecycleTick(deps: LifecycleDeps): Promise<LifecycleReport> {
  const now = deps.now ?? Date.now;
  const db = deps.db;
  const report: LifecycleReport = { sent: {}, exports: [], deleted: [], waiting: [], expired: 0 };
  const app = appOrigin(deps.hostedDomain);
  const links = (t: BillingTenant) => ({ tenantUrl: tenantOrigin(t.slug, deps.hostedDomain), ...hostedUrls(t.slug, deps.hostedDomain), exportUrl: `${app}/account/export` });

  /** Claims the notice, sends it, and drops the claim when the send fails. */
  async function notice(t: BillingTenant, kind: NoticeKind, cycle: string, render: () => RenderedEmail): Promise<boolean> {
    if (!deps.mailer) return false;
    const claimed = await db
      .prepare("INSERT INTO lifecycle_notices (tenant_id, kind, cycle, sent_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING")
      .bind(t.tenantId, kind, cycle, now())
      .run();
    if ((claimed.meta.changes ?? 0) === 0) return false;
    const email = render();
    const result = await deps.mailer.send({
      to: t.email,
      ...email,
      category: kind,
      tenantId: t.tenantId,
      replyTo: PLATFORM_REPLY_TO,
      idempotencyKey: `lifecycle-${t.tenantId}-${kind}-${cycle}`,
    });
    if (!result.ok) {
      await db.prepare("DELETE FROM lifecycle_notices WHERE tenant_id = ? AND kind = ? AND cycle = ?").bind(t.tenantId, kind, cycle).run();
      console.error("[lifecycle] email not sent", { tenant: t.tenantId, kind, error: result.error });
      return false;
    }
    report.sent[kind] = (report.sent[kind] ?? 0) + 1;
    await audit(db, t, "lifecycle.email_sent", { kind }, now());
    return true;
  }

  // --- Emails ---------------------------------------------------------------

  for (const t of await deps.billing.newlyReady(now() - WELCOME_WINDOW_MS, BATCH)) {
    if (t.status === "suspended") continue;
    await notice(t, "welcome", "once", () =>
      welcomeEmail({ tenantUrl: links(t).tenantUrl, trialEndsAt: t.status === "trial" ? t.trialEndsAt : null, monitors: PLAN_LIMITS.trial.monitors }),
    );
  }

  for (const t of await deps.billing.trialsEnding(now(), now() + TRIAL_NOTICE_DAYS[0] * DAY, BATCH)) {
    const left = t.trialEndsAt! - now();
    // Only the nearer one when both are due (a trial that began less than 3 days before its end, or a late run).
    const days = left <= TRIAL_NOTICE_DAYS[1] * DAY ? 1 : 3;
    await notice(t, days === 1 ? "trial_ending_1" : "trial_ending_3", String(t.trialEndsAt), () =>
      trialEndingEmail({ tenantUrl: links(t).tenantUrl, endsAt: t.trialEndsAt!, daysLeft: days, upgradeUrl: links(t).upgrade, deleteAfterDays: DELETE_AFTER_MS / DAY }),
    );
  }

  // A tenant no longer past due may fail again later: that is a new email.
  await db.prepare("DELETE FROM lifecycle_notices WHERE kind = 'payment_failed' AND tenant_id NOT IN (SELECT id FROM tenants WHERE status = 'past_due')").run();
  for (const t of await deps.billing.pastDue(BATCH)) {
    await notice(t, "payment_failed", "current", () => paymentFailedEmail({ tenantUrl: links(t).tenantUrl, billingUrl: links(t).billing, suspendAt: null }));
  }

  const suspended = await deps.billing.suspended(BATCH);
  for (const t of suspended) {
    const cycle = String(t.suspendedAt);
    const reason = await deps.billing.suspensionReason(t);
    await notice(t, "suspended", cycle, () =>
      suspendedEmail({ tenantUrl: links(t).tenantUrl, reason, billingUrl: links(t).billing, accountUrl: links(t).exportUrl, deleteAt: t.suspendedAt! + DELETE_AFTER_MS }),
    );
    if (now() >= t.suspendedAt! + DELETE_AFTER_MS - WARNING_BEFORE_MS) {
      const deleteAt = Math.max(t.suspendedAt! + DELETE_AFTER_MS, now() + WARNING_BEFORE_MS);
      await notice(t, "deletion_warning", cycle, () =>
        deletionWarningEmail({ tenantUrl: links(t).tenantUrl, deleteAt, billingUrl: links(t).billing, accountUrl: links(t).exportUrl }),
      );
    }
  }

  // --- Exports, and the deletions waiting on them ---------------------------

  if (deps.exports) {
    const exportDeps: ExportDeps = { ...deps.exports, db, now };
    for (const t of suspended) {
      const due = deletionTime(t.suspendedAt!, await warnedAt(db, t.tenantId, String(t.suspendedAt)));
      if (due === null) {
        if (now() >= t.suspendedAt! + DELETE_AFTER_MS) report.waiting.push({ tenantId: t.tenantId, why: "its deletion warning hasn't gone out yet" });
        continue;
      }
      if (now() < due) continue;
      const exp = await latestExport(db, t.tenantId, "deletion", t.suspendedAt!);
      if (!exp || (exp.state === "failed" && now() - (exp.finishedAt ?? exp.createdAt) >= EXPORT_RETRY_AFTER_MS)) {
        await requestExport(db, { tenantId: t.tenantId, accountId: t.accountId, slug: t.slug, reason: "deletion", now: now() });
        report.waiting.push({ tenantId: t.tenantId, why: "its export has just been asked for" });
        continue;
      }
      if (exp.state === "failed") {
        report.waiting.push({ tenantId: t.tenantId, why: `its export failed: ${exp.error ?? "no reason"}` });
        continue;
      }
      if (exp.state !== "done") {
        report.waiting.push({ tenantId: t.tenantId, why: "its export is running" });
        continue;
      }
      // Done on the row isn't enough: the files must be in the bucket.
      if (!(await exportIsStored(deps.exports.bucket, exp))) {
        await db.prepare("UPDATE tenant_exports SET state = 'failed', error = 'its files are missing from the bucket', finished_at = ? WHERE id = ?").bind(now(), exp.id).run();
        report.waiting.push({ tenantId: t.tenantId, why: "its export's files are missing" });
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
      // The teardown; if it fails, provisioning's sweep keeps retrying it.
      await runProvisioning(deps.provisioning, t.tenantId, { force: true }).catch((error) => console.error("[lifecycle] teardown failed", { tenant: t.tenantId }, error));
      report.deleted.push(t.tenantId);
    }

    const open = await db.prepare(OPEN_EXPORTS_SQL).bind(now(), 10).all<{ id: string }>();
    for (const { id } of open.results) {
      const row = await db.prepare("SELECT slug FROM tenant_exports WHERE id = ?").bind(id).first<{ slug: string }>();
      report.exports.push(
        await advanceExport(exportDeps, id, { tenantUrl: tenantOrigin(row?.slug ?? "", deps.hostedDomain), accountUrl: `${app}/account/export` }),
      );
    }
    report.expired = await expireExports(exportDeps);
  }

  for (const w of report.waiting) console.warn("[lifecycle] deletion waiting", w);
  return report;
}
