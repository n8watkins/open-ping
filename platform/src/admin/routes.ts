/**
 * app.<domain>/admin: the owner's console (build plan, B6).
 *
 * Who gets in (./owner.ts): an account named in PLATFORM_OWNERS, signed in
 * with a passkey in the last 12 hours, and for any change in the last 10
 * minutes. Anyone else, signed in or not, gets the platform's ordinary 404
 * for every method and path, so the console can't be found by probing; the
 * owner without a fresh passkey sign-in gets a page asking for one.
 *
 * Every change is a POST from this origin (the same check as the account
 * pages), counted against the owner's rate limit, and written to the audit
 * log with actor `owner` (or `support` for a support sign-in) and the
 * tenant's own account, so it shows up wherever that tenant's history does.
 */

import { Hono, type Context } from "hono";

import { PLATFORM_HEALTH_PATH, type HealthResponse, type PlatformCapability } from "../../../src/shared/hosted-contract";
import { audit } from "../accounts";
import { emailsToday } from "../capability";
import { continuePage, messagePage } from "../account-pages";
import { listPasskeys } from "../auth/passkeys";
import { LIMITS, hitInOrder } from "../auth/rate-limit";
import { readSession, type Session } from "../auth/sessions";
import { callTenant, type TenantDispatcher } from "../dispatch";
import type { PlatformEnv } from "../env";
import { handoffUrl, mintHandoffToken } from "../handoff";
import { appOrigin, requestTenantOrigin } from "../hosts";
import { appNotFoundPage } from "../pages";
import { markForRemoval, runProvisioning, unpauseProvisioning } from "../provisioning";
import type { ProvisioningSetup } from "../provisioning-env";
import { enqueueProvisioning } from "../provisioning-queue";
import type { TenantRecord } from "../tenants";
import {
  auditFilters,
  auditLog,
  cleanReason,
  listTenants,
  resumeTenant,
  suspendTenant,
  tenantCounts,
  tenantDetail,
  tenantFilters,
  tenantHistory,
} from "./data";
import { adminAccess, parsePinnedPasskeys } from "./owner";
import { scheduleView } from "../scheduling";
import { auditPage, tenantListPage, tenantPage, verifyPage, waitlistPage, type HealthView } from "./pages";
import { releaseRoutes } from "./releases";
import type { ReleaseSetup } from "../releases/env";
import { WAITLIST_MAX_BYTES, importWaitlist, parseWaitlistExport, readBodyCapped, waitlistSummary } from "./waitlist";

export interface AdminDeps {
  dispatcher(env: PlatformEnv): TenantDispatcher;
  capability(env: PlatformEnv, ctx: ExecutionContext, tenant: TenantRecord): PlatformCapability;
  provisioning(env: PlatformEnv, ctx: ExecutionContext): ProvisioningSetup;
  /** The release runner (src/releases/); absent, the Releases tab says it is off. */
  releases?(env: PlatformEnv, ctx: ExecutionContext, capability: (tenant: TenantRecord) => PlatformCapability): ReleaseSetup;
  now?: () => number;
}

type Env = { Bindings: PlatformEnv; Variables: { owner: Session; now: number; recent: boolean } };
type Ctx = Context<Env>;

const NO_STORE = { "cache-control": "no-store" } as const;
/** A tenant's health is asked live on its page; a tenant slower than this is shown as not answering. */
export const HEALTH_TIMEOUT_MS = 5_000;

/** Pages of the console a passkey sign-in may return to (account-routes' safeNext accepts these). */
export const ADMIN_NEXT_PATTERN = /^\/admin(?:\/(?:audit|waitlist|releases(?:\/rel_[0-9a-f]{24})?|tenants\/[a-z0-9]{16}))?$/;

/** Where to come back to after confirming: the page itself, or for a change the page it was made from. */
function returnPath(path: string): string {
  const page = path
    .replace(/\/+$/, "")
    .replace(/^(\/admin\/tenants\/[a-z0-9]{16})\/[a-z-]+$/, "$1")
    .replace(/^(\/admin\/releases)\/request$/, "$1");
  return ADMIN_NEXT_PATTERN.test(page) ? page : "/admin";
}

function seeOther(location: string): Response {
  return new Response(null, { status: 303, headers: { location, ...NO_STORE } });
}

async function form(c: Ctx): Promise<Record<string, string | File>> {
  const body = (await c.req.parseBody().catch(() => ({}))) as Record<string, unknown>;
  const out: Record<string, string | File> = {};
  for (const [k, v] of Object.entries(body)) if (typeof v === "string" || v instanceof File) out[k] = v;
  return out;
}

const text = (value: string | File | undefined) => (typeof value === "string" ? value : "");

/** What the tenant page says after a change (?done=...). */
const FLASH: Record<string, { message: string; tone: "ok" | "error" }> = {
  suspended: { message: "Suspended. Visitors see the paused page now here, and everywhere within 30 seconds.", tone: "ok" },
  "already-suspended": { message: "It was already suspended.", tone: "error" },
  resumed: { message: "Resumed. Visitors reach it again within 30 seconds.", tone: "ok" },
  "not-suspended": { message: "It wasn't suspended.", tone: "error" },
  "provisioning-resumed": { message: "Provisioning resumed. This page shows its progress when you reload it.", tone: "ok" },
  "not-paused": { message: "Its provisioning isn't paused, so nothing was changed.", tone: "error" },
  "provisioning-off": { message: "Provisioning is off until all its settings are set (the cron logs which), so nothing was changed.", tone: "error" },
  "confirm-mismatch": { message: "The address you typed doesn't match, so nothing was removed.", tone: "error" },
  "reason-needed": { message: "Write a short reason (at least 3 characters) first.", tone: "error" },
  "not-ready": { message: "Support sign-in needs a ready OpenPing that isn't suspended.", tone: "error" },
  "support-off": { message: "Support sign-in isn't available: HANDOFF_SIGNING_KEY isn't set.", tone: "error" },
};

const LIST_FLASH: Record<string, { message: string; tone: "ok" | "error" }> = {
  "removal-started": { message: "Removal started. The tenant disappears from this list once its Worker and database are deleted.", tone: "ok" },
};

/** `promise`, or "timeout" after `ms`. */
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

export function adminRoutes(deps: AdminDeps): Hono<Env> {
  const app = new Hono<Env>();
  const clock = deps.now ?? Date.now;

  app.use("*", async (c, next) => {
    const now = clock();
    const db = c.env.PLATFORM_DB;
    const access = await adminAccess(db, await readSession(db, c.req.raw, now), c.env, now);
    // Before anything else, so nobody but the owner learns the console exists.
    if (access.kind === "none") return appNotFoundPage(appOrigin(c.env.HOSTED_DOMAIN));
    const change = c.req.method !== "GET" && c.req.method !== "HEAD";
    if (change) {
      const from = c.req.header("origin");
      const own = new URL(c.req.url).origin;
      const ok = from && from !== "null" ? from === own : c.req.header("sec-fetch-site") === "same-origin";
      if (!ok) return c.json({ error: "forbidden", message: "This request didn't come from OpenPing Hosted." }, 403, NO_STORE);
    }
    const back = returnPath(new URL(c.req.url).pathname);
    if (access.kind === "verify" || (change && !access.recent)) {
      return verifyPage({
        next: back,
        passkeys: await listPasskeys(db, access.session.account.id),
        pinned: parsePinnedPasskeys(c.env.PLATFORM_OWNER_PASSKEYS),
        current: access.session.passkeyCredential,
        unpinned: access.kind === "verify" && access.reason === "unpinned",
        forChange: change,
        status: change ? 401 : 200,
      });
    }
    if (change) {
      const limited = await hitInOrder(db, [[LIMITS.adminAction, access.session.account.id]], now);
      if (limited) {
        return messagePage({ title: "Too many changes", body: "Wait a few minutes, then try again.", status: 429, action: { href: back, label: "Back" } });
      }
    }
    c.set("owner", access.session);
    c.set("now", now);
    c.set("recent", access.recent);
    await next();
  });

  // --- Tenants ------------------------------------------------------------

  app.get("/", async (c) => {
    const db = c.env.PLATFORM_DB;
    const [list, counts] = await Promise.all([listTenants(db, tenantFilters(c.req.query())), tenantCounts(db)]);
    return tenantListPage({ list, counts, flash: LIST_FLASH[c.req.query("done") ?? ""] ?? null });
  });

  async function liveHealth(c: Ctx, tenant: TenantRecord): Promise<HealthView> {
    if (tenant.provisionState !== "ready") return { kind: "skipped", reason: "Not asked: it isn't ready yet." };
    try {
      const call = callTenant(
        deps.dispatcher(c.env),
        { tenant, hostedDomain: c.env.HOSTED_DOMAIN, platform: deps.capability(c.env, c.executionCtx as ExecutionContext, tenant) },
        PLATFORM_HEALTH_PATH,
      );
      const result = await withTimeout(call, HEALTH_TIMEOUT_MS);
      if (result === "timeout") return { kind: "unreachable", reason: `It didn't answer within ${HEALTH_TIMEOUT_MS / 1000} seconds.` };
      if (result.kind === "missing") return { kind: "unreachable", reason: `Its Worker ${tenant.scriptName} isn't in the namespace.` };
      const body = await result.response.json<HealthResponse>().catch(() => null);
      if (!body || typeof body.ok !== "boolean") return { kind: "unreachable", reason: `It answered HTTP ${result.response.status} without a health report.` };
      return { kind: "answered", status: result.response.status, health: body };
    } catch (error) {
      console.error("[admin] health call failed", { tenant: tenant.id }, error);
      return { kind: "unreachable", reason: "The call to it failed; the platform's logs have the error." };
    }
  }

  app.get("/tenants/:id", async (c) => {
    const db = c.env.PLATFORM_DB;
    const detail = await tenantDetail(db, c.req.param("id"));
    if (!detail) return appNotFoundPage(appOrigin(c.env.HOSTED_DOMAIN));
    const [history, health, schedule, emails] = await Promise.all([
      tenantHistory(db, detail.record.id),
      liveHealth(c, detail.record),
      scheduleView(db, detail.record),
      emailsToday(db, detail.record.id, c.get("now")),
    ]);
    return tenantPage({
      detail,
      history,
      health,
      schedule,
      tenantUrl: requestTenantOrigin(c.req.url, detail.record.slug, c.env.HOSTED_DOMAIN),
      recent: c.get("recent"),
      supportOn: Boolean(c.env.HANDOFF_SIGNING_KEY),
      emails,
      flash: FLASH[c.req.query("done") ?? ""] ?? null,
    });
  });

  /** Runs `handler` with the tenant, or answers 404 when there is none. */
  function tenantAction(handler: (c: Ctx, tenant: TenantRecord, fields: Record<string, string | File>) => Promise<Response>) {
    return async (c: Ctx) => {
      const detail = await tenantDetail(c.env.PLATFORM_DB, c.req.param("id") ?? "");
      if (!detail) return appNotFoundPage(appOrigin(c.env.HOSTED_DOMAIN));
      return handler(c, detail.record, await form(c));
    };
  }

  const pageOf = (tenant: TenantRecord, done: string) => seeOther(`/admin/tenants/${tenant.id}?done=${done}`);

  const ownerAudit = (c: Ctx, tenant: TenantRecord, action: string, detail: Record<string, unknown>) =>
    audit(c.env.PLATFORM_DB, {
      accountId: tenant.accountId,
      tenantId: tenant.id,
      actor: "owner",
      action,
      detail: { by: c.get("owner").account.id, ...detail },
      now: c.get("now"),
    });

  app.post(
    "/tenants/:id/suspend",
    tenantAction(async (c, tenant, fields) => {
      const reason = cleanReason(fields.reason);
      if (reason.length < 3) return pageOf(tenant, "reason-needed");
      if (!(await suspendTenant(c.env.PLATFORM_DB, tenant, reason, c.get("now")))) return pageOf(tenant, "already-suspended");
      await ownerAudit(c, tenant, "tenant.suspended", { reason, from: tenant.status });
      return pageOf(tenant, "suspended");
    }),
  );

  app.post(
    "/tenants/:id/resume",
    tenantAction(async (c, tenant) => {
      const status = await resumeTenant(c.env.PLATFORM_DB, tenant, c.get("now"));
      if (!status) return pageOf(tenant, "not-suspended");
      await ownerAudit(c, tenant, "tenant.resumed", { to: status });
      return pageOf(tenant, "resumed");
    }),
  );

  /** Starts a run for a tenant just unpaused or marked for removal: the queue when there is one, else after this answer. */
  async function startRun(c: Ctx, setup: ProvisioningSetup, tenantId: string): Promise<void> {
    if (c.env.PROVISION_QUEUE) {
      await enqueueProvisioning(c.env.PROVISION_QUEUE, tenantId);
    } else if (setup.ok) {
      c.executionCtx.waitUntil(runProvisioning(setup.deps, tenantId, { force: true }).catch((error) => console.error("[admin] provisioning run failed", error)));
    }
  }

  /** Provisioning can run (now or from the queue); otherwise the change would only strand the tenant. */
  function provisioningFor(c: Ctx): ProvisioningSetup | null {
    const setup = deps.provisioning(c.env, c.executionCtx as ExecutionContext);
    return setup.ok || c.env.PROVISION_QUEUE ? setup : null;
  }

  app.post(
    "/tenants/:id/resume-provisioning",
    tenantAction(async (c, tenant) => {
      const setup = provisioningFor(c);
      if (!setup) return pageOf(tenant, "provisioning-off");
      if (!(await unpauseProvisioning(c.env.PLATFORM_DB, tenant.id, c.get("now")))) return pageOf(tenant, "not-paused");
      await ownerAudit(c, tenant, "tenant.provision_resumed", { state: tenant.provisionState });
      await startRun(c, setup, tenant.id);
      return pageOf(tenant, "provisioning-resumed");
    }),
  );

  app.post(
    "/tenants/:id/remove",
    tenantAction(async (c, tenant, fields) => {
      if (text(fields.confirm).trim().toLowerCase() !== tenant.slug) return pageOf(tenant, "confirm-mismatch");
      const setup = provisioningFor(c);
      if (!setup) return pageOf(tenant, "provisioning-off");
      if (!(await markForRemoval(c.env.PLATFORM_DB, tenant.id, c.get("now"), { onlyIfPaused: true }))) return pageOf(tenant, "not-paused");
      await ownerAudit(c, tenant, "tenant.removal_requested", { slug: tenant.slug, state: tenant.provisionState });
      await startRun(c, setup, tenant.id);
      return seeOther("/admin?done=removal-started");
    }),
  );

  // Support: the contract's hand-off with role "support" (CONTRACT.md, section 7),
  // signed as the owner. The tenant audits the sign-in too and makes the
  // session last an hour; the customer sees this row on their account page.
  app.post(
    "/tenants/:id/support",
    tenantAction(async (c, tenant, fields) => {
      if (tenant.provisionState !== "ready" || tenant.status === "suspended") return pageOf(tenant, "not-ready");
      if (!c.env.HANDOFF_SIGNING_KEY) return pageOf(tenant, "support-off");
      const reason = cleanReason(fields.reason);
      if (reason.length < 3) return pageOf(tenant, "reason-needed");
      const owner = c.get("owner").account;
      const limited = await hitInOrder(c.env.PLATFORM_DB, [[LIMITS.adminSupport, owner.id]], c.get("now"));
      if (limited) {
        return messagePage({ title: "Too many support sign-ins", body: "Wait a while, then try again.", status: 429, action: { href: `/admin/tenants/${tenant.id}`, label: "Back" } });
      }
      const token = await mintHandoffToken(c.env.HANDOFF_SIGNING_KEY, {
        tenantId: tenant.id,
        accountId: owner.id,
        email: owner.email,
        role: "support",
        now: c.get("now"),
      });
      // Recorded before the browser has the token: no support sign-in without its row.
      await audit(c.env.PLATFORM_DB, {
        accountId: tenant.accountId,
        tenantId: tenant.id,
        actor: "support",
        action: "support.handoff_issued",
        detail: { by: owner.id, email: owner.email, reason },
        now: c.get("now"),
      });
      // A page that goes on by GET, not a 303: the CSP's form-action 'self'
      // blocks a post's redirect to the tenant's origin.
      return continuePage({
        href: handoffUrl(requestTenantOrigin(c.req.url, tenant.slug, c.env.HOSTED_DOMAIN), token),
        title: "Signing in as support",
        body: `Opening ${tenant.slug} as support, for one hour. The customer sees this sign-in and its reason.`,
        label: `Continue to ${tenant.slug}`,
        headers: { "referrer-policy": "no-referrer" },
      });
    }),
  );

  // --- Releases (C1) --------------------------------------------------------

  app.route("/releases", releaseRoutes({ releases: deps.releases, capability: deps.capability }));

  // --- The audit log --------------------------------------------------------

  app.get("/audit", async (c) => {
    const filters = auditFilters(c.req.query());
    const { events, more } = await auditLog(c.env.PLATFORM_DB, filters);
    return auditPage({ events, more, filters });
  });

  // --- The waitlist ---------------------------------------------------------

  app.get("/waitlist", async (c) => waitlistPage({ summary: await waitlistSummary(c.env.PLATFORM_DB) }));

  app.post("/waitlist", async (c) => {
    const db = c.env.PLATFORM_DB;
    const refuse = async (error: string, status = 400) => waitlistPage({ summary: await waitlistSummary(db), error, status });
    const tooBig = `That file is over ${WAITLIST_MAX_BYTES / 1_000_000} MB. Split it into smaller files and import each.`;
    // Read with a cap (the multipart wrapper adds a little), whatever Content-Length claims.
    const raw = await readBodyCapped(c.req.raw, WAITLIST_MAX_BYTES + 64_000);
    if (!raw) return refuse(tooBig, 413);
    const parsedForm = await new Request(c.req.url, { method: "POST", headers: { "content-type": c.req.header("content-type") ?? "" }, body: raw })
      .formData()
      .catch(() => null);
    if (!parsedForm) return refuse("That upload couldn't be read. Choose the file again, or paste it.");
    const fileField = parsedForm.get("file");
    const file = fileField instanceof File && fileField.size > 0 ? fileField : null;
    if (file && file.size > WAITLIST_MAX_BYTES) return refuse(tooBig, 413);
    const pasted = parsedForm.get("text");
    const body = file ? await file.text() : typeof pasted === "string" ? pasted : "";
    const parsed = parseWaitlistExport(body);
    if (!parsed.ok) return refuse(parsed.message);
    const { added, existing } = await importWaitlist(db, parsed.list.entries, c.get("now"));
    const owner = c.get("owner").account;
    await audit(db, {
      accountId: owner.id,
      actor: "owner",
      action: "waitlist.imported",
      detail: { by: owner.id, added, existing, invalid: parsed.list.invalid.length, duplicates: parsed.list.duplicates, source: file ? "file" : "pasted" },
      now: c.get("now"),
    });
    return waitlistPage({ summary: await waitlistSummary(db), result: { added, existing, list: parsed.list } });
  });

  return app;
}
