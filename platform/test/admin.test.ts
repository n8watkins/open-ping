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
import { csvFields, parseJoinedAt, parseWaitlistExport } from "../src/admin/waitlist";
import { createApp } from "../src/app";
import { LIMITS } from "../src/auth/rate-limit";
import { StaticBundleSource, type TenantBundle } from "../src/bundle";
import { TenantCapability } from "../src/capability";
import type { PlatformEnv } from "../src/env";
import { generateMasterKey } from "../src/keys";
import type { Mailer, OutgoingEmail } from "../src/mail";
import { requestTenant, type ProvisioningDeps } from "../src/provisioning";
import { clearTenantCache } from "../src/tenants";
import { FakeCloudflareApi } from "./fake-cloudflare";
import { FakeDispatcher } from "./fake-dispatcher";
import { fakeOpenPing } from "./fake-openping";

const DOMAIN = "openping.test";
const APP = `https://app.${DOMAIN}`;
let keys: { publicKey: string; privateKey: string };

// --- The world: a clock, mail, provisioning and tenants, all in memory ------

let clock = Date.now();
let owners = "";
let signingKey: string | undefined;

class Outbox implements Mailer {
  sent: OutgoingEmail[] = [];
  async send(message: OutgoingEmail) {
    this.sent.push(message);
    return { ok: true as const, id: `m${this.sent.length}` };
  }
  lastCode(): string {
    return /Code: (\d{6})/.exec(this.sent.at(-1)!.text)![1]!;
  }
}
const outbox = new Outbox();

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

const app = createApp({ dispatcher: () => dispatcher, capability: () => noopPlatform, accounts: accountDeps });

function platformEnv(): PlatformEnv {
  return {
    ...(env as unknown as PlatformEnv),
    SIGN_UPS: "open",
    PLATFORM_OWNERS: owners,
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

/** The owner (by account id), signed in with a passkey just now. */
async function owner() {
  const person = await personWithPasskey();
  owners = person.accountId;
  return person;
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
  signingKey = keys.privateKey;
  clearTenantCache();
  await env.PLATFORM_DB.prepare("DELETE FROM rate_limits").run();
});

// --- Who gets in ------------------------------------------------------------

describe("who can open the admin console", () => {
  const paths = ["/admin", "/admin/", "/admin/audit", "/admin/waitlist", "/admin/tenants/abcdefghijklmnop", "/admin/nothing-here"];

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

  it("lets the owner in by account id or email with a passkey sign-in, and links it from the account page", async () => {
    const person = await personWithPasskey();
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
    expect((await tenantRow(tenant.id))!.status).toBe("suspended");
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
      "SELECT COUNT(*) AS all_count, SUM(provision_paused_at IS NOT NULL) AS paused, SUM(status = 'suspended') AS suspended FROM tenants",
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
      "tenant.provisioned",
      "version: 0.11.0 · seconds: 41",
      `href="https://detailco.${DOMAIN}"`,
    ]) {
      expect(page, expected).toContain(expected);
    }
    // The health call was a platform call, with the contract's header.
    expect(dispatcher.calls.at(-1)!.props.invocation).toBe("platform");
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
    const row = await tenantRow(tenant.id);
    expect(row).toMatchObject({ status: "suspended", status_before_suspend: "past_due", suspended_at: clock, suspended_reason: "Phishing page on its status page" });
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
    expect(await tenantRow(tenant.id)).toMatchObject({ status: "past_due", status_before_suspend: null, suspended_at: null, suspended_reason: null });
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
    expect(res.status).toBe(303);
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    const location = new URL(res.headers.get("location")!);
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
    expect(csvFields('a@example.com,"2026-10-01T00:00:00Z"')).toEqual(["a@example.com", "2026-10-01T00:00:00Z"]);
    expect(csvFields('"say ""hi""",x')).toEqual(['say "hi"', "x"]);
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
    // A tenant clock running ahead can't push its counts into the future.
    await capability.reportUsage({ monitors: 5, statusPages: 2, channels: 2, at: clock + 86_400_000 });
    expect(await env.PLATFORM_DB.prepare("SELECT monitors, status_pages, channels, counted_at FROM tenant_usage WHERE tenant_id = ?").bind(tenant.id).first()).toEqual({
      monitors: 5,
      status_pages: 2,
      channels: 2,
      counted_at: clock,
    });
    for (const bad of [{ monitors: -1 }, { statusPages: 1.5 }, { channels: "3" }, { at: Number.NaN }]) {
      await expect(capability.reportUsage({ monitors: 1, statusPages: 1, channels: 1, at: clock, ...bad } as never)).rejects.toThrow(/usage refused/);
    }
  });
});
