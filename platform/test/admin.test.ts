import { env } from "cloudflare:workers";
import { applyD1Migrations, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  PLATFORM_HEALTH_PATH,
  generateHandoffKeyPair,
  importHandoffPublicKey,
  verifyHandoffToken,
  type HealthResponse,
  type PlatformCapability,
} from "../../src/shared/hosted-contract";
import { rateLimitKey, windowIndexFor } from "../../src/worker/db/rate-limit";
import { SoftAuthenticator } from "../../test/support/soft-authenticator";
import type { AccountDeps } from "../src/account-routes";
import { ADMIN_REAUTH_MS, ADMIN_SESSION_MAX_AGE_MS, parseOwners } from "../src/admin/owner";
import { WAITLIST_MAX_BYTES, csvRecords, parseJoinedAt, parseWaitlistExport } from "../src/admin/waitlist";
import { createApp } from "../src/app";
import { LIMITS } from "../src/auth/rate-limit";
import { R2BundleSource, StaticBundleSource, clearLoadedBundles, type BundleManifest, type TenantBundle } from "../src/bundle";
import { TenantCapability } from "../src/capability";
import type { PlatformEnv } from "../src/env";
import { ensureMasterKey, generateMasterKey } from "../src/keys";
import { FakeMailer } from "./fake-mailer";
import { requestTenant, type ProvisioningDeps } from "../src/provisioning";
import { clearTenantCache } from "../src/tenants";
import { FakeCloudflareApi } from "./fake-cloudflare";
import { FakeDispatcher } from "./fake-dispatcher";
import { fakeOpenPing, type FakeOpenPingState } from "./fake-openping";
import { FakeR2Bucket } from "./fake-r2";
import type { ReleaseSetup } from "../src/releases/env";
import { FAILING_LIST_SQL, OVERDUE_LIST_SQL } from "../src/admin/operations";
import { runMinuteStatements } from "../src/observability/metrics";

const DOMAIN = "openping.test";
const APP = `https://app.${DOMAIN}`;
let keys: { publicKey: string; privateKey: string };

// --- The world: a clock, mail, provisioning and tenants, all in memory ------

let clock = Date.now();
let owners = "";
let pinned = "";
let signingKey: string | undefined;

const outbox = new FakeMailer();

const noopPlatform: PlatformCapability = {
  sendEmail: async () => ({ ok: false, error: "email_unavailable", message: "" }),
  reportUsage: async () => {},
  audit: async () => {},
};

const BUNDLE: TenantBundle = {
  version: "0.11.0",
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

const api = new FakeCloudflareApi();
const dispatcher = new FakeDispatcher();
api.onScriptChange = (name, script) => {
  if (script) dispatcher.register(name, fakeOpenPing(script).worker);
  else dispatcher.remove(name);
};

function provisioningDeps(): ProvisioningDeps {
  return {
    db: env.PLATFORM_DB,
    api,
    bundles: new StaticBundleSource(BUNDLE),
    dispatcher,
    capability: () => noopPlatform,
    config: { hostedDomain: DOMAIN, namespace: "ns", platformKey: generateMasterKey(), handoffPublicKey: keys.publicKey },
    now: () => clock,
  };
}

const accountDeps: AccountDeps = {
  mailer: () => outbox,
  provisioning: () => ({ ok: true, deps: provisioningDeps() }),
  now: () => clock,
};

// The release runner behind the console's Releases tab, over an in-memory bucket.
const RELEASE_PLATFORM_KEY = generateMasterKey();
let releaseBucket = new FakeR2Bucket();
let releasesOn = true;
function releaseSetup(): ReleaseSetup {
  if (!releasesOn) return { ok: false, missing: ["CF_API_TOKEN", "PLATFORM_KEY"] };
  return {
    ok: true,
    deps: {
      db: env.PLATFORM_DB,
      api,
      store: new R2BundleSource(releaseBucket.bucket),
      dispatcher,
      capability: () => noopPlatform,
      config: { hostedDomain: DOMAIN, namespace: "ns", platformKey: RELEASE_PLATFORM_KEY, handoffPublicKey: keys.publicKey },
      defaultCanary: null,
      now: () => clock,
    },
  };
}

const app = createApp({ dispatcher: () => dispatcher, capability: () => noopPlatform, accounts: accountDeps, releases: () => releaseSetup() });

function platformEnv(): PlatformEnv {
  return {
    ...(env as unknown as PlatformEnv),
    SIGN_UPS: "open",
    PLATFORM_OWNERS: owners,
    PLATFORM_OWNER_PASSKEYS: pinned,
    HANDOFF_SIGNING_KEY: signingKey,
  };
}

let ipSeq = 0;

/** One browser: its cookies, its IP, and a same-origin Origin on every post. */
class Browser {
  cookies = new Map<string, string>();
  readonly ip = `192.0.2.${(++ipSeq % 250) + 1}`;

  async fetch(path: string, init: RequestInit & { form?: Record<string, string>; json?: unknown; origin?: string | null } = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("cf-connecting-ip", this.ip);
    let body = init.body;
    if (init.form) body = new URLSearchParams(init.form);
    if (init.json !== undefined) {
      headers.set("content-type", "application/json");
      body = JSON.stringify(init.json);
    }
    const method = init.method ?? (body ? "POST" : "GET");
    if (method !== "GET" && init.origin !== null) headers.set("origin", init.origin ?? APP);
    if (this.cookies.size) headers.set("cookie", [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "));
    const ctx = createExecutionContext();
    const res = await app.fetch(new Request(`${APP}${path}`, { method, headers, body, redirect: "manual" }), platformEnv(), ctx);
    await waitOnExecutionContext(ctx);
    for (const raw of res.headers.getSetCookie()) {
      const [pair, ...attrs] = raw.split(";");
      const [name, ...rest] = pair!.split("=");
      const value = rest.join("=");
      if (!value || attrs.some((a) => /max-age=0/i.test(a))) this.cookies.delete(name!.trim());
      else this.cookies.set(name!.trim(), value);
    }
    return res;
  }

  async signInWithCode(email: string): Promise<void> {
    const page = await this.fetch("/sign-in/email", { form: { email } });
    const loginId = /name="login" value="([^"]+)"/.exec(await page.text())![1]!;
    const res = await this.fetch("/sign-in/code", { form: { login: loginId, code: outbox.lastCode() } });
    expect(res.status).toBe(303);
  }

  /** Signs in with the passkey (a new session, method passkey); answers where it sends the browser. */
  async signInWithPasskey(authenticator: SoftAuthenticator, next?: string): Promise<string> {
    const options = (await (await this.fetch("/sign-in/passkey/options", { json: next ? { next } : {} })).json()) as any;
    const res = await this.fetch("/sign-in/passkey", { json: { credential: await authenticator.authenticate(options, APP) } });
    expect(res.status).toBe(200);
    return ((await res.json()) as { redirect: string }).redirect;
  }
}

let emailSeq = 0;
const newEmail = () => `admin-test${++emailSeq}@example.com`;

async function accountIdOf(email: string): Promise<string> {
  return (await env.PLATFORM_DB.prepare("SELECT id FROM accounts WHERE email = ?").bind(email).first<{ id: string }>())!.id;
}

/** A person with an account and a passkey, signed in with it. */
async function personWithPasskey(): Promise<{ browser: Browser; authenticator: SoftAuthenticator; email: string; accountId: string }> {
  const browser = new Browser();
  const email = newEmail();
  await browser.signInWithCode(email);
  const authenticator = await SoftAuthenticator.create();
  const options = (await (await browser.fetch("/account/passkeys/options", { json: {} })).json()) as any;
  expect((await browser.fetch("/account/passkeys", { json: { credential: await authenticator.register(options, APP) } })).status).toBe(200);
  await browser.signInWithPasskey(authenticator);
  return { browser, authenticator, email, accountId: await accountIdOf(email) };
}

/** The owner (by account id), signed in just now with their pinned passkey. */
async function owner() {
  const person = await personWithPasskey();
  owners = person.accountId;
  pinned = person.authenticator.id;
  return person;
}

/** The page's own continue link (continuePage): where it goes next, by GET. */
function continueHref(page: string): string {
  const meta = /<meta http-equiv="refresh" content="0;url=([^"]+)">/.exec(page)![1]!;
  expect(page).toContain(`href="${meta}"`);
  return meta;
}

let tenantSeq = 0;
/** A tenant row and its account, written directly (not provisioned). */
async function addTenant(fields: { slug?: string; status?: string; plan?: string; provisionState?: string; paused?: boolean; email?: string; createdAt?: number } = {}) {
  tenantSeq++;
  const id = `adm${String(tenantSeq).padStart(13, "0")}`;
  const accountId = `acc_admintest${tenantSeq}`;
  const email = fields.email ?? `customer${tenantSeq}@example.com`;
  const slug = fields.slug ?? `customer-${tenantSeq}`;
  const at = fields.createdAt ?? clock - tenantSeq * 1000;
  await env.PLATFORM_DB.batch([
    env.PLATFORM_DB.prepare("INSERT INTO accounts (id, email, created_at, updated_at) VALUES (?, ?, ?, ?)").bind(accountId, email, at, at),
    env.PLATFORM_DB.prepare(
      `INSERT INTO tenants (id, account_id, slug, script_name, status, plan, provision_state, provision_paused_at, provision_error, trial_ends_at, created_at, updated_at, version, d1_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      id,
      accountId,
      slug,
      `t-${id}`,
      fields.status ?? "active",
      fields.plan ?? "hosted",
      fields.provisionState ?? "ready",
      fields.paused ? at : null,
      fields.paused ? "uploaded: bundle is broken" : null,
      at + 14 * 86_400_000,
      at,
      at,
      fields.provisionState === "ready" || !fields.provisionState ? "0.11.0" : null,
      "00000000-0000-4000-8000-000000000000",
    ),
  ]);
  return { id, accountId, email, slug, scriptName: `t-${id}` };
}

const healthy: HealthResponse = {
  ok: true,
  version: "0.11.0",
  schemaVersion: 19,
  bundledSchemaVersion: 19,
  migrating: false,
  lastRun: { at: Date.UTC(2026, 9, 28, 12, 0), outcome: "ran", durationMs: 840 },
};

async function auditRows(where: string, ...binds: unknown[]) {
  const rows = await env.PLATFORM_DB.prepare(`SELECT account_id, tenant_id, actor, action, detail FROM audit_events WHERE ${where} ORDER BY id`)
    .bind(...binds)
    .all<{ account_id: string | null; tenant_id: string | null; actor: string; action: string; detail: string | null }>();
  return rows.results.map((r) => ({ ...r, detail: r.detail ? JSON.parse(r.detail) : null }));
}

async function tenantRow(id: string) {
  return env.PLATFORM_DB.prepare("SELECT * FROM tenants WHERE id = ?").bind(id).first<Record<string, unknown>>();
}

/** A visitor's request to a tenant's own address. */
async function visit(slug: string): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await app.fetch(new Request(`https://${slug}.${DOMAIN}/`), platformEnv(), ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

const text = async (res: Response) => (await res.text()).replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");

beforeAll(async () => {
  await applyD1Migrations(env.PLATFORM_DB, env.TEST_MIGRATIONS);
  keys = await generateHandoffKeyPair();
});

beforeEach(async () => {
  clock = Date.now();
  owners = "";
  pinned = "";
  signingKey = keys.privateKey;
  clearTenantCache();
  await env.PLATFORM_DB.prepare("DELETE FROM rate_limits").run();
});

// --- Who gets in ------------------------------------------------------------

describe("who can open the admin console", () => {
  const paths = ["/admin", "/admin/", "/admin/audit", "/admin/waitlist", "/admin/operations", "/admin/tenants/abcdefghijklmnop", "/admin/nothing-here"];

  it("is the plain 404 for a signed-out visitor, on every path and method", async () => {
    const someone = await addTenant();
    owners = "acc_someone_else";
    const visitor = new Browser();
    for (const path of paths) {
      const res = await visitor.fetch(path);
      expect(res.status, path).toBe(404);
      expect(await res.text()).toContain("Page not found");
    }
    for (const path of [`/admin/tenants/${someone.id}/suspend`, "/admin/waitlist"]) {
      expect((await visitor.fetch(path, { form: { reason: "nope" } })).status).toBe(404);
      // Even from another site: a 404, never the 403 that would say something is here.
      expect((await visitor.fetch(path, { form: { reason: "nope" }, origin: "https://evil.example" })).status).toBe(404);
    }
    expect((await tenantRow(someone.id))!.status).toBe("active");
  });

  it("is the plain 404 for a signed-in customer, even with a fresh passkey", async () => {
    const tenant = await addTenant();
    const { browser } = await personWithPasskey();
    owners = "acc_the_real_owner, owner@example.com";
    for (const path of paths) expect((await browser.fetch(path)).status, path).toBe(404);
    const posted = await browser.fetch(`/admin/tenants/${tenant.id}/suspend`, { form: { reason: "trying it" } });
    expect(posted.status).toBe(404);
    expect((await browser.fetch(`/admin/tenants/${tenant.id}/suspend`, { form: { reason: "x" }, origin: "https://evil.example" })).status).toBe(404);
    expect((await tenantRow(tenant.id))!.status).toBe("active");
    expect(await auditRows("tenant_id = ? AND actor = 'owner'", tenant.id)).toEqual([]);
    // Nothing on the account page points at it either.
    expect(await text(await browser.fetch("/account?done=passkey"))).not.toContain("/admin");
  });

  it("is a 404 for everyone while PLATFORM_OWNERS is empty", async () => {
    const { browser } = await personWithPasskey();
    owners = "";
    expect((await browser.fetch("/admin")).status).toBe(404);
  });

  it("asks the owner for a passkey when the session came from an email code, and changes nothing", async () => {
    const tenant = await addTenant();
    const browser = new Browser();
    const email = newEmail();
    await browser.signInWithCode(email);
    owners = email.toUpperCase();
    const page = await browser.fetch("/admin");
    expect(page.status).toBe(200);
    const body = await text(page);
    expect(body).toContain("Confirm it's you");
    // No passkey on the account yet: it says where to add one.
    expect(body).toContain("Your account has no passkey yet");
    const posted = await browser.fetch(`/admin/tenants/${tenant.id}/suspend`, { form: { reason: "abuse report" } });
    expect(posted.status).toBe(401);
    expect(await text(posted)).toContain("Nothing was changed");
    expect((await tenantRow(tenant.id))!.status).toBe("active");
  });

  it("lets the owner in by account id or email with a pinned passkey sign-in, and links it from the account page", async () => {
    const person = await personWithPasskey();
    pinned = `someotherpasskeyid0000, ${person.authenticator.id}`;
    for (const value of [person.accountId, `someone@example.com,${person.email.toUpperCase()}`]) {
      owners = value;
      const res = await person.browser.fetch("/admin");
      expect(res.status).toBe(200);
      expect(await text(res)).toContain('aria-current="page">Tenants</a>');
    }
    expect(await text(await person.browser.fetch("/account?done=passkey"))).toContain('href="/admin"');
  });

  it("asks again after 12 hours, and comes back to the same page after the passkey", async () => {
    const { browser, authenticator } = await owner();
    const tenant = await addTenant();
    clock += ADMIN_SESSION_MAX_AGE_MS + 1;
    const page = await text(await browser.fetch(`/admin/tenants/${tenant.id}`));
    expect(page).toContain("Confirm it's you");
    expect(page).toContain(`data-next="/admin/tenants/${tenant.id}"`);
    expect(page).toContain('<script src="/static/passkeys.js" defer></script>');
    expect(await browser.signInWithPasskey(authenticator, `/admin/tenants/${tenant.id}`)).toBe(`/admin/tenants/${tenant.id}`);
    expect((await browser.fetch(`/admin/tenants/${tenant.id}`)).status).toBe(200);
  });

  it("wants a passkey sign-in from the last 10 minutes for any change", async () => {
    const { browser, authenticator } = await owner();
    const tenant = await addTenant();
    clock += ADMIN_REAUTH_MS + 1;
    // Looking is still fine.
    const page = await text(await browser.fetch(`/admin/tenants/${tenant.id}`));
    expect(page).toContain("Changes ask you to confirm with your passkey first");
    const refused = await browser.fetch(`/admin/tenants/${tenant.id}/suspend`, { form: { reason: "abuse report" } });
    expect(refused.status).toBe(401);
    expect(await text(refused)).toContain(`data-next="/admin/tenants/${tenant.id}"`);
    expect((await tenantRow(tenant.id))!.status).toBe("active");
    expect(await auditRows("tenant_id = ? AND actor = 'owner'", tenant.id)).toEqual([]);

    await browser.signInWithPasskey(authenticator, `/admin/tenants/${tenant.id}`);
    expect((await browser.fetch(`/admin/tenants/${tenant.id}/suspend`, { form: { reason: "abuse report" } })).status).toBe(303);
    expect((await tenantRow(tenant.id))!.owner_suspended_at).toBe(clock);
  });

  it("refuses the owner's change from another site", async () => {
    const { browser } = await owner();
    const tenant = await addTenant();
    const res = await browser.fetch(`/admin/tenants/${tenant.id}/suspend`, { form: { reason: "abuse report" }, origin: "https://evil.example" });
    expect(res.status).toBe(403);
    expect((await tenantRow(tenant.id))!.status).toBe("active");
  });

  it("limits the owner's changes", async () => {
    const { browser, accountId } = await owner();
    const tenant = await addTenant();
    const rule = LIMITS.adminAction;
    await env.PLATFORM_DB.prepare("INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, ?)")
      .bind(rateLimitKey(`${rule.scope}:${accountId}`, clock, rule.windowMs), windowIndexFor(clock, rule.windowMs) * rule.windowMs, rule.limit)
      .run();
    const res = await browser.fetch(`/admin/tenants/${tenant.id}/suspend`, { form: { reason: "abuse report" } });
    expect(res.status).toBe(429);
    expect((await tenantRow(tenant.id))!.status).toBe("active");
  });

  it("reads PLATFORM_OWNERS as ids and emails, ignoring anything else", () => {
    const parsed = parseOwners(" acc_abc123, Owner@Example.com\nnot-an-owner acc_def;drop ");
    expect([...parsed.ids]).toEqual(["acc_abc123"]);
    expect([...parsed.emails]).toEqual(["owner@example.com"]);
    expect(parseOwners(undefined).ids.size).toBe(0);
  });
});

// --- The tenant list ----------------------------------------------------------

describe("the tenant list", () => {
  it("searches and filters by status, plan and setup state, paused included", async () => {
    const { browser } = await owner();
    const base = clock + 10_000_000;
    const a = await addTenant({ slug: "filter-alpha", status: "trial", plan: "trial", email: "alpha@filter.example", createdAt: base + 3 });
    const b = await addTenant({ slug: "filter-bravo", status: "suspended", plan: "hosted_fast", createdAt: base + 2 });
    const c = await addTenant({ slug: "filter-charlie", provisionState: "uploaded", paused: true, createdAt: base + 1 });
    const d = await addTenant({ slug: "filter-delta", provisionState: "requested", createdAt: base });
    const list = async (q: string) => {
      const page = await text(await browser.fetch(`/admin${q}`));
      return ["alpha", "bravo", "charlie", "delta"].filter((n) => page.includes(`>filter-${n}</a>`));
    };
    expect(await list("?q=filter-")).toEqual(["alpha", "bravo", "charlie", "delta"]);
    expect(await list("?q=ALPHA%40filter")).toEqual(["alpha"]);
    expect(await list(`?q=${b.id}`)).toEqual(["bravo"]);
    expect(await list(`?q=${d.accountId}`)).toEqual(["delta"]);
    expect(await list("?q=filter-&status=suspended")).toEqual(["bravo"]);
    expect(await list("?q=filter-&plan=trial")).toEqual(["alpha"]);
    expect(await list("?q=filter-&setup=paused")).toEqual(["charlie"]);
    expect(await list("?q=filter-&setup=requested")).toEqual(["delta"]);
    // Unknown filter values are ignored, and % and _ are taken literally.
    expect(await list("?q=filter-&status=frozen&plan=gold")).toEqual(["alpha", "bravo", "charlie", "delta"]);
    expect(await list("?q=filter%25")).toEqual([]);
    expect(await list("?q=filter_alpha")).toEqual([]);

    const page = await text(await browser.fetch("/admin?q=filter-"));
    expect(page).toContain("4 tenants match");
    expect(page).toContain('href="/admin">Clear filters</a>');
    // Each row a card on phones: every cell carries its label.
    expect(page).toContain('<td data-label="Status">');
    expect(page).toContain(`href="/admin/tenants/${c.id}"`);
    expect(page).toContain("alpha@filter.example");
    void a;
  });

  it("counts what needs a look and pages through long lists", async () => {
    const { browser } = await owner();
    const page = await text(await browser.fetch("/admin"));
    const counts = await env.PLATFORM_DB.prepare(
      "SELECT COUNT(*) AS all_count, SUM(provision_paused_at IS NOT NULL) AS paused, SUM(status = 'suspended' OR owner_suspended_at IS NOT NULL) AS suspended FROM tenants",
    ).first<{ all_count: number; paused: number; suspended: number }>();
    expect(page).toContain(`<strong>${counts!.all_count}</strong><span>All tenants</span>`);
    expect(page).toContain(`<strong>${counts!.paused}</strong><span>Paused, need a look</span>`);
    expect(page).toContain(`<strong>${counts!.suspended}</strong><span>Suspended</span>`);
    for (let i = 0; i < 51; i++) await addTenant({ slug: `pager-${i}` });
    const first = await text(await browser.fetch("/admin?q=pager-"));
    expect(first).toContain("51 tenants match, page 1 of 2");
    expect(first).toContain('href="/admin?q=pager-&page=2">Older</a>');
    const second = await text(await browser.fetch("/admin?q=pager-&page=2"));
    expect(second.match(/<tr>/g)?.length).toBe(2); // the header row and one tenant
  });
});

// --- One tenant -------------------------------------------------------------------

describe("a tenant's page", () => {
  it("shows its names, plan, version, live health, usage and history", async () => {
    const { browser } = await owner();
    const tenant = await addTenant({ slug: "detailco", plan: "hosted_fast" });
    dispatcher.register(tenant.scriptName, (request) =>
      new URL(request.url).pathname === PLATFORM_HEALTH_PATH ? Response.json(healthy) : new Response("hello"),
    );
    await new TenantCapability(env.PLATFORM_DB, tenant.id, tenant.accountId, () => clock).reportUsage({ monitors: 7, statusPages: 1, channels: 3, at: clock });
    await env.PLATFORM_DB.prepare("INSERT INTO audit_events (at, account_id, tenant_id, actor, action, detail) VALUES (?, ?, ?, 'system', 'tenant.provisioned', ?)")
      .bind(clock, tenant.accountId, tenant.id, JSON.stringify({ version: "0.11.0", seconds: 41 }))
      .run();
    await env.PLATFORM_DB.prepare("INSERT INTO tenant_email_usage (tenant_id, day, category, sent, failed, refused) VALUES (?, ?, 'alert', 12, 1, 0), (?, ?, 'report', 2, 0, 3)")
      .bind(tenant.id, new Date(clock).toISOString().slice(0, 10), tenant.id, new Date(clock).toISOString().slice(0, 10))
      .run();
    const res = await browser.fetch(`/admin/tenants/${tenant.id}`);
    expect(res.status).toBe(200);
    const page = await text(res);
    for (const expected of [
      "<h1>detailco</h1>",
      `t-${tenant.id}`,
      `openping-t-${tenant.id}`,
      "Hosted, 1-minute",
      "Healthy",
      "19 of 19",
      "Oct 28, 2026, 12:00 UTC",
      "7 of 20",
      "1 of 2",
      "<dt>Emails today (UTC)</dt><dd>14 of 500, 1 failed, 3 over the cap</dd>",
      "tenant.provisioned",
      "version: 0.11.0 · seconds: 41",
      `href="https://detailco.${DOMAIN}"`,
    ]) {
      expect(page, expected).toContain(expected);
    }
    // The health call was a platform call, with the contract's header.
    expect(dispatcher.calls.at(-1)!.props.invocation).toBe("platform");
  });

  it("shows its scheduler: cadence, the last run's numbers, and the days before", async () => {
    const { browser } = await owner();
    const tenant = await addTenant({ slug: "runsco", plan: "hosted_fast" });
    const day = Math.floor(clock / 86_400_000);
    await env.PLATFORM_DB.batch([
      env.PLATFORM_DB.prepare("UPDATE tenants SET schedule_next_at = ? WHERE id = ?").bind(clock + 45_000, tenant.id),
      env.PLATFORM_DB.prepare(
        `INSERT INTO scheduler_stats (tenant_id, last_run_id, last_at, last_outcome, last_duration_ms, last_tenant_ms, last_lag_ms, last_checked,
           last_failures, last_deferred, last_d1_queries, last_version, last_error, last_ok_at, streak, day, day_runs, day_errors, day_checked,
           day_failures, day_d1_queries, day_ms, day_max_ms)
         VALUES (?, 'run-1', ?, 'timeout', 40000, NULL, 1200, NULL, NULL, NULL, NULL, '0.15.0', 'no answer in 40 s', ?, 2, ?, 300, 3, 5400, 12, 2700, 96000, 40000)`,
      ).bind(tenant.id, clock - 15_000, clock - 120_000, day),
      env.PLATFORM_DB.prepare(
        "INSERT INTO scheduler_days (tenant_id, day, runs, errors, checked, failures, d1_queries, total_ms, max_ms) VALUES (?, ?, 1440, 0, 28800, 4, 12960, 288000, 900)",
      ).bind(tenant.id, day - 1),
    ]);
    const page = await text(await browser.fetch(`/admin/tenants/${tenant.id}`));
    for (const expected of [
      "<h2>Scheduler</h2>",
      "Every minute",
      "Timed out",
      "Failed in a row",
      "40.0 s",
      "1,200 ms",
      "no answer in 40 s",
      "Last clean run",
      "Last 2 days",
      'data-label="Runs">300<',
      'data-label="Runs">1,440<',
      'data-label="Checks">28,800<',
      'data-label="Average">200 ms<',
    ]) {
      expect(page, expected).toContain(expected);
    }
  });

  it("says so when the tenant doesn't answer, and doesn't ask one that isn't ready", async () => {
    const { browser } = await owner();
    const missing = await addTenant();
    expect(await text(await browser.fetch(`/admin/tenants/${missing.id}`))).toContain(`Its Worker ${missing.scriptName} isn't in the namespace.`);
    const settingUp = await addTenant({ provisionState: "db_created" });
    const before = dispatcher.calls.length;
    expect(await text(await browser.fetch(`/admin/tenants/${settingUp.id}`))).toContain("Not asked: it isn't ready yet.");
    expect(dispatcher.calls.length).toBe(before);
  });

  it("is a 404 for a tenant that doesn't exist", async () => {
    const { browser } = await owner();
    expect((await browser.fetch("/admin/tenants/zzzzzzzzzzzzzzzz")).status).toBe(404);
    expect((await browser.fetch("/admin/tenants/zzzzzzzzzzzzzzzz/suspend", { form: { reason: "abuse" } })).status).toBe(404);
  });
});

// --- Suspend and resume -----------------------------------------------------------

describe("suspending and resuming", () => {
  it("takes the tenant offline at once, keeps where it was, puts it back, and audits both", async () => {
    const { browser, accountId } = await owner();
    const tenant = await addTenant({ slug: "suspendco", status: "past_due" });
    dispatcher.register(tenant.scriptName, () => new Response("the customer's OpenPing"));
    // Warm this isolate's routing cache, as a busy status page would.
    expect(await (await visit("suspendco")).text()).toBe("the customer's OpenPing");

    expect((await browser.fetch(`/admin/tenants/${tenant.id}/suspend`, { form: { reason: "  " } })).headers.get("location")).toBe(
      `/admin/tenants/${tenant.id}?done=reason-needed`,
    );
    expect((await tenantRow(tenant.id))!.status).toBe("past_due");

    const res = await browser.fetch(`/admin/tenants/${tenant.id}/suspend`, { form: { reason: "Phishing\npage on\tits status page" } });
    expect(res.headers.get("location")).toBe(`/admin/tenants/${tenant.id}?done=suspended`);
    // Billing's state is untouched: the owner's suspension has columns of its own.
    expect(await tenantRow(tenant.id)).toMatchObject({ status: "past_due", owner_suspended_at: clock, owner_suspended_reason: "Phishing page on its status page" });
    // forgetTenant: this isolate shows the paused page now, not after its 30-second cache.
    const paused = await visit("suspendco");
    expect(paused.status).toBe(503);
    expect(await text(paused)).toContain("This OpenPing is paused");
    const page = await text(await browser.fetch(`/admin/tenants/${tenant.id}?done=suspended`));
    expect(page).toContain("Suspended. Visitors see the paused page now here");
    expect(page).toContain("Phishing page on its status page");
    // A second suspend changes nothing.
    expect((await browser.fetch(`/admin/tenants/${tenant.id}/suspend`, { form: { reason: "again" } })).headers.get("location")).toContain("done=already-suspended");

    expect((await browser.fetch(`/admin/tenants/${tenant.id}/resume`, { method: "POST" })).headers.get("location")).toBe(`/admin/tenants/${tenant.id}?done=resumed`);
    expect(await tenantRow(tenant.id)).toMatchObject({ status: "past_due", owner_suspended_at: null, owner_suspended_reason: null });
    expect(await (await visit("suspendco")).text()).toBe("the customer's OpenPing");
    expect((await browser.fetch(`/admin/tenants/${tenant.id}/resume`, { method: "POST" })).headers.get("location")).toContain("done=not-suspended");

    expect(await auditRows("tenant_id = ? AND actor = 'owner'", tenant.id)).toEqual([
      { account_id: tenant.accountId, tenant_id: tenant.id, actor: "owner", action: "tenant.suspended", detail: { by: accountId, reason: "Phishing page on its status page", from: "past_due" } },
      { account_id: tenant.accountId, tenant_id: tenant.id, actor: "owner", action: "tenant.resumed", detail: { by: accountId, to: "past_due" } },
    ]);
  });
});

// --- Paused provisioning: resume or remove -------------------------------------------

async function pausedSignUp(slug: string) {
  const email = newEmail();
  await new Browser().signInWithCode(email);
  const accountId = await accountIdOf(email);
  const requested = await requestTenant(env.PLATFORM_DB, { accountId, slug, now: clock });
  if (!requested.ok) throw new Error(requested.reason);
  await env.PLATFORM_DB.prepare("UPDATE tenants SET provision_paused_at = ?, provision_attempts = 6, provision_error = 'requested: Cloudflare 10000 Authentication error' WHERE id = ?")
    .bind(clock, requested.tenantId)
    .run();
  return { id: requested.tenantId, accountId };
}

describe("a tenant whose provisioning paused", () => {
  it("shows the error, and resumes from where it stopped to ready", async () => {
    const { browser, accountId } = await owner();
    const tenant = await pausedSignUp("resumeco");
    const page = await text(await browser.fetch(`/admin/tenants/${tenant.id}`));
    expect(page).toContain("Provisioning is paused");
    expect(page).toContain("Cloudflare 10000 Authentication error");
    expect(page).toContain(`action="/admin/tenants/${tenant.id}/resume-provisioning"`);
    expect(page).toContain(`action="/admin/tenants/${tenant.id}/remove"`);

    const res = await browser.fetch(`/admin/tenants/${tenant.id}/resume-provisioning`, { method: "POST" });
    expect(res.headers.get("location")).toBe(`/admin/tenants/${tenant.id}?done=provisioning-resumed`);
    expect(await tenantRow(tenant.id)).toMatchObject({ provision_state: "ready", provision_paused_at: null, provision_attempts: 0 });
    expect((await auditRows("tenant_id = ?", tenant.id)).map((e) => `${e.actor}:${e.action}`)).toEqual(["owner:tenant.provision_resumed", "system:tenant.provisioned"]);
    expect((await auditRows("tenant_id = ? AND actor = 'owner'", tenant.id))[0]!.detail).toEqual({ by: accountId, state: "requested" });
    // Ready now: nothing to resume or remove.
    expect((await browser.fetch(`/admin/tenants/${tenant.id}/resume-provisioning`, { method: "POST" })).headers.get("location")).toContain("done=not-paused");
    expect((await browser.fetch(`/admin/tenants/${tenant.id}/remove`, { form: { confirm: "resumeco" } })).headers.get("location")).toContain("done=not-paused");
    expect((await tenantRow(tenant.id))!.provision_state).toBe("ready");
  });

  it("is removed only after its address is typed, then torn down and audited", async () => {
    const { browser } = await owner();
    const tenant = await pausedSignUp("removeco");
    expect((await browser.fetch(`/admin/tenants/${tenant.id}/remove`, { form: { confirm: "removec" } })).headers.get("location")).toContain("done=confirm-mismatch");
    expect(await tenantRow(tenant.id)).not.toBeNull();

    const res = await browser.fetch(`/admin/tenants/${tenant.id}/remove`, { form: { confirm: " RemoveCo " } });
    expect(res.headers.get("location")).toBe("/admin?done=removal-started");
    expect(await tenantRow(tenant.id)).toBeNull();
    expect((await auditRows("tenant_id = ?", tenant.id)).map((e) => `${e.actor}:${e.action}`)).toEqual(["owner:tenant.removal_requested", "system:tenant.removed"]);
    expect(await text(await browser.fetch("/admin?done=removal-started"))).toContain("Removal started.");
  });

  it("changes nothing while provisioning is off", async () => {
    const { browser } = await owner();
    const tenant = await pausedSignUp("offco");
    const off = createApp({
      dispatcher: () => dispatcher,
      capability: () => noopPlatform,
      accounts: { ...accountDeps, provisioning: () => ({ ok: false, missing: ["CF_API_TOKEN"] }) },
    });
    const ctx = createExecutionContext();
    const res = await off.fetch(
      new Request(`${APP}/admin/tenants/${tenant.id}/resume-provisioning`, {
        method: "POST",
        headers: { origin: APP, cookie: [...browser.cookies].map(([k, v]) => `${k}=${v}`).join("; ") },
      }),
      platformEnv(),
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(res.headers.get("location")).toContain("done=provisioning-off");
    expect((await tenantRow(tenant.id))!.provision_paused_at).not.toBeNull();
  });
});

// --- Support sign-in ------------------------------------------------------------------

describe("signing in to a customer's OpenPing as support", () => {
  it("mints a support hand-off as the owner, audits it, and shows it to the customer", async () => {
    const { browser, accountId, email } = await owner();
    const customer = new Browser();
    const customerEmail = newEmail();
    await customer.signInWithCode(customerEmail);
    await customer.fetch("/start", { form: { slug: "helpco" } });
    const tenant = (await env.PLATFORM_DB.prepare("SELECT id, account_id FROM tenants WHERE slug = 'helpco'").first<{ id: string; account_id: string }>())!;

    expect((await browser.fetch(`/admin/tenants/${tenant.id}/support`, { form: { reason: "" } })).headers.get("location")).toContain("done=reason-needed");
    const res = await browser.fetch(`/admin/tenants/${tenant.id}/support`, { form: { reason: "Your email about a failing monitor" } });
    // A page that goes on by GET: the CSP's form-action would block a 303 to the tenant's origin.
    expect(res.status).toBe(200);
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const page = await text(res);
    expect(page).toContain(">Continue to helpco</a>");
    const location = new URL(continueHref(page));
    expect(`${location.origin}${location.pathname}`).toBe(`https://helpco.${DOMAIN}/auth/hosted`);
    const verified = await verifyHandoffToken(location.searchParams.get("t")!, await importHandoffPublicKey(keys.publicKey), { tenantId: tenant.id, now: clock });
    expect(verified).toMatchObject({ ok: true, claims: { aud: tenant.id, sub: accountId, email, role: "support" } });

    expect(await auditRows("tenant_id = ? AND action = 'support.handoff_issued'", tenant.id)).toEqual([
      { account_id: tenant.account_id, tenant_id: tenant.id, actor: "support", action: "support.handoff_issued", detail: { by: accountId, email, reason: "Your email about a failing monitor" } },
    ]);
    const account = await text(await customer.fetch("/account"));
    expect(account).toContain("Support access");
    expect(account).toContain("<strong>Your email about a failing monitor</strong>");
  });

  it("is refused for a suspended or unfinished tenant, and without the signing key", async () => {
    const { browser } = await owner();
    const suspended = await addTenant({ status: "suspended" });
    const settingUp = await addTenant({ provisionState: "uploaded" });
    for (const t of [suspended, settingUp]) {
      expect((await browser.fetch(`/admin/tenants/${t.id}/support`, { form: { reason: "checking" } })).headers.get("location")).toContain("done=not-ready");
    }
    const ready = await addTenant();
    signingKey = undefined;
    expect((await browser.fetch(`/admin/tenants/${ready.id}/support`, { form: { reason: "checking" } })).headers.get("location")).toContain("done=support-off");
    expect(await text(await browser.fetch(`/admin/tenants/${ready.id}`))).toContain("HANDOFF_SIGNING_KEY isn't set");
    expect(await auditRows("action = 'support.handoff_issued' AND tenant_id IN (?, ?, ?)", suspended.id, settingUp.id, ready.id)).toEqual([]);
  });
});

// --- The audit log --------------------------------------------------------------------

describe("the audit log", () => {
  it("lists events newest first, filters by tenant, actor and action, and pages back", async () => {
    const { browser } = await owner();
    const tenant = await addTenant({ slug: "auditco" });
    for (let i = 0; i < 55; i++) {
      await env.PLATFORM_DB.prepare("INSERT INTO audit_events (at, account_id, tenant_id, actor, action, detail) VALUES (?, ?, ?, 'customer', 'session.created', ?)")
        .bind(clock + i, tenant.accountId, tenant.id, JSON.stringify({ n: i }))
        .run();
    }
    await env.PLATFORM_DB.prepare("INSERT INTO audit_events (at, account_id, tenant_id, actor, action) VALUES (?, ?, ?, 'system', 'tenant.provisioned')")
      .bind(clock + 100, tenant.accountId, tenant.id)
      .run();

    const bySlug = await text(await browser.fetch("/admin/audit?tenant=auditco"));
    expect(bySlug.indexOf("tenant.provisioned")).toBeLessThan(bySlug.indexOf("n: 54"));
    expect(bySlug).not.toContain("n: 5<");
    const older = /href="(\/admin\/audit\?tenant=auditco&before=\d+)">Older/.exec(bySlug)![1]!;
    const second = await text(await browser.fetch(older));
    expect(second).toContain("n: 5<");
    expect(second).toContain("n: 0<");
    expect(second).not.toContain(">Older<");

    const system = await text(await browser.fetch(`/admin/audit?tenant=${tenant.id}&actor=system`));
    expect(system).toContain("tenant.provisioned");
    expect(system).not.toContain("session.created");
    const byAction = await text(await browser.fetch(`/admin/audit?tenant=${tenant.id}&action=session.`));
    expect(byAction).toContain("session.created");
    expect(byAction).not.toContain("tenant.provisioned");
    expect(byAction).toContain(`<td data-label="Account">${tenant.email}</td>`);
  });
});

// --- The waitlist -------------------------------------------------------------------------

describe("importing the waitlist", () => {
  it("takes the canonical install's CSV, skips repeats and bad lines, and audits the import", async () => {
    const { browser, accountId } = await owner();
    const existing = newEmail();
    await new Browser().signInWithCode(existing);
    const csv = [
      "email,joined_at",
      `${existing},2026-10-01T09:00:00.000Z`,
      '"quoted,odd@example.com",2026-10-02T09:00:00.000Z',
      "Waiter.One@Example.com,2026-10-03T09:00:00.000Z",
      "waiter.one@example.com,2026-09-30T09:00:00.000Z",
      "not an email,2026-10-04T09:00:00.000Z",
      "waiter.two@example.com,yesterday",
      "",
    ].join("\n");
    const form = new FormData();
    form.set("file", new File([csv], "openping-waitlist.csv", { type: "text/csv" }));
    form.set("text", "");
    const res = await browser.fetch("/admin/waitlist", { method: "POST", body: form });
    expect(res.status).toBe(200);
    const page = await text(res);
    expect(page).toContain("<strong>3 new addresses</strong> added, 1 repeated in the file.");
    expect(page).toContain("2 entries had");
    expect(page).toContain("line 3: <code>");
    expect(page).toContain("line 6: <code>not an email,2026-10-04T09:00:00.000Z</code>");
    const rows = await env.PLATFORM_DB.prepare("SELECT email, joined_at FROM waitlist_entries WHERE email IN (?, ?, ?) ORDER BY email")
      .bind(existing, "waiter.one@example.com", "waiter.two@example.com")
      .all<{ email: string; joined_at: number | null }>();
    expect(rows.results).toEqual([
      { email: existing, joined_at: Date.parse("2026-10-01T09:00:00.000Z") },
      // The earlier of the two joins.
      { email: "waiter.one@example.com", joined_at: Date.parse("2026-09-30T09:00:00.000Z") },
      { email: "waiter.two@example.com", joined_at: null },
    ]);
    expect(page).toContain("Signed up");

    // The same export again adds nothing; pasted JSON from /api/waitlist works too.
    const again = await text(await browser.fetch("/admin/waitlist", { method: "POST", body: form }));
    expect(again).toContain("<strong>0 new addresses</strong> added, 3 already on the list");
    const json = JSON.stringify({ count: 2, entries: [{ email: "json.waiter@example.com", created_at: Date.parse("2026-10-05T00:00:00Z") }, { email: existing, created_at: 0 }] });
    const pasted = await text(await browser.fetch("/admin/waitlist", { form: { text: json } }));
    expect(pasted).toContain("<strong>1 new address</strong> added, 1 already on the list.");

    const imports = await auditRows("action = 'waitlist.imported' AND account_id = ?", accountId);
    expect(imports.map((e) => e.detail)).toEqual([
      { by: accountId, added: 3, existing: 0, invalid: 2, duplicates: 1, source: "file" },
      { by: accountId, added: 0, existing: 3, invalid: 2, duplicates: 1, source: "file" },
      { by: accountId, added: 1, existing: 1, invalid: 0, duplicates: 0, source: "pasted" },
    ]);
    expect(imports.every((e) => e.actor === "owner")).toBe(true);
  });

  it("says what is wrong with an empty or unusable file, and imports nothing", async () => {
    const { browser } = await owner();
    const empty = await browser.fetch("/admin/waitlist", { form: { text: "  " } });
    expect(empty.status).toBe(400);
    expect(await text(empty)).toContain("That file is empty.");
    expect(await text(await browser.fetch("/admin/waitlist", { form: { text: "{ nope" } }))).toContain("doesn't parse");
    expect(await text(await browser.fetch("/admin/waitlist", { form: { text: "email\nnobody\nstill nobody" } }))).toContain("No email addresses were found");
  });

  it("parses the export's CSV and times", () => {
    expect(csvRecords('a@example.com,"2026-10-01T00:00:00Z"').map((r) => r.fields)).toEqual([["a@example.com", "2026-10-01T00:00:00Z"]]);
    expect(csvRecords('"say ""hi""",x').map((r) => r.fields)).toEqual([['say "hi"', "x"]]);
    // A quoted line break stays in its field, and later records keep their real line numbers.
    expect(csvRecords('email\r\n"two\nlines@example.com",x\r\nthree@example.com,y')).toEqual([
      { line: 1, raw: "email", fields: ["email"] },
      { line: 2, raw: '"two\nlines@example.com",x', fields: ["two\nlines@example.com", "x"] },
      { line: 4, raw: "three@example.com,y", fields: ["three@example.com", "y"] },
    ]);
    const quotedBreak = parseWaitlistExport('email,joined_at\n"broken\naddress@example.com",2026-10-01\nok@example.com,2026-10-01');
    expect(quotedBreak.ok && quotedBreak.list.invalid.map((i) => i.where)).toEqual(["line 2"]);
    expect(quotedBreak.ok && quotedBreak.list.entries.map((e) => e.email)).toEqual(["ok@example.com"]);
    expect(parseJoinedAt("2026-10-01T00:00:00.000Z")).toBe(Date.parse("2026-10-01T00:00:00.000Z"));
    expect(parseJoinedAt(String(Date.parse("2026-10-01T00:00:00Z")))).toBe(Date.parse("2026-10-01T00:00:00Z"));
    expect(parseJoinedAt("1999-01-01")).toBeNull();
    expect(parseJoinedAt("tomorrow")).toBeNull();
    const plain = parseWaitlistExport("one@example.com\ntwo@example.com\n");
    expect(plain.ok && plain.list.entries.map((e) => e.email)).toEqual(["one@example.com", "two@example.com"]);
    const tooMany = parseWaitlistExport(Array.from({ length: 5001 }, (_, i) => `p${i}@example.com`).join("\n"));
    expect(tooMany).toMatchObject({ ok: false });
  });
});

// --- Usage from tenants -----------------------------------------------------------------

describe("usage reported by a tenant", () => {
  it("keeps the newest counts, ignores late ones, and refuses nonsense", async () => {
    const tenant = await addTenant();
    const capability = new TenantCapability(env.PLATFORM_DB, tenant.id, tenant.accountId, () => clock);
    await capability.reportUsage({ monitors: 4, statusPages: 1, channels: 2, at: clock - 1000 });
    await capability.reportUsage({ monitors: 3, statusPages: 1, channels: 2, at: clock - 5000 });
    const stored = () => env.PLATFORM_DB.prepare("SELECT monitors, counted_at FROM tenant_usage WHERE tenant_id = ?").bind(tenant.id).first();
    expect(await stored()).toEqual({ monitors: 4, counted_at: clock - 1000 });
    // Reports are ordered by the tenant's own time, as sent: one from a clock
    // running ahead wins over a slightly later real one, as it should when it
    // really was taken later.
    await capability.reportUsage({ monitors: 5, statusPages: 2, channels: 2, at: clock + 60_000 });
    await capability.reportUsage({ monitors: 6, statusPages: 2, channels: 2, at: clock + 30_000 });
    expect(await stored()).toEqual({ monitors: 5, counted_at: clock + 60_000 });
    for (const bad of [{ monitors: -1 }, { statusPages: 1.5 }, { channels: "3" }, { at: Number.NaN }]) {
      await expect(capability.reportUsage({ monitors: 1, statusPages: 1, channels: 1, at: clock, ...bad } as never)).rejects.toThrow(/usage refused/);
    }
  });
});

// --- Review fixes ------------------------------------------------------------------

describe("the owner's inbox alone", () => {
  it("can't open the console, even with a passkey it registered before anything was pinned", async () => {
    const tenant = await addTenant();
    const real = await personWithPasskey();
    owners = real.accountId;
    // Someone with the inbox signs in by code and adds their own passkey: allowed, since nothing is pinned yet...
    const attacker = new Browser();
    await attacker.signInWithCode(real.email);
    const theirs = await SoftAuthenticator.create();
    const options = (await (await attacker.fetch("/account/passkeys/options", { json: {} })).json()) as any;
    expect((await attacker.fetch("/account/passkeys", { json: { credential: await theirs.register(options, APP) } })).status).toBe(200);
    // ...and the owner is told by email, as every account is.
    expect(outbox.sent.at(-1)).toMatchObject({ to: real.email, subject: "A passkey was added to your OpenPing Hosted account" });
    await attacker.signInWithPasskey(theirs);

    // Not pinned: the console stays closed, and shows the ids so the owner can pin the right one.
    const page = await attacker.fetch("/admin");
    expect(page.status).toBe(200);
    const body = await text(page);
    expect(body).toContain("None of your passkeys is pinned yet");
    expect(body).toContain(real.authenticator.id);
    expect(body).toContain(`${theirs.id}`);
    expect(body).toContain("(this session)");
    expect(body).not.toContain('aria-current="page">Tenants</a>');
    const refused = await attacker.fetch(`/admin/tenants/${tenant.id}/suspend`, { form: { reason: "taking over" } });
    expect(refused.status).toBe(401);
    expect((await tenantRow(tenant.id))!.owner_suspended_at).toBeNull();

    // The owner pins their own passkey: the attacker's still opens nothing.
    pinned = real.authenticator.id;
    await attacker.signInWithPasskey(theirs);
    expect(await text(await attacker.fetch("/admin"))).toContain("isn't one of your pinned passkeys");
    expect((await attacker.fetch(`/admin/tenants/${tenant.id}/suspend`, { form: { reason: "taking over" } })).status).toBe(401);
    // While the owner's pinned passkey opens it.
    await real.browser.signInWithPasskey(real.authenticator);
    expect(await text(await real.browser.fetch("/admin"))).toContain('aria-current="page">Tenants</a>');
    expect(await auditRows("tenant_id = ? AND actor = 'owner'", tenant.id)).toEqual([]);
  });

  it("can't add or remove the owner's passkeys once one is pinned", async () => {
    const { browser, authenticator, email } = await owner();
    const attacker = new Browser();
    await attacker.signInWithCode(email);
    const locked = await attacker.fetch("/account/passkeys/options", { json: {} });
    expect(locked.status).toBe(403);
    expect(((await locked.json()) as { error: string }).error).toBe("passkey_locked");
    const account = await text(await attacker.fetch("/account?done=passkey"));
    const id = /action="\/account\/passkeys\/([^/]+)\/delete"/.exec(account)![1]!;
    expect((await attacker.fetch(`/account/passkeys/${id}/delete`, { method: "POST" })).headers.get("location")).toBe("/account?done=passkey-locked");
    expect(await env.PLATFORM_DB.prepare("SELECT COUNT(*) AS n FROM account_identities WHERE id = ?").bind(id).first<{ n: number }>()).toEqual({ n: 1 });

    // The owner, signed in with the pinned passkey within 10 minutes, can.
    expect((await browser.fetch("/account/passkeys/options", { json: {} })).status).toBe(200);
    clock += ADMIN_REAUTH_MS + 1;
    expect((await browser.fetch("/account/passkeys/options", { json: {} })).status).toBe(403);
    await browser.signInWithPasskey(authenticator);
    expect((await browser.fetch("/account/passkeys/options", { json: {} })).status).toBe(200);
  });

  it("leaves other accounts' passkeys as they were", async () => {
    await owner();
    const someone = new Browser();
    await someone.signInWithCode(newEmail());
    expect((await someone.fetch("/account/passkeys/options", { json: {} })).status).toBe(200);
  });
});

describe("the owner's suspension and billing's", () => {
  it("are separate: billing can't lift the owner's, and the owner's resume leaves billing's", async () => {
    const { browser } = await owner();
    const tenant = await addTenant({ slug: "twosuspends", status: "suspended" });
    // Suspended by billing only: nothing for the owner to resume.
    expect((await browser.fetch(`/admin/tenants/${tenant.id}/resume`, { method: "POST" })).headers.get("location")).toContain("done=not-suspended");
    expect(await text(await browser.fetch(`/admin/tenants/${tenant.id}`))).toContain("Suspended by billing");
    // The owner suspends it too; billing then "pays" (status active): it stays suspended.
    await browser.fetch(`/admin/tenants/${tenant.id}/suspend`, { form: { reason: "abuse report" } });
    await env.PLATFORM_DB.prepare("UPDATE tenants SET status = 'active' WHERE id = ?").bind(tenant.id).run();
    clearTenantCache();
    expect((await visit("twosuspends")).status).toBe(503);
    // Lifting the owner's: billing's state (active) decides again.
    await browser.fetch(`/admin/tenants/${tenant.id}/resume`, { method: "POST" });
    expect(await tenantRow(tenant.id)).toMatchObject({ status: "active", owner_suspended_at: null });
    dispatcher.register(tenant.scriptName, () => new Response("back"));
    expect(await (await visit("twosuspends")).text()).toBe("back");
  });
});

describe("the audit log's action filter", () => {
  it("uses its index", async () => {
    const { auditFilters, auditLogQuery } = await import("../src/admin/data");
    const query = auditLogQuery(auditFilters({ action: "tenant." }));
    const plan = await env.PLATFORM_DB.prepare(`EXPLAIN QUERY PLAN ${query.sql}`).bind(...query.binds).all<{ detail: string }>();
    expect(plan.results.map((r) => r.detail).join("\n")).toMatch(/USING (COVERING )?INDEX idx_audit_events_action \(action>\? AND action<\?\)/);
  });
});

describe("the waitlist import, under pressure", () => {
  it("refuses a body over the limit while reading it", async () => {
    const { browser } = await owner();
    const big = `email\n${"x".repeat(WAITLIST_MAX_BYTES + 100_000)}@example.com\n`;
    const res = await browser.fetch("/admin/waitlist", { form: { text: big } });
    expect(res.status).toBe(413);
    expect(await text(res)).toContain("over 1 MB");
  });

  it("counts what each of two imports at once really added", async () => {
    const { importWaitlist } = await import("../src/admin/waitlist");
    const entries = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => ({ email: `race${from + i}@example.com`, joinedAt: null }));
    const [a, b] = await Promise.all([importWaitlist(env.PLATFORM_DB, entries(0, 120), clock), importWaitlist(env.PLATFORM_DB, entries(60, 180), clock)]);
    expect(a.added + b.added).toBe(180);
    expect(a.added + a.existing).toBe(120);
    expect(b.added + b.existing).toBe(120);
  });
});

describe("the Operations tab", () => {
  it("shows the platform's health, run metrics, and the failing and overdue tenants, linked", async () => {
    const { browser } = await owner();
    const failing = await addTenant({ slug: "ops-failing" });
    const late = await addTenant({ slug: "ops-late" });
    const db = env.PLATFORM_DB;
    await db.batch([
      db
        .prepare(
          `INSERT INTO scheduler_stats (tenant_id, last_run_id, last_at, last_outcome, last_duration_ms, last_lag_ms, last_error, streak, day, day_runs, day_errors, day_checked, day_failures, day_d1_queries, day_ms, day_max_ms)
           VALUES (?, 'r1', ?, 'timeout', 90000, 0, 'no answer in 90 s', 99, 0, 1, 1, 0, 0, 0, 90000, 90000)`,
        )
        .bind(failing.id, clock - 60_000),
      db.prepare("UPDATE tenants SET schedule_next_at = ? WHERE id = ?").bind(clock - 86_400_000, late.id),
      ...runMinuteStatements(db, [
        { at: clock - 120_000, outcome: "ran", durationMs: 800, lagMs: 3_000, checked: 5, failures: 0 },
        { at: clock - 120_000, outcome: "timeout", durationMs: 90_000, lagMs: 4_000, checked: 0, failures: 0 },
      ]),
    ]);
    const res = await browser.fetch("/admin/operations");
    expect(res.status).toBe(200);
    const page = await text(res);
    expect(page).toContain('<a href="/admin/operations" aria-current="page">');
    // No heartbeat in this database: the same verdict as /__health, with why.
    expect(page).toContain("Degraded.");
    expect(page).toContain("The cron has never run.");
    expect(page).toContain("The scheduler is behind");
    expect(page).toContain("Last 15 minutes");
    expect(page).toContain("Timed out");
    expect(page).toContain(`<a href="/admin/tenants/${failing.id}">ops-failing</a>`);
    expect(page).toContain("no answer in 90 s");
    expect(page).toContain(`<a href="/admin/tenants/${late.id}">ops-late</a>`);
    expect(page).toContain("24 h");
    // Nothing on it runs a script.
    expect(page).not.toMatch(/<script(?![^>]*src=)/);
    await db.prepare("DELETE FROM scheduler_stats WHERE tenant_id = ?").bind(failing.id).run();
    await db.prepare("UPDATE tenants SET schedule_next_at = 0 WHERE id = ?").bind(late.id).run();
  });

  it("lists the failing and overdue tenants from their indexes, never a table scan", async () => {
    const failing = (await env.PLATFORM_DB.prepare(`EXPLAIN QUERY PLAN ${FAILING_LIST_SQL}`).all<{ detail: string }>()).results.map((r) => r.detail).join(" | ");
    expect(failing).toContain("idx_scheduler_stats_failing");
    expect(failing).not.toMatch(/SCAN (tenants|t|s)\b/);
    // Already in the order shown: no sort.
    expect(failing).not.toContain("TEMP B-TREE");
    const overdue = (await env.PLATFORM_DB.prepare(`EXPLAIN QUERY PLAN ${OVERDUE_LIST_SQL}`).bind(clock).all<{ detail: string }>()).results.map((r) => r.detail).join(" | ");
    expect(overdue).toContain("SEARCH tenants USING INDEX idx_tenants_schedule_due (schedule_next_at<?)");
    expect(overdue).not.toMatch(/SCAN (tenants|t|s)\b/);
    // Sorted by how long each has waited, but only the late rows, at most 1,000 of them.
    expect(OVERDUE_LIST_SQL).toContain("LIMIT 1000)");
  });
});

describe("the Releases tab", () => {
  const MANIFEST = (version: string): BundleManifest => ({
    version,
    mainModule: "index.js",
    compatibilityDate: "2024-12-30",
    compatibilityFlags: [],
    assetsConfig: {},
    vars: {},
    modules: [{ name: "index.js", contentType: "application/javascript+module" }],
    assets: [],
    d1Migrations: [{ name: "0021_support.sql", sha256: "a" }],
  });
  function upload(version: string) {
    releaseBucket.putText(`releases/${version}/modules/index.js`, `export default {} // ${version}`);
    releaseBucket.putText(`releases/${version}/migrations/0021_support.sql`, "CREATE TABLE support_activity (id INTEGER PRIMARY KEY);");
    releaseBucket.putText(`releases/${version}/bundle.json`, JSON.stringify(MANIFEST(version)));
  }
  const states = new Map<string, FakeOpenPingState>();
  const original = api.onScriptChange;

  /** A ready tenant the runner can update: its database, its escrowed key, its OpenPing answering. */
  async function updatableTenant(slug: string) {
    const tenant = await addTenant({ slug });
    const d1 = "00000000-0000-4000-8000-000000000000";
    api.databases.set(d1, { id: d1, name: `openping-t-${tenant.id}` });
    await ensureMasterKey(env.PLATFORM_DB, tenant.id, RELEASE_PLATFORM_KEY, clock);
    return tenant;
  }

  beforeEach(async () => {
    releaseBucket = new FakeR2Bucket();
    releasesOn = true;
    clearLoadedBundles();
    upload("0.11.0");
    upload("0.12.0");
    releaseBucket.putText("releases/current", "0.11.0");
    api.onScriptChange = (name, script) => {
      if (!script) return dispatcher.remove(name);
      const fake = fakeOpenPing(script, { state: states.get(name), healthMigrates: true });
      states.set(name, fake.state);
      dispatcher.register(name, fake.worker);
    };
    // Only this block's tenants: a rollout reaches every ready tenant.
    await env.PLATFORM_DB.batch([
      env.PLATFORM_DB.prepare("DELETE FROM release_tenants"),
      env.PLATFORM_DB.prepare("DELETE FROM releases"),
      env.PLATFORM_DB.prepare("DELETE FROM release_requests"),
      env.PLATFORM_DB.prepare("DELETE FROM escrowed_keys"),
      env.PLATFORM_DB.prepare("DELETE FROM tenant_usage"),
      env.PLATFORM_DB.prepare("DELETE FROM tenants"),
    ]);
    return () => {
      api.onScriptChange = original;
    };
  });

  it("is the plain 404 for anyone but the owner", async () => {
    const { browser } = await personWithPasskey();
    owners = "acc_the_real_owner";
    expect((await browser.fetch("/admin/releases")).status).toBe(404);
    expect((await browser.fetch("/admin/releases/request", { form: { action: "rollback" } })).status).toBe(404);
    expect(await env.PLATFORM_DB.prepare("SELECT COUNT(*) AS n FROM release_requests").first("n")).toBe(0);
  });

  it("shows what new tenants get and what is in the bucket", async () => {
    const { browser } = await owner();
    const page = await text(await browser.fetch("/admin/releases"));
    expect(page).toContain('aria-current="page">Releases</a>');
    expect(page).toContain('<strong class="mono">0.11.0</strong><span>New tenants get</span>');
    expect(page).toContain('<option value="0.12.0" selected>0.12.0</option>');
    expect(page).toContain("No releases yet.");
  });

  it("plans a dry run and shows its plan without touching anyone", async () => {
    const { browser } = await owner();
    const tenant = await updatableTenant("canary-one");
    const res = await browser.fetch("/admin/releases/request", { form: { action: "rollout", version: "0.12.0", dry_run: "1", canary: "canary-one", batch_size: "50" } });
    expect(res.status).toBe(303);
    const page = await text(await browser.fetch(res.headers.get("location")!));
    expect(page).toContain("Dry run: 1 tenant to update: the canary canary-one, then 0 batches of up to 50.");
    expect(page).toContain("<dt>New D1 migrations</dt><dd>None</dd>");
    expect(page).toContain("A dry run touches no tenant.");
    // The request's answer once, not again as the release's note.
    expect(page.split("Dry run: 1 tenant to update").length).toBe(2);
    expect((await tenantRow(tenant.id))!.version).toBe("0.11.0");
    const rows = await env.PLATFORM_DB.prepare("SELECT requested_by FROM releases").all<{ requested_by: string }>();
    expect(rows.results).toEqual([{ requested_by: `owner:${owners}` }]);
  });

  it("starts a rollout, follows it, and offers the right controls when it stops", async () => {
    const { browser } = await owner();
    const canary = await updatableTenant("canary-two");
    const other = await addTenant({ slug: "no-key-here" }); // no escrowed key: it can't be updated
    const res = await browser.fetch("/admin/releases/request", { form: { action: "rollout", version: "0.12.0", dry_run: "0", canary: "canary-two" } });
    expect(res.status).toBe(303);
    const location = res.headers.get("location")!;
    expect(location).toMatch(/^\/admin\/releases\/rel_[0-9a-f]{24}\?request=rrq_[0-9a-f]{24}$/);
    // The console pushed it right away: the canary passed, then the tenant without a key stopped it.
    expect((await tenantRow(canary.id))!.version).toBe("0.12.0");
    expect(releaseBucket.textOf("releases/current")).toBe("0.12.0");
    const page = await text(await browser.fetch(location));
    expect(page).toContain("Started: 2 tenants to update: the canary canary-two, then 1 batch of up to 50.");
    expect(page).toContain("Stopped in batch 1: 1 tenant didn't come back healthy: no-key-here (upload: it has no escrowed MASTER_KEY).");
    expect(page).toContain('aria-valuenow="1"');

    const overview = await text(await browser.fetch("/admin/releases"));
    expect(overview).toContain("Roll out 0.12.0");
    expect(overview).toContain('<input type="hidden" name="action" value="skip_failed">');
    expect(overview).toContain("Roll back to 0.11.0");
    expect(overview).toMatch(/<button class="button primary" type="submit" name="dry_run" value="0" disabled>/);

    const skipped = await browser.fetch("/admin/releases/request", { form: { action: "skip_failed" } });
    expect(await text(await browser.fetch(skipped.headers.get("location")!))).toContain("Shipped 0.12.0: 1 tenant healthy, 0 failed and 1 skipped (see the list).");
    expect((await tenantRow(other.id))!.version).toBe("0.11.0");

    const back = await browser.fetch("/admin/releases/request", { form: { action: "rollback", version: "", dry_run: "0" } });
    const rolledBack = await text(await browser.fetch(back.headers.get("location")!));
    expect(rolledBack).toContain("Started: Back to 0.11.0: 1 tenant in 1 batch.");
    expect((await tenantRow(canary.id))!.version).toBe("0.11.0");
    expect(releaseBucket.textOf("releases/current")).toBe("0.11.0");
  });

  it("asks for a fresh passkey before any release change", async () => {
    const { browser } = await owner();
    clock += ADMIN_REAUTH_MS + 1;
    expect(await text(await browser.fetch("/admin/releases"))).toContain("Changes ask you to confirm with your passkey first.");
    const refused = await browser.fetch("/admin/releases/request", { form: { action: "rollout", version: "0.12.0", dry_run: "1" } });
    expect(refused.status).toBe(401);
    expect(await text(refused)).toContain('data-next="/admin/releases"');
    expect(await env.PLATFORM_DB.prepare("SELECT COUNT(*) AS n FROM release_requests").first("n")).toBe(0);
  });

  it("refuses nonsense, and says when releases are off", async () => {
    const { browser } = await owner();
    const bad = await browser.fetch("/admin/releases/request", { form: { action: "rollout", version: "../../etc" } });
    expect(bad.status).toBe(400);
    expect(await text(bad)).toContain("That isn't a version.");
    expect((await browser.fetch("/admin/releases/request", { form: { action: "drop" } })).status).toBe(400);
    releasesOn = false;
    const page = await text(await browser.fetch("/admin/releases"));
    expect(page).toContain("Releases are off until these are set: CF_API_TOKEN, PLATFORM_KEY.");
    expect(page).not.toContain("Start a release");
    expect((await browser.fetch("/admin/releases/request", { form: { action: "pause" } })).status).toBe(400);
    expect((await browser.fetch("/admin/releases/rel_000000000000000000000000")).status).toBe(404);
  });
});
