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
import { EXPORT_MAX_ATTEMPTS, accountExports, advanceExport, exportInstructions, requestExport } from "../src/lifecycle/exports";
import { DELETE_AFTER_MS, EXPORT_RETRY_AFTER_MS, NOTICE_CLAIM_STALE_MS, WARNING_BEFORE_MS, deletionTime, lifecycleTick, type LifecycleDeps } from "../src/lifecycle/jobs";
import { TRIAL_DAYS, type ProvisioningDeps } from "../src/provisioning";
import { FakeCloudflareApi } from "./fake-cloudflare";
import { FakeDispatcher } from "./fake-dispatcher";
import { FakeMailer } from "./fake-mailer";
import { FakeR2Bucket } from "./fake-r2";

const DOMAIN = "openping.test";
const APP = `https://app.${DOMAIN}`;
const DAY = 86_400_000;
const PLATFORM_KEY = generateMasterKey();
const DUMP =
  "PRAGMA defer_foreign_keys=TRUE;\nCREATE TABLE d1_migrations (id INTEGER PRIMARY KEY, name TEXT);\nCREATE TABLE monitors (id TEXT PRIMARY KEY);\nINSERT INTO monitors VALUES ('mon_1');\n";

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
  d1Migrations: [],
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
async function tenant(w: World, fields: { status?: string; trialEndsAt?: number | null; suspendedAt?: number | null; provisionedAt?: number; ownerSuspended?: boolean; billingReason?: string } = {}) {
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
         owner_suspended_at, provisioned_at, billing_reason, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'trial', 'ready', '0.14.0', ?, ?, ?, ?, ?, 0, 0)`,
    ).bind(
      id,
      accountId,
      slug,
      `t-${id}`,
      db.id,
      fields.status ?? "trial",
      fields.trialEndsAt === undefined ? w.clock.now + TRIAL_DAYS * DAY : fields.trialEndsAt,
      fields.suspendedAt ?? null,
      fields.ownerSuspended ? w.clock.now : null,
      fields.provisionedAt ?? w.clock.now - 30 * DAY,
      // As billing (B5) would have it: an ended trial, or a lapsed subscription.
      fields.status === "suspended"
        ? (fields.billingReason ?? (fields.trialEndsAt != null && fields.suspendedAt != null && fields.trialEndsAt <= fields.suspendedAt ? "trial_ended" : "canceled"))
        : null,
    ),
  ]);
  await ensureMasterKey(env.PLATFORM_DB, id, PLATFORM_KEY, 0);
  return { id, accountId, email, slug, d1Id: db.id };
}

const tick = async (w: World, over: Partial<LifecycleDeps> = {}) => (await lifecycleTick({ ...w.deps, ...over }))!;
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
    ["lifecycle_notices", "lifecycle_locks", "export_keys", "tenant_exports", "account_identities", "escrowed_keys", "slug_holds", "subscriptions", "tenants", "platform_sessions", "rate_limits", "audit_events", "accounts"].map((t) =>
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

  it("sends the trial emails on days 27 and 29 of a 30-day trial, and nothing between", async () => {
    expect(TRIAL_DAYS).toBe(30);
    const w = world();
    const t = await tenant(w); // just signed up: a TRIAL_DAYS trial
    const start = w.clock.now;
    const sentBy = async (day: number) => {
      w.clock.now = start + day * DAY;
      await tick(w);
      return kinds(w, t.email).filter((k) => k?.startsWith("trial_ending"));
    };
    expect(await sentBy(1)).toEqual([]);
    expect(await sentBy(26)).toEqual([]);
    expect(await sentBy(27.01)).toEqual(["trial_ending_3"]);
    expect(w.mailer.to(t.email).at(-1)!.subject).toBe("Your OpenPing trial ends in 3 days");
    expect(await sentBy(28.5)).toEqual(["trial_ending_3"]);
    expect(await sentBy(29.01)).toEqual(["trial_ending_3", "trial_ending_1"]);
    expect(w.mailer.to(t.email).at(-1)!.subject).toBe("Your OpenPing trial ends tomorrow");
  });

  it("sends only the 1-day email when the trial is already that close", async () => {
    const w = world();
    const t = await tenant(w, { trialEndsAt: w.clock.now + 12 * 3_600_000 });
    await tick(w);
    expect(kinds(w, t.email)).toEqual(["trial_ending_1"]);
  });

  it("leaves a failed payment's email to billing", async () => {
    const w = world();
    const t = await tenant(w, { status: "past_due", trialEndsAt: null });
    await tick(w);
    expect(kinds(w, t.email)).toEqual([]);
  });

  it("emails once per suspension, saying why", async () => {
    const w = world();
    const trial = await tenant(w, { status: "suspended", trialEndsAt: w.clock.now - DAY, suspendedAt: w.clock.now - DAY + 60_000 });
    const lapsed = await tenant(w, { status: "suspended", trialEndsAt: w.clock.now - 400 * DAY, suspendedAt: w.clock.now - 3_600_000, billingReason: "unpaid" });
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
    expect(report.waiting).toEqual([{ tenantId: t.id, why: "its export can't be trusted: its files are missing from the bucket" }]);
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

  async function signedIn(w: World, accountId: string, method: "email" | "passkey" = "email") {
    const cookie = (await createSession(env.PLATFORM_DB, accountId, method, w.clock.now, method === "passkey" ? "cred-1" : null)).split(";")[0]!;
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
    expect(page).toContain(`action="/account/export/${exp!.id}/key"`);
    const dump = await browse(`/account/export/${exp!.id}/openping.sql`);
    expect(dump.headers.get("content-disposition")).toBe(`attachment; filename="openping-${t.slug}-${new Date(exp!.createdAt).toISOString().slice(0, 10)}.sql"`);
    expect(dump.headers.get("cache-control")).toBe("no-store");
    expect(new TextDecoder().decode(await dump.arrayBuffer())).toBe(DUMP);
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
    await browse("/account/export", { method: "POST" });
    const [exp] = await accountExports(env.PLATFORM_DB, t.accountId);
    const res = await browse(`/account/export/${exp!.id}/key`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const { masterKey } = await ensureMasterKey(env.PLATFORM_DB, t.id, PLATFORM_KEY, 0);
    expect(await res.text()).toContain(`<code class="key">${masterKey}</code>`);
    expect(w.mailer.to(t.email).map((m) => m.subject)).toEqual(["Your OpenPing key was shown"]);
    expect(w.mailer.sent.some((m) => m.text.includes(masterKey) || m.html.includes(masterKey))).toBe(false);
    const audited = await env.PLATFORM_DB.prepare("SELECT actor FROM audit_events WHERE action = 'tenant.master_key_revealed' AND tenant_id = ?").bind(t.id).all();
    expect(audited.results).toEqual([{ actor: "customer" }]);

    w.clock.now += 16 * 60_000;
    const stale = await browse(`/account/export/${exp!.id}/key`, { method: "POST" });
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

describe("the review's cases", () => {
  const notice = (tenantId: string, kind: string, cycle: string, at: number) =>
    env.PLATFORM_DB.prepare("INSERT INTO lifecycle_notices (tenant_id, kind, cycle, state, claimed_at, sent_at) VALUES (?, ?, ?, 'sent', ?, ?)").bind(tenantId, kind, cycle, at, at);
  const sentNotice = (tenantId: string, kind: string, cycle: string, at: number) => notice(tenantId, kind, cycle, at).run();

  /**
   * `n` tenants suspended by billing, each with a sent notice of `kind` for
   * its suspension, written in one D1 batch: the cases below need many rows
   * ahead of the one they check, and one round trip per row made them slow
   * enough to time out under the full suite's load. These rows are only ever
   * read, never exported or torn down, so they need no database or key.
   */
  async function suspendedMany(n: number, input: { trialEndsAt: number; suspendedAt: (i: number) => number; kind: string; sentAt: number; exportNextAt?: number }) {
    const db = env.PLATFORM_DB;
    const statements: D1PreparedStatement[] = [];
    for (let i = 0; i < n; i++) {
      seq++;
      const id = `life${String(seq).padStart(12, "0")}`;
      const accountId = `acc_life${seq}`;
      const suspendedAt = input.suspendedAt(i);
      statements.push(
        db.prepare("INSERT INTO accounts (id, email, created_at, updated_at) VALUES (?, ?, 0, 0)").bind(accountId, `customer${seq}@example.com`),
        db
          .prepare(
            `INSERT INTO tenants (id, account_id, slug, script_name, d1_id, status, plan, provision_state, version, trial_ends_at, suspended_at, provisioned_at, billing_reason, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, 'suspended', 'trial', 'ready', '0.14.0', ?, ?, 0, ?, 0, 0)`,
          )
          .bind(id, accountId, `life-${seq}`, `t-${id}`, `db-${id}`, input.trialEndsAt, suspendedAt, input.trialEndsAt <= suspendedAt ? "trial_ended" : "canceled"),
        notice(id, input.kind, String(suspendedAt), input.sentAt),
      );
      if (input.exportNextAt !== undefined) {
        statements.push(
          db
            .prepare(
              `INSERT INTO tenant_exports (id, tenant_id, account_id, slug, reason, state, next_at, created_at, updated_at)
               VALUES (?, ?, ?, ?, 'deletion', 'requested', ?, ?, ?)`,
            )
            .bind(`exp_bulk${seq}`, id, accountId, `life-${seq}`, input.exportNextAt, input.sentAt, input.sentAt),
        );
      }
    }
    await db.batch(statements);
  }

  it("doesn't let tenants already emailed fill the window and starve newer ones", async () => {
    const w = world();
    await suspendedMany(51, { trialEndsAt: w.clock.now - 10 * DAY, suspendedAt: (i) => w.clock.now - 5 * DAY - i * 60_000, kind: "suspended", sentAt: w.clock.now - DAY });
    const late = await tenant(w, { status: "suspended", trialEndsAt: w.clock.now - 10 * DAY, suspendedAt: w.clock.now - 60_000 });
    await tick(w);
    expect(kinds(w, late.email)).toEqual(["suspended"]);
  });

  it("doesn't let deletions waiting on an export starve the ones behind them", async () => {
    const w = world();
    const at = w.clock.now - 31 * DAY;
    // Each with an export that won't be worked on for a day: deletions waiting on it.
    await suspendedMany(51, { trialEndsAt: at - DAY, suspendedAt: (i) => at - i * 60_000, kind: "deletion_warning", sentAt: at, exportNextAt: w.clock.now + DAY });
    const last = await tenant(w, { status: "suspended", trialEndsAt: at - DAY, suspendedAt: at + 60_000 });
    await sentNotice(last.id, "deletion_warning", String(at + 60_000), at + 60_000);
    await tick(w);
    expect((await accountExports(env.PLATFORM_DB, last.accountId)).map((e) => e.reason)).toEqual(["deletion"]);
    // 52 tenants through a whole tick take about 3.5 s alone, past the 5 s default when every suite runs at once.
  }, 30_000);

  it("keeps a deleted tenant's key with its export, shows it for that export, and drops both when it expires", async () => {
    const w = world();
    const t = await tenant(w, { status: "suspended", trialEndsAt: w.clock.now - 24 * DAY, suspendedAt: w.clock.now - 23 * DAY });
    const { masterKey } = await ensureMasterKey(env.PLATFORM_DB, t.id, PLATFORM_KEY, 0);
    await tick(w);
    w.clock.now += WARNING_BEFORE_MS;
    await tick(w);
    await tick(w);
    expect(await exists(t.id)).toBeNull();
    expect(await env.PLATFORM_DB.prepare("SELECT COUNT(*) AS n FROM escrowed_keys WHERE tenant_id = ?").bind(t.id).first("n")).toBe(0);
    const [exp] = await accountExports(env.PLATFORM_DB, t.accountId);
    const browse = await (async () => {
      const cookie = (await createSession(env.PLATFORM_DB, t.accountId, "email", w.clock.now)).split(";")[0]!;
      const a = createApp({
        dispatcher: () => new FakeDispatcher(),
        capability: () => noopPlatform,
        accounts: { mailer: () => w.mailer, provisioning: () => ({ ok: false, missing: ["none"] }), now: () => w.clock.now },
        exports: { exports: () => w.deps.exports, mailer: () => w.mailer, now: () => w.clock.now },
      });
      return async (path: string, method = "GET") => {
        const ctx = createExecutionContext();
        const headers = new Headers({ cookie, ...(method === "POST" ? { origin: APP } : {}) });
        const res = await a.fetch(new Request(`${APP}${path}`, { method, headers, redirect: "manual" }), { ...(env as unknown as PlatformEnv), PLATFORM_KEY }, ctx);
        await waitOnExecutionContext(ctx);
        return res;
      };
    })();
    expect(await (await browse("/account/export")).text()).toContain(`/account/export/${exp!.id}/key`);
    expect(await (await browse(`/account/export/${exp!.id}/key`, "POST")).text()).toContain(`<code class="key">${masterKey}</code>`);
    w.clock.now += 31 * DAY;
    await tick(w);
    expect(await env.PLATFORM_DB.prepare("SELECT COUNT(*) AS n FROM export_keys WHERE export_id = ?").bind(exp!.id).first("n")).toBe(0);
  });

  it("counts only a warning the provider took, and takes over a dead run's claim", async () => {
    const w = world();
    const t = await tenant(w, { status: "suspended", trialEndsAt: w.clock.now - 32 * DAY, suspendedAt: w.clock.now - 31 * DAY });
    const cycle = String(w.clock.now - 31 * DAY);
    await sentNotice(t.id, "suspended", cycle, w.clock.now - 31 * DAY);
    // A run claimed the warning a while ago and died before Resend answered.
    await env.PLATFORM_DB.prepare("INSERT INTO lifecycle_notices (tenant_id, kind, cycle, state, claimed_at) VALUES (?, 'deletion_warning', ?, 'sending', ?)")
      .bind(t.id, cycle, w.clock.now - 8 * DAY)
      .run();
    const report = await tick(w);
    expect(report.deleted).toEqual([]);
    expect(kinds(w, t.email)).toEqual(["deletion_warning"]);
    const row = await env.PLATFORM_DB.prepare("SELECT state, sent_at FROM lifecycle_notices WHERE tenant_id = ? AND kind = 'deletion_warning'").bind(t.id).first();
    expect(row).toEqual({ state: "sent", sent_at: w.clock.now });
    // A fresh claim by a live run is left alone.
    const other = await tenant(w, { status: "suspended", trialEndsAt: w.clock.now - 2 * DAY, suspendedAt: w.clock.now - DAY });
    await env.PLATFORM_DB.prepare("INSERT INTO lifecycle_notices (tenant_id, kind, cycle, state, claimed_at) VALUES (?, 'suspended', ?, 'sending', ?)")
      .bind(other.id, String(w.clock.now - DAY), w.clock.now - NOTICE_CLAIM_STALE_MS / 2)
      .run();
    await tick(w);
    expect(kinds(w, other.email)).toEqual([]);
    w.clock.now += WARNING_BEFORE_MS - 3_600_000;
    await tick(w);
    expect(await exists(t.id)).toBe("ready");
  });

  it("never deletes behind a dump that changed or isn't an OpenPing database", async () => {
    const w = world();
    const t = await tenant(w, { status: "suspended", trialEndsAt: w.clock.now - 24 * DAY, suspendedAt: w.clock.now - 23 * DAY });
    await tick(w);
    w.clock.now += WARNING_BEFORE_MS;
    await tick(w); // exported
    const [exp] = await accountExports(env.PLATFORM_DB, t.accountId);
    // Same size, other bytes.
    w.bucket.putText(`${exp!.r2Prefix}openping.sql`, DUMP.replace("mon_1", "mon_2"));
    const report = await tick(w);
    expect(report.waiting).toEqual([{ tenantId: t.id, why: "its export can't be trusted: its dump doesn't match its checksum" }]);
    expect(await exists(t.id)).toBe("ready");

    // A D1 export that isn't an OpenPing dump is never done.
    const w2 = world();
    w2.deps.exports!.fetchDump = async () => new Response("<html>error page</html>");
    const u = await tenant(w2, { status: "active", trialEndsAt: null });
    const id = await requestExport(env.PLATFORM_DB, { tenantId: u.id, accountId: u.accountId, slug: u.slug, reason: "self_host", now: w2.clock.now });
    expect(await advanceExport({ ...w2.deps.exports!, db: env.PLATFORM_DB, now: () => w2.clock.now }, id, { tenantUrl: "x", accountUrl: "y" })).toMatchObject({
      kind: "retry",
      error: "the dump doesn't look like SQL",
    });
  });

  it("wants a passkey sign-in for the key when the account has a passkey", async () => {
    const w = world();
    const t = await tenant(w, { status: "active", trialEndsAt: null });
    await env.PLATFORM_DB.prepare(
      "INSERT INTO account_identities (id, account_id, kind, subject, public_key, alg, created_at) VALUES ('idn_pk', ?, 'passkey', 'cred-1', 'pk', -7, 0)",
    ).bind(t.accountId).run();
    const exportId = await requestExport(env.PLATFORM_DB, { tenantId: t.id, accountId: t.accountId, slug: t.slug, reason: "self_host", now: w.clock.now });
    await advanceExport({ ...w.deps.exports!, db: env.PLATFORM_DB, now: () => w.clock.now }, exportId, { tenantUrl: "x", accountUrl: "y" });
    const viaEmail = await signedInFor(w, t.accountId, "email");
    const refused = await viaEmail(`/account/export/${exportId}/key`, "POST");
    expect(refused.status).toBe(401);
    expect(await refused.text()).toContain("with your passkey");
    const viaPasskey = await signedInFor(w, t.accountId, "passkey");
    expect((await viaPasskey(`/account/export/${exportId}/key`, "POST")).status).toBe(200);
  });

  it("runs one lifecycle at a time, and one run per export", async () => {
    const w = world();
    await env.PLATFORM_DB.prepare("INSERT INTO lifecycle_locks (name, until, token) VALUES ('tick', ?, 'other')").bind(w.clock.now + 60_000).run();
    expect(await lifecycleTick(w.deps)).toBeNull();
    await env.PLATFORM_DB.prepare("DELETE FROM lifecycle_locks").run();
    const t = await tenant(w, { status: "active", trialEndsAt: null });
    const id = await requestExport(env.PLATFORM_DB, { tenantId: t.id, accountId: t.accountId, slug: t.slug, reason: "self_host", now: w.clock.now });
    const deps = { ...w.deps.exports!, db: env.PLATFORM_DB, now: () => w.clock.now };
    const [a, b] = await Promise.all([advanceExport(deps, id, { tenantUrl: "x", accountUrl: "y" }), advanceExport(deps, id, { tenantUrl: "x", accountUrl: "y" })]);
    expect([a.kind, b.kind].sort()).toEqual(["done", "waiting"]);
  });
});

async function signedInFor(w: World, accountId: string, method: "email" | "passkey") {
  const cookie = (await createSession(env.PLATFORM_DB, accountId, method, w.clock.now, method === "passkey" ? "cred-1" : null)).split(";")[0]!;
  const a = createApp({
    dispatcher: () => new FakeDispatcher(),
    capability: () => noopPlatform,
    accounts: { mailer: () => w.mailer, provisioning: () => ({ ok: false, missing: ["none"] }), now: () => w.clock.now },
    exports: { exports: () => w.deps.exports, mailer: () => w.mailer, now: () => w.clock.now },
  });
  return async (path: string, method2 = "GET") => {
    const ctx = createExecutionContext();
    const headers = new Headers({ cookie, ...(method2 === "POST" ? { origin: APP } : {}) });
    const res = await a.fetch(new Request(`${APP}${path}`, { method: method2, headers, redirect: "manual" }), { ...(env as unknown as PlatformEnv), PLATFORM_KEY }, ctx);
    await waitOnExecutionContext(ctx);
    return res;
  };
}

describe("deleting an account", () => {
  /** The account page's routes for `accountId`, signed in `signedInAgo` ms ago. */
  async function browser(w: World, accountId: string, options: { signedInAgo?: number; stripe?: FakeStripeLike | null } = {}) {
    const cookie = (await createSession(env.PLATFORM_DB, accountId, "email", w.clock.now - (options.signedInAgo ?? 0))).split(";")[0]!;
    const a = createApp({
      dispatcher: () => new FakeDispatcher(),
      capability: () => noopPlatform,
      accounts: {
        mailer: () => w.mailer,
        provisioning: () => ({ ok: false, missing: ["none"] }),
        billing: () =>
          options.stripe
            ? { ok: true, stripe: options.stripe as never, config: { webhookSecret: "whsec_x", priceHosted: "price_h", priceFast: "price_f", priceMonitorPack: "price_m", priceFastPack: "price_p", automaticTax: false, portalConfiguration: null, live: false } }
            : { ok: false, missing: ["STRIPE_SECRET_KEY"] },
        now: () => w.clock.now,
      },
    });
    return async (path: string, form?: Record<string, string>) => {
      const ctx = createExecutionContext();
      const headers = new Headers({ cookie, ...(form ? { origin: APP } : {}) });
      const res = await a.fetch(
        new Request(`${APP}${path}`, { method: form ? "POST" : "GET", headers, body: form ? new URLSearchParams(form) : undefined, redirect: "manual" }),
        env as unknown as PlatformEnv,
        ctx,
      );
      await waitOnExecutionContext(ctx);
      return res;
    };
  }
  interface FakeStripeLike {
    cancelled: string[];
    fail: boolean;
    cancelSubscription(id: string, key: string): Promise<unknown>;
  }
  const stripeStub = (): FakeStripeLike => ({
    cancelled: [],
    fail: false,
    async cancelSubscription(id: string) {
      if (this.fail) throw new Error("stripe down");
      this.cancelled.push(id);
      return { id, status: "canceled" };
    },
  });
  const accountRow = (id: string) =>
    env.PLATFORM_DB.prepare("SELECT email, disabled_at, deletion_requested_at, deleted_at, stripe_customer_id FROM accounts WHERE id = ?")
      .bind(id)
      .first<{ email: string; disabled_at: number | null; deletion_requested_at: number | null; deleted_at: number | null; stripe_customer_id: string | null }>();

  it("from the account page: stops the OpenPing now, exports it, deletes it, then scrubs the account, keeping billing records", async () => {
    const w = world();
    const t = await tenant(w, { status: "active" });
    const stripe = stripeStub();
    await env.PLATFORM_DB.batch([
      env.PLATFORM_DB.prepare("UPDATE accounts SET stripe_customer_id = 'cus_del' WHERE id = ?").bind(t.accountId),
      env.PLATFORM_DB.prepare(
        "INSERT INTO subscriptions (id, account_id, tenant_id, stripe_customer_id, stripe_subscription_id, status, plan, created_at, updated_at) VALUES ('sub_del', ?, ?, 'cus_del', 'sub_stripe_del', 'active', 'hosted', 0, 0)",
      ).bind(t.accountId, t.id),
      env.PLATFORM_DB.prepare("INSERT INTO account_identities (id, account_id, kind, subject, created_at) VALUES ('idn_del_gh', ?, 'github', '99001', 0)").bind(t.accountId),
      env.PLATFORM_DB.prepare("INSERT INTO waitlist_entries (email, imported_at) VALUES (?, 0)").bind(t.email),
      env.PLATFORM_DB.prepare("INSERT INTO rate_limits (key, window_start, count) VALUES (?, 0, 1), (?, 0, 1), ('signin-email:address:other@example.com:1', 0, 1)").bind(
        `signin-email:address:${t.email}:1`,
        `export:account:${t.accountId}:1`,
      ),
    ]);
    const go = await browser(w, t.accountId, { stripe });
    const page = await (await go("/account/delete")).text();
    expect(page).toContain("Your OpenPing's checks stop at once");
    expect(page).toContain("Your plan is cancelled");
    expect(page).toContain('href="/account/export"');
    // The typed email must match.
    expect((await go("/account/delete", { confirm: "someone@else.example" })).status).toBe(400);
    expect((await accountRow(t.accountId))!.deletion_requested_at).toBeNull();

    const done = await go("/account/delete", { confirm: ` ${t.email.toUpperCase()} ` });
    expect(done.status).toBe(200);
    expect(await done.text()).toContain("Your account is being deleted");
    expect(stripe.cancelled).toEqual(["sub_stripe_del"]);
    const tenantRow = await env.PLATFORM_DB.prepare("SELECT owner_suspended_at, owner_suspended_reason FROM tenants WHERE id = ?").bind(t.id).first<{ owner_suspended_at: number; owner_suspended_reason: string }>();
    expect(tenantRow).toEqual({ owner_suspended_at: w.clock.now, owner_suspended_reason: "Being deleted at the account's request" });
    expect((await accountRow(t.accountId))!.disabled_at).toBe(w.clock.now);
    expect(await env.PLATFORM_DB.prepare("SELECT COUNT(*) AS n FROM platform_sessions WHERE account_id = ?").bind(t.accountId).first("n")).toBe(0);
    expect(kinds(w, t.email)).toEqual(["account_deletion"]);

    // The lifecycle: an export first, read back, then the teardown, then the account.
    await tick(w);
    expect(await exists(t.id)).toBe("ready");
    await tick(w);
    expect(await exists(t.id)).toBeNull();
    const [exp] = await accountExports(env.PLATFORM_DB, t.accountId);
    expect(exp).toMatchObject({ reason: "deletion", state: "done" });
    await tick(w);
    const scrubbed = (await accountRow(t.accountId))!;
    expect(scrubbed.email).toBe(`deleted-${t.accountId}@deleted.invalid`);
    expect(scrubbed.deleted_at).toBe(w.clock.now);
    // Billing records stay; everything that says who it was goes.
    expect(scrubbed.stripe_customer_id).toBe("cus_del");
    expect(await env.PLATFORM_DB.prepare("SELECT COUNT(*) AS n FROM subscriptions WHERE account_id = ?").bind(t.accountId).first("n")).toBe(1);
    for (const [sql, bind] of [
      ["SELECT COUNT(*) AS n FROM account_identities WHERE account_id = ?", t.accountId],
      ["SELECT COUNT(*) AS n FROM waitlist_entries WHERE email = ?", t.email],
      ["SELECT COUNT(*) AS n FROM rate_limits WHERE key LIKE '%' || ? || '%'", t.email],
      ["SELECT COUNT(*) AS n FROM rate_limits WHERE key LIKE '%' || ? || '%'", t.accountId],
    ] as const) {
      expect(await env.PLATFORM_DB.prepare(sql).bind(bind).first("n"), sql).toBe(0);
    }
    expect(await env.PLATFORM_DB.prepare("SELECT COUNT(*) AS n FROM rate_limits WHERE key LIKE '%other@example.com%'").first("n")).toBe(1);
    expect(kinds(w, t.email)).toEqual(["account_deletion", "account_deleted"]);
    const actions = await env.PLATFORM_DB.prepare("SELECT action FROM audit_events WHERE account_id = ? AND action LIKE 'account.%' ORDER BY id").bind(t.accountId).all<{ action: string }>();
    expect(actions.results.map((r) => r.action)).toEqual(["account.deletion_requested", "account.deleted"]);
    // Nothing more happens on later runs, and the address can sign up afresh.
    await tick(w);
    expect(kinds(w, t.email)).toHaveLength(2);
    expect(await env.PLATFORM_DB.prepare("SELECT COUNT(*) AS n FROM accounts WHERE email = ?").bind(t.email).first("n")).toBe(0);
  });

  it("never sends the lapsed-plan emails to an account being deleted", async () => {
    const w = world();
    const t = await tenant(w, { status: "suspended", trialEndsAt: w.clock.now - DAY, suspendedAt: w.clock.now - DAY });
    const go = await browser(w, t.accountId);
    await go("/account/delete", { confirm: t.email });
    await tick(w);
    expect(kinds(w, t.email)).toEqual(["account_deletion"]);
  });

  it("needs a fresh sign-in, and doesn't scrub the account while its plan can't be cancelled", async () => {
    const w = world();
    await env.PLATFORM_DB.prepare("INSERT INTO accounts (id, email, created_at, updated_at) VALUES ('acc_payer', 'payer@example.com', 0, 0)").run();
    await env.PLATFORM_DB.prepare(
      "INSERT INTO subscriptions (id, account_id, stripe_customer_id, stripe_subscription_id, status, plan, created_at, updated_at) VALUES ('sub_fail', 'acc_payer', 'cus_f', 'sub_stripe_fail', 'active', 'hosted', 0, 0)",
    ).run();
    const stale = await browser(w, "acc_payer", { signedInAgo: 16 * 60_000 });
    expect((await stale("/account/delete")).status).toBe(401);
    expect((await stale("/account/delete", { confirm: "payer@example.com" })).status).toBe(401);
    expect((await accountRow("acc_payer"))!.deletion_requested_at).toBeNull();
    // Stripe down: the deletion starts, and says so.
    const stripe = stripeStub();
    stripe.fail = true;
    const res = await (await browser(w, "acc_payer", { stripe }))("/account/delete", { confirm: "payer@example.com" });
    expect(await res.text()).toContain("we keep trying until it does");
    expect((await accountRow("acc_payer"))!.disabled_at).toBe(w.clock.now);
    // Without Stripe, or with it still failing, the job waits; once Stripe takes it, the account goes.
    await tick(w);
    expect((await accountRow("acc_payer"))!.deleted_at).toBeNull();
    await tick(w, { stripe: stripe as never });
    expect((await accountRow("acc_payer"))!.deleted_at).toBeNull();
    stripe.fail = false;
    await tick(w, { stripe: stripe as never });
    expect(stripe.cancelled).toEqual(["sub_stripe_fail"]);
    expect((await accountRow("acc_payer"))!.deleted_at).toBe(w.clock.now);
  });

  it("blanks the addresses in the account's history and lets its security record expire", async () => {
    const w = world();
    await env.PLATFORM_DB.prepare("INSERT INTO accounts (id, email, created_at, updated_at) VALUES ('acc_hist', 'hist@example.com', 0, 0)").run();
    await env.PLATFORM_DB.batch([
      env.PLATFORM_DB.prepare("INSERT INTO audit_events (at, account_id, actor, action, detail) VALUES (1, 'acc_hist', 'customer', 'account.email_changed', '{\"from\":\"old@example.com\",\"to\":\"hist@example.com\"}')"),
      env.PLATFORM_DB.prepare("INSERT INTO audit_events (at, account_id, tenant_id, actor, action) VALUES (1, 'acc_hist', 'tenhist000000001', 'system', 'tenant.requested')"),
      env.PLATFORM_DB.prepare("INSERT INTO audit_events (at, account_id, tenant_id, actor, action, detail) VALUES (1, NULL, 'tenhist000000001', 'system', 'email.recipient_confirmed', '{\"address\":\"friend@example.com\"}')"),
    ]);
    await (await browser(w, "acc_hist"))("/account/delete", { confirm: "hist@example.com" });
    await tick(w, { exports: null, provisioning: null });
    const rows = await env.PLATFORM_DB.prepare("SELECT action, detail, kept FROM audit_events WHERE account_id = 'acc_hist' OR tenant_id = 'tenhist000000001' ORDER BY id").all<{ action: string; detail: string | null; kept: number }>();
    const text = JSON.stringify(rows.results);
    expect(text).not.toContain("@example.com");
    expect(rows.results.every((r) => r.kept === 0)).toBe(true);
    expect(rows.results.map((r) => r.action)).toContain("account.deleted");
  });

  it("deletes an account with no OpenPing at once on the next run, even with exports off", async () => {
    const w = world();
    w.deps.exports = null;
    w.deps.provisioning = null;
    await env.PLATFORM_DB.prepare("INSERT INTO accounts (id, email, created_at, updated_at) VALUES ('acc_lonely', 'lonely@example.com', 0, 0)").run();
    const go = await browser(w, "acc_lonely");
    expect(await (await go("/account/delete")).text()).not.toContain("checks stop");
    await go("/account/delete", { confirm: "lonely@example.com" });
    await tick(w);
    expect((await accountRow("acc_lonely"))!.deleted_at).not.toBeNull();
    expect(kinds(w, "lonely@example.com")).toEqual(["account_deletion", "account_deleted"]);
  });
});

describe("the account scrub's rate-limit delete", () => {
  it("is a range over the primary key, one per scope", async () => {
    const { rateLimitScrub } = await import("../src/account-deletion");
    const statements = rateLimitScrub(env.PLATFORM_DB, "a@example.com", "acc_x");
    expect(statements.length).toBeGreaterThan(3);
    const plan = await env.PLATFORM_DB.prepare("EXPLAIN QUERY PLAN DELETE FROM rate_limits WHERE key >= ? AND key < ?").bind("a:", "a;").all<{ detail: string }>();
    expect(plan.results.map((r) => r.detail).join(" | ")).toMatch(/USING (COVERING )?INDEX sqlite_autoindex_rate_limits_1 \(key>\? AND key<\?\)/);
  });
});
