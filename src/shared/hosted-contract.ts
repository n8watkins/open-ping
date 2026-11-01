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
  /**
   * Polled monitors that may be checked more often than every
   * STANDARD_CHECK_MINUTES (paused ones count); 0 on a plan without fast
   * checks. Read it through fastMonitorAllowance, which also answers for a
   * platform that doesn't send it yet.
   */
  fastMonitors: number;
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
  trial: { monitors: 5, statusPages: 1, minIntervalMinutes: 12, fastMonitors: 0, channelKinds: ["email"], emailsPerDay: 50 },
  hosted: { monitors: 20, statusPages: 2, minIntervalMinutes: 12, fastMonitors: 0, channelKinds: "all", emailsPerDay: 500 },
  hosted_fast: { monitors: 20, statusPages: 2, minIntervalMinutes: 1, fastMonitors: 5, channelKinds: "all", emailsPerDay: 500 },
};

/**
 * The interval every plan checks at, in minutes: the self-hosted cron's. A
 * polled monitor set to check more often than this is a fast monitor, and
 * counts against `PlanLimits.fastMonitors`.
 */
export const STANDARD_CHECK_MINUTES = 12;

/** Is a polled monitor checked every `seconds` a fast monitor? */
export function isFastInterval(seconds: number): boolean {
  return Number.isFinite(seconds) && seconds < STANDARD_CHECK_MINUTES * 60;
}

/**
 * How many fast monitors the limits allow. A platform older than the
 * `fastMonitors` field sends none: then every monitor may be fast when the
 * plan's shortest interval is under 12 minutes, as it was before the field.
 */
export function fastMonitorAllowance(limits: Pick<PlanLimits, "monitors" | "minIntervalMinutes"> & { fastMonitors?: unknown }): number {
  const { fastMonitors } = limits;
  if (typeof fastMonitors === "number" && Number.isSafeInteger(fastMonitors) && fastMonitors >= 0) return fastMonitors;
  return limits.minIntervalMinutes < STANDARD_CHECK_MINUTES ? limits.monitors : 0;
}

// ---------------------------------------------------------------------------
// Packs: more monitors on a paid plan (decision D13)
// ---------------------------------------------------------------------------

/**
 * What a customer can add to a paid plan, each as a quantity on the
 * subscription. The platform adds them to the plan's limits and sends the
 * final numbers in `tenant.limits`: a tenant never sees a pack, and never
 * works out a limit itself.
 *
 * - `monitors`: 25 more monitors (checked at the plan's intervals), at most 4.
 * - `fast_monitors`: 5 more fast monitors, at most 3, only with the fast
 *   checks add-on (`hosted_fast`).
 *
 * Larger accounts ask support, who grant more through the per-tenant
 * overrides on top of these.
 */
export const PACK_KINDS = ["monitors", "fast_monitors"] as const;
export type PackKind = (typeof PACK_KINDS)[number];

export const PACKS: Readonly<Record<PackKind, Readonly<{ adds: number; max: number; plans: readonly PlanId[] }>>> = {
  monitors: { adds: 25, max: 4, plans: ["hosted", "hosted_fast"] },
  fast_monitors: { adds: 5, max: 3, plans: ["hosted_fast"] },
};

/** How many of each pack an account has. */
export type PackQuantities = Readonly<Record<PackKind, number>>;

export const NO_PACKS: PackQuantities = { monitors: 0, fast_monitors: 0 };

/**
 * The packs that count on `plan`: each a whole number from 0 to its maximum,
 * and 0 on a plan it isn't sold with (a trial, or fast packs without the fast
 * checks add-on).
 */
export function packsForPlan(plan: PlanId, packs: Partial<Record<PackKind, unknown>>): PackQuantities {
  const out = { ...NO_PACKS };
  for (const kind of PACK_KINDS) {
    const pack = PACKS[kind];
    const raw = packs[kind];
    const n = typeof raw === "number" && Number.isFinite(raw) ? Math.floor(raw) : 0;
    out[kind] = pack.plans.includes(plan) ? Math.min(pack.max, Math.max(0, n)) : 0;
  }
  return out;
}

/**
 * A support grant (the platform's per-tenant `limit_overrides`): what the
 * owner gives one tenant on top of what it pays for. Counts are added to the
 * plan and its packs, so a grant never takes away a pack the customer paid
 * for; `minIntervalMinutes` and `channelKinds` only ever widen (the shorter
 * interval, the union of kinds). Fast monitors are granted only through
 * `fastMonitors`: a shorter interval alone lets no monitor be fast.
 */
export type LimitGrant = Partial<PlanLimits>;

/** The limits with a support grant on top (platform side): see LimitGrant. */
export function withLimitGrant(limits: PlanLimits, grant: LimitGrant | null | undefined): PlanLimits {
  if (!grant) return limits;
  const add = (base: number, extra: number | undefined) => base + (typeof extra === "number" && Number.isFinite(extra) && extra > 0 ? Math.floor(extra) : 0);
  const kinds = grant.channelKinds;
  return {
    ...limits,
    monitors: add(limits.monitors, grant.monitors),
    statusPages: add(limits.statusPages, grant.statusPages),
    fastMonitors: add(limits.fastMonitors, grant.fastMonitors),
    emailsPerDay: add(limits.emailsPerDay, grant.emailsPerDay),
    minIntervalMinutes:
      typeof grant.minIntervalMinutes === "number" && grant.minIntervalMinutes >= 1
        ? Math.min(limits.minIntervalMinutes, grant.minIntervalMinutes)
        : limits.minIntervalMinutes,
    channelKinds:
      limits.channelKinds === "all" || kinds === "all"
        ? "all"
        : kinds
          ? [...new Set([...limits.channelKinds, ...kinds])]
          : limits.channelKinds,
  };
}

/** A plan's limits with its packs added (platform side; the result is what `tenant.limits` carries). */
export function planLimitsWithPacks(plan: PlanId, packs: Partial<Record<PackKind, unknown>> = NO_PACKS): PlanLimits {
  const base = PLAN_LIMITS[plan];
  const counted = packsForPlan(plan, packs);
  return {
    ...base,
    monitors: base.monitors + counted.monitors * PACKS.monitors.adds,
    fastMonitors: base.fastMonitors + counted.fast_monitors * PACKS.fast_monitors.adds,
  };
}

/** Links into the platform the customer's OpenPing shows (Settings, 402 answers, sign-out). */
export interface HostedUrls {
  /** The customer's account page on the platform. */
  account: string;
  /** Billing (Stripe Customer Portal entry on the platform). */
  billing: string;
  /** Where a limit answer points: the upgrade or add-on page (upgradeUrlFor adds what is needed). */
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
  /** Polled monitors set to check more often than every STANDARD_CHECK_MINUTES. Absent from older bundles. */
  fastMonitors?: number;
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
  /**
   * When this tenant next has work (epoch ms), set when outcome is "ran": the
   * earliest moment a call finds a monitor due, a heartbeat deadline passed or
   * a schedule window starting. Never later than the run's start plus
   * SCHEDULED_MAX_GAP_MS, and possibly already past (a backlog the budget
   * deferred). The platform calls on its first tick at or after it
   * (nextScheduledCall). Absent from older bundles.
   */
  nextDueAt?: number;
}

/**
 * The longest a tenant goes without a scheduler run: the self-hosted cron's 12
 * minutes. A tenant never reports a nextDueAt later than this after its run
 * started, so alerts, reports and cleanup keep at least today's cadence.
 */
export const SCHEDULED_MAX_GAP_MS = 12 * 60 * 1000;

/**
 * When the platform should next call a tenant's scheduler, given the summary of
 * its last call (null when the call got no answer) and the time now (epoch ms).
 * A result at or before `now` means the next tick.
 *
 * - "ran" with nextDueAt: that time, clamped to SCHEDULED_MAX_GAP_MS after the run started.
 * - "ran" without nextDueAt (an older bundle): SCHEDULED_MAX_GAP_MS after the run started.
 * - "failed", "lease_busy" or no answer: the next tick (the platform may back off a tenant that keeps failing).
 */
export function nextScheduledCall(
  summary: Pick<ScheduledRunSummary, "outcome" | "startedAt" | "nextDueAt"> | null,
  now: number,
): number {
  if (!summary || summary.outcome !== "ran") return now;
  const latest = summary.startedAt + SCHEDULED_MAX_GAP_MS;
  const due = summary.nextDueAt;
  return typeof due === "number" && Number.isFinite(due) ? Math.min(due, latest) : latest;
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

export const LIMIT_KINDS = ["monitors", "status_pages", "interval", "fast_monitors", "channel_kind"] as const;
export type LimitKind = (typeof LIMIT_KINDS)[number];

/** The JSON body of a 402 answer from a create or update route. */
export interface PlanLimitBody {
  error: typeof PLAN_LIMIT_ERROR;
  limit: LimitKind;
  /** The plan's allowance: a count (monitors, status pages, fast monitors), a minimum interval in minutes, or the allowed kinds. */
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

/**
 * Would `adding` more fast monitors (when `existing` already are) exceed the
 * plan? An edit counts the monitor's others: `existing` leaves it out.
 */
export function checkFastMonitorLimit(limits: PlanLimits, existing: number, adding = 1): Exceeded | null {
  const allowed = fastMonitorAllowance(limits);
  const after = existing + adding;
  if (adding <= 0 || after <= allowed) return null;
  return {
    limit: "fast_monitors",
    allowed,
    requested: after,
    message:
      allowed === 0
        ? `Checks more often than every ${STANDARD_CHECK_MINUTES} minutes come with the fast checks add-on.`
        : `Your plan includes ${plural(allowed, "fast monitor", "fast monitors")}, checked more often than every ${STANDARD_CHECK_MINUTES} minutes. ` +
          `Set one to ${STANDARD_CHECK_MINUTES} minutes or more, or add more fast monitors.`,
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

/** The query parameter an upgrade link names the limit with, so the platform leads with what fixes it. */
export const UPGRADE_NEED_PARAM = "need";

/**
 * The upgrade link for a limit: `urls.upgrade` with `?need=<limit kind>`, so
 * the platform's upgrade page leads with the fast checks add-on, a monitor
 * pack or a fast monitor pack. A platform that ignores it shows its usual page.
 */
export function upgradeUrlFor(upgrade: string, limit: LimitKind): string {
  try {
    const url = new URL(upgrade);
    url.searchParams.set(UPGRADE_NEED_PARAM, limit);
    return url.href;
  } catch {
    return upgrade;
  }
}

/** The full 402 body for a check that failed, with the tenant's plan and upgrade link. */
export function planLimitBody(exceeded: Exceeded, tenant: Pick<TenantInfo, "plan" | "urls">): PlanLimitBody {
  return { error: PLAN_LIMIT_ERROR, ...exceeded, plan: tenant.plan, upgradeUrl: upgradeUrlFor(tenant.urls.upgrade, exceeded.limit) };
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

// ---------------------------------------------------------------------------
// Starter mode: ordinary Workers, called over HTTPS with signed requests
// ---------------------------------------------------------------------------

/**
 * How the platform and a customer's OpenPing reach each other
 * (docs/hosted/CONTRACT.md, section 10).
 *
 * - "dispatch": the user Worker lives in the dispatch namespace; the platform
 *   calls it with props through the namespace binding, and `props.platform`
 *   is an RPC stub. This is the default and needs Workers for Platforms.
 * - "https" (starter mode): the user Worker is an ordinary Worker on the
 *   account (`t-<tenant id>`, reached through its own Custom Domain). There
 *   are no props from the runtime, so every call between the two is HTTPS,
 *   signed with a secret only this tenant and the platform know, and the
 *   user Worker builds the very same TenantProps from what verifies.
 */
export const TENANT_TRANSPORTS = ["dispatch", "https"] as const;
export type TenantTransport = (typeof TENANT_TRANSPORTS)[number];

/** The plain vars and the secret the platform adds to a starter mode user Worker. */
export const STARTER_ENV = {
  /** "https" turns starter mode on (with HOSTED_MODE "1"). Absent or anything else: dispatch. */
  transport: "HOSTED_TRANSPORT",
  /** The platform's origin, `https://app.<hosted domain>`, for the tenant's calls back. */
  platformUrl: "PLATFORM_URL",
  /** Secret: this tenant's own PLATFORM_CALL_SECRET (generatePlatformCallSecret). Never shared between tenants. */
  callSecret: "PLATFORM_CALL_SECRET",
} as const;

/** The value of HOSTED_TRANSPORT that turns starter mode on. */
export const STARTER_TRANSPORT_ON = "https";

/** The transport a user Worker's HOSTED_TRANSPORT var selects. Strict: only exactly "https" is starter mode. */
export function hostedTransport(value: unknown): TenantTransport {
  return value === STARTER_TRANSPORT_ON ? "https" : "dispatch";
}

/**
 * The platform's endpoints a starter mode tenant calls, on `app.<domain>`.
 * Each is a POST with a JSON body, signed tenant-to-platform, and answered
 * with a JSON body signed platform-to-tenant (signResponse).
 */
export const TENANT_CALL_PATH_PREFIX = "/__tenant/v1/";
export const TENANT_CALL_PATHS = {
  /** Body `{}`; answers TenantInfoAnswer, or 409 `tenant_not_ready` while provisioning or removing. */
  info: "/__tenant/v1/info",
  /** Body HostedEmail; answers SendEmailResult. */
  sendEmail: "/__tenant/v1/send-email",
  /** Body UsageCounts; answers `{ ok: true }`. */
  reportUsage: "/__tenant/v1/report-usage",
  /** Body HostedAuditEvent; answers `{ ok: true }`. */
  audit: "/__tenant/v1/audit",
} as const;

/** The `error` of a 409 from TENANT_CALL_PATHS.info: the tenant is being provisioned or removed. */
export const TENANT_NOT_READY_ERROR = "tenant_not_ready";

export function isTenantCallPath(pathname: string): boolean {
  return pathname === TENANT_CALL_PATH_PREFIX.slice(0, -1) || pathname.startsWith(TENANT_CALL_PATH_PREFIX);
}

/** The answer of TENANT_CALL_PATHS.info: who the tenant is right now, as props would say. */
export interface TenantInfoAnswer {
  contract: typeof HOSTED_CONTRACT_VERSION;
  tenant: TenantInfo;
}

/**
 * How long a starter mode tenant may keep a TenantInfoAnswer for its public
 * requests: the platform's own cache of a tenant row (TENANT_CACHE_MS), so a
 * suspension or a plan change reaches a tenant as fast in both modes.
 */
export const STARTER_INFO_CACHE_MS = 30_000;
/**
 * How long a tenant may keep serving its last answer when the platform can't
 * be reached. Past this, public requests answer 503 `hosted_unavailable`,
 * exactly as they would in dispatch mode with the platform down.
 */
export const STARTER_INFO_STALE_MS = 10 * 60_000;

/** The headers of a signed call. All start with INTERNAL_HEADER_PREFIX, so a dispatch platform strips them from public traffic too. */
export const SIGNED_CALL_HEADERS = {
  /** `v1=<base64url of the 32-byte HMAC-SHA256>`. */
  signature: "x-openping-signature",
  /** Epoch milliseconds, decimal. */
  timestamp: "x-openping-timestamp",
  /** 16 random bytes, base64url (22 characters), new for every call. */
  nonce: "x-openping-nonce",
  /** The tenant id the call is for (platform-to-tenant) or from (tenant-to-platform). */
  tenant: "x-openping-tenant",
  /** Platform-to-tenant only: base64url of the JSON SignedCallProps. */
  props: "x-openping-props",
} as const;

/** A signed call is accepted this long either side of its timestamp. */
export const SIGNED_CALL_MAX_SKEW_MS = 30_000;
/** How long the receiver must remember a nonce: past the end of every window it could be accepted in. */
export const SIGNED_CALL_NONCE_RETENTION_MS = 2 * SIGNED_CALL_MAX_SKEW_MS + 5_000;
/** The largest body a signed call may carry; anything longer is refused before it is read in full. */
export const SIGNED_CALL_MAX_BODY_BYTES = 256 * 1024;
/** The largest x-openping-props header. */
export const SIGNED_CALL_MAX_PROPS_LENGTH = 8 * 1024;

/** Which way a call goes. Each has its own key, so a signature can't be reflected back to the side that made it. */
export const SIGNED_DIRECTIONS = ["platform-to-tenant", "tenant-to-platform"] as const;
export type SignedDirection = (typeof SIGNED_DIRECTIONS)[number];

/**
 * What a platform-to-tenant call carries in x-openping-props: TenantProps
 * without the capability, which in starter mode is the tenant's own HTTPS
 * client (and can't travel in a header). `invocation` is always "platform":
 * public traffic never passes through the platform in starter mode.
 */
export type SignedCallProps = Omit<TenantProps, "platform">;

export const SIGNED_CALL_ERRORS = [
  /** No signature header at all: a public request. */
  "unsigned",
  /** A header missing or not in its format. */
  "malformed",
  "bad_signature",
  /** Signed for, or by, another tenant. */
  "wrong_tenant",
  "expired",
  "not_yet_valid",
  "body_too_large",
  /** x-openping-props doesn't describe this tenant in this contract version. */
  "bad_props",
  /** The nonce was seen before (the receiver's nonce store says so). */
  "replayed",
] as const;
export type SignedCallError = (typeof SIGNED_CALL_ERRORS)[number];

const CALL_SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const SIGNATURE_PREFIX = "v1=";
const CANONICAL_REQUEST_LABEL = "openping-signed-call-v1";
const CANONICAL_RESPONSE_LABEL = "openping-signed-response-v1";
const HKDF_SALT = "openping/platform-call-secret/v1";

/** A new PLATFORM_CALL_SECRET: 32 random bytes, base64url (43 characters). One per tenant, never reused. */
export function generatePlatformCallSecret(): string {
  return base64urlEncode(crypto.getRandomValues(new Uint8Array(32)));
}

export function isPlatformCallSecret(value: unknown): value is string {
  return typeof value === "string" && CALL_SECRET_PATTERN.test(value);
}

/** The two HMAC-SHA256 keys a tenant's secret gives, one per direction (HKDF-SHA256, RFC 5869). */
export interface CallKeys {
  platformToTenant: CryptoKey;
  tenantToPlatform: CryptoKey;
}

export async function deriveCallKeys(secret: string): Promise<CallKeys> {
  const raw = isPlatformCallSecret(secret) ? base64urlDecode(secret) : null;
  if (!raw || raw.length !== 32) throw new Error("PLATFORM_CALL_SECRET must be 32 bytes of base64url");
  const base = await crypto.subtle.importKey("raw", raw, "HKDF", false, ["deriveKey"]);
  const derive = (direction: SignedDirection) =>
    crypto.subtle.deriveKey(
      { name: "HKDF", hash: "SHA-256", salt: new TextEncoder().encode(HKDF_SALT), info: new TextEncoder().encode(direction) },
      base,
      { name: "HMAC", hash: "SHA-256", length: 256 },
      false,
      ["sign", "verify"],
    );
  const [platformToTenant, tenantToPlatform] = await Promise.all([derive("platform-to-tenant"), derive("tenant-to-platform")]);
  return { platformToTenant, tenantToPlatform };
}

/** The key that signs (and verifies) calls going `direction`. */
export function keyFor(keys: CallKeys, direction: SignedDirection): CryptoKey {
  return direction === "platform-to-tenant" ? keys.platformToTenant : keys.tenantToPlatform;
}

/** The other direction: what the answer to a call going `direction` is signed with. */
export function reverseDirection(direction: SignedDirection): SignedDirection {
  return direction === "platform-to-tenant" ? "tenant-to-platform" : "platform-to-tenant";
}

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The exact text a request signature covers, one field per line: the label,
 * the direction, the tenant id, the method, the host, the path and query,
 * the timestamp, the nonce, the SHA-256 of the body (hex), and the props and
 * call id headers ("-" when absent). Everything the receiver acts on is in it.
 */
export function canonicalRequest(input: {
  direction: SignedDirection;
  tenantId: string;
  method: string;
  url: string;
  timestamp: string;
  nonce: string;
  bodySha256: string;
  props: string | null;
  callId: string | null;
}): string {
  const url = new URL(input.url);
  return [
    CANONICAL_REQUEST_LABEL,
    input.direction,
    input.tenantId,
    input.method.toUpperCase(),
    url.host.toLowerCase(),
    `${url.pathname}${url.search}`,
    input.timestamp,
    input.nonce,
    input.bodySha256,
    input.props ?? "-",
    input.callId ?? "-",
  ].join("\n");
}

async function hmac(key: CryptoKey, text: string): Promise<string> {
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(text));
  return `${SIGNATURE_PREFIX}${base64urlEncode(new Uint8Array(signature))}`;
}

/** Constant-time check of a `v1=` signature header against `text`. */
async function hmacMatches(key: CryptoKey, text: string, header: string | null): Promise<boolean> {
  if (!header || !header.startsWith(SIGNATURE_PREFIX)) return false;
  const mac = base64urlDecode(header.slice(SIGNATURE_PREFIX.length));
  if (!mac || mac.length !== 32) return false;
  try {
    return await crypto.subtle.verify("HMAC", key, mac, new TextEncoder().encode(text));
  } catch {
    return false;
  }
}

/** Encodes props for x-openping-props (platform side). */
export function encodeSignedCallProps(props: SignedCallProps): string {
  return base64urlEncode(new TextEncoder().encode(JSON.stringify(props)));
}

/** Decodes and checks x-openping-props for `tenantId`; null when it isn't well-formed props of this contract for that tenant. */
export function decodeSignedCallProps(header: string, tenantId: string): SignedCallProps | null {
  if (header.length > SIGNED_CALL_MAX_PROPS_LENGTH) return null;
  const bytes = base64urlDecode(header);
  if (!bytes) return null;
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  // isTenantProps checks everything but the capability, which never travels.
  const candidate = { ...(value as Record<string, unknown>), platform: {} };
  if (!isTenantProps(candidate, tenantId) || candidate.invocation !== "platform") return null;
  const { platform: _platform, ...props } = candidate;
  return props as SignedCallProps;
}

/** Reads a body up to `max` bytes; null when it is longer. */
async function readBounded(body: ReadableStream<Uint8Array> | null, max: number): Promise<Uint8Array<ArrayBuffer> | null> {
  if (!body) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

/**
 * Signs a call (either side): a new Request with the same method, URL and
 * body and the signed-call headers set. Any x-openping-* header `init`
 * carries other than INTERNAL_HEADER is dropped first, so only what is
 * signed travels.
 */
export async function signRequest(
  input: { method: string; url: string; body?: string; headers?: HeadersInit },
  sign: {
    direction: SignedDirection;
    tenantId: string;
    keys: CallKeys;
    now: number;
    nonce?: string;
    /** Platform-to-tenant: the props this call carries (callId goes in INTERNAL_HEADER too). */
    props?: SignedCallProps;
  },
): Promise<Request> {
  const headers = new Headers(input.headers);
  for (const name of [...headers.keys()]) {
    if (name.startsWith(INTERNAL_HEADER_PREFIX) && name !== INTERNAL_HEADER) headers.delete(name);
  }
  const body = new Uint8Array(new TextEncoder().encode(input.body ?? ""));
  if (body.byteLength > SIGNED_CALL_MAX_BODY_BYTES) throw new Error("signed call body is too large");
  const timestamp = String(Math.floor(sign.now));
  const nonce = sign.nonce ?? newHandoffNonce();
  const props = sign.props ? encodeSignedCallProps(sign.props) : null;
  if (props && props.length > SIGNED_CALL_MAX_PROPS_LENGTH) throw new Error("signed call props are too large");
  const callId = sign.props ? sign.props.callId : headers.get(INTERNAL_HEADER);
  if (sign.props) headers.set(INTERNAL_HEADER, sign.props.callId);
  const text = canonicalRequest({
    direction: sign.direction,
    tenantId: sign.tenantId,
    method: input.method,
    url: input.url,
    timestamp,
    nonce,
    bodySha256: await sha256Hex(body),
    props,
    callId,
  });
  headers.set(SIGNED_CALL_HEADERS.tenant, sign.tenantId);
  headers.set(SIGNED_CALL_HEADERS.timestamp, timestamp);
  headers.set(SIGNED_CALL_HEADERS.nonce, nonce);
  if (props) headers.set(SIGNED_CALL_HEADERS.props, props);
  headers.set(SIGNED_CALL_HEADERS.signature, await hmac(keyFor(sign.keys, sign.direction), text));
  const method = input.method.toUpperCase();
  return new Request(input.url, { method, headers, body: method === "GET" || method === "HEAD" ? undefined : body });
}

export type SignedCallVerification =
  | {
      ok: true;
      tenantId: string;
      nonce: string;
      /** When the receiver may forget the nonce (epoch ms). */
      nonceExpiresAt: number;
      /** Platform-to-tenant: the props the call carries. */
      props: SignedCallProps | null;
      /** The same request, with its body buffered so it can still be read. */
      request: Request;
    }
  | { ok: false; error: SignedCallError; /** The request with its body, when it could be read, for handling as public. */ request: Request | null };

/** True when a request carries the signature header, so it must verify or be treated as public. */
export function hasSignedCallHeaders(headers: Headers): boolean {
  return headers.has(SIGNED_CALL_HEADERS.signature);
}

const TIMESTAMP_PATTERN = /^\d{1,16}$/;
const CALL_NONCE_PATTERN = /^[A-Za-z0-9_-]{22}$/;

/**
 * Verifies a signed call (either side): the headers' format, the timestamp
 * within SIGNED_CALL_MAX_SKEW_MS of `now`, the body within
 * SIGNED_CALL_MAX_BODY_BYTES, the HMAC over canonicalRequest with the key
 * for `direction`, and, platform-to-tenant, the props for this tenant.
 * `keysFor` answers the tenant's keys (the tenant: its own, only for its own
 * id; the platform: looked up by the claimed id), or null for an unknown
 * tenant. Cheap checks first: no key is looked up and no body is read for a
 * call that is malformed or outside its window.
 *
 * Replay is the caller's job, as for hand-off tokens: after this succeeds,
 * record `nonce` with an INSERT that fails on a duplicate, keep it until
 * `nonceExpiresAt`, and refuse the call as "replayed" when it was there.
 */
export async function verifySignedRequest(
  request: Request,
  expect: {
    direction: SignedDirection;
    now: number;
    keysFor: (tenantId: string) => Promise<CallKeys | null>;
  },
): Promise<SignedCallVerification> {
  const h = request.headers;
  const signature = h.get(SIGNED_CALL_HEADERS.signature);
  if (!signature) return { ok: false, error: "unsigned", request };
  const tenantId = h.get(SIGNED_CALL_HEADERS.tenant);
  const timestamp = h.get(SIGNED_CALL_HEADERS.timestamp);
  const nonce = h.get(SIGNED_CALL_HEADERS.nonce);
  const propsHeader = h.get(SIGNED_CALL_HEADERS.props);
  if (!isTenantId(tenantId) || !timestamp || !TIMESTAMP_PATTERN.test(timestamp) || !nonce || !CALL_NONCE_PATTERN.test(nonce)) {
    return { ok: false, error: "malformed", request };
  }
  const toTenant = expect.direction === "platform-to-tenant";
  // Props travel platform-to-tenant only, and always there.
  if (toTenant !== (propsHeader !== null)) return { ok: false, error: "malformed", request };
  const at = Number(timestamp);
  if (at > expect.now + SIGNED_CALL_MAX_SKEW_MS) return { ok: false, error: "not_yet_valid", request };
  if (at < expect.now - SIGNED_CALL_MAX_SKEW_MS) return { ok: false, error: "expired", request };
  const declared = Number(h.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > SIGNED_CALL_MAX_BODY_BYTES) return { ok: false, error: "body_too_large", request: null };
  const body = await readBounded(request.body, SIGNED_CALL_MAX_BODY_BYTES);
  if (!body) return { ok: false, error: "body_too_large", request: null };
  const method = request.method.toUpperCase();
  const bufferedHeaders = new Headers(h);
  bufferedHeaders.delete("content-length");
  const buffered = new Request(request.url, {
    method,
    headers: bufferedHeaders,
    body: method === "GET" || method === "HEAD" ? undefined : body,
  });
  const keys = await expect.keysFor(tenantId);
  if (!keys) return { ok: false, error: "wrong_tenant", request: buffered };
  const text = canonicalRequest({
    direction: expect.direction,
    tenantId,
    method,
    url: request.url,
    timestamp,
    nonce,
    bodySha256: await sha256Hex(body),
    props: propsHeader,
    callId: h.get(INTERNAL_HEADER),
  });
  if (!(await hmacMatches(keyFor(keys, expect.direction), text, signature))) return { ok: false, error: "bad_signature", request: buffered };
  let props: SignedCallProps | null = null;
  if (propsHeader !== null) {
    props = decodeSignedCallProps(propsHeader, tenantId);
    if (!props || props.callId !== h.get(INTERNAL_HEADER)) return { ok: false, error: "bad_props", request: buffered };
  }
  return { ok: true, tenantId, nonce, nonceExpiresAt: at + SIGNED_CALL_NONCE_RETENTION_MS, props, request: buffered };
}

/** The text an answer's signature covers: bound to the call's nonce, so an answer can't be replayed onto another call. */
export function canonicalResponse(input: { direction: SignedDirection; tenantId: string; requestNonce: string; status: number; bodySha256: string }): string {
  return [CANONICAL_RESPONSE_LABEL, input.direction, input.tenantId, input.requestNonce, String(input.status), input.bodySha256].join("\n");
}

/**
 * Signs the answer to a verified call, with the key of the opposite
 * direction (the platform answers a tenant's call platform-to-tenant).
 */
export async function signResponse(
  answer: { status: number; body: string; headers?: HeadersInit },
  sign: { requestDirection: SignedDirection; tenantId: string; requestNonce: string; keys: CallKeys },
): Promise<Response> {
  const direction = reverseDirection(sign.requestDirection);
  const bytes = new Uint8Array(new TextEncoder().encode(answer.body));
  const headers = new Headers(answer.headers);
  if (!headers.has("content-type")) headers.set("content-type", "application/json");
  headers.set("cache-control", "no-store");
  const text = canonicalResponse({ direction, tenantId: sign.tenantId, requestNonce: sign.requestNonce, status: answer.status, bodySha256: await sha256Hex(bytes) });
  headers.set(SIGNED_CALL_HEADERS.signature, await hmac(keyFor(sign.keys, direction), text));
  return new Response(bytes, { status: answer.status, headers });
}

/**
 * Checks the answer to a call this side signed, and reads its body (at most
 * SIGNED_CALL_MAX_BODY_BYTES). Null when the answer isn't signed by the
 * other side for this call: the caller treats that as no answer.
 */
export async function verifySignedResponse(
  response: Response,
  expect: { requestDirection: SignedDirection; tenantId: string; requestNonce: string; keys: CallKeys },
): Promise<{ status: number; text: string } | null> {
  const direction = reverseDirection(expect.requestDirection);
  const body = await readBounded(response.body, SIGNED_CALL_MAX_BODY_BYTES);
  if (!body) return null;
  const text = canonicalResponse({ direction, tenantId: expect.tenantId, requestNonce: expect.requestNonce, status: response.status, bodySha256: await sha256Hex(body) });
  if (!(await hmacMatches(keyFor(expect.keys, direction), text, response.headers.get(SIGNED_CALL_HEADERS.signature)))) return null;
  return { status: response.status, text: new TextDecoder().decode(body) };
}
