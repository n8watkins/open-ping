/**
 * The OpenPing Hosted platform Worker (docs/HOSTED_BUILD_PLAN.md, B1).
 *
 * `fetch` routes by hostname (src/app.ts). `TenantPlatform` is the capability
 * each customer's OpenPing receives as `props.platform`: ctx.exports makes a
 * stub of it bound to one tenant, so the customer's code can call it but can't
 * point it at anyone else (docs/hosted/CONTRACT.md, section 4).
 */

import { WorkerEntrypoint } from "cloudflare:workers";

import type {
  HostedAuditEvent,
  HostedEmail,
  PlatformCapability,
  SendEmailResult,
  UsageCounts,
} from "../../src/shared/hosted-contract";
import { createApp } from "./app";
import { endTrials } from "./billing/state";
import { auditCleanup } from "./audit-retention";
import { billingRecordsCleanup } from "./billing/webhook";
import { ceremonyCleanup } from "./auth/ceremonies";
import { emailSignInCleanup } from "./auth/email-sign-in";
import { rateLimitCleanup } from "./auth/rate-limit";
import { sessionCleanup } from "./auth/sessions";
import { TenantCapability, emailUsageCleanup, tenantMailFromEnv } from "./capability";
import { NamespaceDispatcher } from "./dispatch";
import type { PlatformEnv } from "./env";
import { mailerFromEnv } from "./mail";
import { lifecycleDepsFromEnv } from "./lifecycle/env";
import { LIFECYCLE_EVERY_MINUTES, lifecycleTick } from "./lifecycle/jobs";
import { provisionDue } from "./provisioning";
import { handleProvisionBatch, type ProvisionMessage } from "./provisioning-queue";
import { provisioningSetup } from "./provisioning-env";
import { enqueueDue, handleScheduleBatch, schedulerDaysCleanup, type SchedulingDeps } from "./scheduling";
import { releaseSetup } from "./releases/env";
import { releaseTick } from "./releases/runner";
import { log } from "./log";
import { heartbeatStatement } from "./observability/health";
import { schedulerMinutesCleanup } from "./observability/metrics";
import type { TenantRecord } from "./tenants";

/** Set by the platform when it makes the stub; never by the tenant. */
export interface TenantPlatformProps {
  tenantId: string;
  accountId: string;
}

export class TenantPlatform
  extends WorkerEntrypoint<PlatformEnv, TenantPlatformProps>
  implements PlatformCapability
{
  private capability(): TenantCapability {
    // The platform's own Resend key, in the platform only: the tenant gets a
    // stub that can ask for one email at a time, capped per day.
    const mail = tenantMailFromEnv(this.env, mailerFromEnv(this.env));
    return new TenantCapability(this.env.PLATFORM_DB, this.ctx.props.tenantId, this.ctx.props.accountId, Date.now, mail);
  }

  sendEmail(message: HostedEmail): Promise<SendEmailResult> {
    return this.capability().sendEmail(message);
  }

  reportUsage(counts: UsageCounts): Promise<void> {
    return this.capability().reportUsage(counts);
  }

  audit(event: HostedAuditEvent): Promise<void> {
    return this.capability().audit(event);
  }
}

/** The capability stub one call to `tenant` carries as props.platform. */
function capabilityFor(ctx: ExecutionContext, tenant: TenantRecord): PlatformCapability {
  // The RPC stub forwards each method to TenantPlatform above; its Rpc
  // result types are the same promises PlatformCapability declares.
  return ctx.exports.TenantPlatform({
    props: { tenantId: tenant.id, accountId: tenant.accountId },
  }) as unknown as PlatformCapability;
}

const app = createApp({
  dispatcher: (env) => new NamespaceDispatcher(env.TENANTS),
  capability: (_env, ctx, tenant) => capabilityFor(ctx, tenant),
  releases: (env, _ctx, capability) => releaseSetup(env, capability),
  accounts: {
    mailer: (env) => mailerFromEnv(env),
    provisioning: (env, ctx) => provisioningSetup(env, (tenant) => capabilityFor(ctx, tenant)),
  },
});

function schedulingDeps(env: PlatformEnv, ctx: ExecutionContext): SchedulingDeps {
  return {
    db: env.PLATFORM_DB,
    dispatcher: new NamespaceDispatcher(env.TENANTS),
    capability: (tenant) => capabilityFor(ctx, tenant),
    hostedDomain: env.HOSTED_DOMAIN,
  };
}

/**
 * The release runner's turn (src/releases/runner.ts): the owner's requests,
 * then the active rollout for up to five minutes. Beside the rest of the
 * cron, not before it, so a long rollout never holds up provisioning or the
 * scheduler; its lease keeps the next minute's tick from running it twice.
 */
async function releases(env: PlatformEnv, ctx: ExecutionContext): Promise<void> {
  const setup = releaseSetup(env, (tenant) => capabilityFor(ctx, tenant));
  if (!setup.ok) return; // provisioning logs the missing settings, which are the same
  try {
    const { requests, tick } = await releaseTick(setup.deps);
    for (const r of requests) log.info("release.request_handled", { request: r.requestId, release: r.releaseId, result: r.result });
    if (tick.kind === "ran") log.info("release.tick", { release: tick.releaseId, state: tick.state, steps: tick.steps });
  } catch (error) {
    log.error("release.tick_failed", { error });
  }
}

/**
 * Every minute: end the trials that are over (src/billing/state.ts), enqueue
 * the customers whose scheduler is due (src/scheduling.ts), clear expired
 * sign-in state, the release runner beside the rest, and the safety net for provisioning, picking
 * up any tenant a queue message missed. The scheduler goes first and runs
 * alongside the rest, since it is the one that is late when it waits.
 */
/** The lifecycle jobs (src/lifecycle/jobs.ts), every few minutes, beside the rest of the cron. */
async function lifecycle(env: PlatformEnv, ctx: ExecutionContext): Promise<void> {
  try {
    const report = await lifecycleTick(lifecycleDepsFromEnv(env, (tenant) => capabilityFor(ctx, tenant)));
    if (!report) return; // the run before this one still holds the lock
    const sent = Object.entries(report.sent).map(([k, n]) => `${k}:${n}`);
    if (sent.length || report.deleted.length || report.exports.length) {
      log.info("lifecycle.run", { sent, deleted: report.deleted, exports: report.exports.map((e) => `${e.exportId}:${e.kind}`) });
    }
  } catch (error) {
    log.error("lifecycle.run_failed", { error });
  }
}

async function scheduled(controller: ScheduledController, env: PlatformEnv, ctx: ExecutionContext): Promise<void> {
  const now = Date.now();
  const db = env.PLATFORM_DB;
  // First and on its own: the health check's proof that the cron fires (src/observability/health.ts), whatever else fails.
  const heartbeat = heartbeatStatement(db, "cron", now)
    .run()
    .catch((error) => log.error("cron.heartbeat_failed", { error }));
  // Trials past their 14 days stop first (billing, B5), so the scheduler doesn't enqueue them.
  await endTrials(db, now)
    .then((ended) => {
      if (ended.length) log.info("billing.trials_ended", { tenants: ended.map((t) => t.tenantId) });
    })
    .catch((error) => log.error("billing.trial_sweep_failed", { error }));
  const schedule = enqueueDue({ db }, env.SCHEDULE_QUEUE, controller.scheduledTime)
    .then(async (r) => {
      if (r.sent || r.returned) log.info("schedule.enqueued", { sent: r.sent, returned: r.returned, rounds: r.rounds });
      // The health check's proof that the cron reaches the queue (src/observability/health.ts).
      await heartbeatStatement(db, "enqueue", Date.now(), { sent: r.sent, returned: r.returned }).run();
    })
    .catch((error) => log.error("schedule.enqueue_failed", { error }));
  const hourly =
    new Date(controller.scheduledTime).getUTCMinutes() === 7
      ? [schedulerDaysCleanup(db, now), schedulerMinutesCleanup(db, now), ...billingRecordsCleanup(db, now)]
      : [];
  if (hourly.length) {
    ctx.waitUntil(
      auditCleanup(db, now)
        .then((deleted) => {
          if (deleted) log.info("audit.expired_deleted", { deleted });
        })
        .catch((error) => log.error("audit.cleanup_failed", { error })),
    );
  }
  if (new Date(controller.scheduledTime).getUTCMinutes() % LIFECYCLE_EVERY_MINUTES === 0) ctx.waitUntil(lifecycle(env, ctx));
  ctx.waitUntil(releases(env, ctx));
  await db
    .batch([
      sessionCleanup(db, now),
      emailSignInCleanup(db, now),
      ceremonyCleanup(db, now),
      rateLimitCleanup(db, now),
      emailUsageCleanup(db, now),
      ...hourly,
    ])
    .catch((error) => log.error("cron.cleanup_failed", { error }));
  const setup = provisioningSetup(env, (tenant) => capabilityFor(ctx, tenant));
  if (!setup.ok) {
    log.warn("provision.off", { missing: setup.missing });
  } else {
    const outcomes = await provisionDue(setup.deps);
    if (outcomes.length) log.info("provision.sweep", { outcomes: outcomes.map((o) => `${o.tenantId}:${o.kind}`) });
  }
  await Promise.all([schedule, heartbeat]);
}

/** The queues' consumer: the scheduler's runs and provisioning's. */
async function queue(batch: MessageBatch<unknown>, env: PlatformEnv, ctx: ExecutionContext): Promise<void> {
  // openping-schedule, or a staging copy of it (openping-schedule-staging).
  if (batch.queue.startsWith("openping-schedule")) {
    // Logs its own summary line (schedule.batch) and writes the run metrics.
    await handleScheduleBatch(schedulingDeps(env, ctx), batch);
    return;
  }
  // openping-provision, or a staging copy of it (openping-provision-staging).
  if (!batch.queue.startsWith("openping-provision")) {
    log.error("queue.unknown", { queue: batch.queue });
    batch.retryAll({ delaySeconds: 300 });
    return;
  }
  const setup = provisioningSetup(env, (tenant) => capabilityFor(ctx, tenant));
  if (!setup.ok || !env.PROVISION_QUEUE) {
    log.warn("provision.off", { missing: setup.ok ? ["PROVISION_QUEUE"] : setup.missing });
    batch.retryAll({ delaySeconds: 600 });
    return;
  }
  await handleProvisionBatch(setup.deps, batch as MessageBatch<ProvisionMessage>, env.PROVISION_QUEUE);
}

export default {
  fetch: (request, env, ctx) => app.fetch(request, env, ctx),
  scheduled: (controller, env, ctx) => scheduled(controller, env, ctx),
  queue: (batch, env, ctx) => queue(batch, env, ctx),
} satisfies ExportedHandler<PlatformEnv>;
