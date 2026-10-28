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
import { ceremonyCleanup } from "./auth/ceremonies";
import { emailSignInCleanup } from "./auth/email-sign-in";
import { rateLimitCleanup } from "./auth/rate-limit";
import { sessionCleanup } from "./auth/sessions";
import { TenantCapability } from "./capability";
import { NamespaceDispatcher } from "./dispatch";
import type { PlatformEnv } from "./env";
import { mailerFromEnv } from "./mail";
import { provisionDue } from "./provisioning";
import { handleProvisionBatch, type ProvisionMessage } from "./provisioning-queue";
import { provisioningSetup } from "./provisioning-env";
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
    return new TenantCapability(this.env.PLATFORM_DB, this.ctx.props.tenantId, this.ctx.props.accountId);
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

/**
 * Every minute: clear expired sign-in state, and the safety net for
 * provisioning, picking up any tenant a queue message missed (B4 adds the
 * scheduler here).
 */
async function scheduled(env: PlatformEnv, ctx: ExecutionContext): Promise<void> {
  const now = Date.now();
  const db = env.PLATFORM_DB;
  await db
    .batch([sessionCleanup(db, now), emailSignInCleanup(db, now), ceremonyCleanup(db, now), rateLimitCleanup(db, now)])
    .catch((error) => console.error("[cleanup] failed", error));
  const setup = provisioningSetup(env, (tenant) => capabilityFor(ctx, tenant));
  if (!setup.ok) {
    console.warn("[provision] off until these are set:", setup.missing.join(", "));
    return;
  }
  const outcomes = await provisionDue(setup.deps);
  if (outcomes.length) console.log("[provision] sweep", outcomes.map((o) => `${o.tenantId}:${o.kind}`).join(" "));
}

/** The provisioning queue's consumer. */
async function queue(batch: MessageBatch<unknown>, env: PlatformEnv, ctx: ExecutionContext): Promise<void> {
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
  scheduled: (_controller, env, ctx) => scheduled(env, ctx),
  queue: (batch, env, ctx) => queue(batch, env, ctx),
} satisfies ExportedHandler<PlatformEnv>;
