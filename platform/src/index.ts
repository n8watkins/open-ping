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
 * Every minute: end the trials that are over (src/billing/state.ts), enqueue
 * the customers whose scheduler is due (src/scheduling.ts), clear expired
 * sign-in state, and the safety net for provisioning, picking
 * up any tenant a queue message missed. The scheduler goes first and runs
 * alongside the rest, since it is the one that is late when it waits.
 */
/** The lifecycle jobs (src/lifecycle/jobs.ts), every few minutes, beside the rest of the cron. */
async function lifecycle(env: PlatformEnv, ctx: ExecutionContext): Promise<void> {
  try {
    const report = await lifecycleTick(lifecycleDepsFromEnv(env, (tenant) => capabilityFor(ctx, tenant)));
    const sent = Object.entries(report.sent).map(([k, n]) => `${k}:${n}`);
    if (sent.length || report.deleted.length || report.exports.length) {
      console.log("[lifecycle]", { sent: sent.join(" "), deleted: report.deleted, exports: report.exports.map((e) => `${e.exportId}:${e.kind}`) });
    }
  } catch (error) {
    console.error("[lifecycle] run failed", error);
  }
}

async function scheduled(controller: ScheduledController, env: PlatformEnv, ctx: ExecutionContext): Promise<void> {
  const now = Date.now();
  const db = env.PLATFORM_DB;
  // Trials past their 14 days stop first (billing, B5), so the scheduler doesn't enqueue them.
  await endTrials(db, now)
    .then((ended) => {
      if (ended.length) console.log("[billing] trials ended", ended.map((t) => t.tenantId).join(" "));
    })
    .catch((error) => console.error("[billing] trial sweep failed", error));
  const schedule = enqueueDue({ db }, env.SCHEDULE_QUEUE, controller.scheduledTime)
    .then((r) => {
      if (r.sent || r.returned) console.log("[schedule] enqueued", r);
    })
    .catch((error) => console.error("[schedule] enqueue failed", error));
  const hourly = new Date(controller.scheduledTime).getUTCMinutes() === 7 ? [schedulerDaysCleanup(db, now), ...billingRecordsCleanup(db, now)] : [];
  if (new Date(controller.scheduledTime).getUTCMinutes() % LIFECYCLE_EVERY_MINUTES === 0) ctx.waitUntil(lifecycle(env, ctx));
  await db
    .batch([sessionCleanup(db, now), emailSignInCleanup(db, now), ceremonyCleanup(db, now), rateLimitCleanup(db, now), emailUsageCleanup(db, now), ...hourly])
    .catch((error) => console.error("[cleanup] failed", error));
  const setup = provisioningSetup(env, (tenant) => capabilityFor(ctx, tenant));
  if (!setup.ok) {
    console.warn("[provision] off until these are set:", setup.missing.join(", "));
  } else {
    const outcomes = await provisionDue(setup.deps);
    if (outcomes.length) console.log("[provision] sweep", outcomes.map((o) => `${o.tenantId}:${o.kind}`).join(" "));
  }
  await schedule;
}

/** The queues' consumer: the scheduler's runs and provisioning's. */
async function queue(batch: MessageBatch<unknown>, env: PlatformEnv, ctx: ExecutionContext): Promise<void> {
  // openping-schedule, or a staging copy of it (openping-schedule-staging).
  if (batch.queue.startsWith("openping-schedule")) {
    const results = await handleScheduleBatch(schedulingDeps(env, ctx), batch);
    const failed = results.filter((r) => r.kind === "ran" && r.outcome !== "ran" && r.outcome !== "lease_busy");
    if (failed.length) console.warn("[schedule] runs without a clean answer", failed.length, "of", results.length);
    return;
  }
  // openping-provision, or a staging copy of it (openping-provision-staging).
  if (!batch.queue.startsWith("openping-provision")) {
    console.error("[queue] message for an unknown queue", batch.queue);
    batch.retryAll({ delaySeconds: 300 });
    return;
  }
  const setup = provisioningSetup(env, (tenant) => capabilityFor(ctx, tenant));
  if (!setup.ok || !env.PROVISION_QUEUE) {
    console.warn("[provision] off until these are set:", setup.ok ? "PROVISION_QUEUE" : setup.missing.join(", "));
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
