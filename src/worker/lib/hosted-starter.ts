import {
  HOSTED_CONTRACT_VERSION,
  HOSTED_ERRORS,
  INTERNAL_HEADER_PREFIX,
  SEND_EMAIL_ERRORS,
  SIGNED_CALL_HEADERS,
  STARTER_INFO_CACHE_MS,
  STARTER_INFO_STALE_MS,
  TENANT_CALL_PATHS,
  TENANT_NOT_READY_ERROR,
  deriveCallKeys,
  hasSignedCallHeaders,
  hostedTransport,
  isInternalPath,
  isTenantId,
  isTenantProps,
  signRequest,
  signResponse,
  verifySignedRequest,
  verifySignedResponse,
  type CallKeys,
  type HostedAuditEvent,
  type HostedEmail,
  type PlatformCapability,
  type SendEmailResult,
  type TenantInfo,
  type TenantInfoAnswer,
  type TenantProps,
  type UsageCounts,
} from "../../shared/hosted-contract";
import type { Env } from "../types";
import { hostedMode } from "./hosted";
import { recordPlatformCallNonce } from "../db/platform-call-nonces";

/**
 * Starter mode (docs/hosted/CONTRACT.md, section 10): this OpenPing is an
 * ordinary Worker on the platform's account, reached at its own Custom
 * Domain, with no dispatch namespace to hand it props. This module is the
 * only thing that differs from dispatch mode. It runs before the app and turns
 * every request into exactly what the dispatcher would have delivered:
 *
 *   - a call from the platform, signed with this tenant's own
 *     PLATFORM_CALL_SECRET, verified (signature, 30 second window, a nonce
 *     recorded once), runs with the props it carries;
 *   - anything else is a visitor's request: every x-openping-* header is
 *     removed, an internal path gets the platform's 404, and the props are
 *     built from what the platform last said about this tenant
 *     (/__tenant/v1/info, kept 30 seconds).
 *
 * In both cases `props.platform` is HttpsPlatform, the capability as signed
 * HTTPS calls back to the platform. From there the request goes to the same
 * app, hosted gate and routes as in dispatch mode, so the contract is one code
 * path. A plain install and a dispatch mode tenant never get here.
 */

type Handler = (request: Request, env: Env, ctx: ExecutionContext) => Response | Promise<Response>;

/** How long a call back to the platform may take before it counts as failed. */
export const PLATFORM_CALL_TIMEOUT_MS = 10_000;

/** True when this Worker is a starter mode tenant: hosted mode with HOSTED_TRANSPORT "https". */
export function starterMode(env: Pick<Env, "HOSTED_MODE" | "HOSTED_TRANSPORT">): boolean {
  return hostedMode(env) && hostedTransport(env.HOSTED_TRANSPORT) === "https";
}

let keyCache: { secret: string; keys: Promise<CallKeys> } | null = null;

/** This tenant's two call keys, derived once per isolate from PLATFORM_CALL_SECRET. Rejects when the secret isn't one. */
function ownKeys(secret: string | undefined): Promise<CallKeys> {
  if (!secret) return Promise.reject(new Error("PLATFORM_CALL_SECRET is not set"));
  if (keyCache?.secret !== secret) {
    const keys = deriveCallKeys(secret);
    keyCache = { secret, keys };
    // A bad secret must not stay cached as a rejected promise forever.
    keys.catch(() => {
      if (keyCache?.keys === keys) keyCache = null;
    });
  }
  return keyCache.keys;
}

/** PLATFORM_URL as an https origin, or null when it isn't one. */
export function platformOrigin(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    return url.origin;
  } catch {
    return null;
  }
}

/** A failed call back to the platform: no answer, a timeout, or an answer that didn't verify. */
export class PlatformCallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlatformCallError";
  }
}

function isSendEmailResult(value: unknown): value is SendEmailResult {
  if (!value || typeof value !== "object") return false;
  const r = value as Record<string, unknown>;
  if (r.ok === true) return typeof r.id === "string";
  return r.ok === false && (SEND_EMAIL_ERRORS as readonly unknown[]).includes(r.error) && typeof r.message === "string";
}

/**
 * The platform capability in starter mode: each method one signed POST to the
 * platform (contract, section 10, "Tenant to platform"), its answer checked
 * against this call's nonce. Like the RPC stub, it never throws for a delivery
 * problem; it throws (PlatformCallError) when the call itself failed.
 */
export class HttpsPlatform implements PlatformCapability {
  constructor(
    private readonly deps: {
      tenantId: string;
      platformUrl: string;
      keys: Promise<CallKeys>;
      fetch?: typeof fetch;
      now?: () => number;
      timeoutMs?: number;
    },
  ) {}

  /** One signed call; resolves the verified answer's status and parsed body. */
  async call(path: string, body: unknown): Promise<{ status: number; body: unknown }> {
    const keys = await this.deps.keys;
    const request = await signRequest(
      { method: "POST", url: `${this.deps.platformUrl}${path}`, body: JSON.stringify(body), headers: { "content-type": "application/json" } },
      { direction: "tenant-to-platform", tenantId: this.deps.tenantId, keys, now: (this.deps.now ?? Date.now)() },
    );
    const requestNonce = request.headers.get(SIGNED_CALL_HEADERS.nonce)!;
    const send = this.deps.fetch ?? ((r: Request, init?: RequestInit) => fetch(r, init));
    let response: Response;
    try {
      response = await send(request, { signal: AbortSignal.timeout(this.deps.timeoutMs ?? PLATFORM_CALL_TIMEOUT_MS) });
    } catch (error) {
      throw new PlatformCallError(`the platform didn't answer ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const verified = await verifySignedResponse(response, { requestDirection: "tenant-to-platform", tenantId: this.deps.tenantId, requestNonce, keys });
    if (!verified) throw new PlatformCallError(`the platform's answer to ${path} isn't signed for this call (HTTP ${response.status})`);
    let parsed: unknown;
    try {
      parsed = verified.text ? JSON.parse(verified.text) : null;
    } catch {
      throw new PlatformCallError(`the platform's answer to ${path} isn't JSON`);
    }
    return { status: verified.status, body: parsed };
  }

  async sendEmail(message: HostedEmail): Promise<SendEmailResult> {
    const { status, body } = await this.call(TENANT_CALL_PATHS.sendEmail, message);
    if (status !== 200 || !isSendEmailResult(body)) throw new PlatformCallError(`sendEmail answered HTTP ${status}`);
    return body;
  }

  async reportUsage(counts: UsageCounts): Promise<void> {
    const { status } = await this.call(TENANT_CALL_PATHS.reportUsage, counts);
    if (status !== 200) throw new PlatformCallError(`reportUsage answered HTTP ${status}`);
  }

  async audit(event: HostedAuditEvent): Promise<void> {
    const { status } = await this.call(TENANT_CALL_PATHS.audit, event);
    if (status !== 200) throw new PlatformCallError(`audit answered HTTP ${status}`);
  }

  /** Who this tenant is right now: its TenantInfo, or "not_ready" while it is being provisioned or removed. */
  async info(): Promise<TenantInfo | "not_ready"> {
    const { status, body } = await this.call(TENANT_CALL_PATHS.info, {});
    if (status === 409 && (body as { error?: unknown } | null)?.error === TENANT_NOT_READY_ERROR) return "not_ready";
    const answer = body as Partial<TenantInfoAnswer> | null;
    if (status !== 200 || !answer || answer.contract !== HOSTED_CONTRACT_VERSION) throw new PlatformCallError(`info answered HTTP ${status}`);
    // The same check as dispatched props: well-formed, this contract, this tenant.
    const props = { contract: answer.contract, invocation: "public", callId: "0".repeat(32), tenant: answer.tenant, platform: this };
    if (!isTenantProps(props, this.deps.tenantId)) throw new PlatformCallError("info answered a tenant that isn't this one");
    return props.tenant;
  }
}

// ---------------------------------------------------------------------------
// The tenant's description, for public requests
// ---------------------------------------------------------------------------

let infoCache: { tenantId: string; tenant: TenantInfo; at: number } | null = null;
/**
 * This isolate's one refresh of the description at a time: when it started
 * (a refresh that never settles stops counting after REFRESH_STUCK_MS), and
 * the backoff after failed ones. Only these plain values are shared between
 * requests, never a promise, since Workers ties I/O to the request that made it.
 */
let refresh: { since: number } | null = null;
let backoff: { failures: number; until: number } = { failures: 0, until: 0 };

/** How long the description call may take: a visitor waits on it only when there is no description at all. */
export const INFO_CALL_TIMEOUT_MS = 5_000;
/** The waits after failed refreshes: 5 s, then doubling, at most a minute. */
export const INFO_BACKOFF_MS = [5_000, 10_000, 20_000, 40_000, 60_000] as const;
const REFRESH_STUCK_MS = INFO_CALL_TIMEOUT_MS + 5_000;

/** Tests only: forget the cached description, the refresh state and the keys. */
export function resetStarterCaches(): void {
  infoCache = null;
  keyCache = null;
  refresh = null;
  backoff = { failures: 0, until: 0 };
}

export type TenantDescription = { kind: "ok"; tenant: TenantInfo } | { kind: "not_ready" } | { kind: "unavailable" };

/** One call for the description, recording what it found and the backoff. */
async function fetchDescription(platform: HttpsPlatform, tenantId: string, now: () => number): Promise<TenantDescription> {
  try {
    const answer = await platform.info();
    backoff = { failures: 0, until: 0 };
    if (answer === "not_ready") {
      infoCache = null;
      return { kind: "not_ready" };
    }
    infoCache = { tenantId, tenant: answer, at: now() };
    return { kind: "ok", tenant: answer };
  } catch (error) {
    const failures = backoff.failures + 1;
    backoff = { failures, until: now() + INFO_BACKOFF_MS[Math.min(failures, INFO_BACKOFF_MS.length) - 1]! };
    console.error("[hosted starter] the platform didn't describe this tenant", error);
    return { kind: "unavailable" };
  }
}

/**
 * What the platform says about this tenant (contract, section 10, "Public
 * requests"), without ever making a visitor wait on a platform that is slow
 * or down when there is something to serve:
 *
 *   - at most STARTER_INFO_CACHE_MS old: served;
 *   - older, up to STARTER_INFO_STALE_MS: served at once, and one refresh
 *     per isolate starts in the background (`waitUntil`), unless one is in
 *     flight or a failed one is backing off;
 *   - none, or too old: asked for now, unless a failed call is backing off,
 *     when the answer is "unavailable" at once instead of another wait.
 */
export async function describeTenant(
  platform: HttpsPlatform,
  tenantId: string,
  now: number,
  waitUntil: (promise: Promise<unknown>) => void,
  clock: () => number = Date.now,
): Promise<TenantDescription> {
  const cached = infoCache?.tenantId === tenantId ? infoCache : null;
  const age = cached ? now - cached.at : Infinity;
  if (cached && age < STARTER_INFO_CACHE_MS) return { kind: "ok", tenant: cached.tenant };
  const backingOff = now < backoff.until;
  if (cached && age < STARTER_INFO_STALE_MS) {
    const inFlight = refresh !== null && now - refresh.since < REFRESH_STUCK_MS;
    if (!inFlight && !backingOff) {
      refresh = { since: now };
      waitUntil(
        fetchDescription(platform, tenantId, clock).finally(() => {
          refresh = null;
        }),
      );
    }
    return { kind: "ok", tenant: cached.tenant };
  }
  if (backingOff) return { kind: "unavailable" };
  return fetchDescription(platform, tenantId, clock);
}

// ---------------------------------------------------------------------------
// The entry point
// ---------------------------------------------------------------------------

/** The same context with `props` set, as the dispatcher would have passed it. */
export function contextWithProps(ctx: ExecutionContext, props: TenantProps): ExecutionContext {
  return {
    waitUntil: (promise: Promise<unknown>) => ctx.waitUntil(promise),
    passThroughOnException: () => ctx.passThroughOnException(),
    props,
  } as unknown as ExecutionContext;
}

/**
 * A visitor's request with every x-openping-* header removed, exactly as the
 * dispatch platform forwards one (dispatch.ts publicRequest), so nothing a
 * visitor sends can read as the platform.
 */
export function withoutInternalHeaders(request: Request): Request {
  const headers = new Headers(request.headers);
  let changed = false;
  for (const name of [...headers.keys()]) {
    if (name.toLowerCase().startsWith(INTERNAL_HEADER_PREFIX)) {
      headers.delete(name);
      changed = true;
    }
  }
  return changed ? new Request(request, { headers }) : request;
}

function newCallId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
}

const NO_STORE = { "cache-control": "no-store" };

const unavailable = () => Response.json({ error: HOSTED_ERRORS.unavailable }, { status: 503, headers: NO_STORE });

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

/** The page a paused tenant shows every visitor: what the platform shows for it in dispatch mode. */
export function suspendedPage(accountUrl: string): Response {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>This OpenPing is paused</title>
<style>
  :root { color-scheme: light dark; --bg: #f7f8fb; --ink: #121826; --muted: #5b6475; --accent: #2563eb; }
  @media (prefers-color-scheme: dark) { :root { --bg: #0b1020; --ink: #e8ebf3; --muted: #9aa3b5; --accent: #60a5fa; } }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 16px;
    background: var(--bg); color: var(--ink); font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 26rem; text-align: center; }
  h1 { font-size: 1.125rem; margin: 0 0 .5rem; }
  p { margin: 0 0 .75rem; color: var(--muted); font-size: .875rem; }
  a { color: var(--accent); font-weight: 600; }
</style>
</head>
<body>
<main>
<h1>This OpenPing is paused</h1>
<p>Its monitors aren't being checked and its status page is offline for now.</p>
<p>If it's yours, sign in to your account to restore it. Your monitors and history are kept for 30 days.</p>
<p><a href="${escapeHtml(accountUrl)}">Sign in to your account</a></p>
</main>
</body>
</html>
`;
  return new Response(html, { status: 503, headers: { "content-type": "text/html; charset=utf-8", ...NO_STORE } });
}

/** Signs the app's answer to a verified platform call, bound to the call's nonce. */
async function signedAnswer(response: Response, tenantId: string, requestNonce: string, keys: CallKeys): Promise<Response> {
  const headers = new Headers();
  const type = response.headers.get("content-type");
  if (type) headers.set("content-type", type);
  return signResponse({ status: response.status, body: await response.text(), headers }, { requestDirection: "platform-to-tenant", tenantId, requestNonce, keys });
}

/**
 * Wraps the Worker's fetch: a starter mode tenant's requests go through the
 * steps at the top of this file; any other Worker's go straight to `handler`.
 */
export function starterFetch(handler: Handler, options: { now?: () => number; fetch?: typeof fetch } = {}): Handler {
  return async (request, env, ctx) => {
    if (!starterMode(env)) return handler(request, env, ctx);
    const now = (options.now ?? Date.now)();
    const tenantId = env.TENANT_ID;
    const platformUrl = platformOrigin(env.PLATFORM_URL);
    if (!isTenantId(tenantId) || !platformUrl) {
      console.error("[hosted starter] TENANT_ID or PLATFORM_URL is missing or malformed");
      return unavailable();
    }
    const keys = ownKeys(env.PLATFORM_CALL_SECRET);
    try {
      await keys;
    } catch (error) {
      console.error("[hosted starter] PLATFORM_CALL_SECRET is missing or malformed", error);
      return unavailable();
    }
    const platform = new HttpsPlatform({ tenantId, platformUrl, keys, fetch: options.fetch, now: options.now });
    // The description gets a shorter timeout: a visitor waits on it when there is none yet.
    const describer = new HttpsPlatform({ tenantId, platformUrl, keys, fetch: options.fetch, now: options.now, timeoutMs: INFO_CALL_TIMEOUT_MS });

    let incoming = request;
    if (hasSignedCallHeaders(request.headers)) {
      const verified = await verifySignedRequest(request, {
        direction: "platform-to-tenant",
        now,
        keysFor: async (id) => (id === tenantId ? keys : null),
      });
      if (verified.ok && verified.props) {
        if (await recordPlatformCallNonce(env.DB, verified.nonce, verified.nonceExpiresAt, now)) {
          const props: TenantProps = { ...verified.props, platform };
          const response = await handler(verified.request, env, contextWithProps(ctx, props));
          return signedAnswer(response, tenantId, verified.nonce, await keys);
        }
        console.warn("[hosted starter] a signed call was replayed; handling it as a visitor's");
      } else if (!verified.ok) {
        console.warn(`[hosted starter] a signed call didn't verify (${verified.error}); handling it as a visitor's`);
      }
      // Verifying read the body; what goes on is the copy it kept.
      if (!verified.request) return Response.json({ error: "payload_too_large" }, { status: 413, headers: NO_STORE });
      incoming = verified.request;
    }

    // A visitor. Internal paths are the platform's: the same 404 dispatch mode
    // answers before a visitor's request ever reaches the tenant.
    const visitor = withoutInternalHeaders(incoming);
    if (isInternalPath(new URL(visitor.url).pathname)) {
      return Response.json({ error: HOSTED_ERRORS.notFound }, { status: 404, headers: NO_STORE });
    }
    const description = await describeTenant(describer, tenantId, now, (promise) => ctx.waitUntil(promise), options.now ?? Date.now);
    if (description.kind !== "ok") return unavailable();
    const { tenant } = description;
    if (tenant.status === "suspended") return suspendedPage(tenant.urls.account);
    const props: TenantProps = { contract: HOSTED_CONTRACT_VERSION, invocation: "public", callId: newCallId(), tenant, platform };
    return handler(visitor, env, contextWithProps(ctx, props));
  };
}
