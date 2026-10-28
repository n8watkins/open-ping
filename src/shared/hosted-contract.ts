/**
 * The contract between the OpenPing Hosted platform Worker (platform/) and a
 * customer's OpenPing running as a user Worker in the dispatch namespace.
 *
 * Both sides import this file, and it changes only through a contract PR
 * (docs/hosted/CONTRACT.md, which explains every rule here in prose).
 *
 * Everything in this module is pure: types, constants, and helpers that run
 * the same in workerd and in Node (Web Crypto only), so both sides can unit
 * test against it. No Worker code lives here.
 */

import type { ChannelKind } from "./notifications";

/** Bumped when a change to this contract is not backwards compatible. */
export const HOSTED_CONTRACT_VERSION = 1;

// ---------------------------------------------------------------------------
// Environment of a customer's OpenPing in hosted mode
// ---------------------------------------------------------------------------

/**
 * The plain vars the platform sets on every user Worker it uploads. Secrets
 * (the tenant's own MASTER_KEY) are set separately and are not listed here.
 */
export const HOSTED_ENV = {
  /** "1" turns hosted mode on. Absent or anything else: a plain install. */
  mode: "HOSTED_MODE",
  /** The tenant id (TenantInfo.id) this Worker was provisioned for. */
  tenantId: "TENANT_ID",
  /** base64url of the raw 32-byte Ed25519 public key that verifies hand-off tokens. */
  handoffPublicKey: "HANDOFF_PUBLIC_KEY",
} as const;

/** The value of HOSTED_MODE that turns hosted mode on. */
export const HOSTED_MODE_ON = "1";

/** True when `value` (the HOSTED_MODE var) turns hosted mode on. Strict on purpose. */
export function isHostedMode(value: unknown): boolean {
  return value === HOSTED_MODE_ON;
}

// ---------------------------------------------------------------------------
// Tenants, plans and limits
// ---------------------------------------------------------------------------

/** Billing status of a tenant. Provisioning progress is a separate, platform-only field. */
export const TENANT_STATUSES = ["trial", "active", "past_due", "suspended"] as const;
export type TenantStatus = (typeof TENANT_STATUSES)[number];

/** The plans. `hosted_fast` is the yearly plan with the 1-minute checks add-on. */
export const PLAN_IDS = ["trial", "hosted", "hosted_fast"] as const;
export type PlanId = (typeof PLAN_IDS)[number];

/** What a plan includes. The user Worker enforces these from props, never from its own copy. */
export interface PlanLimits {
  /** Monitors that may exist at once (paused ones count). */
  monitors: number;
  /** Status pages that may exist at once. */
  statusPages: number;
  /** Shortest check interval a monitor may have, in minutes. */
  minIntervalMinutes: number;
  /** Notification channel kinds that may be created; "all" means every kind. */
  channelKinds: "all" | readonly ChannelKind[];
  /** Emails the platform's mail capability sends for this tenant per UTC day. */
  emailsPerDay: number;
}

/**
 * The platform's default limits per plan (docs/HOSTED_PLAN.md). The platform
 * puts the resolved limits into props, so it can change a tenant's limits
 * (a support grant, a promotion) without a release of OpenPing.
 */
export const PLAN_LIMITS: Readonly<Record<PlanId, Readonly<PlanLimits>>> = {
  trial: { monitors: 5, statusPages: 1, minIntervalMinutes: 12, channelKinds: ["email"], emailsPerDay: 50 },
  hosted: { monitors: 20, statusPages: 2, minIntervalMinutes: 12, channelKinds: "all", emailsPerDay: 500 },
  hosted_fast: { monitors: 20, statusPages: 2, minIntervalMinutes: 1, channelKinds: "all", emailsPerDay: 500 },
};

/** Links into the platform the customer's OpenPing shows (Settings, 402 answers, sign-out). */
export interface HostedUrls {
  /** The customer's account page on the platform. */
  account: string;
  /** Billing (Stripe Customer Portal entry on the platform). */
  billing: string;
  /** Where a limit answer points: the upgrade or add-on page. */
  upgrade: string;
  /** Platform sign-in; the tenant redirects here when it has no session. */
  signIn: string;
  /** Platform sign-out; the tenant redirects here after ending its own session. */
  signOut: string;
}

/** The tenant, as the platform describes it to the customer's OpenPing on each call. */
export interface TenantInfo {
  /** Opaque, permanent id: 16 characters of [a-z0-9]. Never the slug, which can change. */
  id: string;
  /** The subdomain label: `<slug>.<hosted domain>`. */
  slug: string;
  status: TenantStatus;
  plan: PlanId;
  limits: PlanLimits;
  /** End of the trial (epoch ms) while status is "trial", otherwise null. */
  trialEndsAt: number | null;
  urls: HostedUrls;
}

/** Tenant ids are 16 lowercase letters and digits. */
export const TENANT_ID_PATTERN = /^[a-z0-9]{16}$/;

export function isTenantId(value: unknown): value is string {
  return typeof value === "string" && TENANT_ID_PATTERN.test(value);
}

/** The user Worker's script name in the dispatch namespace. */
export function tenantScriptName(tenantId: string): string {
  return `t-${tenantId}`;
}

/** The name of the tenant's own D1 database. */
export function tenantDatabaseName(tenantId: string): string {
  return `openping-t-${tenantId}`;
}

// ---------------------------------------------------------------------------
// The platform capability (an RPC stub passed in props)
// ---------------------------------------------------------------------------

/** An email the customer's OpenPing asks the platform to send. The platform picks the From address. */
export interface HostedEmail {
  to: string[];
  subject: string;
  text: string;
  html?: string;
  replyTo?: string;
  /** What it is, for per-tenant metrics and caps: "alert", "report", "signin", ... */
  category: string;
}

export const SEND_EMAIL_ERRORS = ["email_quota_exceeded", "email_rejected", "email_unavailable"] as const;
export type SendEmailError = (typeof SEND_EMAIL_ERRORS)[number];

export type SendEmailResult = { ok: true; id: string } | { ok: false; error: SendEmailError; message: string };

/** Counts the customer's OpenPing reports after a change or a run, for the admin console and abuse caps. */
export interface UsageCounts {
  monitors: number;
  statusPages: number;
  channels: number;
  /** When these counts were taken (epoch ms). */
  at: number;
}

/** Who did something recorded in the platform's audit log. */
export const AUDIT_ACTORS = ["customer", "support", "system"] as const;
export type AuditActor = (typeof AUDIT_ACTORS)[number];

/** An event the customer's OpenPing records in the platform's audit log. */
export interface HostedAuditEvent {
  /** Dotted, lowercase: "session.created", "monitor.deleted", "settings.changed". */
  action: string;
  actor: AuditActor;
  /** Small, flat, non-secret details. */
  detail?: Record<string, string | number | boolean | null>;
  /** When it happened (epoch ms). */
  at: number;
}

export const AUDIT_ACTION_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;

/**
 * The capability the platform passes as `props.platform`. Each method runs in
 * the platform Worker, already scoped to the calling tenant, so no tenant id is
 * passed and none can be forged. The stub is valid only during the call that
 * received it: never store it across requests.
 */
export interface PlatformCapability {
  sendEmail(message: HostedEmail): Promise<SendEmailResult>;
  reportUsage(counts: UsageCounts): Promise<void>;
  audit(event: HostedAuditEvent): Promise<void>;
}

// ---------------------------------------------------------------------------
// Props on every dispatched call
// ---------------------------------------------------------------------------

/**
 * "public": a visitor's request the platform routed from `<slug>.<domain>`.
 * "platform": the platform itself calling (the scheduler, health checks, releases).
 */
export const INVOCATIONS = ["public", "platform"] as const;
export type Invocation = (typeof INVOCATIONS)[number];

/** What the customer's OpenPing receives as `ctx.props` on every call. */
export interface TenantProps {
  contract: typeof HOSTED_CONTRACT_VERSION;
  invocation: Invocation;
  /**
   * A random id for this one call. On a "platform" call the request also
   * carries it in INTERNAL_HEADER; on a "public" call nothing carries it.
   */
  callId: string;
  tenant: TenantInfo;
  platform: PlatformCapability;
}

const URL_KEYS = ["account", "billing", "upgrade", "signIn", "signOut"] as const;

function isHttpUrl(value: unknown): boolean {
  if (typeof value !== "string" || value.length > 2048) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

/**
 * The user Worker's check of `ctx.props` in hosted mode: true only for props
 * of this contract version with a well-formed tenant, whose id is `tenantId`
 * (the TENANT_ID var) when given. Props come from the platform and can't be
 * forged; this guards against a platform and a bundle that disagree (an older
 * or newer contract, a tenant id mix-up), which the user Worker answers with
 * 503 `hosted_unavailable`. It never calls the `platform` stub.
 */
export function isTenantProps(value: unknown, tenantId?: string): value is TenantProps {
  if (!value || typeof value !== "object") return false;
  const p = value as Record<string, unknown>;
  if (p.contract !== HOSTED_CONTRACT_VERSION) return false;
  if (!(INVOCATIONS as readonly unknown[]).includes(p.invocation)) return false;
  if (typeof p.callId !== "string" || p.callId.length < 16) return false;
  if (!p.platform || (typeof p.platform !== "object" && typeof p.platform !== "function")) return false;
  const t = p.tenant as Record<string, unknown> | null | undefined;
  if (!t || typeof t !== "object") return false;
  if (!isTenantId(t.id) || (tenantId !== undefined && t.id !== tenantId)) return false;
  if (typeof t.slug !== "string" || !t.slug) return false;
  if (!(TENANT_STATUSES as readonly unknown[]).includes(t.status)) return false;
  if (!(PLAN_IDS as readonly unknown[]).includes(t.plan)) return false;
  if (!t.limits || typeof t.limits !== "object") return false;
  if (t.trialEndsAt !== null && !Number.isSafeInteger(t.trialEndsAt)) return false;
  const urls = t.urls as Record<string, unknown> | null | undefined;
  if (!urls || typeof urls !== "object") return false;
  return URL_KEYS.every((key) => isHttpUrl(urls[key]));
}

// ---------------------------------------------------------------------------
// Internal paths
// ---------------------------------------------------------------------------

/** Every path under this prefix is internal: the platform never forwards public traffic to it. */
export const INTERNAL_PATH_PREFIX = "/__platform/";
export const PLATFORM_SCHEDULED_PATH = "/__platform/scheduled";
export const PLATFORM_HEALTH_PATH = "/__platform/health";

/**
 * The header a platform call carries, set to `props.callId`. The platform
 * strips every header starting with INTERNAL_HEADER_PREFIX from public traffic.
 */
export const INTERNAL_HEADER = "x-openping-platform";
export const INTERNAL_HEADER_PREFIX = "x-openping-";

export function isInternalPath(pathname: string): boolean {
  return pathname === INTERNAL_PATH_PREFIX.slice(0, -1) || pathname.startsWith(INTERNAL_PATH_PREFIX);
}

/**
 * The user Worker's gate for INTERNAL paths: true only for a platform call
 * whose header matches the call id in props. Props are set by the platform and
 * can't be forged; the header binds the request to that call.
 */
export function isPlatformCall(
  props: Pick<TenantProps, "invocation" | "callId"> | null | undefined,
  headerValue: string | null,
): boolean {
  if (!props || props.invocation !== "platform") return false;
  if (typeof props.callId !== "string" || props.callId.length < 16) return false;
  return headerValue === props.callId;
}

/** Body of `POST /__platform/scheduled`. */
export interface ScheduledRequest {
  /** The platform's id for this run, echoed in the summary. */
  runId: string;
  /** When the platform's cron fired (epoch ms). */
  scheduledTime: number;
  /** The cron expression that fired, for the run record. */
  cron: string;
}

export const SCHEDULED_OUTCOMES = ["ran", "lease_busy", "failed"] as const;
export type ScheduledOutcome = (typeof SCHEDULED_OUTCOMES)[number];

/** Answer of `POST /__platform/scheduled`: HTTP 200 with this body whatever the outcome. */
export interface ScheduledRunSummary {
  runId: string;
  outcome: ScheduledOutcome;
  /** OpenPing version (package.json) of the bundle that ran. */
  version: string;
  /** Highest migration number applied, after any self-migration this run did. */
  schemaVersion: number;
  /** Migrations this run applied before checking (0 almost always). */
  migrationsApplied: number;
  startedAt: number;
  durationMs: number;
  checked: number;
  failures: number;
  /** Monitors that were due but left for the next run by the budget. */
  deferred: number;
  d1Queries: number;
  /** A short, non-secret reason when outcome is "failed". */
  error?: string;
}

/**
 * Answer of `GET /__platform/health`. HTTP 200 when ok, 503 when not. `ok`:
 * the database answers, schemaVersion >= bundledSchemaVersion, and no
 * migration is in progress.
 */
export interface HealthResponse {
  ok: boolean;
  version: string;
  schemaVersion: number;
  /**
   * The highest migration the bundle carries. schemaVersion is at least this
   * once migrated, and higher after a rollback to an older bundle (migrations
   * are additive, so that is still healthy).
   */
  bundledSchemaVersion: number;
  migrating: boolean;
  lastRun: { at: number; outcome: ScheduledOutcome; durationMs: number } | null;
}

// ---------------------------------------------------------------------------
// Plan limit answers (HTTP 402)
// ---------------------------------------------------------------------------

export const PLAN_LIMIT_ERROR = "plan_limit";
export const PLAN_LIMIT_STATUS = 402;

export const LIMIT_KINDS = ["monitors", "status_pages", "interval", "channel_kind"] as const;
export type LimitKind = (typeof LIMIT_KINDS)[number];

/** The JSON body of a 402 answer from a create or update route. */
export interface PlanLimitBody {
  error: typeof PLAN_LIMIT_ERROR;
  limit: LimitKind;
  /** The plan's allowance: a count, a minimum interval in minutes, or the allowed kinds. */
  allowed: number | readonly ChannelKind[];
  /** What was asked for: the count after the create, the interval, or the kind. */
  requested: number | string;
  plan: PlanId;
  /** One plain sentence the UI can show as is. */
  message: string;
  upgradeUrl: string;
}

type Exceeded = Omit<PlanLimitBody, "error" | "plan" | "upgradeUrl">;

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * Would creating one more monitor (when `existing` already exist) exceed the
 * plan? Returns the 402 details, or null when it fits.
 */
export function checkMonitorLimit(limits: PlanLimits, existing: number): Exceeded | null {
  const after = existing + 1;
  if (after <= limits.monitors) return null;
  return {
    limit: "monitors",
    allowed: limits.monitors,
    requested: after,
    message: `Your plan includes ${plural(limits.monitors, "monitor", "monitors")}. Remove one or upgrade to add more.`,
  };
}

export function checkStatusPageLimit(limits: PlanLimits, existing: number): Exceeded | null {
  const after = existing + 1;
  if (after <= limits.statusPages) return null;
  return {
    limit: "status_pages",
    allowed: limits.statusPages,
    requested: after,
    message: `Your plan includes ${plural(limits.statusPages, "status page", "status pages")}. Remove one or upgrade to add more.`,
  };
}

/** Is a check interval of `minutes` allowed? Fractions and non-finite values count as too short. */
export function checkIntervalLimit(limits: PlanLimits, minutes: number): Exceeded | null {
  if (Number.isFinite(minutes) && minutes >= limits.minIntervalMinutes) return null;
  return {
    limit: "interval",
    allowed: limits.minIntervalMinutes,
    requested: minutes,
    message:
      limits.minIntervalMinutes === 1
        ? "Checks can run at most once a minute."
        : `Your plan checks every ${limits.minIntervalMinutes} minutes at the fastest. Add fast checks for 1-minute checks.`,
  };
}

export function checkChannelKindLimit(limits: PlanLimits, kind: ChannelKind): Exceeded | null {
  if (limits.channelKinds === "all" || limits.channelKinds.includes(kind)) return null;
  return {
    limit: "channel_kind",
    allowed: limits.channelKinds,
    requested: kind,
    message: `Your plan includes ${limits.channelKinds.join(" and ")} alerts. Upgrade to add ${kind} alerts.`,
  };
}

/** The full 402 body for a check that failed, with the tenant's plan and upgrade link. */
export function planLimitBody(exceeded: Exceeded, tenant: Pick<TenantInfo, "plan" | "urls">): PlanLimitBody {
  return { error: PLAN_LIMIT_ERROR, ...exceeded, plan: tenant.plan, upgradeUrl: tenant.urls.upgrade };
}

// ---------------------------------------------------------------------------
// Other error codes the hosted paths answer with
// ---------------------------------------------------------------------------

export const HOSTED_ERRORS = {
  /** 402: a plan limit (PlanLimitBody). */
  planLimit: PLAN_LIMIT_ERROR,
  /** 404 for /setup, /recover and the GitHub OAuth configuration in hosted mode. */
  managedByPlatform: "managed_by_platform",
  /** 404 for an internal path without a valid platform call. Same body as any unknown route. */
  notFound: "not_found",
  /** 403 for every write while the tenant is suspended (reads and exports still work). */
  tenantSuspended: "tenant_suspended",
  /** 503 in hosted mode when props are missing, of another contract version, or for another tenant. */
  unavailable: "hosted_unavailable",
  /**
   * 503 with Retry-After for a public call while the database is older than
   * the bundle: only platform calls migrate, and the next one will.
   */
  updating: "hosted_updating",
  /** 403 for a change a support sign-in may not make (section 7). */
  supportRestricted: "support_restricted",
} as const;

// ---------------------------------------------------------------------------
// The sign-in hand-off token
// ---------------------------------------------------------------------------

/** The user Worker path the platform redirects a signed-in customer to. */
export const HANDOFF_PATH = "/auth/hosted";
/** The query parameter carrying the token: `/auth/hosted?t=<token>`. */
export const HANDOFF_QUERY_PARAM = "t";
/** A token is valid for this long after it is issued. */
export const HANDOFF_TTL_SECONDS = 60;
/** Clock difference tolerated between the platform and the tenant. */
export const HANDOFF_CLOCK_SKEW_SECONDS = 5;
/** How long the tenant must remember a used nonce: past every possible expiry. */
export const HANDOFF_NONCE_RETENTION_SECONDS = HANDOFF_TTL_SECONDS + HANDOFF_CLOCK_SKEW_SECONDS;
export const HANDOFF_ISSUER = "openping-platform";
/** The first segment of every token; a new format gets a new prefix. */
export const HANDOFF_TOKEN_PREFIX = "v1";
/** Upper bound on a token's length, checked before any decoding. */
export const HANDOFF_MAX_TOKEN_LENGTH = 2048;

/** Who the hand-off signs in: the customer, or the owner as support (audited, visible to the customer). */
export const HANDOFF_ROLES = ["customer", "support"] as const;
export type HandoffRole = (typeof HANDOFF_ROLES)[number];

export interface HandoffClaims {
  v: 1;
  iss: typeof HANDOFF_ISSUER;
  /** The tenant id the token is for. */
  aud: string;
  /** The platform account id. */
  sub: string;
  email: string;
  role: HandoffRole;
  /** 16 random bytes, base64url (22 characters). The tenant stores it once used. */
  nonce: string;
  /** Issued at and expires at, in whole seconds since the epoch. */
  iat: number;
  exp: number;
}

export const HANDOFF_ERRORS = [
  "malformed",
  "bad_signature",
  "wrong_issuer",
  "wrong_tenant",
  "not_yet_valid",
  "expired",
  "lifetime_too_long",
  "replayed",
] as const;
export type HandoffError = (typeof HANDOFF_ERRORS)[number];

const NONCE_PATTERN = /^[A-Za-z0-9_-]{22}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

export function base64urlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Decodes unpadded base64url; null for anything else. */
export function base64urlDecode(text: string): Uint8Array<ArrayBuffer> | null {
  if (!BASE64URL_PATTERN.test(text) || text.length % 4 === 1) return null;
  const padded = text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4);
  try {
    const binary = atob(padded);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/** A fresh nonce: 16 random bytes, base64url. */
export function newHandoffNonce(): string {
  return base64urlEncode(crypto.getRandomValues(new Uint8Array(16)));
}

/** Builds the claims for a token issued `now` (epoch ms). */
export function handoffClaims(input: {
  tenantId: string;
  accountId: string;
  email: string;
  role?: HandoffRole;
  now: number;
  nonce?: string;
}): HandoffClaims {
  const iat = Math.floor(input.now / 1000);
  return {
    v: 1,
    iss: HANDOFF_ISSUER,
    aud: input.tenantId,
    sub: input.accountId,
    email: input.email,
    role: input.role ?? "customer",
    nonce: input.nonce ?? newHandoffNonce(),
    iat,
    exp: iat + HANDOFF_TTL_SECONDS,
  };
}

function isClaimsShape(value: unknown): value is HandoffClaims {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const c = value as Record<string, unknown>;
  return (
    c.v === 1 &&
    typeof c.iss === "string" &&
    typeof c.aud === "string" &&
    typeof c.sub === "string" &&
    c.sub.length > 0 &&
    c.sub.length <= 64 &&
    typeof c.email === "string" &&
    c.email.length <= 320 &&
    c.email.includes("@") &&
    (HANDOFF_ROLES as readonly unknown[]).includes(c.role) &&
    typeof c.nonce === "string" &&
    NONCE_PATTERN.test(c.nonce) &&
    Number.isSafeInteger(c.iat) &&
    Number.isSafeInteger(c.exp)
  );
}

export interface ParsedHandoffToken {
  claims: HandoffClaims;
  /** The bytes the signature covers: ASCII of `v1.<payload>`. */
  signingInput: Uint8Array<ArrayBuffer>;
  signature: Uint8Array<ArrayBuffer>;
}

/**
 * Splits and decodes a token without checking its signature or times.
 * Format: `v1.<base64url(UTF-8 JSON claims)>.<base64url(64-byte Ed25519 signature)>`.
 */
export function parseHandoffToken(token: string): ParsedHandoffToken | null {
  if (typeof token !== "string" || token.length > HANDOFF_MAX_TOKEN_LENGTH) return null;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== HANDOFF_TOKEN_PREFIX) return null;
  const [, payloadPart = "", signaturePart = ""] = parts;
  const payload = base64urlDecode(payloadPart);
  const signature = base64urlDecode(signaturePart);
  if (!payload || !signature || signature.length !== 64) return null;
  let claims: unknown;
  try {
    claims = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(payload));
  } catch {
    return null;
  }
  if (!isClaimsShape(claims)) return null;
  return {
    claims,
    signingInput: new Uint8Array(new TextEncoder().encode(`${HANDOFF_TOKEN_PREFIX}.${payloadPart}`)),
    signature,
  };
}

/**
 * Checks the claims (not the signature, not replay) for the tenant `tenantId`
 * at `now` (epoch ms). Returns null when they are acceptable.
 */
export function validateHandoffClaims(
  claims: HandoffClaims,
  expect: { tenantId: string; now: number },
): HandoffError | null {
  const now = Math.floor(expect.now / 1000);
  if (claims.iss !== HANDOFF_ISSUER) return "wrong_issuer";
  if (claims.aud !== expect.tenantId) return "wrong_tenant";
  if (claims.exp - claims.iat > HANDOFF_TTL_SECONDS || claims.exp <= claims.iat) return "lifetime_too_long";
  if (claims.iat > now + HANDOFF_CLOCK_SKEW_SECONDS) return "not_yet_valid";
  if (now >= claims.exp + HANDOFF_CLOCK_SKEW_SECONDS) return "expired";
  return null;
}

const ED25519 = { name: "Ed25519" } as const;

/** Imports the tenant-side verification key (HANDOFF_PUBLIC_KEY: base64url of the raw 32 bytes). */
export async function importHandoffPublicKey(base64url: string): Promise<CryptoKey> {
  const raw = base64urlDecode(base64url.trim());
  if (!raw || raw.length !== 32) throw new Error("HANDOFF_PUBLIC_KEY must be 32 bytes of base64url");
  return crypto.subtle.importKey("raw", raw, ED25519, false, ["verify"]);
}

/** Imports the platform's signing key (HANDOFF_SIGNING_KEY: base64url of the PKCS#8 DER). */
export async function importHandoffPrivateKey(base64url: string): Promise<CryptoKey> {
  const der = base64urlDecode(base64url.trim());
  if (!der) throw new Error("HANDOFF_SIGNING_KEY must be base64url PKCS#8");
  return crypto.subtle.importKey("pkcs8", der, ED25519, false, ["sign"]);
}

/** A new key pair in the two text forms above (for the owner's setup step and for tests). */
export async function generateHandoffKeyPair(): Promise<{ publicKey: string; privateKey: string }> {
  const pair = (await crypto.subtle.generateKey(ED25519, true, ["sign", "verify"])) as CryptoKeyPair;
  const raw = (await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer;
  const pkcs8 = (await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer;
  return { publicKey: base64urlEncode(new Uint8Array(raw)), privateKey: base64urlEncode(new Uint8Array(pkcs8)) };
}

/** Signs claims into a token (platform side). */
export async function signHandoffToken(claims: HandoffClaims, privateKey: CryptoKey): Promise<string> {
  const payload = base64urlEncode(new TextEncoder().encode(JSON.stringify(claims)));
  const signingInput = `${HANDOFF_TOKEN_PREFIX}.${payload}`;
  const signature = await crypto.subtle.sign(ED25519, privateKey, new TextEncoder().encode(signingInput));
  return `${signingInput}.${base64urlEncode(new Uint8Array(signature))}`;
}

export type HandoffVerification = { ok: true; claims: HandoffClaims } | { ok: false; error: HandoffError };

/**
 * Verifies a token (tenant side): format, signature, issuer, audience and
 * times. Replay is the caller's job: after this succeeds, record
 * `claims.nonce` atomically (an INSERT that fails on a duplicate) and answer
 * "replayed" when it was already there; keep it HANDOFF_NONCE_RETENTION_SECONDS
 * past `claims.exp`.
 */
export async function verifyHandoffToken(
  token: string,
  publicKey: CryptoKey,
  expect: { tenantId: string; now: number },
): Promise<HandoffVerification> {
  const parsed = parseHandoffToken(token);
  if (!parsed) return { ok: false, error: "malformed" };
  let valid: boolean;
  try {
    valid = await crypto.subtle.verify(ED25519, publicKey, parsed.signature, parsed.signingInput);
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, error: "bad_signature" };
  const error = validateHandoffClaims(parsed.claims, expect);
  if (error) return { ok: false, error };
  return { ok: true, claims: parsed.claims };
}
