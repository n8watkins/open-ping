import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { generateHandoffKeyPair, type PlatformCapability } from "../../src/shared/hosted-contract";
import { R2BundleSource, clearLoadedBundles, compareVersions, type BundleManifest, type TenantBundle } from "../src/bundle";
import { generateMasterKey, openEscrowedKey, activeEscrowedKey } from "../src/keys";
import { requestTenant, runProvisioning, type ProvisioningDeps } from "../src/provisioning";
import { checkRollback, checkRollout } from "../src/releases/checks";
import {
  HEALTH_MAX_ATTEMPTS,
  RELEASE_TICK_BUDGET_MS,
  UPLOAD_MAX_ATTEMPTS,
  activeRelease,
  advanceRelease,
  getRelease,
  handleRequests,
  memberCounts,
  releaseMembers,
  releaseTick,
  submitRequest,
  type ReleaseDeps,
  type ReleaseRequestInput,
} from "../src/releases/runner";
import { FakeCloudflareApi } from "./fake-cloudflare";
import { FakeDispatcher } from "./fake-dispatcher";
import { fakeOpenPing, type FakeOpenPingState } from "./fake-openping";
import { FakeR2Bucket } from "./fake-r2";

const DOMAIN = "openping.test";
const NAMESPACE = "openping-tenants-test";
const PLATFORM_KEY = generateMasterKey();
let HANDOFF_PUBLIC_KEY = "";

const bytes = (s: string) => new Uint8Array(new TextEncoder().encode(s));

const MIGRATIONS: Record<string, string> = {
  "0021_support.sql": "CREATE TABLE support_activity (id INTEGER PRIMARY KEY);",
  "0022_notes.sql": "ALTER TABLE monitors ADD COLUMN note TEXT;",
  "0023_drop.sql": "DROP TABLE support_activity;",
  "0023_index.sql": "CREATE INDEX idx_notes ON monitors(note);",
};

function bundle(version: string, migrations: string[], doTags: string[] = ["v1"], overrides: Partial<TenantBundle> = {}): TenantBundle {
  return {
    version,
    mainModule: "index.js",
    modules: [{ name: "index.js", content: bytes(`export default {} // ${version}`), contentType: "application/javascript+module" }],
    assets: [
      { path: "/index.html", content: bytes(`<!doctype html><title>OpenPing ${version}</title>`), contentType: "text/html; charset=utf-8" },
      { path: "/assets/app.js", content: bytes(`console.log("${version}")`), contentType: "text/javascript" },
    ],
    compatibilityDate: "2024-12-30",
    compatibilityFlags: ["nodejs_compat"],
    assetsConfig: { not_found_handling: "none", run_worker_first: ["/*", "!/assets/*"], _headers: "/*\n  X-Content-Type-Options: nosniff\n" },
    vars: { WORKERS_PLAN: "free", HOME_PAGE: "status" },
    durableObjects: [{ name: "REGION_PROBE", className: "RegionProbe" }],
    migrations: doTags.map((tag, i) => (i === 0 ? { tag, new_sqlite_classes: ["RegionProbe"] } : { tag, new_sqlite_classes: [`Extra${i}`] })),
    d1Migrations: migrations.map((name) => ({ name, sha256: `sha-${name}-${MIGRATIONS[name]!.length}` })),
    ...overrides,
  };
}

/** Writes a bundle to the bucket in the layout scripts/tenant-release.mjs uploads (bundle.json last). */
function publish(r2: FakeR2Bucket, b: TenantBundle): void {
  const prefix = `releases/${b.version}`;
  for (const m of b.modules) r2.objects.set(`${prefix}/modules/${m.name}`, { body: typeof m.content === "string" ? bytes(m.content) : m.content, uploaded: new Date(0) });
  for (const a of b.assets) r2.objects.set(`${prefix}/assets${a.path}`, { body: a.content, uploaded: new Date(0) });
  for (const m of b.d1Migrations) r2.putText(`${prefix}/migrations/${m.name}`, MIGRATIONS[m.name]!);
  const manifest: BundleManifest = {
    version: b.version,
    mainModule: b.mainModule,
    compatibilityDate: b.compatibilityDate,
    compatibilityFlags: b.compatibilityFlags,
    assetsConfig: b.assetsConfig,
    vars: b.vars,
    durableObjects: b.durableObjects,
    migrations: b.migrations,
    d1Migrations: b.d1Migrations,
    modules: b.modules.map((m) => ({ name: m.name, contentType: m.contentType })),
    assets: b.assets.map((a) => ({ path: a.path, contentType: a.contentType })),
  };
  r2.putText(`${prefix}/bundle.json`, JSON.stringify(manifest));
}

const V1 = bundle("0.14.0", ["0021_support.sql"]);
const V2 = bundle("0.15.0", ["0021_support.sql", "0022_notes.sql"]);

const noopPlatform: PlatformCapability = {
  sendEmail: async () => ({ ok: false, error: "email_unavailable", message: "" }),
  reportUsage: async () => {},
  audit: async () => {},
};

interface World {
  r2: FakeR2Bucket;
  api: FakeCloudflareApi;
  dispatcher: FakeDispatcher;
  /** Each tenant's OpenPing, by script name; kept across uploads, like its database. */
  tenants: Map<string, FakeOpenPingState>;
  clock: { now: number };
  provisioning: ProvisioningDeps;
  deps: ReleaseDeps;
}

function world(options: { defaultCanary?: string } = {}): World {
  const r2 = new FakeR2Bucket();
  const api = new FakeCloudflareApi();
  const dispatcher = new FakeDispatcher();
  const tenants = new Map<string, FakeOpenPingState>();
  api.onScriptChange = (name, script) => {
    if (!script) {
      dispatcher.remove(name);
      tenants.delete(name);
      return;
    }
    const fake = fakeOpenPing(script, { state: tenants.get(name), healthMigrates: true });
    dispatcher.register(name, fake.worker);
    tenants.set(name, fake.state);
  };
  const clock = { now: Date.UTC(2026, 10, 1) };
  const store = new R2BundleSource(r2.bucket);
  const config = { hostedDomain: DOMAIN, namespace: NAMESPACE, platformKey: PLATFORM_KEY, handoffPublicKey: HANDOFF_PUBLIC_KEY };
  const now = () => clock.now;
  const provisioning: ProvisioningDeps = { db: env.PLATFORM_DB, api, bundles: store, dispatcher, capability: () => noopPlatform, config, now };
  const deps: ReleaseDeps = {
    db: env.PLATFORM_DB,
    api,
    store,
    dispatcher,
    capability: () => noopPlatform,
    config,
    defaultCanary: options.defaultCanary ?? null,
    now,
    sleep: async (ms) => {
      clock.now += ms;
    },
  };
  return { r2, api, dispatcher, tenants, clock, provisioning, deps };
}

let seq = 0;
/** A ready tenant on whatever releases/current is. */
async function readyTenant(w: World, slug: string): Promise<string> {
  seq++;
  const accountId = `acc_rel${seq}`;
  await env.PLATFORM_DB.prepare("INSERT INTO accounts (id, email, created_at, updated_at) VALUES (?, ?, 0, 0)").bind(accountId, `rel${seq}@example.com`).run();
  const result = await requestTenant(env.PLATFORM_DB, { accountId, slug, now: w.clock.now });
  if (!result.ok) throw new Error(result.reason);
  w.clock.now += 1000;
  const outcome = await runProvisioning(w.provisioning, result.tenantId, { force: true });
  expect(outcome.kind).toBe("ready");
  return result.tenantId;
}

async function request(w: World, input: Omit<ReleaseRequestInput, "requestedBy"> & { requestedBy?: string }) {
  await submitRequest(env.PLATFORM_DB, { requestedBy: "cli", ...input }, w.clock.now);
  w.clock.now += 1;
  const [outcome] = await handleRequests(w.deps);
  return outcome!;
}

async function versions(): Promise<Record<string, string | null>> {
  const rows = await env.PLATFORM_DB.prepare("SELECT slug, version FROM tenants ORDER BY slug").all<{ slug: string; version: string | null }>();
  return Object.fromEntries(rows.results.map((r) => [r.slug, r.version]));
}

const scriptOf = (w: World, tenantId: string) => w.api.scriptIn(NAMESPACE, `t-${tenantId}`)!;
const putScripts = (w: World) => w.api.count("putScript");

beforeAll(async () => {
  await applyD1Migrations(env.PLATFORM_DB, env.TEST_MIGRATIONS);
  HANDOFF_PUBLIC_KEY = (await generateHandoffKeyPair()).publicKey;
});

beforeEach(async () => {
  clearLoadedBundles();
  await env.PLATFORM_DB.batch([
    env.PLATFORM_DB.prepare("DELETE FROM release_tenants"),
    env.PLATFORM_DB.prepare("DELETE FROM releases"),
    env.PLATFORM_DB.prepare("DELETE FROM release_requests"),
    env.PLATFORM_DB.prepare("DELETE FROM release_locks"),
    env.PLATFORM_DB.prepare("DELETE FROM escrowed_keys"),
    env.PLATFORM_DB.prepare("DELETE FROM audit_events"),
    env.PLATFORM_DB.prepare("DELETE FROM tenants"),
  ]);
});

/** A world with V1 current and three ready tenants on it, and V2 uploaded. */
async function shipped(options: { defaultCanary?: string } = {}) {
  const w = world(options);
  publish(w.r2, V1);
  w.r2.putText("releases/current", V1.version);
  const ids = {
    alpha: await readyTenant(w, "alpha"),
    bravo: await readyTenant(w, "bravo"),
    charlie: await readyTenant(w, "charlie"),
  };
  publish(w.r2, V2);
  return { w, ids };
}

describe("the bundle store in R2", () => {
  it("lists versions newest first across pages, ignoring the pointer", async () => {
    const r2 = new FakeR2Bucket();
    r2.pageSize = 2;
    for (const v of ["0.9.0", "0.10.0", "0.14.0", "0.9.1"]) publish(r2, bundle(v, ["0021_support.sql"]));
    r2.putText("releases/current", "0.10.0");
    const store = new R2BundleSource(r2.bucket);
    expect(await store.listVersions()).toEqual(["0.14.0", "0.10.0", "0.9.1", "0.9.0"]);
    expect(await store.currentVersion()).toBe("0.10.0");
    expect(await store.hasVersion("0.9.1")).toBe(true);
    expect(await store.hasVersion("0.9.2")).toBe(false);
    expect(await store.hasVersion("../x")).toBe(false);
  });

  it("reads a version back exactly, and refuses a broken one", async () => {
    const r2 = new FakeR2Bucket();
    publish(r2, V2);
    const store = new R2BundleSource(r2.bucket);
    const loaded = await store.version("0.15.0");
    expect(loaded.d1Migrations).toEqual(V2.d1Migrations);
    expect(loaded.assetsConfig._headers).toContain("nosniff");
    expect(new TextDecoder().decode(loaded.assets[0]!.content)).toBe("<!doctype html><title>OpenPing 0.15.0</title>");
    expect(await store.migrationSql("0.15.0", "0022_notes.sql")).toBe(MIGRATIONS["0022_notes.sql"]);

    const broken = bundle("0.16.0", ["0021_support.sql"]);
    publish(r2, broken);
    const manifest = JSON.parse(r2.textOf("releases/0.16.0/bundle.json")!) as BundleManifest;
    r2.putText("releases/0.16.0/bundle.json", JSON.stringify({ ...manifest, mainModule: "missing.js" }));
    await expect(store.version("0.16.0")).rejects.toThrow("main module");
    r2.putText("releases/0.17.0/bundle.json", "{not json");
    await expect(store.version("0.17.0")).rejects.toThrow("not JSON");
  });

  it("orders versions like SemVer", () => {
    expect(["0.10.0", "0.9.0", "1.0.0", "0.10.1"].sort(compareVersions)).toEqual(["0.9.0", "0.10.0", "0.10.1", "1.0.0"]);
  });
});

describe("the release checks", () => {
  const sql = async (name: string) => MIGRATIONS[name]!;

  it("accepts a release that only adds migrations", async () => {
    expect(await checkRollout(V2, V1, sql)).toEqual({ problems: [], newMigrations: ["0022_notes.sql"], newDurableObjectTags: [] });
  });

  it("refuses a migration that isn't additive", async () => {
    const bad = bundle("0.15.0", ["0021_support.sql", "0023_drop.sql"]);
    const checks = await checkRollout(bad, V1, sql);
    expect(checks.problems).toEqual([expect.stringContaining("0023_drop.sql drops something")]);
  });

  it("refuses a release that changed or lost a migration tenants already ran", async () => {
    const changed = bundle("0.15.0", ["0021_support.sql"]);
    changed.d1Migrations[0] = { name: "0021_support.sql", sha256: "edited" };
    expect((await checkRollout(changed, V1, sql)).problems).toEqual([expect.stringContaining("was changed after tenants ran it")]);
    const lost = bundle("0.15.0", ["0022_notes.sql"]);
    expect((await checkRollout(lost, V1, sql)).problems).toEqual([expect.stringContaining("missing or out of order")]);
  });

  it("refuses a bundle that doesn't list its migrations, and a rewritten Durable Object migration", async () => {
    expect((await checkRollout(bundle("0.15.0", []), V1, sql)).problems).toEqual([expect.stringContaining("doesn't list its D1 migrations")]);
    const rewritten = bundle("0.15.0", ["0021_support.sql"], ["v1"]);
    rewritten.migrations[0] = { tag: "v1", new_classes: ["RegionProbe"] };
    expect((await checkRollout(rewritten, V1, sql)).problems).toEqual([expect.stringContaining("Durable Object migration v1")]);
    expect((await checkRollout(bundle("0.15.0", ["0021_support.sql"], ["v1", "v2"]), V1, sql)).newDurableObjectTags).toEqual(["v2"]);
  });

  it("checks every migration after the rule's start on a first release", async () => {
    const first = bundle("0.14.0", ["0021_support.sql", "0023_drop.sql"]);
    expect((await checkRollout(first, null, sql)).problems).toHaveLength(1);
  });

  it("lets a rollback run on the newer schema, but not across a Durable Object migration", () => {
    expect(checkRollback(V1, V2).problems).toEqual([]);
    expect(checkRollback(V1, V2).newMigrations).toEqual(["0022_notes.sql"]);
    expect(checkRollback(V1, bundle("0.15.0", ["0021_support.sql"], ["v1", "v2"])).problems).toEqual([expect.stringContaining("can't be undone")]);
    const other = bundle("0.13.0", ["0022_notes.sql"]);
    expect(checkRollback(other, V2).problems).toEqual([expect.stringContaining("isn't one the tenants ran")]);
  });
});

describe("a rollout", () => {
  it("goes canary first, points new tenants at it once the canary ran clean, then batches", async () => {
    const { w, ids } = await shipped({ defaultCanary: "bravo" });
    const before = putScripts(w);
    const keyBefore = scriptOf(w, ids.alpha).metadata.bindings.find((b) => b.name === "MASTER_KEY");

    const started = await request(w, { action: "rollout", version: "0.15.0", batchSize: 1 });
    expect(started.result).toMatch(/^Started: 3 tenants to update: the canary bravo, then 2 batches of up to 1\./);
    const release = (await getRelease(env.PLATFORM_DB, started.releaseId!))!;
    expect(release).toMatchObject({ state: "canary", canaryTenantId: ids.bravo, canaryState: "pending", fromVersion: "0.14.0" });

    // One step at a time: the canary first, and nothing else until it ran clean.
    await advanceRelease({ ...w.deps, sleep: undefined }, 0);
    expect(await versions()).toEqual({ alpha: "0.14.0", bravo: "0.15.0", charlie: "0.14.0" });
    expect(w.r2.textOf("releases/current")).toBe("0.14.0");

    const tick = await advanceRelease(w.deps);
    expect(tick).toMatchObject({ kind: "ran", state: "done" });
    expect(await versions()).toEqual({ alpha: "0.15.0", bravo: "0.15.0", charlie: "0.15.0" });
    expect(w.r2.textOf("releases/current")).toBe("0.15.0");
    expect(putScripts(w) - before).toBe(3);
    // The canary's clean run came from the release itself.
    expect(w.tenants.get(`t-${ids.bravo}`)!.scheduledRuns.map((r) => r.cron)).toContain("release");

    const done = (await getRelease(env.PLATFORM_DB, started.releaseId!))!;
    expect(done).toMatchObject({ state: "done", canaryState: "ran", batch: 2, note: "Shipped 0.15.0: 3 tenants healthy." });
    expect(await memberCounts(env.PLATFORM_DB, done.id)).toMatchObject({ healthy: 3, failed: 0 });
    const batches = Object.fromEntries((await releaseMembers(env.PLATFORM_DB, done.id)).map((m) => [m.slug, m.batch]));
    expect(batches.bravo).toBe(0);
    expect(new Set([batches.alpha, batches.charlie])).toEqual(new Set([1, 2]));

    // The same key, tags and hosted vars as provisioning gave it; the new bundle's config.
    const script = scriptOf(w, ids.alpha);
    expect(script.metadata.bindings.find((b) => b.name === "MASTER_KEY")).toEqual(keyBefore);
    const escrowed = await activeEscrowedKey(env.PLATFORM_DB, ids.alpha);
    expect((keyBefore as { text: string }).text).toBe(await openEscrowedKey(escrowed!, ids.alpha, PLATFORM_KEY));
    expect(script.metadata.tags).toEqual(["openping", `tenant-${ids.alpha}`, "release-0.15.0"]);
    expect(script.metadata.assets?.config?._headers).toContain("nosniff");
    expect(script.metadata.migrations).toBeUndefined();
    expect(w.tenants.get(`t-${ids.alpha}`)!.env).toMatchObject({ HOSTED_MODE: "1", TENANT_ID: ids.alpha, HANDOFF_PUBLIC_KEY });

    const actions = await env.PLATFORM_DB.prepare("SELECT action FROM audit_events WHERE action LIKE 'release.%' ORDER BY id").all<{ action: string }>();
    expect(actions.results.map((r) => r.action)).toEqual(["release.started", "release.canary_passed", "release.done"]);
    expect(await activeRelease(env.PLATFORM_DB)).toBeNull();

    // A new sign-up now gets the new version.
    expect((await readyTenant(w, "delta")) && (await versions()).delta).toBe("0.15.0");
  });

  it("sends a new Durable Object migration from the tag each tenant is at", async () => {
    const { w, ids } = await shipped();
    publish(w.r2, bundle("0.16.0", ["0021_support.sql", "0022_notes.sql"], ["v1", "v2"]));
    await request(w, { action: "rollout", version: "0.16.0" });
    expect((await advanceRelease(w.deps)).kind).toBe("ran");
    const script = scriptOf(w, ids.charlie);
    expect(script.metadata.migrations).toEqual({ old_tag: "v1", new_tag: "v2", steps: [{ new_sqlite_classes: ["Extra1"] }] });
    expect(script.migrationTag).toBe("v2");
    const tag = await env.PLATFORM_DB.prepare("SELECT do_migration_tag FROM tenants WHERE id = ?").bind(ids.charlie).first<{ do_migration_tag: string }>();
    expect(tag!.do_migration_tag).toBe("v2");
  });

  it("a dry run plans and touches nothing", async () => {
    const { w } = await shipped();
    const before = putScripts(w);
    const outcome = await request(w, { action: "rollout", version: "0.15.0", dryRun: true, batchSize: 2 });
    expect(outcome.result).toBe("Dry run: 3 tenants to update: the canary alpha, then 1 batch of up to 2.");
    const release = (await getRelease(env.PLATFORM_DB, outcome.releaseId!))!;
    expect(release).toMatchObject({ state: "done", dryRun: true });
    expect(release.plan).toMatchObject({
      toUpdate: 3,
      batches: 1,
      canary: { slug: "alpha", reason: expect.stringContaining("oldest") },
      firstBatch: expect.arrayContaining(["bravo", "charlie"]),
      checks: { problems: [], newMigrations: ["0022_notes.sql"] },
    });
    expect(await advanceRelease(w.deps)).toEqual({ kind: "idle" });
    expect(putScripts(w)).toBe(before);
    expect(w.r2.textOf("releases/current")).toBe("0.14.0");
    expect(await versions()).toEqual({ alpha: "0.14.0", bravo: "0.14.0", charlie: "0.14.0" });
  });

  it("is refused when its migrations aren't additive, before anything is touched", async () => {
    const { w } = await shipped();
    publish(w.r2, bundle("0.16.0", ["0021_support.sql", "0023_drop.sql"]));
    const before = putScripts(w);
    const outcome = await request(w, { action: "rollout", version: "0.16.0" });
    expect(outcome.result).toMatch(/^Refused: 0023_drop.sql drops something/);
    expect((await getRelease(env.PLATFORM_DB, outcome.releaseId!))!.state).toBe("refused");
    expect(await advanceRelease(w.deps)).toEqual({ kind: "idle" });
    expect(putScripts(w)).toBe(before);
  });

  it("is refused for a version that isn't uploaded, an unknown canary, or while another runs", async () => {
    const { w } = await shipped();
    expect((await request(w, { action: "rollout", version: "0.99.0" })).result).toMatch(/isn't in the bundle bucket/);
    expect((await request(w, { action: "rollout", version: "0.15.0", canary: "nobody" })).result).toMatch(/no tenant nobody/);
    expect((await request(w, { action: "rollout", version: "0.15.0" })).result).toMatch(/^Started/);
    expect((await request(w, { action: "rollout", version: "0.15.0" })).result).toMatch(/is still canary/);
  });

  it("refuses a malformed request from the command line without failing the others", async () => {
    const { w } = await shipped();
    await env.PLATFORM_DB.prepare("INSERT INTO release_requests (id, action, version, requested_by, created_at) VALUES ('rrq_bad', 'rollout', '../../etc', 'cli', 1)").run();
    await submitRequest(env.PLATFORM_DB, { action: "rollout", version: "0.15.0", dryRun: true, requestedBy: "cli" }, 2);
    const outcomes = await handleRequests(w.deps);
    expect(outcomes.map((o) => o.result)).toEqual(["Refused: a rollout needs a version.", expect.stringMatching(/^Dry run/)]);
    expect(await handleRequests(w.deps)).toEqual([]);
    expect(() => submitRequest(env.PLATFORM_DB, { action: "rollout", version: "x y", requestedBy: "cli" }, 3)).rejects.toThrow("needs a version");
  });

  it("stops at a canary that doesn't come back healthy, and touches nobody else", async () => {
    const { w, ids } = await shipped();
    w.tenants.get(`t-${ids.alpha}`)!.unhealthy = true;
    await request(w, { action: "rollout", version: "0.15.0" });
    const tick = await advanceRelease(w.deps);
    expect(tick).toMatchObject({ state: "paused" });
    const release = (await activeRelease(env.PLATFORM_DB))!;
    expect(release.note).toMatch(/^The canary alpha failed: not healthy/);
    expect(w.tenants.get(`t-${ids.alpha}`)!.healthChecks).toBeGreaterThanOrEqual(HEALTH_MAX_ATTEMPTS);
    expect(await versions()).toEqual({ alpha: "0.15.0", bravo: "0.14.0", charlie: "0.14.0" });
    expect(w.r2.textOf("releases/current")).toBe("0.14.0");
    // A paused release isn't advanced by the cron.
    expect(await advanceRelease(w.deps)).toEqual({ kind: "idle" });

    // Fixed (say, a dependency came back): resume tries the canary again.
    w.tenants.get(`t-${ids.alpha}`)!.unhealthy = false;
    expect((await request(w, { action: "resume" })).result).toMatch(/^Resumed by cli/);
    expect(await advanceRelease(w.deps)).toMatchObject({ state: "done" });
    expect(await versions()).toEqual({ alpha: "0.15.0", bravo: "0.15.0", charlie: "0.15.0" });
  });

  it("stops when the canary's scheduled run fails, and waits out a busy one", async () => {
    const { w, ids } = await shipped();
    const canary = w.tenants.get(`t-${ids.alpha}`)!;
    canary.busyRuns = 2;
    await request(w, { action: "rollout", version: "0.15.0" });
    // Two busy answers (each tick ends waiting), then a failed run.
    expect(await advanceRelease({ ...w.deps, sleep: undefined })).toMatchObject({ state: "canary" });
    expect(await advanceRelease({ ...w.deps, sleep: undefined })).toMatchObject({ state: "canary" });
    expect(canary.scheduledRuns).toHaveLength(2);
    canary.failNextRun = true;
    expect(await advanceRelease(w.deps)).toMatchObject({ state: "paused" });
    expect((await activeRelease(env.PLATFORM_DB))!.note).toBe("The canary alpha's scheduled run failed: migration 0004 failed. Nothing else was touched.");
    expect(w.r2.textOf("releases/current")).toBe("0.14.0");
    await request(w, { action: "resume" });
    expect(await advanceRelease(w.deps)).toMatchObject({ state: "done" });
  });

  it("stops on a failed health check in a batch; skipping the failure finishes the rest", async () => {
    const { w, ids } = await shipped();
    await request(w, { action: "rollout", version: "0.15.0", batchSize: 5 });
    // bravo breaks once it is on the new version.
    w.api.onScriptChange = ((original) => (name, script) => {
      original!(name, script);
      if (name === `t-${ids.bravo}` && script) w.tenants.get(name)!.unhealthy = true;
    })(w.api.onScriptChange);
    expect(await advanceRelease(w.deps)).toMatchObject({ state: "paused" });
    const paused = (await activeRelease(env.PLATFORM_DB))!;
    expect(paused.note).toMatch(/^Stopped in batch 1: 1 tenant didn't come back healthy: bravo \(not healthy/);
    expect(await memberCounts(env.PLATFORM_DB, paused.id)).toMatchObject({ failed: 1 });

    expect((await request(w, { action: "skip_failed" })).result).toMatch(/skipping the failed tenants/);
    expect(await advanceRelease(w.deps)).toMatchObject({ state: "done" });
    const done = (await getRelease(env.PLATFORM_DB, paused.id))!;
    expect(done.note).toBe("Shipped 0.15.0: 2 tenants healthy, 0 failed and 1 skipped (see the list).");
    expect((await releaseMembers(env.PLATFORM_DB, done.id)).map((m) => [m.slug, m.state])).toEqual([
      ["bravo", "skipped"],
      ["alpha", "healthy"],
      ["charlie", "healthy"],
    ]);
  });

  it("picks up where it stopped, and never runs twice at once", async () => {
    const { w } = await shipped();
    await request(w, { action: "rollout", version: "0.15.0", batchSize: 1 });
    // Each tick does one step and stops, like a run that died.
    const stepOnce = { ...w.deps, sleep: undefined };
    const held = await env.PLATFORM_DB.prepare("UPDATE releases SET lease_until = ?, lease_token = 'other' WHERE state = 'canary'").bind(w.clock.now + 60_000).run();
    expect(held.meta.changes).toBe(1);
    expect((await advanceRelease(stepOnce)).kind).toBe("busy");
    w.clock.now += 61_000;
    for (let i = 0; i < 40 && (await activeRelease(env.PLATFORM_DB)); i++) {
      await advanceRelease(stepOnce, 0);
      w.clock.now += 20_000;
    }
    expect(await activeRelease(env.PLATFORM_DB)).toBeNull();
    expect(await versions()).toEqual({ alpha: "0.15.0", bravo: "0.15.0", charlie: "0.15.0" });
  });

  it("updates a tenant that became ready on the old version during the canary", async () => {
    const { w } = await shipped();
    await request(w, { action: "rollout", version: "0.15.0" });
    await advanceRelease({ ...w.deps, sleep: undefined }, 0); // the canary is uploaded
    await readyTenant(w, "delta"); // still provisioned from releases/current, 0.14.0
    expect((await versions()).delta).toBe("0.14.0");
    await advanceRelease(w.deps);
    expect((await versions()).delta).toBe("0.15.0");
  });

  it("retries a Cloudflare outage, and fails a tenant whose key is missing instead of making one", async () => {
    const { w, ids } = await shipped();
    w.api.failNext("putScript").failNext("putScript");
    await env.PLATFORM_DB.prepare("DELETE FROM escrowed_keys WHERE tenant_id = ?").bind(ids.charlie).run();
    await request(w, { action: "rollout", version: "0.15.0", batchSize: 5 });
    expect(await advanceRelease(w.deps)).toMatchObject({ state: "paused" });
    expect(UPLOAD_MAX_ATTEMPTS).toBeGreaterThan(2);
    expect((await versions()).alpha).toBe("0.15.0");
    const failed = (await releaseMembers(env.PLATFORM_DB, (await activeRelease(env.PLATFORM_DB))!.id)).find((m) => m.state === "failed");
    expect(failed).toMatchObject({ slug: "charlie", error: "upload: it has no escrowed MASTER_KEY" });
    expect(await activeEscrowedKey(env.PLATFORM_DB, ids.charlie)).toBeNull();
  });

  it("skips a tenant removed while it waited for its batch", async () => {
    const { w, ids } = await shipped();
    await request(w, { action: "rollout", version: "0.15.0", batchSize: 5 });
    // The canary's upload, its health, its run, then the batch is chosen.
    for (let i = 0; i < 4; i++) await advanceRelease({ ...w.deps, sleep: undefined }, 0);
    const chosen = await env.PLATFORM_DB.prepare("SELECT COUNT(*) AS n FROM release_tenants WHERE batch = 1").first<{ n: number }>();
    expect(chosen!.n).toBe(2);
    await env.PLATFORM_DB.prepare("UPDATE tenants SET provision_state = 'deleting' WHERE id = ?").bind(ids.charlie).run();
    expect(await advanceRelease(w.deps)).toMatchObject({ state: "done" });
    const members = await releaseMembers(env.PLATFORM_DB, (await getRelease(env.PLATFORM_DB, (await env.PLATFORM_DB.prepare("SELECT id FROM releases").first<{ id: string }>())!.id))!.id);
    expect(members.find((m) => m.slug === "charlie")).toMatchObject({ state: "skipped", error: "it is deleting" });
  });

  it("can be paused and cancelled", async () => {
    const { w } = await shipped();
    await request(w, { action: "rollout", version: "0.15.0" });
    expect((await request(w, { action: "pause" })).result).toBe("Paused by cli.");
    expect(await advanceRelease(w.deps)).toEqual({ kind: "idle" });
    expect((await request(w, { action: "cancel" })).result).toMatch(/^Cancelled by cli/);
    expect(await activeRelease(env.PLATFORM_DB)).toBeNull();
    expect((await request(w, { action: "pause" })).result).toBe("Nothing to do: no release is in progress.");
  });

  it("with no tenant yet just becomes current", async () => {
    const w = world();
    publish(w.r2, V1);
    const outcome = await request(w, { action: "rollout", version: "0.14.0" });
    expect(outcome.result).toBe("Started: No tenant to update; new tenants get it once it is current.");
    expect(w.r2.textOf("releases/current")).toBe("0.14.0");
    expect(await releaseTick(w.deps)).toMatchObject({ tick: { state: "done" } });
  });
});

describe("a rollback", () => {
  it("goes back to the version before in one request, current first", async () => {
    const { w } = await shipped();
    await request(w, { action: "rollout", version: "0.15.0" });
    await advanceRelease(w.deps);
    expect(await versions()).toEqual({ alpha: "0.15.0", bravo: "0.15.0", charlie: "0.15.0" });

    const dry = await request(w, { action: "rollback", dryRun: true });
    expect(dry.result).toBe("Dry run: Back to 0.14.0: 3 tenants in 1 batch.");
    expect(w.r2.textOf("releases/current")).toBe("0.15.0");

    const outcome = await request(w, { action: "rollback" });
    expect(outcome.result).toBe("Started: Back to 0.14.0: 3 tenants in 1 batch.");
    expect(w.r2.textOf("releases/current")).toBe("0.14.0");
    expect(await advanceRelease(w.deps)).toMatchObject({ state: "done" });
    expect(await versions()).toEqual({ alpha: "0.14.0", bravo: "0.14.0", charlie: "0.14.0" });
    // The older bundle runs on the newer schema: health stays ok.
    expect((await getRelease(env.PLATFORM_DB, outcome.releaseId!))!.note).toBe("Rolled back to 0.14.0: 3 tenants healthy.");
    expect((await request(w, { action: "rollback" })).result).toMatch(/^Refused: There's no earlier release|^Refused: Every tenant already runs 0.14.0/);
  });

  it("replaces a stopped rollout and undoes its canary", async () => {
    const { w, ids } = await shipped();
    w.tenants.get(`t-${ids.alpha}`)!.unhealthy = true;
    const rollout = await request(w, { action: "rollout", version: "0.15.0" });
    await advanceRelease(w.deps);
    w.tenants.get(`t-${ids.alpha}`)!.unhealthy = false;
    const back = await request(w, { action: "rollback" });
    expect(back.result).toBe(`Started: Back to 0.14.0: 1 tenant in 1 batch, replacing ${rollout.releaseId}.`);
    expect((await getRelease(env.PLATFORM_DB, rollout.releaseId!))!).toMatchObject({ state: "cancelled", note: `Replaced by the rollback ${back.releaseId}.` });
    await advanceRelease(w.deps);
    expect(await versions()).toEqual({ alpha: "0.14.0", bravo: "0.14.0", charlie: "0.14.0" });
  });

  it("keeps going past a tenant that fails, and reports it", async () => {
    const { w, ids } = await shipped();
    await request(w, { action: "rollout", version: "0.15.0" });
    await advanceRelease(w.deps);
    w.api.onScriptChange = ((original) => (name, script) => {
      original!(name, script);
      if (name === `t-${ids.alpha}` && script) w.tenants.get(name)!.unhealthy = true;
    })(w.api.onScriptChange);
    const back = await request(w, { action: "rollback", batchSize: 1 });
    expect(await advanceRelease(w.deps, RELEASE_TICK_BUDGET_MS)).toMatchObject({ state: "done" });
    expect((await getRelease(env.PLATFORM_DB, back.releaseId!))!.note).toBe("Rolled back to 0.14.0: 2 tenants healthy, 1 failed and 0 skipped (see the list).");
  });

  it("is refused across a Durable Object migration", async () => {
    const { w } = await shipped();
    publish(w.r2, bundle("0.16.0", ["0021_support.sql", "0022_notes.sql"], ["v1", "v2"]));
    await request(w, { action: "rollout", version: "0.16.0" });
    await advanceRelease(w.deps);
    expect((await request(w, { action: "rollback" })).result).toMatch(/can't be undone; ship a fix forward instead/);
  });
});

describe("the review's cases", () => {
  it("recovers when an upload applied its Durable Object migration but died before recording it", async () => {
    const { w, ids } = await shipped();
    publish(w.r2, bundle("0.16.0", ["0021_support.sql", "0022_notes.sql"], ["v1", "v2"]));
    // The upload takes effect at Cloudflare, then the answer is lost.
    w.api.failNext("putScript", { when: "after", status: 503 });
    await request(w, { action: "rollout", version: "0.16.0" });
    expect(await advanceRelease(w.deps)).toMatchObject({ state: "done" });
    for (const id of Object.values(ids)) {
      const row = await env.PLATFORM_DB.prepare("SELECT version, do_migration_tag, do_migration_pending FROM tenants WHERE id = ?").bind(id).first();
      expect(row).toEqual({ version: "0.16.0", do_migration_tag: "v2", do_migration_pending: null });
    }
    expect(w.api.count("getScriptMigrationTag")).toBeGreaterThanOrEqual(1);
  });

  it("asks Cloudflare for the tag when the recorded one is stale", async () => {
    const { w, ids } = await shipped();
    publish(w.r2, bundle("0.16.0", ["0021_support.sql", "0022_notes.sql"], ["v1", "v2"]));
    await env.PLATFORM_DB.prepare("UPDATE tenants SET do_migration_tag = NULL WHERE id = ?").bind(ids.bravo).run();
    await request(w, { action: "rollout", version: "0.16.0" });
    expect(await advanceRelease(w.deps)).toMatchObject({ state: "done" });
    expect(scriptOf(w, ids.bravo).migrationTag).toBe("v2");
  });

  it("repairs releases/current when a rollback died before setting it", async () => {
    const { w } = await shipped();
    await request(w, { action: "rollout", version: "0.15.0" });
    await advanceRelease(w.deps);
    await request(w, { action: "rollback" });
    w.r2.putText("releases/current", "0.15.0"); // as if the run died right after marking it rolling
    await advanceRelease({ ...w.deps, sleep: undefined }, 0);
    expect(w.r2.textOf("releases/current")).toBe("0.14.0");
  });

  it("refuses a rollback whose current bundle can't be read, or to a version that isn't older or never shipped", async () => {
    const { w } = await shipped();
    await request(w, { action: "rollout", version: "0.15.0" });
    await advanceRelease(w.deps);
    publish(w.r2, bundle("0.13.0", ["0021_support.sql"]));
    expect((await request(w, { action: "rollback", version: "0.13.0" })).result).toMatch(/0.13.0 was never released to tenants/);
    publish(w.r2, bundle("0.16.0", ["0021_support.sql", "0022_notes.sql"]));
    expect((await request(w, { action: "rollback", version: "0.16.0" })).result).toMatch(/isn't older than 0.15.0/);
    clearLoadedBundles();
    w.r2.objects.delete("releases/0.15.0/bundle.json");
    expect((await request(w, { action: "rollback" })).result).toMatch(/^Refused: Tenants run 0.15.0, which can't be read/);
  });

  it("checks a rollout against every version tenants run, not just the current one", async () => {
    const { w, ids } = await shipped();
    // A stopped rollout left bravo on 0.15.0 while releases/current stayed 0.14.0.
    await env.PLATFORM_DB.prepare("UPDATE tenants SET version = '0.15.0' WHERE id = ?").bind(ids.bravo).run();
    const edited = bundle("0.16.0", ["0021_support.sql", "0022_notes.sql"]);
    edited.d1Migrations[1] = { name: "0022_notes.sql", sha256: "edited" };
    publish(w.r2, edited);
    expect((await request(w, { action: "rollout", version: "0.16.0" })).result).toMatch(/0022_notes.sql was changed after tenants ran it/);
  });

  it("picks a default canary that is in good standing", async () => {
    const { w, ids } = await shipped();
    await env.PLATFORM_DB.prepare("UPDATE tenants SET status = 'suspended' WHERE id = ?").bind(ids.alpha).run();
    await env.PLATFORM_DB.prepare("UPDATE tenants SET status = 'past_due' WHERE id = ?").bind(ids.bravo).run();
    const outcome = await request(w, { action: "rollout", version: "0.15.0", dryRun: true });
    expect(outcome.result).toMatch(/the canary charlie/);
  });

  it("stops at a canary whose scheduled run never answers", async () => {
    const { w, ids } = await shipped();
    const original = w.dispatcher.dispatch.bind(w.dispatcher);
    w.dispatcher.dispatch = (script, req, props, limits) =>
      script === `t-${ids.alpha}` && new URL(req.url).pathname === "/__platform/scheduled" ? new Promise(() => {}) : original(script, req, props, limits);
    await request(w, { action: "rollout", version: "0.15.0" });
    expect(await advanceRelease({ ...w.deps, canaryTimeoutMs: 10 })).toMatchObject({ state: "paused" });
    expect((await activeRelease(env.PLATFORM_DB))!.note).toMatch(/didn't answer within 0.01 seconds/);
  });

  it("goes round again for a tenant a raced upload left on another version", async () => {
    const { w, ids } = await shipped();
    await request(w, { action: "rollout", version: "0.15.0", batchSize: 5 });
    // Through the canary and the batch, until only the finish is left.
    for (let i = 0; i < 20; i++) {
      const members = await env.PLATFORM_DB.prepare("SELECT COUNT(*) AS n FROM release_tenants WHERE state = 'healthy'").first<{ n: number }>();
      if (members!.n === 3) break;
      await advanceRelease({ ...w.deps, sleep: undefined }, 0);
    }
    await env.PLATFORM_DB.prepare("UPDATE tenants SET version = '0.14.0' WHERE id = ?").bind(ids.charlie).run();
    expect(await advanceRelease(w.deps)).toMatchObject({ state: "done" });
    expect(await versions()).toEqual({ alpha: "0.15.0", bravo: "0.15.0", charlie: "0.15.0" });
    const row = await env.PLATFORM_DB.prepare("SELECT requeues FROM release_tenants WHERE tenant_id = ?").bind(ids.charlie).first<{ requeues: number }>();
    expect(row!.requeues).toBe(1);
  });

  it("cancelling takes the lease, so a run in flight writes nothing more", async () => {
    const { w } = await shipped();
    await request(w, { action: "rollout", version: "0.15.0" });
    await env.PLATFORM_DB.prepare("UPDATE releases SET lease_until = ?, lease_token = 'inflight' WHERE state = 'canary'").bind(w.clock.now + 60_000).run();
    await request(w, { action: "cancel" });
    const row = await env.PLATFORM_DB.prepare("SELECT state, lease_token FROM releases").first();
    expect(row).toEqual({ state: "cancelled", lease_token: null });
  });

  it("handles requests one handler at a time, in order", async () => {
    const { w } = await shipped();
    await env.PLATFORM_DB.prepare("INSERT INTO release_locks (name, until, token) VALUES ('requests', ?, 'other')").bind(w.clock.now + 60_000).run();
    await submitRequest(env.PLATFORM_DB, { action: "rollout", version: "0.15.0", dryRun: true, requestedBy: "cli" }, w.clock.now);
    expect(await handleRequests(w.deps)).toEqual([]);
    w.clock.now += 61_000;
    expect(await handleRequests(w.deps)).toHaveLength(1);
    expect(await env.PLATFORM_DB.prepare("SELECT COUNT(*) AS n FROM release_locks").first("n")).toBe(0);
  });
});
