/**
 * Shipping an OpenPing release to every tenant (build plan, C1).
 *
 * Workers for Platforms has no gradual deployments for user Workers (an
 * upload goes to 100% at once), so the platform does its own:
 *
 *   1. The owner asks (the admin console, or scripts/tenant-release.mjs
 *      through a row in release_requests). The request is checked: the
 *      bundle is in R2 and loads, its D1 migrations are additive and its
 *      Durable Object migrations extend what tenants run (./checks.ts). A
 *      failed check is a `refused` release that touched nothing; a dry run
 *      records the plan and stops there.
 *   2. canary: one tenant gets the new bundle. Its GET /__platform/health
 *      (which applies the bundled migrations) must answer ok on the new
 *      version, then one POST /__platform/scheduled must come back `ran`.
 *      Only then does releases/current point at the new version, so new
 *      sign-ups get it too.
 *   3. rolling: batches of RELEASE_BATCH_SIZE tenants, each tenant uploaded
 *      and health-checked, each batch finished before the next starts. Any
 *      tenant that doesn't come back healthy stops the rollout (`paused`),
 *      for the owner to resume, skip the failures, cancel, or roll back.
 *   4. done.
 *
 * A rollback is the same machine run backwards with no canary: it points
 * releases/current at the version before at once, then re-uploads it to
 * every tenant on another version, and keeps going past a failure, since
 * getting tenants back is the point. Migrations are additive, so the older
 * bundle runs on the newer schema (CONTRACT.md, section 6).
 *
 * Every step is written to the platform database before the next starts
 * (releases, release_tenants), and an upload is idempotent, so a run that
 * dies anywhere is picked up by the next cron tick from the step it was on.
 * One run works on a release at a time, under a lease like provisioning's.
 * Batches are chosen as they start, from the tenants not yet on the new
 * version, so a tenant that finished provisioning on the old bundle while
 * the canary ran is still updated.
 */

import {
  PLATFORM_HEALTH_PATH,
  PLATFORM_SCHEDULED_PATH,
  HOSTED_ENV,
  HOSTED_MODE_ON,
  isTenantId,
  type HealthResponse,
  type PlatformCapability,
  type ScheduledRequest,
  type ScheduledRunSummary,
} from "../../../src/shared/hosted-contract";
import { isBundleVersion, type TenantBundle } from "../bundle";
import { CloudflareApiError, type CloudflareApi } from "../cloudflare/api";
import { uploadUserWorker } from "../cloudflare/upload";
import { callTenant, type TenantDispatcher } from "../dispatch";
import { PermanentError } from "../errors";
import { activeEscrowedKey, openEscrowedKey } from "../keys";
import { describeError, tenantTags, type ProvisioningConfig } from "../provisioning";
import { tenantFromRow, type TenantRecord } from "../tenants";
import { checkRollback, checkRollout, type ReleaseChecks } from "./checks";

/** Tenants per batch after the canary (build plan, section 11). */
export const RELEASE_BATCH_SIZE = 50;
/** How long a run holds a release without renewing it (renewed before each step). */
export const RELEASE_LEASE_MS = 2 * 60_000;
/** Health checks that may answer "not yet" (migrating, still starting) before a tenant counts as failed. */
export const HEALTH_MAX_ATTEMPTS = 5;
/** Wait between those checks. */
export const HEALTH_RETRY_MS = 15_000;
/** A tenant slower than this to answer its health check counts as not answering. */
export const HEALTH_TIMEOUT_MS = 10_000;
/** Upload attempts that may fail with a retryable Cloudflare error before the tenant counts as failed. */
export const UPLOAD_MAX_ATTEMPTS = 3;
/** Times the canary's scheduled run may find another run holding its lease before the rollout stops. */
export const CANARY_BUSY_MAX = 5;
/** What one cron tick may spend on a release (the cron has 15 minutes; provisioning and the scheduler share it). */
export const RELEASE_TICK_BUDGET_MS = 5 * 60_000;

export const RELEASE_STATES = ["canary", "rolling", "paused", "done", "refused", "cancelled"] as const;
export type ReleaseState = (typeof RELEASE_STATES)[number];
export const ACTIVE_STATES: readonly ReleaseState[] = ["canary", "rolling", "paused"];
export const RELEASE_TENANT_STATES = ["pending", "uploaded", "healthy", "failed", "skipped"] as const;
export type ReleaseTenantState = (typeof RELEASE_TENANT_STATES)[number];
export const REQUEST_ACTIONS = ["rollout", "rollback", "pause", "resume", "skip_failed", "cancel"] as const;
export type RequestAction = (typeof REQUEST_ACTIONS)[number];

/** Where releases are read from and where the current version is kept (R2BundleSource). */
export interface ReleaseStore {
  currentVersion(): Promise<string | null>;
  setCurrent(version: string): Promise<void>;
  hasVersion(version: string): Promise<boolean>;
  listVersions(): Promise<string[]>;
  version(version: string): Promise<TenantBundle>;
  migrationSql(version: string, name: string): Promise<string>;
}

export interface ReleaseDeps {
  db: D1Database;
  api: CloudflareApi;
  store: ReleaseStore;
  dispatcher: TenantDispatcher;
  capability(tenant: TenantRecord): PlatformCapability;
  config: ProvisioningConfig;
  /** RELEASE_CANARY: the canary when a request names none (a slug or tenant id). */
  defaultCanary?: string | null;
  now?: () => number;
  /** Tests only: waits between health checks without sleeping. */
  sleep?: (ms: number) => Promise<void>;
}

export interface ReleasePlan {
  checks: ReleaseChecks;
  canary: { id: string; slug: string; reason: string } | null;
  /** Tenants not yet on the version, the canary included. */
  toUpdate: number;
  batches: number;
  batchSize: number;
  /** The first tenants after the canary, for the owner to see. */
  firstBatch: string[];
}

export interface Release {
  id: string;
  kind: "rollout" | "rollback";
  version: string;
  fromVersion: string | null;
  dryRun: boolean;
  state: ReleaseState;
  canaryTenantId: string | null;
  canaryState: "pending" | "healthy" | "ran" | null;
  batchSize: number;
  batch: number;
  requestedBy: string;
  note: string | null;
  plan: ReleasePlan | null;
  createdAt: number;
  updatedAt: number;
  finishedAt: number | null;
}

interface ReleaseRow {
  id: string;
  kind: string;
  version: string;
  from_version: string | null;
  dry_run: number;
  state: string;
  canary_tenant_id: string | null;
  canary_state: string | null;
  batch_size: number;
  batch: number;
  requested_by: string;
  note: string | null;
  plan: string | null;
  created_at: number;
  updated_at: number;
  finished_at: number | null;
}

const RELEASE_COLUMNS =
  "id, kind, version, from_version, dry_run, state, canary_tenant_id, canary_state, batch_size, batch, requested_by, note, plan, created_at, updated_at, finished_at";

function releaseFromRow(row: ReleaseRow): Release {
  let plan: ReleasePlan | null;
  try {
    plan = row.plan ? (JSON.parse(row.plan) as ReleasePlan) : null;
  } catch {
    plan = null;
  }
  return {
    id: row.id,
    kind: row.kind === "rollback" ? "rollback" : "rollout",
    version: row.version,
    fromVersion: row.from_version,
    dryRun: row.dry_run === 1,
    state: (RELEASE_STATES as readonly string[]).includes(row.state) ? (row.state as ReleaseState) : "paused",
    canaryTenantId: row.canary_tenant_id,
    canaryState: row.canary_state === "pending" || row.canary_state === "healthy" || row.canary_state === "ran" ? row.canary_state : null,
    batchSize: row.batch_size,
    batch: row.batch,
    requestedBy: row.requested_by,
    note: row.note,
    plan,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at,
  };
}

export async function getRelease(db: D1Database, id: string): Promise<Release | null> {
  const row = await db.prepare(`SELECT ${RELEASE_COLUMNS} FROM releases WHERE id = ?`).bind(id).first<ReleaseRow>();
  return row ? releaseFromRow(row) : null;
}

export async function activeRelease(db: D1Database): Promise<Release | null> {
  const row = await db
    .prepare(`SELECT ${RELEASE_COLUMNS} FROM releases WHERE state IN ('canary', 'rolling', 'paused') ORDER BY created_at DESC LIMIT 1`)
    .first<ReleaseRow>();
  return row ? releaseFromRow(row) : null;
}

export async function recentReleases(db: D1Database, limit = 20): Promise<Release[]> {
  const rows = await db.prepare(`SELECT ${RELEASE_COLUMNS} FROM releases ORDER BY created_at DESC, id DESC LIMIT ?`).bind(limit).all<ReleaseRow>();
  return rows.results.map(releaseFromRow);
}

function randomId(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return `${prefix}${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

export interface ReleaseRequestInput {
  action: RequestAction;
  version?: string | null;
  dryRun?: boolean;
  canary?: string | null;
  batchSize?: number | null;
  requestedBy: string;
}

export interface ReleaseRequest extends Required<Omit<ReleaseRequestInput, "dryRun">> {
  id: string;
  dryRun: boolean;
  createdAt: number;
}

/** Why a request is malformed, or null. The command line writes these rows by hand, so they are checked like any input. */
export function requestProblem(input: ReleaseRequestInput): string | null {
  if (!(REQUEST_ACTIONS as readonly string[]).includes(input.action)) return "unknown action";
  if (input.action === "rollout" && !isBundleVersion(input.version)) return "a rollout needs a version";
  if (input.version != null && !isBundleVersion(input.version)) return "that isn't a version";
  if (input.canary != null && !/^[a-z0-9-]{1,63}$/.test(input.canary)) return "the canary must be a slug or a tenant id";
  if (input.batchSize != null && (!Number.isSafeInteger(input.batchSize) || input.batchSize < 1 || input.batchSize > 500)) {
    return "a batch size is 1 to 500";
  }
  return null;
}

/** Records a request for the next tick (or for handleRequests right after). */
export async function submitRequest(db: D1Database, input: ReleaseRequestInput, now: number): Promise<string> {
  const problem = requestProblem(input);
  if (problem) throw new Error(`release request refused: ${problem}`);
  const id = randomId("rrq_");
  await db
    .prepare(
      `INSERT INTO release_requests (id, action, version, dry_run, canary, batch_size, requested_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, input.action, input.version ?? null, input.dryRun ? 1 : 0, input.canary ?? null, input.batchSize ?? null, input.requestedBy.slice(0, 80), now)
    .run();
  return id;
}

export interface RequestOutcome {
  requestId: string;
  releaseId: string | null;
  result: string;
}

/**
 * Handles every request not yet handled, oldest first. Each is claimed
 * before it is acted on, so two ticks never handle one twice.
 */
export async function handleRequests(deps: ReleaseDeps, limit = 10): Promise<RequestOutcome[]> {
  const now = deps.now ?? Date.now;
  const pending = await deps.db
    .prepare(
      `SELECT id, action, version, dry_run, canary, batch_size, requested_by, created_at FROM release_requests
       WHERE handled_at IS NULL ORDER BY created_at, id LIMIT ?`,
    )
    .bind(limit)
    .all<{ id: string; action: string; version: string | null; dry_run: number; canary: string | null; batch_size: number | null; requested_by: string; created_at: number }>();
  const outcomes: RequestOutcome[] = [];
  for (const row of pending.results) {
    const claimed = await deps.db.prepare("UPDATE release_requests SET handled_at = ? WHERE id = ? AND handled_at IS NULL").bind(now(), row.id).run();
    if ((claimed.meta.changes ?? 0) === 0) continue;
    const request: ReleaseRequest = {
      id: row.id,
      action: row.action as RequestAction,
      version: row.version,
      dryRun: row.dry_run === 1,
      canary: row.canary,
      batchSize: row.batch_size,
      requestedBy: row.requested_by,
      createdAt: row.created_at,
    };
    let outcome: { releaseId: string | null; result: string };
    const problem = requestProblem(request);
    try {
      outcome = problem ? { releaseId: null, result: `Refused: ${problem}.` } : await applyRequest(deps, request);
    } catch (error) {
      console.error("[release] request failed", { request: row.id, error: describeError(error) });
      outcome = { releaseId: null, result: `Failed: ${describeError(error)}` };
    }
    await deps.db
      .prepare("UPDATE release_requests SET release_id = ?, result = ? WHERE id = ?")
      .bind(outcome.releaseId, outcome.result.slice(0, 500), row.id)
      .run();
    outcomes.push({ requestId: row.id, ...outcome });
  }
  return outcomes;
}

async function applyRequest(deps: ReleaseDeps, request: ReleaseRequest): Promise<{ releaseId: string | null; result: string }> {
  switch (request.action) {
    case "rollout":
      return startRollout(deps, request);
    case "rollback":
      return startRollback(deps, request);
    default:
      return changeActive(deps, request);
  }
}

async function systemAudit(db: D1Database, action: string, detail: Record<string, unknown>, now: number, tenant?: TenantRecord) {
  await db
    .prepare("INSERT INTO audit_events (at, account_id, tenant_id, actor, action, detail) VALUES (?, ?, ?, 'system', ?, ?)")
    .bind(now, tenant?.accountId ?? null, tenant?.id ?? null, action, JSON.stringify(detail))
    .run();
}

interface CanaryChoice {
  tenant: { id: string; slug: string } | null;
  reason: string;
  error?: string;
}

async function chooseCanary(deps: ReleaseDeps, asked: string | null, version: string): Promise<CanaryChoice> {
  const wanted = asked ?? deps.defaultCanary?.trim().toLowerCase() ?? null;
  if (wanted) {
    const row = await deps.db
      .prepare("SELECT id, slug, provision_state FROM tenants WHERE id = ? OR slug = ?")
      .bind(isTenantId(wanted) ? wanted : "", wanted)
      .first<{ id: string; slug: string; provision_state: string }>();
    if (!row) return { tenant: null, reason: "", error: `There's no tenant ${wanted} to use as the canary.` };
    if (row.provision_state !== "ready") return { tenant: null, reason: "", error: `The canary ${row.slug} isn't ready.` };
    return { tenant: row, reason: asked ? "named in the request" : "RELEASE_CANARY" };
  }
  const oldest = await deps.db
    .prepare(
      `SELECT id, slug FROM tenants WHERE provision_state = 'ready' AND (version IS NULL OR version <> ?)
       ORDER BY provisioned_at, created_at, id LIMIT 1`,
    )
    .bind(version)
    .first<{ id: string; slug: string }>();
  return { tenant: oldest, reason: oldest ? "the oldest tenant (set RELEASE_CANARY to choose one)" : "no tenant needs it" };
}

/** Tenants that would get `version`, and the first batch's slugs. */
async function pendingTenants(db: D1Database, version: string, exclude: string | null, sample: number): Promise<{ count: number; slugs: string[] }> {
  const [count, first] = await db.batch<{ n?: number; slug?: string }>([
    db.prepare("SELECT COUNT(*) AS n FROM tenants WHERE provision_state = 'ready' AND (version IS NULL OR version <> ?)").bind(version),
    db
      .prepare("SELECT slug FROM tenants WHERE provision_state = 'ready' AND (version IS NULL OR version <> ?) AND id <> ? ORDER BY id LIMIT ?")
      .bind(version, exclude ?? "", sample),
  ]);
  return { count: count!.results[0]?.n ?? 0, slugs: first!.results.map((r) => r.slug!) };
}

async function insertRelease(
  deps: ReleaseDeps,
  r: {
    id: string;
    kind: "rollout" | "rollback";
    version: string;
    fromVersion: string | null;
    dryRun: boolean;
    state: ReleaseState;
    canary: string | null;
    canaryState: string | null;
    batchSize: number;
    batch: number;
    requestedBy: string;
    note: string | null;
    plan: ReleasePlan | null;
  },
  extra: D1PreparedStatement[] = [],
): Promise<void> {
  const now = (deps.now ?? Date.now)();
  const finished = ACTIVE_STATES.includes(r.state) ? null : now;
  await deps.db.batch([
    ...extra,
    deps.db
      .prepare(
        `INSERT INTO releases (id, kind, version, from_version, dry_run, state, canary_tenant_id, canary_state, batch_size, batch,
           requested_by, note, plan, created_at, updated_at, finished_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        r.id,
        r.kind,
        r.version,
        r.fromVersion,
        r.dryRun ? 1 : 0,
        r.state,
        r.canary,
        r.canaryState,
        r.batchSize,
        r.batch,
        r.requestedBy,
        r.note?.slice(0, 1000) ?? null,
        r.plan ? JSON.stringify(r.plan) : null,
        now,
        now,
        finished,
      ),
    ...(r.canary && ACTIVE_STATES.includes(r.state)
      ? [
          deps.db
            .prepare("INSERT INTO release_tenants (release_id, tenant_id, batch, state, updated_at) VALUES (?, ?, 0, 'pending', ?)")
            .bind(r.id, r.canary, now),
        ]
      : []),
  ]);
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

async function loadOrRefuse(deps: ReleaseDeps, version: string): Promise<TenantBundle | string> {
  if (!(await deps.store.hasVersion(version))) return `${version} isn't in the bundle bucket (or its upload didn't finish).`;
  try {
    return await deps.store.version(version);
  } catch (error) {
    return `${version} doesn't load: ${describeError(error)}`;
  }
}

async function refuse(deps: ReleaseDeps, request: ReleaseRequest, kind: "rollout" | "rollback", version: string, fromVersion: string | null, note: string, checks?: ReleaseChecks) {
  const id = randomId("rel_");
  await insertRelease(deps, {
    id,
    kind,
    version,
    fromVersion,
    dryRun: request.dryRun,
    state: "refused",
    canary: null,
    canaryState: null,
    batchSize: request.batchSize ?? RELEASE_BATCH_SIZE,
    batch: 0,
    requestedBy: request.requestedBy,
    note,
    plan: checks ? { checks, canary: null, toUpdate: 0, batches: 0, batchSize: request.batchSize ?? RELEASE_BATCH_SIZE, firstBatch: [] } : null,
  });
  await systemAudit(deps.db, "release.refused", { release: id, kind, version, reason: note.slice(0, 200) }, (deps.now ?? Date.now)());
  return { releaseId: id, result: `Refused: ${note}` };
}

async function startRollout(deps: ReleaseDeps, request: ReleaseRequest): Promise<{ releaseId: string | null; result: string }> {
  const version = request.version!;
  const batchSize = request.batchSize ?? RELEASE_BATCH_SIZE;
  const live = await deps.store.currentVersion();
  const active = await activeRelease(deps.db);
  if (active && !request.dryRun) {
    return refuse(deps, request, "rollout", version, live, `Release ${active.id} (${active.version}) is still ${active.state}; finish, cancel or roll it back first.`);
  }
  const next = await loadOrRefuse(deps, version);
  if (typeof next === "string") return refuse(deps, request, "rollout", version, live, next);
  let liveBundle: TenantBundle | null = null;
  if (live && live !== version) {
    const loaded = await loadOrRefuse(deps, live);
    if (typeof loaded === "string") return refuse(deps, request, "rollout", version, live, `The current release can't be read to compare with: ${loaded}`);
    liveBundle = loaded;
  }
  const checks = await checkRollout(next, liveBundle, (name) => deps.store.migrationSql(version, name));
  if (checks.problems.length) return refuse(deps, request, "rollout", version, live, checks.problems.join(" "), checks);

  const canary = await chooseCanary(deps, request.canary, version);
  if (canary.error) return refuse(deps, request, "rollout", version, live, canary.error, checks);
  const pending = await pendingTenants(deps.db, version, canary.tenant?.id ?? null, 10);
  const afterCanary = pending.count - (canary.tenant ? 1 : 0);
  const plan: ReleasePlan = {
    checks,
    canary: canary.tenant ? { ...canary.tenant, reason: canary.reason } : null,
    toUpdate: pending.count,
    batches: Math.ceil(Math.max(0, afterCanary) / batchSize),
    batchSize,
    firstBatch: pending.slugs,
  };
  const summary = canary.tenant
    ? `${plural(pending.count, "tenant")} to update: the canary ${canary.tenant.slug}, then ${plural(plan.batches, "batch", "batches")} of up to ${batchSize}.`
    : "No tenant to update; new tenants get it once it is current.";
  const id = randomId("rel_");
  const base = { id, kind: "rollout" as const, version, fromVersion: live, batchSize, requestedBy: request.requestedBy, plan };
  if (request.dryRun) {
    await insertRelease(deps, { ...base, dryRun: true, state: "done", canary: canary.tenant?.id ?? null, canaryState: null, batch: 0, note: `Dry run: ${summary}` });
    return { releaseId: id, result: `Dry run: ${summary}` };
  }
  try {
    await insertRelease(deps, {
      ...base,
      dryRun: false,
      state: canary.tenant ? "canary" : "rolling",
      canary: canary.tenant?.id ?? null,
      canaryState: canary.tenant ? "pending" : null,
      batch: canary.tenant ? 0 : 1,
      note: summary,
    });
  } catch (error) {
    if (String(error).includes("UNIQUE")) return refuse(deps, request, "rollout", version, live, "Another release started at the same moment.");
    throw error;
  }
  // With no canary there is nothing to prove first.
  if (!canary.tenant) await deps.store.setCurrent(version);
  await systemAudit(deps.db, "release.started", { release: id, version, from: live, by: request.requestedBy, tenants: pending.count }, (deps.now ?? Date.now)());
  return { releaseId: id, result: `Started: ${summary}` };
}

/** The version a rollback returns to when none is named: what the newest rollout replaced. */
async function previousVersion(db: D1Database, current: string | null): Promise<string | null> {
  const row = await db
    .prepare(
      `SELECT from_version FROM releases WHERE kind = 'rollout' AND dry_run = 0 AND state <> 'refused' AND from_version IS NOT NULL
         AND version = ? ORDER BY created_at DESC LIMIT 1`,
    )
    .bind(current ?? "")
    .first<{ from_version: string }>();
  if (row) return row.from_version;
  // The current version came from a rollback (or by hand): the rollout before the newest one.
  const last = await db
    .prepare(
      `SELECT from_version FROM releases WHERE kind = 'rollout' AND dry_run = 0 AND state <> 'refused' AND from_version IS NOT NULL
         AND from_version <> ? ORDER BY created_at DESC LIMIT 1`,
    )
    .bind(current ?? "")
    .first<{ from_version: string }>();
  return last?.from_version ?? null;
}

async function startRollback(deps: ReleaseDeps, request: ReleaseRequest): Promise<{ releaseId: string | null; result: string }> {
  const live = await deps.store.currentVersion();
  const active = await activeRelease(deps.db);
  // During a rollout the tenants run its version, whatever releases/current says yet.
  const from = active?.kind === "rollout" ? active.version : live;
  const target = request.version ?? (active?.kind === "rollout" ? active.fromVersion : await previousVersion(deps.db, live));
  const batchSize = request.batchSize ?? RELEASE_BATCH_SIZE;
  if (!target) return refuse(deps, request, "rollback", live ?? "none", live, "There's no earlier release to roll back to.");
  const bundle = await loadOrRefuse(deps, target);
  if (typeof bundle === "string") return refuse(deps, request, "rollback", target, from, bundle);
  let fromBundle: TenantBundle | null = null;
  if (from && from !== target) {
    const loaded = await loadOrRefuse(deps, from);
    if (typeof loaded !== "string") fromBundle = loaded;
  }
  const checks = checkRollback(bundle, fromBundle);
  if (checks.problems.length) return refuse(deps, request, "rollback", target, from, checks.problems.join(" "), checks);
  const pending = await pendingTenants(deps.db, target, null, 10);
  if (pending.count === 0 && live === target && !active) {
    return refuse(deps, request, "rollback", target, from, `Every tenant already runs ${target}.`);
  }
  const plan: ReleasePlan = { checks, canary: null, toUpdate: pending.count, batches: Math.ceil(pending.count / batchSize), batchSize, firstBatch: pending.slugs };
  const summary = `Back to ${target}: ${plural(pending.count, "tenant")} in ${plural(plan.batches, "batch", "batches")}${active ? `, replacing ${active.id}` : ""}.`;
  const id = randomId("rel_");
  const base = { id, kind: "rollback" as const, version: target, fromVersion: from, batchSize, requestedBy: request.requestedBy, plan, canary: null, canaryState: null };
  if (request.dryRun) {
    await insertRelease(deps, { ...base, dryRun: true, state: "done", batch: 0, note: `Dry run: ${summary}` });
    return { releaseId: id, result: `Dry run: ${summary}` };
  }
  const now = (deps.now ?? Date.now)();
  const cancel = active
    ? [
        deps.db
          .prepare("UPDATE releases SET state = 'cancelled', note = ?, finished_at = ?, updated_at = ? WHERE id = ? AND state IN ('canary', 'rolling', 'paused')")
          .bind(`Replaced by the rollback ${id}.`, now, now, active.id),
      ]
    : [];
  await insertRelease(deps, { ...base, dryRun: false, state: "rolling", batch: 1, note: summary }, cancel);
  // New tenants get the older version at once; the rest follow batch by batch.
  await deps.store.setCurrent(target);
  await systemAudit(deps.db, "release.rollback_started", { release: id, version: target, from, by: request.requestedBy, replaced: active?.id ?? null }, now);
  return { releaseId: id, result: `Started: ${summary}` };
}

async function changeActive(deps: ReleaseDeps, request: ReleaseRequest): Promise<{ releaseId: string | null; result: string }> {
  const active = await activeRelease(deps.db);
  if (!active) return { releaseId: null, result: "Nothing to do: no release is in progress." };
  const now = (deps.now ?? Date.now)();
  const db = deps.db;
  const set = async (state: ReleaseState, note: string, extra: D1PreparedStatement[] = []) => {
    await db.batch([
      ...extra,
      db
        .prepare("UPDATE releases SET state = ?, note = ?, updated_at = ?, finished_at = ? WHERE id = ? AND state = ?")
        .bind(state, note, now, ACTIVE_STATES.includes(state) ? null : now, active.id, active.state),
    ]);
    await systemAudit(db, `release.${request.action}`, { release: active.id, version: active.version, by: request.requestedBy }, now);
    return { releaseId: active.id, result: note };
  };
  const resumeState: ReleaseState = active.kind === "rollout" && active.canaryState !== "ran" && active.canaryTenantId ? "canary" : "rolling";
  switch (request.action) {
    case "pause":
      if (active.state === "paused") return { releaseId: active.id, result: "It was already paused." };
      return set("paused", `Paused by ${request.requestedBy}.`);
    case "cancel":
      return set("cancelled", `Cancelled by ${request.requestedBy}. Tenants already updated keep ${active.version}; roll back to undo them.`);
    case "resume":
    case "skip_failed": {
      if (active.state !== "paused") return { releaseId: active.id, result: `It is ${active.state}, not paused.` };
      if (request.action === "skip_failed" && active.batch === 0) {
        return { releaseId: active.id, result: "The canary can't be skipped: cancel and start again with another canary." };
      }
      const retry =
        request.action === "resume"
          ? db.prepare("UPDATE release_tenants SET state = 'pending', attempts = 0, error = NULL, updated_at = ? WHERE release_id = ? AND state = 'failed'").bind(now, active.id)
          : db.prepare("UPDATE release_tenants SET state = 'skipped', updated_at = ? WHERE release_id = ? AND state = 'failed'").bind(now, active.id);
      // The canary's count of busy scheduled runs starts again too.
      const fresh = db.prepare("UPDATE release_tenants SET attempts = 0 WHERE release_id = ? AND batch = 0 AND state = 'healthy'").bind(active.id);
      return set(resumeState, request.action === "resume" ? `Resumed by ${request.requestedBy}; failed tenants are tried again.` : `Resumed by ${request.requestedBy}, skipping the failed tenants.`, [retry, fresh]);
    }
    default:
      return { releaseId: null, result: "Unknown action." };
  }
}

// ---------------------------------------------------------------------------
// Running the active release
// ---------------------------------------------------------------------------

async function acquireLease(db: D1Database, id: string, now: number): Promise<string | null> {
  const token = crypto.randomUUID();
  const result = await db
    .prepare(
      `UPDATE releases SET lease_until = ?, lease_token = ? WHERE id = ? AND state IN ('canary', 'rolling')
         AND (lease_until IS NULL OR lease_until <= ?)`,
    )
    .bind(now + RELEASE_LEASE_MS, token, id, now)
    .run();
  return (result.meta.changes ?? 0) > 0 ? token : null;
}

async function renewLease(db: D1Database, id: string, token: string, now: number): Promise<boolean> {
  const result = await db.prepare("UPDATE releases SET lease_until = ? WHERE id = ? AND lease_token = ?").bind(now + RELEASE_LEASE_MS, id, token).run();
  return (result.meta.changes ?? 0) > 0;
}

async function releaseLease(db: D1Database, id: string, token: string): Promise<void> {
  await db.prepare("UPDATE releases SET lease_until = NULL, lease_token = NULL WHERE id = ? AND lease_token = ?").bind(id, token).run();
}

interface Run {
  deps: ReleaseDeps;
  release: Release;
  token: string;
  now: () => number;
}

/** Changes the release, only while this run holds it and it is still in the state it was read in. */
async function updateRelease(run: Run, set: Record<string, string | number | null>): Promise<boolean> {
  const columns = Object.keys(set);
  const result = await run.deps.db
    .prepare(`UPDATE releases SET ${columns.map((c) => `${c} = ?`).join(", ")}, updated_at = ? WHERE id = ? AND lease_token = ? AND state = ?`)
    .bind(...columns.map((c) => set[c]!), run.now(), run.release.id, run.token, run.release.state)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

async function stop(run: Run, note: string): Promise<"stopped"> {
  await updateRelease(run, { state: "paused", note: note.slice(0, 1000) });
  await systemAudit(run.deps.db, "release.paused", { release: run.release.id, version: run.release.version, reason: note.slice(0, 200) }, run.now());
  console.warn("[release] stopped", { release: run.release.id, note });
  return "stopped";
}

interface TenantRow {
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
  do_migration_tag: string | null;
}

async function loadTenant(db: D1Database, id: string): Promise<{ record: TenantRecord; d1Id: string | null; doTag: string | null } | null> {
  const row = await db
    .prepare(
      `SELECT id, account_id, slug, script_name, status, owner_suspended_at, plan, provision_state, version, limit_overrides,
              trial_ends_at, d1_id, do_migration_tag FROM tenants WHERE id = ?`,
    )
    .bind(id)
    .first<TenantRow>();
  return row ? { record: tenantFromRow(row), d1Id: row.d1_id, doTag: row.do_migration_tag } : null;
}

interface MemberRow {
  tenant_id: string;
  batch: number;
  state: ReleaseTenantState;
  attempts: number;
  updated_at: number;
}

async function setMember(run: Run, tenantId: string, set: Record<string, string | number | null>): Promise<void> {
  const columns = Object.keys(set);
  await run.deps.db
    .prepare(`UPDATE release_tenants SET ${columns.map((c) => `${c} = ?`).join(", ")}, updated_at = ? WHERE release_id = ? AND tenant_id = ?`)
    .bind(...columns.map((c) => set[c]!), run.now(), run.release.id, tenantId)
    .run();
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | "timeout"> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

/** One health check: ok on this version, not yet (with why), or no answer. */
async function checkHealth(run: Run, tenant: TenantRecord): Promise<{ ok: true } | { ok: false; reason: string }> {
  const { deps } = run;
  try {
    const call = callTenant(deps.dispatcher, { tenant, hostedDomain: deps.config.hostedDomain, platform: deps.capability(tenant) }, PLATFORM_HEALTH_PATH);
    const result = await withTimeout(call, HEALTH_TIMEOUT_MS);
    if (result === "timeout") return { ok: false, reason: `health didn't answer within ${HEALTH_TIMEOUT_MS / 1000} seconds` };
    if (result.kind === "missing") return { ok: false, reason: `${tenant.scriptName} isn't in the namespace` };
    const body = await result.response.json<HealthResponse>().catch(() => null);
    if (!body || typeof body.ok !== "boolean") return { ok: false, reason: `health answered HTTP ${result.response.status} without a report` };
    if (body.version !== run.release.version) return { ok: false, reason: `health reports version ${String(body.version)}` };
    if (!body.ok) return { ok: false, reason: `not healthy: schema ${body.schemaVersion} of ${body.bundledSchemaVersion}${body.migrating ? ", migrating" : ""}` };
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: `health call failed: ${describeError(error)}` };
  }
}

type StepResult = "progress" | "wait" | "stopped" | "done";

/** Uploads the release to one tenant (when it isn't on it yet) and checks its health once. */
async function updateTenant(run: Run, bundle: TenantBundle, member: MemberRow): Promise<ReleaseTenantState> {
  const { deps } = run;
  const loaded = await loadTenant(deps.db, member.tenant_id);
  if (!loaded || loaded.record.provisionState !== "ready") {
    await setMember(run, member.tenant_id, { state: "skipped", error: loaded ? `it is ${loaded.record.provisionState}` : "it was removed" });
    return "skipped";
  }
  const tenant = loaded.record;
  if (member.state === "pending") {
    if (tenant.version !== bundle.version) {
      try {
        if (!loaded.d1Id) throw new PermanentError("it has no database id");
        const escrowed = await activeEscrowedKey(deps.db, tenant.id);
        // Never a new key: the tenant's data is encrypted under the one it has.
        if (!escrowed) throw new PermanentError("it has no escrowed MASTER_KEY");
        const masterKey = await openEscrowedKey(escrowed, tenant.id, deps.config.platformKey);
        await uploadUserWorker(deps.api, {
          namespace: deps.config.namespace,
          scriptName: tenant.scriptName,
          bundle,
          bindings: [{ type: "d1", name: "DB", database_id: loaded.d1Id }],
          vars: {
            [HOSTED_ENV.mode]: HOSTED_MODE_ON,
            [HOSTED_ENV.tenantId]: tenant.id,
            [HOSTED_ENV.handoffPublicKey]: deps.config.handoffPublicKey,
          },
          secrets: { MASTER_KEY: masterKey },
          tags: tenantTags(tenant.id, bundle.version),
          previousMigrationTag: loaded.doTag,
        });
      } catch (error) {
        const retryable = error instanceof CloudflareApiError ? error.retryable : !(error instanceof PermanentError);
        const attempts = member.attempts + 1;
        const failed = !retryable || attempts >= UPLOAD_MAX_ATTEMPTS;
        await setMember(run, tenant.id, { state: failed ? "failed" : "pending", attempts, error: `upload: ${describeError(error)}`.slice(0, 300) });
        return failed ? "failed" : "pending";
      }
      await deps.db
        .prepare("UPDATE tenants SET version = ?, do_migration_tag = ?, updated_at = ? WHERE id = ? AND provision_state = 'ready'")
        .bind(bundle.version, bundle.migrations.at(-1)?.tag ?? loaded.doTag, run.now(), tenant.id)
        .run();
      await systemAudit(deps.db, "tenant.updated", { release: run.release.id, from: tenant.version, to: bundle.version }, run.now(), tenant);
    }
    await setMember(run, tenant.id, { state: "uploaded", attempts: 0, error: null, from_version: tenant.version });
    member = { ...member, state: "uploaded", attempts: 0 };
  }
  const health = await checkHealth(run, { ...tenant, version: bundle.version });
  if (health.ok) {
    await setMember(run, tenant.id, { state: "healthy", error: null });
    return "healthy";
  }
  const attempts = member.attempts + 1;
  const failed = attempts >= HEALTH_MAX_ATTEMPTS;
  await setMember(run, tenant.id, { state: failed ? "failed" : "uploaded", attempts, error: health.reason.slice(0, 300) });
  return failed ? "failed" : "uploaded";
}

async function members(run: Run, batch: number): Promise<MemberRow[]> {
  const rows = await run.deps.db
    .prepare("SELECT tenant_id, batch, state, attempts, updated_at FROM release_tenants WHERE release_id = ? AND batch = ? ORDER BY tenant_id")
    .bind(run.release.id, batch)
    .all<MemberRow>();
  return rows.results;
}

/**
 * The next member worth working on now: one pending or uploaded whose last
 * try (if any) is at least HEALTH_RETRY_MS old; "waiting" when every open one
 * was tried too recently; null when none is open.
 */
function nextMember(rows: MemberRow[], now: number): MemberRow | "waiting" | null {
  const open = rows.filter((r) => r.state === "pending" || r.state === "uploaded");
  if (!open.length) return null;
  const due = (r: MemberRow) => r.attempts === 0 || now - r.updated_at >= HEALTH_RETRY_MS;
  return open.find((r) => r.state === "pending" && due(r)) ?? open.find(due) ?? "waiting";
}

async function slugOf(db: D1Database, tenantId: string): Promise<string> {
  return (await db.prepare("SELECT slug FROM tenants WHERE id = ?").bind(tenantId).first<{ slug: string }>())?.slug ?? tenantId;
}

async function stepCanary(run: Run, bundle: TenantBundle): Promise<StepResult> {
  const { deps, release } = run;
  const canaryId = release.canaryTenantId!;
  const [member] = await members(run, 0);
  if (!member || member.state === "skipped") return stop(run, `The canary ${await slugOf(deps.db, canaryId)} is gone or no longer ready; cancel and start again with another canary.`);
  if (member.state === "failed") {
    const error = (await deps.db.prepare("SELECT error FROM release_tenants WHERE release_id = ? AND tenant_id = ?").bind(release.id, canaryId).first<{ error: string | null }>())?.error;
    return stop(run, `The canary ${await slugOf(deps.db, canaryId)} failed: ${error ?? "no reason recorded"}. Nothing else was touched.`);
  }
  if (member.state !== "healthy") {
    const next = nextMember([member], run.now());
    if (next === "waiting" || next === null) return "wait";
    await updateTenant(run, bundle, next);
    return "progress";
  }
  if (release.canaryState === "pending") {
    await updateRelease(run, { canary_state: "healthy" });
    return "progress";
  }
  // Healthy on the new version; now one scheduled run must come back clean.
  const loaded = await loadTenant(deps.db, canaryId);
  if (!loaded) return stop(run, "The canary was removed before its scheduled run.");
  const request: ScheduledRequest = { runId: `release-${release.id}`, scheduledTime: run.now(), cron: "release" };
  let summary: ScheduledRunSummary | null = null;
  let reason = "";
  try {
    const call = callTenant(deps.dispatcher, { tenant: loaded.record, hostedDomain: deps.config.hostedDomain, platform: deps.capability(loaded.record) }, PLATFORM_SCHEDULED_PATH, {
      method: "POST",
      body: request,
    });
    const result = await call;
    if (result.kind === "missing") reason = "its Worker isn't in the namespace";
    else if (result.response.status !== 200) reason = `the scheduled call answered HTTP ${result.response.status}`;
    else summary = await result.response.json<ScheduledRunSummary>().catch(() => null);
  } catch (error) {
    reason = `the scheduled call failed: ${describeError(error)}`;
  }
  const slug = loaded.record.slug;
  if (summary?.outcome === "ran" && summary.version === release.version) {
    // Proven on one tenant: new sign-ups get it from now on, and the batches
    // start. The pointer first: if the write below is lost, the next tick
    // runs the canary's check again and sets the same pointer.
    await deps.store.setCurrent(release.version);
    await updateRelease(run, {
      canary_state: "ran",
      state: "rolling",
      batch: 1,
      note: `The canary ${slug} ran clean (${summary.checked} checks in ${summary.durationMs} ms); rolling out.`,
    });
    await systemAudit(deps.db, "release.canary_passed", { release: release.id, version: release.version, canary: slug }, run.now());
    return "progress";
  }
  if (summary?.outcome === "lease_busy") {
    const busy = member.attempts + 1;
    if (busy >= CANARY_BUSY_MAX) return stop(run, `The canary ${slug} was busy with another run ${busy} times; resume to try again.`);
    await setMember(run, canaryId, { attempts: busy, error: "its scheduled run was busy" });
    return "wait";
  }
  if (summary?.outcome === "failed") return stop(run, `The canary ${slug}'s scheduled run failed: ${summary.error ?? "no reason"}. Nothing else was touched.`);
  if (summary) reason = `its scheduled run reported version ${summary.version}`;
  return stop(run, `The canary ${slug}'s scheduled run gave no clean answer: ${reason || "no summary"}.`);
}

async function stepRolling(run: Run, bundle: TenantBundle): Promise<StepResult> {
  const { deps, release } = run;
  const rows = release.batch > 0 ? await members(run, release.batch) : [];
  const failed = rows.filter((r) => r.state === "failed");
  if (failed.length && release.kind === "rollout") {
    const detail = await deps.db
      .prepare("SELECT t.slug, r.error FROM release_tenants r LEFT JOIN tenants t ON t.id = r.tenant_id WHERE r.release_id = ? AND r.batch = ? AND r.state = 'failed' LIMIT 3")
      .bind(release.id, release.batch)
      .all<{ slug: string | null; error: string | null }>();
    const list = detail.results.map((d) => `${d.slug ?? "?"} (${d.error ?? "no reason"})`).join("; ");
    return stop(run, `Stopped in batch ${release.batch}: ${plural(failed.length, "tenant")} didn't come back healthy: ${list}.`);
  }
  const next = nextMember(rows, run.now());
  if (next === "waiting") return "wait";
  if (next) {
    await updateTenant(run, bundle, next);
    return "progress";
  }
  // This batch is finished (or not chosen yet): choose it from the tenants not on the version yet.
  const nextBatch = rows.length === 0 ? Math.max(1, release.batch) : release.batch + 1;
  const now = run.now();
  const inserted = await deps.db
    .prepare(
      `INSERT INTO release_tenants (release_id, tenant_id, batch, state, updated_at)
       SELECT ?1, id, ?2, 'pending', ?3 FROM tenants
       WHERE provision_state = 'ready' AND (version IS NULL OR version <> ?4)
         AND id NOT IN (SELECT tenant_id FROM release_tenants WHERE release_id = ?1)
         AND EXISTS (SELECT 1 FROM releases WHERE id = ?1 AND lease_token = ?5)
       ORDER BY id LIMIT ?6`,
    )
    .bind(release.id, nextBatch, now, release.version, run.token, release.batchSize)
    .run();
  if ((inserted.meta.changes ?? 0) > 0) {
    if (nextBatch !== release.batch) await updateRelease(run, { batch: nextBatch });
    return "progress";
  }
  const counts = await memberCounts(deps.db, release.id);
  const bad = counts.failed + counts.skipped;
  const note =
    `${release.kind === "rollback" ? "Rolled back to" : "Shipped"} ${release.version}: ${plural(counts.healthy, "tenant")} healthy` +
    (bad ? `, ${counts.failed} failed and ${counts.skipped} skipped (see the list).` : ".");
  if (release.kind === "rollout" && (await deps.store.currentVersion()) !== release.version) await deps.store.setCurrent(release.version);
  await updateRelease(run, { state: "done", finished_at: now, note });
  await systemAudit(deps.db, release.kind === "rollback" ? "release.rolled_back" : "release.done", { release: release.id, version: release.version, ...counts }, now);
  return "done";
}

export interface MemberCounts {
  pending: number;
  uploaded: number;
  healthy: number;
  failed: number;
  skipped: number;
}

export async function memberCounts(db: D1Database, releaseId: string): Promise<MemberCounts> {
  const rows = await db.prepare("SELECT state, COUNT(*) AS n FROM release_tenants WHERE release_id = ? GROUP BY state").bind(releaseId).all<{ state: string; n: number }>();
  const out: MemberCounts = { pending: 0, uploaded: 0, healthy: 0, failed: 0, skipped: 0 };
  for (const r of rows.results) if (r.state in out) out[r.state as keyof MemberCounts] = r.n;
  return out;
}

export type TickOutcome = { kind: "idle" } | { kind: "busy"; releaseId: string } | { kind: "ran"; releaseId: string; steps: number; state: ReleaseState };

/**
 * Takes the active release as far as it goes in `budgetMs` (one step at
 * least): until it waits (a health check to repeat), stops, finishes, or
 * runs out of time. The
 * cron calls this every minute; the console calls it right after a change.
 */
export async function advanceRelease(deps: ReleaseDeps, budgetMs = RELEASE_TICK_BUDGET_MS): Promise<TickOutcome> {
  const now = deps.now ?? Date.now;
  const deadline = now() + budgetMs;
  const first = await activeRelease(deps.db);
  if (!first || first.state === "paused") return { kind: "idle" };
  const token = await acquireLease(deps.db, first.id, now());
  if (!token) return { kind: "busy", releaseId: first.id };
  let steps = 0;
  let state: ReleaseState = first.state;
  try {
    let bundle: TenantBundle;
    try {
      bundle = await deps.store.version(first.version);
    } catch (error) {
      await stop({ deps, release: first, token, now }, `${first.version} can't be read from the bundle bucket: ${describeError(error)}`);
      return { kind: "ran", releaseId: first.id, steps, state: "paused" };
    }
    // At least one step, however small the budget.
    while (steps === 0 || now() < deadline) {
      if (!(await renewLease(deps.db, first.id, token, now()))) break;
      const release = await getRelease(deps.db, first.id);
      if (!release || (release.state !== "canary" && release.state !== "rolling")) {
        state = release?.state ?? state;
        break;
      }
      state = release.state;
      const run: Run = { deps, release, token, now };
      const result = release.state === "canary" ? await stepCanary(run, bundle) : await stepRolling(run, bundle);
      steps++;
      if (result === "wait") {
        if (deps.sleep) {
          await deps.sleep(HEALTH_RETRY_MS);
          continue;
        }
        break;
      }
      if (result !== "progress") {
        state = (await getRelease(deps.db, first.id))?.state ?? state;
        break;
      }
    }
  } finally {
    await releaseLease(deps.db, first.id, token);
  }
  return { kind: "ran", releaseId: first.id, steps, state };
}

/** One cron tick: the owner's requests first, then the active release. */
export async function releaseTick(deps: ReleaseDeps, budgetMs = RELEASE_TICK_BUDGET_MS): Promise<{ requests: RequestOutcome[]; tick: TickOutcome }> {
  const requests = await handleRequests(deps);
  const tick = await advanceRelease(deps, budgetMs);
  return { requests, tick };
}

/** The members of a release for its page: failures first, then by batch. */
export async function releaseMembers(
  db: D1Database,
  releaseId: string,
  limit = 200,
): Promise<{ tenantId: string; slug: string | null; batch: number; state: ReleaseTenantState; fromVersion: string | null; error: string | null; updatedAt: number }[]> {
  const rows = await db
    .prepare(
      `SELECT r.tenant_id, t.slug, r.batch, r.state, r.from_version, r.error, r.updated_at
       FROM release_tenants r LEFT JOIN tenants t ON t.id = r.tenant_id WHERE r.release_id = ?
       ORDER BY CASE r.state WHEN 'failed' THEN 0 WHEN 'uploaded' THEN 1 WHEN 'pending' THEN 2 WHEN 'skipped' THEN 3 ELSE 4 END, r.batch, r.tenant_id
       LIMIT ?`,
    )
    .bind(releaseId, limit)
    .all<{ tenant_id: string; slug: string | null; batch: number; state: ReleaseTenantState; from_version: string | null; error: string | null; updated_at: number }>();
  return rows.results.map((r) => ({ tenantId: r.tenant_id, slug: r.slug, batch: r.batch, state: r.state, fromVersion: r.from_version, error: r.error, updatedAt: r.updated_at }));
}

/** Requests still waiting for a tick (from the command line, usually). */
export async function pendingRequests(db: D1Database): Promise<{ id: string; action: string; version: string | null; createdAt: number }[]> {
  const rows = await db
    .prepare("SELECT id, action, version, created_at FROM release_requests WHERE handled_at IS NULL ORDER BY created_at LIMIT 20")
    .all<{ id: string; action: string; version: string | null; created_at: number }>();
  return rows.results.map((r) => ({ id: r.id, action: r.action, version: r.version, createdAt: r.created_at }));
}
