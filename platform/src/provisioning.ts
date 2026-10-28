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
 *   deleting    a failed (out of retries), cancelled or removed tenant being
 *               torn down: script, then database, then the row
 *
 * Every remote step is idempotent: the database is looked up by its name
 * before it is created, an upload replaces the script with the same one, and
 * deleting something already gone succeeds. A failed step is tried again
 * with backoff (`provisionDue`, from the platform's cron); after
 * PROVISION_MAX_ATTEMPTS failures in a row the tenant is rolled back cleanly
 * and the slug is free again.
 *
 * Only one run works on a tenant at a time, through a lease on its row.
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
import type { CloudflareApi } from "./cloudflare/api";
import { uploadUserWorker } from "./cloudflare/upload";
import { callTenant, type TenantDispatcher } from "./dispatch";
import { ensureMasterKey } from "./keys";
import { checkSlugAvailability, holdSlug, type SlugAvailability } from "./slugs";
import { PROVISION_STATES, tenantFromRow, type ProvisionState, type TenantRecord } from "./tenants";

/** Failures in a row before a tenant is rolled back. */
export const PROVISION_MAX_ATTEMPTS = 6;
/** Wait before attempt n+1 after n failures (the last value repeats). About 45 minutes in all. */
export const PROVISION_BACKOFF_MS = [10_000, 30_000, 120_000, 600_000, 1_800_000] as const;
/** How long one run may hold a tenant. Longer than any run; a crashed run frees it after this. */
export const PROVISION_LEASE_MS = 5 * 60_000;
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
  /** A step failed; the sweep tries again at `nextAt`. */
  | { kind: "retry"; tenantId: string; state: ProvisionState; attempts: number; nextAt: number; error: string }
  /** Torn down: out of retries, cancelled or removed. The row is gone. */
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
 * then runs `runProvisioning` (in waitUntil, so sign-up answers at once);
 * if that run never happens, the sweep picks the tenant up.
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
  plan: string;
  provision_state: string;
  version: string | null;
  limit_overrides: string | null;
  trial_ends_at: number | null;
  d1_id: string | null;
  provision_attempts: number;
  provision_next_at: number | null;
  provisioned_at: number | null;
}

interface ProvisionTenant {
  record: TenantRecord;
  d1Id: string | null;
  attempts: number;
  provisionedAt: number | null;
}

async function loadTenant(db: D1Database, tenantId: string): Promise<ProvisionTenant | null> {
  const row = await db
    .prepare(
      `SELECT id, account_id, slug, script_name, status, plan, provision_state, version, limit_overrides, trial_ends_at,
              d1_id, provision_attempts, provision_next_at, provisioned_at
       FROM tenants WHERE id = ?`,
    )
    .bind(tenantId)
    .first<ProvisionRow>();
  if (!row) return null;
  return { record: tenantFromRow(row), d1Id: row.d1_id, attempts: row.provision_attempts, provisionedAt: row.provisioned_at };
}

/** Takes the tenant for this run, or null when another run has it or it isn't due. */
async function acquireLease(db: D1Database, tenantId: string, now: number, ignoreSchedule: boolean): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE tenants SET provision_lease_until = ?1
       WHERE id = ?2 AND provision_state <> 'ready'
         AND (provision_lease_until IS NULL OR provision_lease_until <= ?3)
         AND (?4 = 1 OR provision_next_at IS NULL OR provision_next_at <= ?3)`,
    )
    .bind(now + PROVISION_LEASE_MS, tenantId, now, ignoreSchedule ? 1 : 0)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

async function releaseLease(db: D1Database, tenantId: string): Promise<void> {
  await db.prepare("UPDATE tenants SET provision_lease_until = NULL WHERE id = ?").bind(tenantId).run();
}

/**
 * A step succeeded: the next state, a clean slate for retries, and any
 * columns the step set. Only from the state the step started in, so a
 * removal that lands mid-step (removeTenant) is never overwritten; the run
 * then sees `deleting` and tears down.
 */
async function advance(
  db: D1Database,
  tenantId: string,
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
       updated_at = ?${assignments ? `, ${assignments}` : ""} WHERE id = ? AND provision_state = ?`,
    )
    .bind(to, now, ...columns.map((c) => set[c]!), tenantId, from)
    .run();
}

async function audit(db: D1Database, tenant: TenantRecord, action: string, now: number, detail: Record<string, unknown>) {
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

async function stepCreateDatabase(deps: ProvisioningDeps, t: ProvisionTenant, now: number): Promise<void> {
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
  await advance(deps.db, t.record.id, "requested", "db_created", now, { d1_id: database.id });
}

async function stepUpload(deps: ProvisioningDeps, t: ProvisionTenant, now: number): Promise<void> {
  if (!t.d1Id) throw new ProvisionStepError("db_created without a database id");
  const { masterKey } = await ensureMasterKey(deps.db, t.record.id, deps.config.platformKey, now);
  const bundle = await deps.bundles.current();
  // A retried upload starts from no script: an earlier attempt may have
  // created it (its answer lost) with Durable Object migrations applied,
  // and the next upload's migrations must start from a known tag. A tenant
  // in this state has never served anyone, so nothing is lost.
  if (t.attempts > 0) await deps.api.deleteScript(deps.config.namespace, t.record.scriptName);
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
  });
  await advance(deps.db, t.record.id, "db_created", "uploaded", now, {
    version: bundle.version,
    do_migration_tag: bundle.migrations.at(-1)?.tag ?? null,
  });
}

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

async function stepMigrate(deps: ProvisioningDeps, t: ProvisionTenant, now: number): Promise<void> {
  const before = await health(deps, t);
  if (!before?.ok) {
    // The contract's scheduled entry applies any missing migrations first
    // (CONTRACT.md, section 6); on a new database it then finds no monitors.
    const request: ScheduledRequest = { runId: `provision-${t.record.id}-${now}`, scheduledTime: now, cron: "provision" };
    const { status, body } = await platformCall<ScheduledRunSummary>(deps, t, PLATFORM_SCHEDULED_PATH, request);
    if (status !== 200 || !body) throw new ProvisionStepError(`scheduled call answered ${status}`);
    if (body.outcome === "failed") throw new ProvisionStepError(`first run failed: ${String(body.error ?? "no reason")}`);
  }
  await advance(deps.db, t.record.id, "uploaded", "migrated", now);
}

async function stepVerify(deps: ProvisioningDeps, t: ProvisionTenant, now: number): Promise<void> {
  const answer = await health(deps, t);
  if (!answer) throw new ProvisionStepError("health check gave no answer");
  if (!answer.ok) {
    throw new ProvisionStepError(
      `not healthy yet: schema ${answer.schemaVersion} of ${answer.bundledSchemaVersion}${answer.migrating ? ", migrating" : ""}`,
    );
  }
  await advance(deps.db, t.record.id, "migrated", "ready", now, { provisioned_at: now });
  await audit(deps.db, t.record, "tenant.provisioned", now, {
    version: t.record.version,
    seconds: Math.round((now - (await createdAt(deps.db, t.record.id))) / 1000),
  });
}

async function createdAt(db: D1Database, tenantId: string): Promise<number> {
  const row = await db.prepare("SELECT created_at FROM tenants WHERE id = ?").bind(tenantId).first<{ created_at: number }>();
  return row?.created_at ?? 0;
}

/**
 * Removes everything the tenant has in Cloudflare, then its row (and with it
 * its escrowed key). Each delete tolerates "already gone", so it can be
 * repeated after a failure until it completes.
 */
async function stepTeardown(deps: ProvisioningDeps, t: ProvisionTenant, now: number): Promise<void> {
  await deps.api.deleteScript(deps.config.namespace, t.record.scriptName);
  // The id may never have been recorded (a create whose answer was lost), so also look it up by name.
  const d1Id = t.d1Id ?? (await deps.api.findDatabaseByName(tenantDatabaseName(t.record.id)))?.id ?? null;
  if (d1Id) await deps.api.deleteDatabase(d1Id);
  // A tenant that ever served visitors keeps its slug out of reach for a while.
  if (t.provisionedAt !== null) await holdSlug(deps.db, t.record.slug, "deleted", now);
  await audit(deps.db, t.record, "tenant.removed", now, { slug: t.record.slug, wasReady: t.provisionedAt !== null });
  await deps.db.batch([
    deps.db.prepare("UPDATE subscriptions SET tenant_id = NULL WHERE tenant_id = ?").bind(t.record.id),
    deps.db.prepare("DELETE FROM escrowed_keys WHERE tenant_id = ?").bind(t.record.id),
    deps.db.prepare("DELETE FROM tenants WHERE id = ?").bind(t.record.id),
  ]);
}

const STEPS: Partial<Record<ProvisionState, (deps: ProvisioningDeps, t: ProvisionTenant, now: number) => Promise<void>>> = {
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
 * scheduled retry, or (after the last allowed failure, or for a tenant being
 * deleted) through teardown. `force` ignores the retry schedule, for the run
 * that starts right after sign-up and for the owner's "retry now".
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
  if (!(await acquireLease(deps.db, tenantId, now(), options.force === true))) return { kind: "busy", tenantId };

  let removed = false;
  try {
    for (let guard = 0; guard < PROVISION_STATES.length + 1; guard++) {
      const t = await loadTenant(deps.db, tenantId);
      if (!t) return { kind: "missing", tenantId };
      const state = t.record.provisionState;
      if (state === "ready") return { kind: "ready", tenantId };
      const step = STEPS[state];
      if (!step) throw new Error(`no step for ${state}`);
      try {
        await step(deps, t, now());
        if (state === "deleting") {
          removed = true;
          return { kind: "removed", tenantId };
        }
      } catch (error) {
        const failure = await recordFailure(deps, t, error, now());
        // Out of retries: the tenant is now `deleting`, and this run tears it down.
        if (failure.kind === "retry" && failure.state === "deleting" && state !== "deleting") continue;
        return failure;
      }
    }
    throw new Error("provisioning did not settle");
  } finally {
    if (!removed) await releaseLease(deps.db, tenantId);
  }
}

async function recordFailure(deps: ProvisioningDeps, t: ProvisionTenant, error: unknown, now: number): Promise<ProvisionOutcome> {
  const attempts = t.attempts + 1;
  const message = describeError(error);
  const state = t.record.provisionState;
  console.error("[provision] step failed", { tenant: t.record.id, state, attempts, error: message });
  // Out of retries: roll back. A teardown that fails just keeps retrying, since there is nothing behind it.
  const rollBack = state !== "deleting" && attempts >= PROVISION_MAX_ATTEMPTS;
  const nextState: ProvisionState = rollBack ? "deleting" : state;
  const nextAttempts = rollBack ? 0 : attempts;
  const nextAt = rollBack ? now : now + backoffMs(attempts);
  await deps.db
    .prepare(
      `UPDATE tenants SET provision_state = ?, provision_attempts = ?, provision_error = ?, provision_next_at = ?, updated_at = ?
       WHERE id = ? AND provision_state = ?`,
    )
    .bind(nextState, nextAttempts, `${state}: ${message}`, nextAt, now, t.record.id, state)
    .run();
  if (rollBack) await audit(deps.db, t.record, "tenant.provision_failed", now, { state, error: message.slice(0, 200) });
  return { kind: "retry", tenantId: t.record.id, state: nextState, attempts: nextAttempts, nextAt, error: message };
}

/**
 * Marks a tenant for removal and runs the teardown: a sign-up cancelled
 * before it finished, or (B7) an account past its 30 days. The tenant stops
 * being dispatched to at once, since only `ready` tenants are.
 */
export async function removeTenant(deps: ProvisioningDeps, tenantId: string): Promise<ProvisionOutcome> {
  const now = (deps.now ?? Date.now)();
  const changed = await deps.db
    .prepare(
      `UPDATE tenants SET provision_state = 'deleting', provision_attempts = 0, provision_error = NULL,
       provision_next_at = NULL, updated_at = ? WHERE id = ?`,
    )
    .bind(now, tenantId)
    .run();
  if ((changed.meta.changes ?? 0) === 0) return { kind: "missing", tenantId };
  return runProvisioning(deps, tenantId, { force: true });
}

/**
 * The retry sweep, for the platform's cron: every tenant that isn't ready,
 * whose next attempt is due and that no run holds, oldest first. Runs them
 * one after another so one slow Cloudflare call can't fan out.
 */
export async function provisionDue(deps: ProvisioningDeps, limit = 10): Promise<ProvisionOutcome[]> {
  const now = (deps.now ?? Date.now)();
  const due = await deps.db
    .prepare(
      `SELECT id FROM tenants
       WHERE provision_state <> 'ready'
         AND (provision_next_at IS NULL OR provision_next_at <= ?1)
         AND (provision_lease_until IS NULL OR provision_lease_until <= ?1)
       ORDER BY updated_at LIMIT ?2`,
    )
    .bind(now, limit)
    .all<{ id: string }>();
  const outcomes: ProvisionOutcome[] = [];
  for (const { id } of due.results) outcomes.push(await runProvisioning(deps, id));
  return outcomes;
}
