/**
 * Starter mode on the platform's side (docs/hosted/CONTRACT.md, section 10):
 * customers' OpenPings as ordinary Workers on the account, on Workers Paid
 * alone, without Workers for Platforms.
 *
 * Without a dispatch namespace there are no props and no RPC stub, so:
 *
 *   platform to tenant  HttpsTenantDispatcher sends the platform's calls
 *                       (the scheduler, health, the release runner) to the
 *                       tenant's own Custom Domain, signed with that tenant's
 *                       PLATFORM_CALL_SECRET, carrying the very props the
 *                       namespace would have passed; it accepts only an
 *                       answer signed back for that call.
 *   tenant to platform  handleTenantCall serves the four capability calls
 *                       (/__tenant/v1/...), identifying the tenant by its
 *                       signature alone, each nonce once, and answers signed.
 *
 * RuntimeDispatcher picks the namespace or HTTPS per tenant (tenants.runtime),
 * so the scheduler, provisioning, the release runner, the admin console and a
 * fleet half moved to Workers for Platforms all use one dispatcher.
 *
 * Each tenant has its own secret, made by the platform, kept sealed with
 * PLATFORM_KEY (src/keys.ts) and set on that tenant's Worker only: no
 * tenant can sign as another, and the secrets never reach a log.
 */

import {
  HOSTED_CONTRACT_VERSION,
  SIGNED_CALL_HEADERS,
  TENANT_CALL_PATHS,
  TENANT_NOT_READY_ERROR,
  deriveCallKeys,
  signRequest,
  signResponse,
  verifySignedRequest,
  verifySignedResponse,
  type CallKeys,
  type HostedAuditEvent,
  type HostedEmail,
  type TenantInfoAnswer,
  type TenantProps,
  type UsageCounts,
} from "../../src/shared/hosted-contract";
import { TenantCapability, type TenantMail } from "./capability";
import type { DispatchLimits, DispatchResult, DispatchTarget, TenantDispatcher } from "./dispatch";
import { tenantCallSecret } from "./keys";
import { log } from "./log";
import { TENANT_COLUMNS, tenantFromRow, tenantInfo, type TenantRecord, type TenantRow } from "./tenants";

/** Keys are derived once per isolate per tenant, and forgotten after this long (a rotated secret takes effect within it). */
export const CALL_KEYS_CACHE_MS = 5 * 60_000;
const CALL_KEYS_CACHE_MAX = 1_000;
const keyCache = new Map<string, { keys: CallKeys; until: number }>();

/** Tests only. */
export function clearCallKeyCache(): void {
  keyCache.clear();
}

/** A tenant's two call keys, from its sealed secret; null for a tenant without one (dispatch tenants, unknown ids). */
export async function callKeysFor(db: D1Database, tenantId: string, platformKey: string, now: number = Date.now()): Promise<CallKeys | null> {
  const hit = keyCache.get(tenantId);
  if (hit && hit.until > now) return hit.keys;
  const secret = await tenantCallSecret(db, tenantId, platformKey);
  if (!secret) return null;
  const keys = await deriveCallKeys(secret);
  if (keyCache.size >= CALL_KEYS_CACHE_MAX) keyCache.delete(keyCache.keys().next().value!);
  keyCache.set(tenantId, { keys, until: now + CALL_KEYS_CACHE_MS });
  return keys;
}

/** Forgets a tenant's cached keys (its secret changed, or it was removed). */
export function forgetCallKeys(tenantId: string): void {
  keyCache.delete(tenantId);
}

// ---------------------------------------------------------------------------
// Platform to tenant
// ---------------------------------------------------------------------------

/**
 * The platform's calls to starter tenants, over HTTPS to each one's Custom
 * Domain. Only platform calls: a visitor reaches a starter tenant directly,
 * never through the platform, so a public call here is a bug and refused.
 * An answer that isn't signed back for this call is no answer (a rejection).
 */
export class HttpsTenantDispatcher implements TenantDispatcher {
  constructor(
    private readonly deps: {
      db: D1Database;
      platformKey: string;
      fetch?: typeof fetch;
      now?: () => number;
    },
  ) {}

  async dispatch(_target: DispatchTarget, request: Request, props: TenantProps, _limits: DispatchLimits): Promise<DispatchResult> {
    if (props.invocation !== "platform") throw new Error("starter mode never relays a visitor's request");
    const now = (this.deps.now ?? Date.now)();
    const tenantId = props.tenant.id;
    const keys = await callKeysFor(this.deps.db, tenantId, this.deps.platformKey, now);
    if (!keys) throw new Error(`tenant ${tenantId} has no call secret`);
    const { platform: _platform, ...carried } = props;
    const method = request.method.toUpperCase();
    const body = method === "GET" || method === "HEAD" ? undefined : await request.text();
    const headers = new Headers();
    const type = request.headers.get("content-type");
    if (type) headers.set("content-type", type);
    const signed = await signRequest(
      { method, url: request.url, body, headers },
      { direction: "platform-to-tenant", tenantId, keys, now, props: carried },
    );
    const nonce = signed.headers.get(SIGNED_CALL_HEADERS.nonce)!;
    const send = this.deps.fetch ?? ((r: Request, init?: RequestInit) => fetch(r, init));
    const response = await send(signed, { signal: request.signal });
    const verified = await verifySignedResponse(response, { requestDirection: "platform-to-tenant", tenantId, requestNonce: nonce, keys });
    if (!verified) throw new Error(`tenant ${tenantId}'s answer isn't signed for this call (HTTP ${response.status})`);
    return {
      kind: "response",
      response: new Response(verified.text, { status: verified.status, headers: { "content-type": response.headers.get("content-type") ?? "application/json" } }),
    };
  }
}

/** The namespace for dispatch tenants, HTTPS for starter ones; a runtime without its dispatcher configured fails the call. */
export class RuntimeDispatcher implements TenantDispatcher {
  constructor(private readonly by: { dispatch: TenantDispatcher | null; starter: TenantDispatcher | null }) {}

  dispatch(target: DispatchTarget, request: Request, props: TenantProps, limits: DispatchLimits): Promise<DispatchResult> {
    const dispatcher = this.by[target.runtime];
    if (!dispatcher) {
      return Promise.reject(new Error(`${target.scriptName} runs in ${target.runtime} mode, which this platform isn't configured for`));
    }
    return dispatcher.dispatch(target, request, props, limits);
  }
}

// ---------------------------------------------------------------------------
// Tenant to platform
// ---------------------------------------------------------------------------

export interface TenantCallDeps {
  db: D1Database;
  hostedDomain: string;
  /** PLATFORM_KEY, which opens tenants' call secrets; null while it isn't set (then every call is refused). */
  platformKey: string | null;
  mail: TenantMail | null;
  now: number;
}

const notFound = () => Response.json({ error: "not_found" }, { status: 404, headers: { "cache-control": "no-store" } });

/** Records a tenant call's nonce once; false for a replay. The expired ones go in the same round trip. */
export async function recordTenantCallNonce(db: D1Database, tenantId: string, nonce: string, expiresAt: number, now: number): Promise<boolean> {
  const [, inserted] = await db.batch([
    db.prepare("DELETE FROM tenant_call_nonces WHERE expires_at <= ?").bind(now),
    db.prepare("INSERT INTO tenant_call_nonces (nonce, tenant_id, expires_at) VALUES (?, ?, ?) ON CONFLICT(nonce) DO NOTHING").bind(nonce, tenantId, expiresAt),
  ]);
  return inserted?.meta.changes === 1;
}

async function tenantById(db: D1Database, tenantId: string): Promise<TenantRecord | null> {
  const row = await db.prepare(`SELECT ${TENANT_COLUMNS} FROM tenants WHERE id = ?`).bind(tenantId).first<TenantRow>();
  return row ? tenantFromRow(row) : null;
}

/**
 * POST app.<domain>/__tenant/v1/{info,send-email,report-usage,audit}: a
 * starter tenant's capability call. Whatever doesn't verify (unsigned,
 * forged, expired, replayed, for a tenant without a secret, from a tenant
 * claiming another's id) answers the unknown path's 404, unsigned, and does
 * nothing. A verified call runs for the tenant its signature names, exactly
 * as `props.platform` does in dispatch mode, and is answered signed.
 */
export async function handleTenantCall(request: Request, deps: TenantCallDeps): Promise<Response> {
  const path = new URL(request.url).pathname;
  const known = (Object.values(TENANT_CALL_PATHS) as string[]).includes(path);
  if (!known || request.method !== "POST" || !deps.platformKey) return notFound();
  const platformKey = deps.platformKey;
  const verified = await verifySignedRequest(request, {
    direction: "tenant-to-platform",
    now: deps.now,
    keysFor: (id) => callKeysFor(deps.db, id, platformKey, deps.now),
  });
  if (!verified.ok) {
    log.warn("tenant_call.refused", { path, reason: verified.error });
    return notFound();
  }
  const { tenantId, nonce } = verified;
  if (!(await recordTenantCallNonce(deps.db, tenantId, nonce, verified.nonceExpiresAt, deps.now))) {
    log.warn("tenant_call.refused", { path, tenant: tenantId, reason: "replayed" });
    return notFound();
  }
  const keys = (await callKeysFor(deps.db, tenantId, platformKey, deps.now))!;
  const answer = (status: number, body: unknown) =>
    signResponse({ status, body: JSON.stringify(body) }, { requestDirection: "tenant-to-platform", tenantId, requestNonce: nonce, keys });

  const tenant = await tenantById(deps.db, tenantId);
  if (!tenant) return answer(409, { error: TENANT_NOT_READY_ERROR });
  let body: unknown;
  try {
    body = JSON.parse((await verified.request.text()) || "null");
  } catch {
    return answer(400, { error: "invalid_request" });
  }

  if (path === TENANT_CALL_PATHS.info) {
    if (tenant.provisionState !== "ready") return answer(409, { error: TENANT_NOT_READY_ERROR });
    const info: TenantInfoAnswer = { contract: HOSTED_CONTRACT_VERSION, tenant: tenantInfo(tenant, deps.hostedDomain) };
    return answer(200, info);
  }
  const capability = new TenantCapability(deps.db, tenant.id, tenant.accountId, () => deps.now, deps.mail);
  try {
    if (path === TENANT_CALL_PATHS.sendEmail) return answer(200, await capability.sendEmail(body as HostedEmail));
    if (path === TENANT_CALL_PATHS.reportUsage) await capability.reportUsage(body as UsageCounts);
    else await capability.audit(body as HostedAuditEvent);
  } catch (error) {
    log.warn("tenant_call.invalid", { path, tenant: tenantId, error });
    return answer(400, { error: "invalid_request" });
  }
  return answer(200, { ok: true });
}
