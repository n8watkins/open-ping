import { env } from "cloudflare:workers";
import { applyD1Migrations, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { generateHandoffKeyPair, type PlatformCapability } from "../../src/shared/hosted-contract";
import { createApp } from "../src/app";
import { createSession } from "../src/auth/sessions";
import { StaticBundleSource, type TenantBundle } from "../src/bundle";
import type { PlatformEnv } from "../src/env";
import { ensureMasterKey, generateMasterKey } from "../src/keys";
import { D1BillingView, type BillingView } from "../src/lifecycle/billing-view";
import { EXPORT_MAX_ATTEMPTS, accountExports, exportInstructions } from "../src/lifecycle/exports";
import { DELETE_AFTER_MS, EXPORT_RETRY_AFTER_MS, WARNING_BEFORE_MS, deletionTime, lifecycleTick, type LifecycleDeps } from "../src/lifecycle/jobs";
import type { ProvisioningDeps } from "../src/provisioning";
import { FakeCloudflareApi } from "./fake-cloudflare";
import { FakeDispatcher } from "./fake-dispatcher";
import { FakeMailer } from "./fake-mailer";
import { FakeR2Bucket } from "./fake-r2";

const DOMAIN = "openping.test";
const APP = `https://app.${DOMAIN}`;
const DAY = 86_400_000;
const PLATFORM_KEY = generateMasterKey();
const DUMP = "PRAGMA defer_foreign_keys=TRUE;\nCREATE TABLE monitors (id TEXT PRIMARY KEY);\nINSERT INTO monitors VALUES ('mon_1');\n";

const noopPlatform: PlatformCapability = {
  sendEmail: async () => ({ ok: false, error: "email_unavailable", message: "" }),
  reportUsage: async () => {},
  audit: async () => {},
};

const BUNDLE: TenantBundle = {
  version: "0.14.0",
  mainModule: "index.js",
  modules: [{ name: "index.js", content: "export default {}", contentType: "application/javascript+module" }],
  assets: [],
  compatibilityDate: "2024-12-30",
  compatibilityFlags: [],
  assetsConfig: {},
  vars: {},
  durableObjects: [],
  migrations: [],
};

interface World {
  clock: { now: number };
  api: FakeCloudflareApi;
  bucket: FakeR2Bucket;
  mailer: FakeMailer;
  dumps: string[];
  deps: LifecycleDeps;
}

let handoffPublicKey = "";

function world(): World {
  const clock = { now: Date.UTC(2026, 10, 1, 12, 0) };
  const api = new FakeCloudflareApi();
  api.exportPolls = 2;
  const bucket = new FakeR2Bucket();
  const mailer = new FakeMailer();
  const dumps: string[] = [];
  const now = () => clock.now;
  const provisioning: ProvisioningDeps = {
    db: env.PLATFORM_DB,
    api,
    bundles: new StaticBundleSource(BUNDLE),
    dispatcher: new FakeDispatcher(),
    capability: () => noopPlatform,
    config: { hostedDomain: DOMAIN, namespace: "ns", platformKey: PLATFORM_KEY, handoffPublicKey },
    now,
  };
  const deps: LifecycleDeps = {
    db: env.PLATFORM_DB,
    billing: new D1BillingView(env.PLATFORM_DB),
    mailer,
    hostedDomain: DOMAIN,
    exports: {
      api,
      bucket: bucket.bucket,
      fetchDump: async (url) => {
        dumps.push(url);
        return new Response(DUMP, { headers: { "content-length": String(new TextEncoder().encode(DUMP).length) } });
      },
      sleep: async (ms) => {
        clock.now += ms;
      },
    },
    provisioning,
    now,
  };
  return { clock, api, bucket, mailer, dumps, deps };
}

let seq = 0;
/** A ready tenant, its account, its database in the fake, and its escrowed key. */
async function tenant(w: World, fields: { status?: string; trialEndsAt?: number | null; suspendedAt?: number | null; provisionedAt?: number; ownerSuspended?: boolean } = {}) {
  seq++;
  const id = `life${String(seq).padStart(12, "0")}`;
  const accountId = `acc_life${seq}`;
  const email = `customer${seq}@example.com`;
  const slug = `life-${seq}`;
  const db = await w.api.createDatabase(`openping-t-${id}`);
  await env.PLATFORM_DB.batch([
    env.PLATFORM_DB.prepare("INSERT INTO accounts (id, email, created_at, updated_at) VALUES (?, ?, 0, 0)").bind(accountId, email),
    env.PLATFORM_DB.prepare(
      `INSERT INTO tenants (id, account_id, slug, script_name, d1_id, status, plan, provision_state, version, trial_ends_at, suspended_at,
         owner_suspended_at, provisioned_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'trial', 'ready', '0.14.0', ?, ?, ?, ?, 0, 0)`,
    ).bind(
      id,
      accountId,
      slug,
      `t-${id}`,
      db.id,
      fields.status ?? "trial",
      fields.trialEndsAt === undefined ? w.clock.now + 14 * DAY : fields.trialEndsAt,
      fields.suspendedAt ?? null,
      fields.ownerSuspended ? w.clock.now : null,
      fields.provisionedAt ?? w.clock.now - 30 * DAY,
    ),
  ]);
  await ensureMasterKey(env.PLATFORM_DB, id, PLATFORM_KEY, 0);
  return { id, accountId, email, slug, d1Id: db.id };
}

const tick = (w: World, over: Partial<LifecycleDeps> = {}) => lifecycleTick({ ...w.deps, ...over });
const kinds = (w: World, email: string) => w.mailer.to(email).map((m) => m.category);
const exists = async (id: string) => (await env.PLATFORM_DB.prepare("SELECT provision_state FROM tenants WHERE id = ?").bind(id).first<{ provision_state: string }>())?.provision_state ?? null;
const setStatus = (id: string, status: string, suspendedAt: number | null = null) =>
  env.PLATFORM_DB.prepare("UPDATE tenants SET status = ?, suspended_at = ? WHERE id = ?").bind(status, suspendedAt, id).run();

beforeAll(async () => {
  await applyD1Migrations(env.PLATFORM_DB, env.TEST_MIGRATIONS);
  handoffPublicKey = (await generateHandoffKeyPair()).publicKey;
});

beforeEach(async () => {
  await env.PLATFORM_DB.batch(
    ["lifecycle_notices", "tenant_exports", "escrowed_keys", "slug_holds", "subscriptions", "tenants", "platform_sessions", "rate_limits", "audit_events", "accounts"].map((t) =>
      env.PLATFORM_DB.prepare(`DELETE FROM ${t}`),
    ),
  );
});

describe("the account emails", () => {
  it("welcomes a new OpenPing once, and not one ready long before", async () => {
    const w = world();
    const fresh = await tenant(w, { provisionedAt: w.clock.now - 60_000 });
    const old = await tenant(w, { provisionedAt: w.clock.now - 8 * DAY });
    w.mailer.failNext = ["unavailable"];
    await tick(w);
    expect(w.mailer.sent).toHaveLength(0);
    await tick(w); // the failed send was tried again
    await tick(w);
    expect(kinds(w, fresh.email)).toEqual(["welcome"]);
    expect(kinds(w, old.email)).toEqual([]);
    const welcome = w.mailer.to(fresh.email)[0]!;
    expect(welcome).toMatchObject({ subject: "Your OpenPing is ready", replyTo: "support@n8builds.dev", tenantId: fresh.id, idempotencyKey: `lifecycle-${fresh.id}-welcome-once` });
    expect(welcome.text).toContain(`https://${fresh.slug}.${DOMAIN}`);
  });

  it("warns 3 days and 1 day before the trial ends, once each, and never a paying customer", async () => {
    const w = world();
    const t = await tenant(w, { trialEndsAt: w.clock.now + 3 * DAY - 60_000 });
    const paying = await tenant(w, { status: "active", trialEndsAt: w.clock.now + 2 * DAY });
    await tick(w);
    await tick(w);
    expect(kinds(w, t.email)).toEqual(["trial_ending_3"]);
    expect(w.mailer.to(t.email)[0]!.subject).toBe("Your OpenPing trial ends in 3 days");
    w.clock.now += 2 * DAY;
    await tick(w);
    expect(kinds(w, t.email)).toEqual(["trial_ending_3", "trial_ending_1"]);
    expect(w.mailer.to(t.email)[1]!.text).toContain(`${w.deps.hostedDomain}/billing/upgrade`);
    w.clock.now += DAY;
    await tick(w);
    expect(kinds(w, t.email)).toHaveLength(2);
    expect(kinds(w, paying.email)).toEqual([]);
  });

  it("sends only the 1-day email when the trial is already that close", async () => {
    const w = world();
    const t = await tenant(w, { trialEndsAt: w.clock.now + 12 * 3_600_000 });
    await tick(w);
    expect(kinds(w, t.email)).toEqual(["trial_ending_1"]);
  });

  it("emails once each time a payment fails", async () => {
    const w = world();
    const t = await tenant(w, { status: "past_due", trialEndsAt: null });
    await tick(w);
    await tick(w);
    expect(kinds(w, t.email)).toEqual(["payment_failed"]);
    await setStatus(t.id, "active");
    await tick(w);
    await setStatus(t.id, "past_due");
    await tick(w);
    expect(kinds(w, t.email)).toEqual(["payment_failed", "payment_failed"]);
  });

  it("emails once per suspension, saying why", async () => {
    const w = world();
    const trial = await tenant(w, { status: "suspended", trialEndsAt: w.clock.now - DAY, suspendedAt: w.clock.now - DAY + 60_000 });
    const lapsed = await tenant(w, { status: "suspended", trialEndsAt: w.clock.now - 400 * DAY, suspendedAt: w.clock.now - 3_600_000 });
    await env.PLATFORM_DB.prepare("INSERT INTO subscriptions (id, account_id, tenant_id, stripe_customer_id, status, plan, created_at, updated_at) VALUES ('sub_1', ?, ?, 'cus_1', 'canceled', 'hosted', 0, 0)")
      .bind(lapsed.accountId, lapsed.id)
      .run();
    await tick(w);
    await tick(w);
    expect(kinds(w, trial.email)).toEqual(["suspended"]);
    expect(w.mailer.to(trial.email)[0]!.subject).toBe("Your OpenPing trial has ended");
    expect(w.mailer.to(lapsed.email)[0]!.text).toContain("We still couldn't take the payment");
    expect(w.mailer.to(lapsed.email)[0]!.text).toContain(`${APP}/account/export`);
    // Paid, then suspended again later: a new suspension, a new email.
    await setStatus(trial.id, "active");
    await tick(w);
    await setStatus(trial.id, "suspended", w.clock.now);
    await tick(w);
    expect(kinds(w, trial.email)).toEqual(["suspended", "suspended"]);
  });

  it("leaves the owner's own suspension alone", async () => {
    const w = world();
    const t = await tenant(w, { status: "active", ownerSuspended: true, trialEndsAt: null });
    w.clock.now += 60 * DAY;
    const report = await tick(w);
    expect(kinds(w, t.email)).toEqual([]);
    expect(report.deleted).toEqual([]);
    expect(await exists(t.id)).toBe("ready");
  });

  it("claims nothing while mail is off, so nothing is lost", async () => {
    const w = world();
    const t = await tenant(w, { provisionedAt: w.clock.now });
    await tick(w, { mailer: null });
    await tick(w);
    expect(kinds(w, t.email)).toEqual(["welcome"]);
  });

  it("reads billing only through its view", async () => {
    const w = world();
    const t = await tenant(w, { status: "suspended", suspendedAt: w.clock.now - DAY });
    const view: BillingView = Object.assign(Object.create(D1BillingView.prototype), new D1BillingView(env.PLATFORM_DB), {
      suspensionReason: async () => "payment" as const,
    });
    await tick(w, { billing: view });
    expect(w.mailer.to(t.email)[0]!.subject).toBe("Your OpenPing is paused");
  });
});

describe("deletion after 30 days", () => {
  async function suspendedFor(w: World, days: number) {
    return tenant(w, { status: "suspended", trialEndsAt: w.clock.now - days * DAY - 1000, suspendedAt: w.clock.now - days * DAY });
  }

  it("warns a week before, exports, reads the export back, and only then deletes", async () => {
    const w = world();
    const t = await suspendedFor(w, 22);
    await tick(w);
    expect(kinds(w, t.email)).toEqual(["suspended"]);
    w.clock.now += DAY; // day 23
    await tick(w);
    expect(kinds(w, t.email)).toEqual(["suspended", "deletion_warning"]);
    const warning = w.mailer.to(t.email)[1]!;
    expect(warning.subject).toBe(`Your OpenPing will be deleted on ${new Date(w.clock.now - 23 * DAY + 30 * DAY).toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone: "UTC" })}`);

    w.clock.now += 6 * DAY + 3_600_000; // day 29: not yet
    expect((await tick(w)).deleted).toEqual([]);
    expect(await accountExports(env.PLATFORM_DB, t.accountId)).toEqual([]);

    w.clock.now += DAY; // day 30: the export first
    const first = await tick(w);
    expect(first.deleted).toEqual([]);
    expect(first.exports).toEqual([expect.objectContaining({ kind: "done" })]);
    const [exp] = await accountExports(env.PLATFORM_DB, t.accountId);
    expect(exp).toMatchObject({ reason: "deletion", state: "done", r2Prefix: `exports/${t.id}/${exp!.id}/` });
    expect(w.bucket.textOf(`${exp!.r2Prefix}openping.sql`)).toBe(DUMP);
    expect(w.bucket.textOf(`${exp!.r2Prefix}README.md`)).toContain("npx wrangler d1 execute open-ping --remote --file openping.sql");
    expect(await exists(t.id)).toBe("ready");

    const second = await tick(w);
    expect(second.deleted).toEqual([t.id]);
    expect(await exists(t.id)).toBeNull();
    expect(w.api.databases.has(t.d1Id)).toBe(false);
    // The export outlives the tenant, for the customer to download.
    expect(w.bucket.textOf(`${exp!.r2Prefix}openping.sql`)).toBe(DUMP);
    const actions = await env.PLATFORM_DB.prepare("SELECT action FROM audit_events WHERE tenant_id = ? AND action LIKE 'tenant.%' ORDER BY id").bind(t.id).all<{ action: string }>();
    expect(actions.results.map((r) => r.action)).toEqual(["tenant.deletion_started", "tenant.removed"]);
  });

  it("never deletes while the export fails, and tries a new one later", async () => {
    const w = world();
    const t = await suspendedFor(w, 23);
    await tick(w); // the warning
    w.clock.now += WARNING_BEFORE_MS;
    w.api.exportError = "database is too busy";
    for (let i = 0; i < EXPORT_MAX_ATTEMPTS + 2; i++) {
      await tick(w);
      w.clock.now += 3 * 3_600_000;
      w.api.exportError = "database is too busy";
    }
    expect(await exists(t.id)).toBe("ready");
    const exports = await accountExports(env.PLATFORM_DB, t.accountId);
    expect(exports.some((e) => e.state === "failed")).toBe(true);
    // D1 works again: a new export, then the deletion.
    w.api.exportError = null;
    w.clock.now += EXPORT_RETRY_AFTER_MS;
    for (let i = 0; i < 6 && (await exists(t.id)); i++) {
      await tick(w);
      w.clock.now += 3 * 3_600_000;
    }
    expect(await exists(t.id)).toBeNull();
  });

  it("never deletes when the export's files aren't in the bucket", async () => {
    const w = world();
    const t = await suspendedFor(w, 23);
    await tick(w);
    w.clock.now += WARNING_BEFORE_MS;
    await tick(w); // exported
    const [exp] = await accountExports(env.PLATFORM_DB, t.accountId);
    w.bucket.objects.delete(`${exp!.r2Prefix}openping.sql`);
    const report = await tick(w);
    expect(report.deleted).toEqual([]);
    expect(report.waiting).toEqual([{ tenantId: t.id, why: "its export's files are missing" }]);
    expect(await exists(t.id)).toBe("ready");
  });

  it("stops the clock when the customer pays, even at the last moment", async () => {
    const w = world();
    const t = await suspendedFor(w, 23);
    await tick(w);
    w.clock.now += WARNING_BEFORE_MS;
    await tick(w); // exported, deletion due on the next run
    await setStatus(t.id, "active");
    expect((await tick(w)).deleted).toEqual([]);
    expect(await exists(t.id)).toBe("ready");
  });

  it("waits a week after a warning that went out late (mail was off)", async () => {
    const w = world();
    const t = await suspendedFor(w, 35);
    const off = await tick(w, { mailer: null });
    expect(off.waiting).toEqual([{ tenantId: t.id, why: "its deletion warning hasn't gone out yet" }]);
    await tick(w);
    expect(kinds(w, t.email)).toEqual(["suspended", "deletion_warning"]);
    expect(w.mailer.to(t.email)[1]!.text).toContain(new Date(w.clock.now + WARNING_BEFORE_MS).toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" }));
    w.clock.now += WARNING_BEFORE_MS - 3_600_000;
    await tick(w);
    expect(await exists(t.id)).toBe("ready");
    w.clock.now += 2 * 3_600_000;
    await tick(w);
    await tick(w);
    expect(await exists(t.id)).toBeNull();
    expect(deletionTime(0, null)).toBeNull();
    expect(deletionTime(0, DELETE_AFTER_MS)).toBe(DELETE_AFTER_MS + WARNING_BEFORE_MS);
  });

  it("forgets an export once it is past its keep time", async () => {
    const w = world();
    const t = await suspendedFor(w, 23);
    await tick(w);
    w.clock.now += WARNING_BEFORE_MS;
    await tick(w);
    await tick(w);
    const [exp] = await accountExports(env.PLATFORM_DB, t.accountId);
    w.clock.now += 31 * DAY;
    const report = await tick(w);
    expect(report.expired).toBe(1);
    expect(w.bucket.objects.has(`${exp!.r2Prefix}openping.sql`)).toBe(false);
    expect(await accountExports(env.PLATFORM_DB, t.accountId)).toEqual([]);
  });
});

describe("taking your OpenPing with you", () => {
  function app(w: World) {
    return createApp({
      dispatcher: () => new FakeDispatcher(),
      capability: () => noopPlatform,
      accounts: { mailer: () => w.mailer, provisioning: () => ({ ok: false, missing: ["none"] }), now: () => w.clock.now },
      exports: { exports: () => w.deps.exports, mailer: () => w.mailer, now: () => w.clock.now },
    });
  }
  const platformEnv = () => ({ ...(env as unknown as PlatformEnv), PLATFORM_KEY });

  async function signedIn(w: World, accountId: string) {
    const cookie = (await createSession(env.PLATFORM_DB, accountId, "email", w.clock.now)).split(";")[0]!;
    const a = app(w);
    return async (path: string, init: { method?: string; origin?: string } = {}) => {
      const ctx = createExecutionContext();
      const headers = new Headers({ cookie });
      if (init.method === "POST") headers.set("origin", init.origin ?? APP);
      const res = await a.fetch(new Request(`${APP}${path}`, { method: init.method ?? "GET", headers, redirect: "manual" }), platformEnv(), ctx);
      await waitOnExecutionContext(ctx);
      return res;
    };
  }

  it("makes an export, lists it, and downloads it only for its own account", async () => {
    const w = world();
    const t = await tenant(w, { status: "active", trialEndsAt: null });
    const other = await tenant(w);
    const browse = await signedIn(w, t.accountId);
    const started = await browse("/account/export", { method: "POST" });
    expect(started.status).toBe(303);
    expect(started.headers.get("location")).toBe("/account/export?done=started");
    const page = await (await browse("/account/export")).text();
    const [exp] = await accountExports(env.PLATFORM_DB, t.accountId);
    expect(exp).toMatchObject({ reason: "self_host", state: "done" });
    expect(page).toContain(`href="/account/export/${exp!.id}/openping.sql"`);
    expect(page).toContain("Show my key");
    const dump = await browse(`/account/export/${exp!.id}/openping.sql`);
    expect(dump.headers.get("content-disposition")).toBe(`attachment; filename="openping-${t.slug}-${new Date(exp!.createdAt).toISOString().slice(0, 10)}.sql"`);
    expect(dump.headers.get("cache-control")).toBe("no-store");
    expect(await dump.text()).toBe(DUMP);
    const steps = await (await browse(`/account/export/${exp!.id}/README.md`)).text();
    expect(steps).toContain(`This is https://${t.slug}.${DOMAIN}`);
    expect(steps).not.toContain(PLATFORM_KEY);

    const stranger = await signedIn(w, other.accountId);
    expect((await stranger(`/account/export/${exp!.id}/openping.sql`)).status).toBe(404);
    expect((await stranger(`/account/export/${exp!.id}/../../x`)).status).toBe(404);
  });

  it("allows one export at a time, three a day, and nothing from another site", async () => {
    const w = world();
    w.api.exportPolls = 1000; // stays running
    const t = await tenant(w, { status: "active", trialEndsAt: null });
    const browse = await signedIn(w, t.accountId);
    expect((await browse("/account/export", { method: "POST", origin: "https://evil.example" })).status).toBe(403);
    expect((await browse("/account/export", { method: "POST" })).headers.get("location")).toBe("/account/export?done=started");
    expect((await browse("/account/export", { method: "POST" })).headers.get("location")).toBe("/account/export?done=open");
    await env.PLATFORM_DB.prepare("UPDATE tenant_exports SET state = 'failed'").run();
    await browse("/account/export", { method: "POST" });
    await env.PLATFORM_DB.prepare("UPDATE tenant_exports SET state = 'failed'").run();
    await browse("/account/export", { method: "POST" });
    await env.PLATFORM_DB.prepare("UPDATE tenant_exports SET state = 'failed'").run();
    expect((await browse("/account/export", { method: "POST" })).headers.get("location")).toBe("/account/export?done=limit");
  });

  it("shows the key after a fresh sign-in only, records it, and tells the inbox", async () => {
    const w = world();
    const t = await tenant(w, { status: "active", trialEndsAt: null });
    const browse = await signedIn(w, t.accountId);
    const res = await browse("/account/export/key", { method: "POST" });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const { masterKey } = await ensureMasterKey(env.PLATFORM_DB, t.id, PLATFORM_KEY, 0);
    expect(await res.text()).toContain(`<code class="key">${masterKey}</code>`);
    expect(w.mailer.to(t.email).map((m) => m.subject)).toEqual(["Your OpenPing key was shown"]);
    expect(w.mailer.sent.some((m) => m.text.includes(masterKey) || m.html.includes(masterKey))).toBe(false);
    const audited = await env.PLATFORM_DB.prepare("SELECT actor FROM audit_events WHERE action = 'tenant.master_key_revealed' AND tenant_id = ?").bind(t.id).all();
    expect(audited.results).toEqual([{ actor: "customer" }]);

    w.clock.now += 16 * 60_000;
    const stale = await browse("/account/export/key", { method: "POST" });
    expect(stale.status).toBe(401);
    expect(await stale.text()).toContain("Sign in again first");
  });

  it("sends a signed-out visitor to sign in and back", async () => {
    const w = world();
    const ctx = createExecutionContext();
    const res = await app(w).fetch(new Request(`${APP}/account/export`), platformEnv(), ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/sign-in?next=%2Faccount%2Fexport");
  });

  it("writes steps that match docs/BACKUP.md and never carry the key", () => {
    const text = exportInstructions({ slug: "acme", tenantUrl: "https://acme.openping.test", version: "0.14.0", exportedAt: 0, accountUrl: `${APP}/account/export` });
    expect(text).toContain("npx wrangler secret put MASTER_KEY");
    expect(text).toContain("apart from this file");
    expect(text).toContain("/recover");
    expect(text).toContain("Rotate `MASTER_KEY`");
    expect(text).not.toMatch(/—/);
  });
});
