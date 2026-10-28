/**
 * Calling a customer's OpenPing.
 *
 * Everything goes through `TenantDispatcher`, so the router and the scheduler
 * never touch the dispatch namespace directly. `NamespaceDispatcher` is the
 * real one (env.TENANTS); tests use the in-memory fake in
 * test/fake-dispatcher.ts, which has the same interface.
 *
 * The props (docs/hosted/CONTRACT.md, section 3) are built here, the same way
 * for both, so the fake can't drift from what production sends.
 */

import {
  HOSTED_CONTRACT_VERSION,
  INTERNAL_HEADER,
  INTERNAL_HEADER_PREFIX,
  isInternalPath,
  type Invocation,
  type PlatformCapability,
  type TenantProps,
} from "../../src/shared/hosted-contract";
import { tenantOrigin } from "./hosts";
import { tenantInfo, type TenantRecord } from "./tenants";

/** The CPU and subrequest caps for one call (custom limits on dynamic dispatch). */
export interface DispatchLimits {
  cpuMs: number;
  subRequests: number;
}

/**
 * Starting values, to be measured in the load test (build plan, section 9).
 * A public request is a page, an API call or an MCP call; a backup restore is
 * the heaviest. A platform call is a whole scheduled run: up to 20 monitors,
 * their confirmations, alerts and D1 round trips.
 */
export const DISPATCH_LIMITS: Readonly<Record<Invocation, Readonly<DispatchLimits>>> = {
  public: { cpuMs: 1_000, subRequests: 200 },
  platform: { cpuMs: 15_000, subRequests: 1_000 },
};

export type DispatchResult = { kind: "response"; response: Response } | { kind: "missing" };

export interface TenantDispatcher {
  /**
   * Sends `request` to the user Worker `scriptName` with these props and
   * limits. Answers "missing" when no such script exists in the namespace;
   * any other failure (the user Worker threw) rejects.
   */
  dispatch(scriptName: string, request: Request, props: TenantProps, limits: DispatchLimits): Promise<DispatchResult>;
}

/** A call id: 32 hex characters (contract: at least 16). */
export function newCallId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function buildTenantProps(input: {
  tenant: TenantRecord;
  hostedDomain: string;
  invocation: Invocation;
  callId: string;
  platform: PlatformCapability;
}): TenantProps {
  return {
    contract: HOSTED_CONTRACT_VERSION,
    invocation: input.invocation,
    callId: input.callId,
    tenant: tenantInfo(input.tenant, input.hostedDomain),
    platform: input.platform,
  };
}

/**
 * A visitor's request with every `x-openping-*` header removed, so nothing a
 * visitor sends can look like it came from the platform.
 */
export function publicRequest(request: Request): Request {
  const headers = new Headers(request.headers);
  for (const name of [...headers.keys()]) {
    if (name.toLowerCase().startsWith(INTERNAL_HEADER_PREFIX)) headers.delete(name);
  }
  return new Request(request, { headers });
}

/**
 * A request from the platform itself to one of the tenant's internal paths,
 * carrying the call id in INTERNAL_HEADER (contract, section 6).
 */
export function platformRequest(
  tenant: Pick<TenantRecord, "slug">,
  hostedDomain: string,
  path: string,
  callId: string,
  init: { method?: string; body?: unknown } = {},
): Request {
  if (!isInternalPath(path)) throw new Error(`not an internal path: ${path}`);
  const headers = new Headers({ [INTERNAL_HEADER]: callId });
  let body: string | undefined;
  if (init.body !== undefined) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(init.body);
  }
  return new Request(`${tenantOrigin(tenant.slug, hostedDomain)}${path}`, {
    method: init.method ?? (body === undefined ? "GET" : "POST"),
    headers,
    body,
  });
}

/** The real dispatcher, over the TENANTS dispatch namespace binding. */
export class NamespaceDispatcher implements TenantDispatcher {
  constructor(private readonly namespace: DispatchNamespace) {}

  async dispatch(
    scriptName: string,
    request: Request,
    props: TenantProps,
    limits: DispatchLimits,
  ): Promise<DispatchResult> {
    let worker: Fetcher;
    try {
      worker = this.namespace.get(scriptName, { props }, { limits: { ...limits } });
    } catch (error) {
      if (isWorkerNotFound(error)) return { kind: "missing" };
      throw error;
    }
    try {
      return { kind: "response", response: await worker.fetch(request) };
    } catch (error) {
      // Depending on the runtime, a missing script surfaces at get() or here.
      if (isWorkerNotFound(error)) return { kind: "missing" };
      throw error;
    }
  }
}

/** Cloudflare's error for a script name that isn't in the namespace starts "Worker not found". */
export function isWorkerNotFound(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith("Worker not found");
}

/**
 * The platform calling one of a tenant's internal paths (the scheduler, the
 * release runner's health check). The caller decides whether the tenant's
 * status allows it; this only builds the call (contract, section 6).
 */
export async function callTenant(
  dispatcher: TenantDispatcher,
  input: { tenant: TenantRecord; hostedDomain: string; platform: PlatformCapability },
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<DispatchResult> {
  const callId = newCallId();
  const request = platformRequest(input.tenant, input.hostedDomain, path, callId, init);
  const props = buildTenantProps({ ...input, invocation: "platform", callId });
  return dispatcher.dispatch(input.tenant.scriptName, request, props, DISPATCH_LIMITS.platform);
}
