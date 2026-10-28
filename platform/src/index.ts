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
import { TenantCapability } from "./capability";
import { NamespaceDispatcher } from "./dispatch";
import type { PlatformEnv } from "./env";

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

const app = createApp({
  dispatcher: (env) => new NamespaceDispatcher(env.TENANTS),
  capability: (_env, ctx, tenant) =>
    // The RPC stub forwards each method to TenantPlatform above; its Rpc
    // result types are the same promises PlatformCapability declares.
    ctx.exports.TenantPlatform({
      props: { tenantId: tenant.id, accountId: tenant.accountId },
    }) as unknown as PlatformCapability,
});

export default {
  fetch: (request, env, ctx) => app.fetch(request, env, ctx),
} satisfies ExportedHandler<PlatformEnv>;
