/**
 * Provisioning a customer's OpenPing (build plan, B3).
 *
 * A tenant moves through `tenants.provision_state`, one step at a time, and
 * the state is written after each step, so a run that dies anywhere picks up
 * where it stopped:
 *
 *   requested   the row exists; its MASTER_KEY is generated and escrowed,
 *               then its D1 database is created         -> db_created
 *   db_created  the current bundle is uploaded as t-<id> with the database,
 *               the hosted vars and the secret           -> uploaded
 *   uploaded    the tenant applies its bundled migrations
 *               (one platform call to /__platform/scheduled) -> migrated
 *   migrated    /__platform/health answers ok            -> ready
 *   ready       dispatched to; provisioning is done
 *
 *   deleting    a cancelled or removed tenant being torn down: script,
 *               then database, then the row (removeTenant)
 *
 * Every remote step is idempotent: the database is looked up by its name
 * before it is created, the upload starts by deleting any half-made script,
 * and deleting something already gone succeeds.
 *
 * Runs are driven by the provisioning queue (./provisioning-queue.ts): a
 * message when the tenant is requested and one per retry. A queue consumer
 * has minutes, not the 30 seconds a waitUntil gets, and a message whose run
 * dies is delivered again. The every-minute cron (`provisionDue`) is the
 * safety net for anything a message missed.
 *
 * A failed step is tried again with backoff. A failure retrying can't fix
 * (a Cloudflare 4xx, a broken bundle, a PLATFORM_KEY that can't open the
 * escrowed key), or PROVISION_MAX_ATTEMPTS failures in a row, pauses the
 * tenant instead (`provision_paused_at`), with nothing rolled back: one bad
 * token or release must not throw away every sign-up. The owner then fixes
 * the cause and calls `resumeProvisioning`, or `removeTenant`.
 *
 * Only one run works on a tenant at a time: a lease on its row with a token,
 * renewed before each step and checked by every write the run makes.
 */

import {
  PLATFORM_HEALTH_PATH,
  PLATFORM_SCHEDULED_PATH,
  HOSTED_ENV,
  HOSTED_MODE_ON,
  isTenantId,
  tenantDatabaseName,
  tenantScriptName,
  type HealthResponse,
  type PlanId,
  type PlatformCapability,
  type ScheduledRequest,
  type ScheduledRunSummary,
} from "../../src/shared/hosted-contract";
import type { BundleSource } from "./bundle";
import { CloudflareApiError, type CloudflareApi } from "./cloudflare/api";
import { uploadUserWorker } from "./cloudflare/upload";
import { callTenant, type TenantDispatcher } from "./dispatch";
import { PermanentError } from "./errors";
import { ensureMasterKey } from "./keys";
import { checkSlugAvailability, holdSlug, type SlugAvailability } from "./slugs";
import { PROVISION_STATES, forgetTenant, tenantFromRow, type ProvisionState, type TenantRecord } from "./tenants";
import { log } from "./log";

/** Failures in a row before a tenant is paused for the owner. */
export const PROVISION_MAX_ATTEMPTS = 6;
/** Wait before attempt n+1 after n failures (the last value repeats). About 45 minutes in all. */
export const PROVISION_BACKOFF_MS = [10_000, 30_000, 120_000, 600_000, 1_800_000] as const;
/** How long a run holds a tenant without renewing (it renews before each step); a dead run frees it after this. */
export const PROVISION_LEASE_MS = 2 * 60_000;
/** A new tenant's trial (decision D5). */
export const TRIAL_DAYS = 14;

/** What provisioning needs from the platform's env, checked once (provisioningConfig in ./index.ts). */
export interface ProvisioningConfig {
  hostedDomain: string;
  /** The dispatch namespace's name (DISPATCH_NAMESPACE), for the API; the binding is TENANTS. */
  namespace: string;
  /** PLATFORM_KEY: escrows each tenant's MASTER_KEY. */
  platformKey: string;
  /** HANDOFF_PUBLIC_KEY: every tenant's copy of the hand-off verification key. */
  handoffPublicKey: string;
  /** TENANT_LOG_SAMPLING: Workers Logs' head sampling rate for every user Worker, 0 to 1; 1 when absent. */
  tenantLogSampling?: number;
}

export interface ProvisioningDeps {
  db: D1Database;
  api: CloudflareApi;
  bundles: BundleSource;
  dispatcher: TenantDispatcher;
  /** The capability a platform call to `tenant` carries as props.platform. */
  capability(tenant: TenantRecord): PlatformCapability;
  config: ProvisioningConfig;
  now?: () => number;
}

export type ProvisionOutcome =
  | { kind: "ready"; tenantId: string }
  /** A step failed; it is tried again at `nextAt`. */
  | { kind: "retry"; tenantId: string; state: ProvisionState; attempts: number; nextAt: number; error: string }
  /** Stopped for the owner: a permanent failure, or too many in a row. Nothing was rolled back. */
  | { kind: "paused"; tenantId: string; state: ProvisionState; error: string }
  /** Torn down (removeTenant). The row is gone. */
  | { kind: "removed"; tenantId: string }
  /** Another run holds the lease, or the next attempt isn't due yet. */
  | { kind: "busy"; tenantId: string }
  | { kind: "missing"; tenantId: string };

// ---------------------------------------------------------------------------
// Creating the tenant row
// ---------------------------------------------------------------------------

const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/** A new tenant id: 16 characters of [a-z0-9], uniformly random (contract: isTenantId). */
export function newTenantId(): string {
  let out = "";
  while (out.length < 16) {
    for (const byte of crypto.getRandomValues(new Uint8Array(32))) {
      // 252 = 7 * 36: rejecting the rest keeps every character equally likely.
      if (byte < 252 && out.length < 16) out += ID_ALPHABET[byte % 36];
    }
  }
  return out;
}

export type RequestTenantResult =
  | { ok: true; tenantId: string; slug: string }
  | { ok: false; slug: string; reason: Exclude<SlugAvailability, { ok: true }>["reason"] };

/**
 * Records a new tenant in state `requested`, on a 14-day trial. The caller
 * then queues its provisioning (enqueueProvisioning), so sign-up answers at
 * once; if that message never arrives, the sweep picks the tenant up.
 */
export async function requestTenant(
  db: D1Database,
  input: { accountId: string; slug: string; now: number; plan?: PlanId },
): Promise<RequestTenantResult> {
  const availability = await checkSlugAvailability(db, input.slug, input.now);
  if (!availability.ok) return availability;
  const id = newTenantId();
  try {
    await db
      .prepare(
        `INSERT INTO tenants (id, account_id, slug, script_name, status, plan, provision_state, trial_ends_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'trial', ?, 'requested', ?, ?, ?)`,
      )
      .bind(id, input.accountId, availability.slug, tenantScriptName(id), input.plan ?? "trial", input.now + TRIAL_DAYS * 86_400_000, input.now, input.now)
      .run();
  } catch (error) {
    // Two sign-ups raced for the same name; the UNIQUE constraint decided.
    if (String(error).includes("UNIQUE") && String(error).includes("slug")) {
      return { ok: false, slug: availability.slug, reason: "taken" };
    }
    throw error;
  }
  return { ok: true, tenantId: id, slug: availability.slug };
}

// ---------------------------------------------------------------------------
// The row, the lease and the bookkeeping
// ---------------------------------------------------------------------------

interface ProvisionRow {
  id: string;
  account_id: string;
  slug: string;
  script_name: string;
  status: string;
  owner_suspended_at: number | null;
  plan: string;
  provision_state: string;
  version: string | null;
  limit_overrides: string | null;
  trial_ends_at: number | null;
  d1_id: string | null;
  provision_attempts: number;
  provision_next_at: number | null;
  provision_paused_at: number | null;
  provisioned_at: number | null;
  created_at: number;
}

interface ProvisionTenant {
  record: TenantRecord;
  d1Id: string | null;
  attempts: number;
  pausedAt: number | null;
  provisionedAt: number | null;
  createdAt: number;
}

async function loadTenant(db: D1Database, tenantId: string): Promise<ProvisionTenant | null> {
  const row = await db
    .prepare(
      `SELECT id, account_id, slug, script_name, status, owner_suspended_at, plan, provision_state, version, limit_overrides, trial_ends_at,
              d1_id, provision_attempts, provision_next_at, provision_paused_at, provisioned_at, created_at
       FROM tenants WHERE id = ?`,
    )
    .bind(tenantId)
    .first<ProvisionRow>();
  if (!row) return null;
  return {
    record: tenantFromRow(row),
    d1Id: row.d1_id,
    attempts: row.provision_attempts,
    pausedAt: row.provision_paused_at,
    provisionedAt: row.provisioned_at,
    createdAt: row.created_at,
  };
}

const newLeaseToken = () => crypto.randomUUID();

/**
 * Takes the tenant for this run: not ready, not paused, nobody else's lease
 * live, and (unless forced) its next attempt due. Answers the run's lease
 * token, or null.
 */
async function acquireLease(db: D1Database, tenantId: string, now: number, ignoreSchedule: boolean): Promise<string | null> {
  const token = newLeaseToken();
  const result = await db
    .prepare(
      `UPDATE tenants SET provision_lease_until = ?1, provision_lease_token = ?2
       WHERE id = ?3 AND provision_state <> 'ready' AND provision_paused_at IS NULL
         AND (provision_lease_until IS NULL OR provision_lease_until <= ?4)
         AND (?5 = 1 OR provision_next_at IS NULL OR provision_next_at <= ?4)`,
    )
    .bind(now + PROVISION_LEASE_MS, token, tenantId, now, ignoreSchedule ? 1 : 0)
    .run();
  return (result.meta.changes ?? 0) > 0 ? token : null;
}

/** Extends this run's lease before a step; false when the run no longer holds it. */
async function renewLease(db: D1Database, tenantId: string, token: string, now: number): Promise<boolean> {
  const result = await db
    .prepare("UPDATE tenants SET provision_lease_until = ? WHERE id = ? AND provision_lease_token = ?")
    .bind(now + PROVISION_LEASE_MS, tenantId, token)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

async function releaseLease(db: D1Database, tenantId: string, token: string): Promise<void> {
  await db
    .prepare("UPDATE tenants SET provision_lease_until = NULL, provision_lease_token = NULL WHERE id = ? AND provision_lease_token = ?")
    .bind(tenantId, token)
    .run();
}

/**
 * A step succeeded: the next state, a clean slate for retries, and any
 * columns the step set. Only from the state the step started in, and only
 * while this run holds the lease, so neither a removal that lands mid-step
 * (removeTenant) nor another run is ever overwritten; the run then sees the
 * new state, or its lost lease, on its next turn.
 */
async function advance(
  db: D1Database,
  run: { tenantId: string; token: string },
  from: ProvisionState,
  to: ProvisionState,
  now: number,
  set: Record<string, string | number | null> = {},
): Promise<void> {
  const columns = Object.keys(set);
  const assignments = columns.map((c) => `${c} = ?`).join(", ");
  await db
    .prepare(
      `UPDATE tenants SET provision_state = ?, provision_attempts = 0, provision_error = NULL, provision_next_at = NULL,
       updated_at = ?${assignments ? `, ${assignments}` : ""} WHERE id = ? AND provision_state = ? AND provision_lease_token = ?`,
    )
    .bind(to, now, ...columns.map((c) => set[c]!), run.tenantId, from, run.token)
    .run();
  log.info("provision.step", { tenant: run.tenantId, from, to, version: typeof set.version === "string" ? set.version : undefined });
}

async function audit(db: D1Database, tenant: TenantRecord, action: string, now: number, detail: Record<string, unknown>) {
  // The audit log's actions are the platform's events too (tenant.*, provision.*): one name in both places.
  log.info(action, { tenant: tenant.id, ...detail });
  await db
    .prepare("INSERT INTO audit_events (at, account_id, tenant_id, actor, action, detail) VALUES (?, ?, ?, 'system', ?, ?)")
    .bind(now, tenant.accountId, tenant.id, action, JSON.stringify(detail))
    .run();
}

/** A short, non-secret reason for the row and the logs. */
export function describeError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.slice(0, 300);
}

export function backoffMs(attempts: number): number {
  return PROVISION_BACKOFF_MS[Math.min(attempts, PROVISION_BACKOFF_MS.length) - 1] ?? PROVISION_BACKOFF_MS[0];
}

/** A failure trying again won't fix: pause instead of retrying. */
export function isPermanentFailure(error: unknown): boolean {
  if (error instanceof CloudflareApiError) return !error.retryable;
  return error instanceof PermanentError;
}

// ---------------------------------------------------------------------------
// The steps
// ---------------------------------------------------------------------------

/** The step failed in a way the tenant itself reported (not an API error); retried like any other. */
export class ProvisionStepError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProvisionStepError";
  }
}

type Step = (deps: ProvisioningDeps, t: ProvisionTenant, run: { tenantId: string; token: string }, now: number) => Promise<void>;

const stepCreateDatabase: Step = async (deps, t, run, now) => {
  // The key first: nothing remote exists yet, and the upload needs it.
  await ensureMasterKey(deps.db, t.record.id, deps.config.platformKey, now);
  const name = tenantDatabaseName(t.record.id);
  let database = await deps.api.findDatabaseByName(name);
  if (!database) {
    try {
      database = await deps.api.createDatabase(name);
    } catch (error) {
      // A create that reached Cloudflare but whose answer was lost: it exists now.
      database = await deps.api.findDatabaseByName(name);
      if (!database) throw error;
    }
  }
  await advance(deps.db, run, "requested", "db_created", now, { d1_id: database.id });
};

const stepUpload: Step = async (deps, t, run, now) => {
  if (!t.d1Id) throw new PermanentError("db_created without a database id");
  const { masterKey } = await ensureMasterKey(deps.db, t.record.id, deps.config.platformKey, now);
  const bundle = await deps.bundles.current();
  // Every upload starts from no script. An earlier attempt may have created
  // it (its answer lost, or its run killed) with Durable Object migrations
  // applied, and this upload's migrations must start from a known tag. A
  // tenant in this state has never served anyone, so nothing is lost, and
  // deleting a script that isn't there succeeds.
  await deps.api.deleteScript(deps.config.namespace, t.record.scriptName);
  await uploadUserWorker(deps.api, {
    namespace: deps.config.namespace,
    scriptName: t.record.scriptName,
    bundle,
    bindings: [{ type: "d1", name: "DB", database_id: t.d1Id }],
    vars: {
      [HOSTED_ENV.mode]: HOSTED_MODE_ON,
      [HOSTED_ENV.tenantId]: t.record.id,
      [HOSTED_ENV.handoffPublicKey]: deps.config.handoffPublicKey,
    },
    secrets: { MASTER_KEY: masterKey },
    tags: tenantTags(t.record.id, bundle.version),
    previousMigrationTag: null,
    logSampling: deps.config.tenantLogSampling,
  });
  await advance(deps.db, run, "db_created", "uploaded", now, {
    version: bundle.version,
    do_migration_tag: bundle.migrations.at(-1)?.tag ?? null,
  });
};

/** The script's tags: find every tenant's Worker, one tenant's, or one release's in the namespace. */
export function tenantTags(tenantId: string, version: string): string[] {
  return ["openping", `tenant-${tenantId}`, `release-${version}`];
}

async function platformCall<T>(deps: ProvisioningDeps, t: ProvisionTenant, path: string, body?: unknown): Promise<{ status: number; body: T | null }> {
  const result = await callTenant(
    deps.dispatcher,
    { tenant: t.record, hostedDomain: deps.config.hostedDomain, platform: deps.capability(t.record) },
    path,
    body === undefined ? {} : { method: "POST", body },
  );
  if (result.kind === "missing") throw new ProvisionStepError(`user Worker ${t.record.scriptName} is not in the namespace`);
  const parsed = await result.response.json<T>().catch(() => null);
  return { status: result.response.status, body: parsed };
}

async function health(deps: ProvisioningDeps, t: ProvisionTenant): Promise<HealthResponse | null> {
  const { status, body } = await platformCall<HealthResponse>(deps, t, PLATFORM_HEALTH_PATH);
  return (status === 200 || status === 503) && body && typeof body.ok === "boolean" ? body : null;
}

const stepMigrate: Step = async (deps, t, run, now) => {
  const before = await health(deps, t);
  if (!before?.ok) {
    // The contract's scheduled entry applies any missing migrations first
    // (CONTRACT.md, section 6); on a new database it then finds no monitors.
    const request: ScheduledRequest = { runId: `provision-${t.record.id}-${now}`, scheduledTime: now, cron: "provision" };
    const { status, body } = await platformCall<ScheduledRunSummary>(deps, t, PLATFORM_SCHEDULED_PATH, request);
    if (status !== 200 || !body) throw new ProvisionStepError(`scheduled call answered ${status}`);
    if (body.outcome === "failed") throw new ProvisionStepError(`first run failed: ${String(body.error ?? "no reason")}`);
  }
  await advance(deps.db, run, "uploaded", "migrated", now);
};

const stepVerify: Step = async (deps, t, run, now) => {
  const answer = await health(deps, t);
  if (!answer) throw new ProvisionStepError("health check gave no answer");
  if (!answer.ok) {
    throw new ProvisionStepError(
      `not healthy yet: schema ${answer.schemaVersion} of ${answer.bundledSchemaVersion}${answer.migrating ? ", migrating" : ""}`,
    );
  }
  await advance(deps.db, run, "migrated", "ready", now, { provisioned_at: now });
  await audit(deps.db, t.record, "tenant.provisioned", now, {
    version: t.record.version,
    seconds: Math.round((now - t.createdAt) / 1000),
  });
};

/**
 * Removes everything the tenant has in Cloudflare, then its row (and with it
 * its escrowed key). Each delete tolerates "already gone", so it can be
 * repeated after a failure until it completes.
 */
const stepTeardown: Step = async (deps, t, run, now) => {
  await deps.api.deleteScript(deps.config.namespace, t.record.scriptName);
  // The id may never have been recorded (a create whose answer was lost), so also look it up by name.
  const d1Id = t.d1Id ?? (await deps.api.findDatabaseByName(tenantDatabaseName(t.record.id)))?.id ?? null;
  if (d1Id) await deps.api.deleteDatabase(d1Id);
  // A tenant that ever served visitors keeps its slug out of reach for a while.
  if (t.provisionedAt !== null) await holdSlug(deps.db, t.record.slug, "deleted", now);
  await audit(deps.db, t.record, "tenant.removed", now, { slug: t.record.slug, wasReady: t.provisionedAt !== null });
  forgetTenant(t.record.slug);
  // One batch, all guarded by this run's lease, so a run that lost it removes nothing.
  const held = "EXISTS (SELECT 1 FROM tenants WHERE id = ?1 AND provision_lease_token = ?2)";
  await deps.db.batch([
    deps.db.prepare(`UPDATE subscriptions SET tenant_id = NULL WHERE tenant_id = ?1 AND ${held}`).bind(t.record.id, run.token),
    deps.db.prepare(`DELETE FROM escrowed_keys WHERE tenant_id = ?1 AND ${held}`).bind(t.record.id, run.token),
    deps.db.prepare("DELETE FROM tenants WHERE id = ?1 AND provision_lease_token = ?2").bind(t.record.id, run.token),
  ]);
};

const STEPS: Partial<Record<ProvisionState, Step>> = {
  requested: stepCreateDatabase,
  db_created: stepUpload,
  uploaded: stepMigrate,
  migrated: stepVerify,
  deleting: stepTeardown,
};

// ---------------------------------------------------------------------------
// Running it
// ---------------------------------------------------------------------------

/**
 * Takes the tenant as far as it will go in one run: to `ready`, to a
 * scheduled retry, to a pause, or (for a tenant being removed) through
 * teardown. `force` ignores the retry schedule, for the run right after
 * sign-up and for the owner's "retry now".
 */
export async function runProvisioning(
  deps: ProvisioningDeps,
  tenantId: string,
  options: { force?: boolean } = {},
): Promise<ProvisionOutcome> {
  const now = deps.now ?? Date.now;
  if (!isTenantId(tenantId)) return { kind: "missing", tenantId };
  const first = await loadTenant(deps.db, tenantId);
  if (!first) return { kind: "missing", tenantId };
  if (first.record.provisionState === "ready") return { kind: "ready", tenantId };
  if (first.pausedAt !== null) {
    return { kind: "paused", tenantId, state: first.record.provisionState, error: "paused for the owner" };
  }
  const token = await acquireLease(deps.db, tenantId, now(), options.force === true);
  if (!token) return { kind: "busy", tenantId };
  const run = { tenantId, token };

  let removed = false;
  try {
    for (let guard = 0; guard < PROVISION_STATES.length + 1; guard++) {
      // Renewed before every step, so a slow run keeps its lease and a stalled one loses it.
      if (!(await renewLease(deps.db, tenantId, token, now()))) return { kind: "busy", tenantId };
      const t = await loadTenant(deps.db, tenantId);
      if (!t) return { kind: "missing", tenantId };
      const state = t.record.provisionState;
      if (state === "ready") return { kind: "ready", tenantId };
      const step = STEPS[state];
      if (!step) throw new Error(`no step for ${state}`);
      try {
        await step(deps, t, run, now());
        if (state === "deleting") {
          removed = true;
          return { kind: "removed", tenantId };
        }
      } catch (error) {
        return await recordFailure(deps, t, run, error, now());
      }
    }
    throw new Error("provisioning did not settle");
  } finally {
    if (!removed) await releaseLease(deps.db, tenantId, token);
  }
}

async function recordFailure(
  deps: ProvisioningDeps,
  t: ProvisionTenant,
  run: { tenantId: string; token: string },
  error: unknown,
  now: number,
): Promise<ProvisionOutcome> {
  const attempts = t.attempts + 1;
  const message = describeError(error);
  const state = t.record.provisionState;
  const permanent = isPermanentFailure(error);
  log.error("provision.step_failed", { tenant: t.record.id, state, attempts, permanent, error: message });
  // A teardown keeps retrying whatever happens: there is nothing behind it to protect.
  const pause = state !== "deleting" && (permanent || attempts >= PROVISION_MAX_ATTEMPTS);
  const nextAt = now + backoffMs(attempts);
  await deps.db
    .prepare(
      `UPDATE tenants SET provision_attempts = ?, provision_error = ?, provision_next_at = ?, provision_paused_at = ?, updated_at = ?
       WHERE id = ? AND provision_state = ? AND provision_lease_token = ?`,
    )
    .bind(attempts, `${state}: ${message}`, pause ? null : nextAt, pause ? now : null, now, t.record.id, state, run.token)
    .run();
  if (pause) {
    await audit(deps.db, t.record, "tenant.provision_paused", now, { state, attempts, permanent, error: message.slice(0, 200) });
    return { kind: "paused", tenantId: t.record.id, state, error: message };
  }
  return { kind: "retry", tenantId: t.record.id, state, attempts, nextAt, error: message };
}

/**
 * Takes the pause off a tenant, with a clean slate of retries, so its next
 * run (a queue message, the sweep, or runProvisioning) starts again from the
 * step it stopped at. False when it wasn't paused.
 */
export async function unpauseProvisioning(db: D1Database, tenantId: string, now: number): Promise<boolean> {
  const changed = await db
    .prepare(
      `UPDATE tenants SET provision_paused_at = NULL, provision_attempts = 0, provision_next_at = NULL, updated_at = ?
       WHERE id = ? AND provision_paused_at IS NOT NULL`,
    )
    .bind(now, tenantId)
    .run();
  return (changed.meta.changes ?? 0) > 0;
}

/**
 * Starts a paused tenant again from the step it stopped at, with a clean
 * slate of retries: the owner fixed the cause (admin console, B6).
 */
export async function resumeProvisioning(deps: ProvisioningDeps, tenantId: string): Promise<ProvisionOutcome> {
  const now = (deps.now ?? Date.now)();
  if (!(await unpauseProvisioning(deps.db, tenantId, now))) return runProvisioning(deps, tenantId);
  return runProvisioning(deps, tenantId, { force: true });
}

/**
 * Marks a tenant for removal: from now on it is never dispatched to (only
 * `ready` tenants are), and its next run tears it down. `onlyIfPaused`
 * limits it to a tenant whose provisioning is paused, the admin console's
 * case. False when nothing matched.
 */
export async function markForRemoval(db: D1Database, tenantId: string, now: number, options: { onlyIfPaused?: boolean } = {}): Promise<boolean> {
  const changed = await db
    .prepare(
      `UPDATE tenants SET provision_state = 'deleting', provision_attempts = 0, provision_error = NULL,
       provision_next_at = NULL, provision_paused_at = NULL, updated_at = ?
       WHERE id = ? AND (? = 0 OR (provision_paused_at IS NOT NULL AND provision_state <> 'ready'))`,
    )
    .bind(now, tenantId, options.onlyIfPaused ? 1 : 0)
    .run();
  return (changed.meta.changes ?? 0) > 0;
}

/**
 * Marks a tenant for removal and runs the teardown: a sign-up the owner
 * gives up on, or (B7) an account past its 30 days. The tenant stops being
 * dispatched to at once, since only `ready` tenants are.
 */
export async function removeTenant(deps: ProvisioningDeps, tenantId: string): Promise<ProvisionOutcome> {
  const now = (deps.now ?? Date.now)();
  if (!(await markForRemoval(deps.db, tenantId, now))) return { kind: "missing", tenantId };
  return runProvisioning(deps, tenantId, { force: true });
}

/**
 * The SQL of the sweep. Its `provision_state <> 'ready'` matches the partial
 * index idx_tenants_provisioning (migration 0002), so the ready tenants,
 * nearly all of them, are never read.
 */
export const DUE_TENANTS_SQL = `SELECT id FROM tenants
       WHERE provision_state <> 'ready'
         AND provision_paused_at IS NULL
         AND (provision_next_at IS NULL OR provision_next_at <= ?1)
         AND (provision_lease_until IS NULL OR provision_lease_until <= ?1)
       ORDER BY provision_next_at LIMIT ?2`;

/**
 * The safety net, from the platform's every-minute cron: every tenant that
 * isn't ready or paused, whose next attempt is due and that no run holds.
 * Runs them one after another so one slow Cloudflare call can't fan out.
 */
export async function provisionDue(deps: ProvisioningDeps, limit = 10): Promise<ProvisionOutcome[]> {
  const now = (deps.now ?? Date.now)();
  const due = await deps.db.prepare(DUE_TENANTS_SQL).bind(now, limit).all<{ id: string }>();
  const outcomes: ProvisionOutcome[] = [];
  for (const { id } of due.results) outcomes.push(await runProvisioning(deps, id));
  return outcomes;
}
