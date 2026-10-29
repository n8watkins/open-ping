/**
 * app.<domain>/account/export: a customer takes their OpenPing with them
 * (build plan, B7): an export of its database, the steps to run it on their
 * own Cloudflare account, and their MASTER_KEY, which opens the encrypted
 * values in it (docs/BACKUP.md: the key is kept apart from the backups).
 *
 * - The export is the same pipeline as the one before a deletion
 *   (./exports.ts), started here and finished by the cron; it is kept 7 days.
 * - The files download only to the account that owns them, from this origin.
 * - The key is each export's own (kept with it in export_keys, so it still
 *   opens after a deletion, decision D12), shown only after a sign-in from
 *   the last 15 minutes (a passkey sign-in, when the account has a passkey),
 *   never emailed and never in a download, and the account is emailed each
 *   time it is shown, the way a new passkey is.
 * - After a deletion the account still reaches its last export here, for as
 *   long as it is kept.
 */

import { Hono } from "hono";

import { audit } from "../accounts";
import { messagePage } from "../account-pages";
import { LIMITS, hitInOrder } from "../auth/rate-limit";
import { readSession, type Session } from "../auth/sessions";
import { keyRevealedEmail } from "../emails";
import type { PlatformEnv } from "../env";
import { appOrigin, requestTenantOrigin } from "../hosts";
import { openEscrowedKey } from "../keys";
import { PLATFORM_REPLY_TO, type Mailer } from "../mail";
import { Html, html, notice, renderPage } from "../ui";
import { accountExports, advanceExport, getExport, requestExport, type ExportDeps, type TenantExport } from "./exports";
import { log } from "../log";

export interface AccountExportDeps {
  /** Exports need Cloudflare and the bucket: null while provisioning's settings or EXPORTS are missing. */
  exports(env: PlatformEnv): Omit<ExportDeps, "db" | "now"> | null;
  mailer(env: PlatformEnv): Mailer | null;
  now?: () => number;
}

/** A sign-in this recent may see the key. */
export const KEY_REVEAL_FRESH_MS = 15 * 60_000;

type Env = { Bindings: PlatformEnv; Variables: { session: Session | null; now: number } };

const NO_STORE = { "cache-control": "no-store" } as const;
const EXPORT_ID = /^exp_[0-9a-f]{24}$/;
const FILES = { "openping.sql": "application/sql", "README.md": "text/markdown; charset=utf-8" } as const;

function seeOther(location: string): Response {
  return new Response(null, { status: 303, headers: { location, ...NO_STORE } });
}

async function accountTenant(db: D1Database, accountId: string) {
  return db
    .prepare("SELECT id, slug, provision_state, d1_id FROM tenants WHERE account_id = ? AND provision_state <> 'deleting' ORDER BY created_at LIMIT 1")
    .bind(accountId)
    .first<{ id: string; slug: string; provision_state: string; d1_id: string | null }>();
}

function sizeText(bytes: number | null): string {
  if (bytes === null) return "";
  return bytes < 1_048_576 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1_048_576).toFixed(1)} MB`;
}

const dateText = (ms: number) => new Date(ms).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });

const FLASH: Record<string, { message: string; tone: "ok" | "error" }> = {
  ready: { message: "Your export is ready to download.", tone: "ok" },
  started: { message: "Your export has started. It usually takes a minute or two; reload this page to see it.", tone: "ok" },
  open: { message: "An export is already being made. It shows here when it's ready.", tone: "error" },
  limit: { message: "That's a lot of exports for one day. Try again tomorrow.", tone: "error" },
  off: { message: "Exports aren't available right now. Please write to support and we'll make one for you.", tone: "error" },
  none: { message: "There's no OpenPing on this account to export.", tone: "error" },
};

function exportRow(e: TenantExport, now: number): Html {
  const when = dateText(e.createdAt);
  const why = e.reason === "deletion" ? "Made before deletion" : "Your export";
  if (e.state === "done" && e.expiresAt && e.expiresAt > now) {
    return html`<li><div class="what"><strong>${why}, ${when}</strong><span>${sizeText(e.bytes)}, kept until ${dateText(e.expiresAt)}</span></div>
<div class="row-actions"><a class="button secondary small" href="/account/export/${e.id}/openping.sql" download>Database</a><a class="button secondary small" href="/account/export/${e.id}/README.md" download>Steps</a>
<form method="post" action="/account/export/${e.id}/key"><button class="button secondary small" type="submit">Key</button></form></div></li>`;
  }
  const state = e.state === "failed" ? "Didn't finish; we've been told" : e.state === "done" ? "No longer kept" : "Being made";
  return html`<li><div class="what"><strong>${why}, ${when}</strong><span>${state}</span></div></li>`;
}

function exportPage(input: { slug: string | null; exports: TenantExport[]; flash: { message: string; tone: "ok" | "error" } | null; now: number; canStart: boolean }): Response {
  const done = input.exports.some((e) => e.state === "done" && e.expiresAt && e.expiresAt > input.now);
  return renderPage({
    title: "Take your OpenPing with you",
    wide: true,
    homeHref: "/account",
    style: `.row-actions { display: flex; gap: 8px; flex: none; } .row-actions .button { width: auto; }
@media (max-width: 479px) { ul.exports li { flex-direction: column; align-items: stretch; } .row-actions .button { flex: 1; } }
ol.steps { padding-left: 20px; } ol.steps li { margin: 0 0 6px; } .back-link { margin: 20px 0 0; } ul.exports { margin-bottom: 16px; }`,
    main: html`<h1>Take your OpenPing with you</h1>
<p class="lead">Download everything in ${input.slug ? html`<strong>${input.slug}</strong>` : "your OpenPing"} and run it on your own Cloudflare account, free, with the same open-source OpenPing.</p>
${input.flash ? notice(input.flash.message, input.flash.tone) : ""}
<section><h2>Your exports</h2>
${input.exports.length ? html`<ul class="rows exports">${input.exports.map((e) => exportRow(e, input.now))}</ul>` : html`<p>None yet.</p>`}
${
  input.canStart
    ? html`<form method="post" action="/account/export"><div class="stack"><button class="button primary" type="submit">Make an export</button></div></form>
<p class="hint">Your OpenPing keeps running while it's made. Each export is kept for 7 days.</p>`
    : ""
}</section>
${
  done
    ? html`<section><h2>Your key</h2>
<p>Passwords, tokens and webhook URLs in the database are encrypted with your OpenPing's key. You need it to read them on your own install; keep it in your password manager, apart from the download. Each export's <strong>Key</strong> button shows the key that export needs, for as long as the export is kept.</p>
<p class="hint">We ask you to sign in again first (with your passkey, if you have one) if you signed in more than 15 minutes ago, and we email you each time it's shown.</p></section>
<section><h2>The steps</h2><ol class="steps">
<li>Download the database and the steps above.</li>
<li>Make a database in your Cloudflare account and load the export into it.</li>
<li>Set your key, deploy OpenPing, and sign in on your new address.</li>
</ol><p class="hint">The steps file has every command.</p></section>`
    : ""
}
<p class="back-link"><a href="/account">Back to your account</a></p>`,
  });
}

export function accountExportRoutes(deps: AccountExportDeps): Hono<Env> {
  const app = new Hono<Env>();
  const clock = deps.now ?? Date.now;

  app.use("*", async (c, next) => {
    c.set("now", clock());
    const session = await readSession(c.env.PLATFORM_DB, c.req.raw, c.get("now"));
    if (!session) return seeOther("/sign-in?next=%2Faccount%2Fexport");
    c.set("session", session);
    if (c.req.method !== "GET" && c.req.method !== "HEAD") {
      const from = c.req.header("origin");
      const own = new URL(c.req.url).origin;
      const ok = from && from !== "null" ? from === own : c.req.header("sec-fetch-site") === "same-origin";
      if (!ok) return c.json({ error: "forbidden", message: "This request didn't come from OpenPing Hosted." }, 403, NO_STORE);
    }
    await next();
  });

  app.get("/", async (c) => {
    const db = c.env.PLATFORM_DB;
    const account = c.get("session")!.account;
    const [tenant, exports] = await Promise.all([accountTenant(db, account.id), accountExports(db, account.id)]);
    // "Started" turns into "ready" once the newest one is done.
    const done = c.req.query("done") === "started" && exports[0]?.state === "done" ? "ready" : (c.req.query("done") ?? "");
    const res = exportPage({
      slug: tenant?.slug ?? exports[0]?.slug ?? null,
      exports,
      flash: FLASH[done] ?? null,
      now: c.get("now"),
      canStart: tenant?.provision_state === "ready",
    });
    res.headers.set("cache-control", "no-store");
    return res;
  });

  app.post("/", async (c) => {
    const db = c.env.PLATFORM_DB;
    const account = c.get("session")!.account;
    const tenant = await accountTenant(db, account.id);
    if (!tenant || tenant.provision_state !== "ready") return seeOther("/account/export?done=none");
    const exportDeps = deps.exports(c.env);
    if (!exportDeps) return seeOther("/account/export?done=off");
    const open = await db.prepare("SELECT 1 AS x FROM tenant_exports WHERE tenant_id = ? AND state IN ('requested', 'exporting')").bind(tenant.id).first();
    if (open) return seeOther("/account/export?done=open");
    if (await hitInOrder(db, [[LIMITS.exportPerAccount, account.id]], c.get("now"))) return seeOther("/account/export?done=limit");
    const id = await requestExport(db, { tenantId: tenant.id, accountId: account.id, slug: tenant.slug, reason: "self_host", now: c.get("now") });
    await audit(db, { accountId: account.id, tenantId: tenant.id, actor: "customer", action: "tenant.export_requested", detail: { export: id }, now: c.get("now") });
    // Started now; the cron finishes it if this runs out of time.
    c.executionCtx.waitUntil(
      advanceExport({ ...exportDeps, db, now: clock }, id, {
        tenantUrl: requestTenantOrigin(c.req.url, tenant.slug, c.env.HOSTED_DOMAIN),
        accountUrl: `${appOrigin(c.env.HOSTED_DOMAIN)}/account/export`,
      }).catch((error) => log.error("export.first_run_failed", { export: id, error })),
    );
    return seeOther("/account/export?done=started");
  });

  app.get("/:id/:file", async (c) => {
    const id = c.req.param("id");
    const file = c.req.param("file") as keyof typeof FILES;
    const account = c.get("session")!.account;
    const exp = EXPORT_ID.test(id) && file in FILES ? await getExport(c.env.PLATFORM_DB, id) : null;
    // Another account's export is the same "not found" as none at all.
    const notFound = () => messagePage({ title: "Not found", body: "There's no such export on your account.", status: 404, action: { href: "/account/export", label: "Your exports" } });
    if (!exp || exp.accountId !== account.id || exp.state !== "done" || !exp.r2Prefix || (exp.expiresAt ?? 0) <= c.get("now")) return notFound();
    const bucket = deps.exports(c.env)?.bucket;
    const object = bucket ? await bucket.get(`${exp.r2Prefix}${file}`) : null;
    if (!object) return notFound();
    const day = new Date(exp.createdAt).toISOString().slice(0, 10);
    const name = file === "README.md" ? `openping-${exp.slug}-${day}-steps.md` : `openping-${exp.slug}-${day}.sql`;
    return new Response(object.body, {
      headers: {
        "content-type": FILES[file],
        "content-disposition": `attachment; filename="${name}"`,
        "x-content-type-options": "nosniff",
        ...NO_STORE,
      },
    });
  });

  // The key of one export: the one its encrypted values are sealed with,
  // kept with it (export_keys), so it still opens after the tenant is gone.
  app.post("/:id/key", async (c) => {
    const db = c.env.PLATFORM_DB;
    const session = c.get("session")!;
    const now = c.get("now");
    const id = c.req.param("id");
    const exp = EXPORT_ID.test(id) ? await getExport(db, id) : null;
    if (!exp || exp.accountId !== session.account.id || exp.state !== "done" || (exp.expiresAt ?? 0) <= now) {
      return messagePage({ title: "Not found", body: "There's no such export on your account.", status: 404, action: { href: "/account/export", label: "Your exports" } });
    }
    // With a passkey on the account, only a passkey sign-in counts: an inbox alone mustn't open the key.
    const hasPasskey = await db.prepare("SELECT 1 AS x FROM account_identities WHERE account_id = ? AND kind = 'passkey' LIMIT 1").bind(session.account.id).first();
    const fresh = now - session.createdAt <= KEY_REVEAL_FRESH_MS && (!hasPasskey || session.method === "passkey");
    if (!fresh) {
      return messagePage({
        title: "Sign in again first",
        body: hasPasskey
          ? "Your key opens everything in your OpenPing, so we ask for a sign-in with your passkey from the last 15 minutes before showing it."
          : "Your key opens everything in your OpenPing, so we ask for a sign-in from the last 15 minutes before showing it.",
        status: 401,
        action: { href: "/sign-in?next=%2Faccount%2Fexport", label: "Sign in again" },
      });
    }
    const escrowed = await db.prepare("SELECT tenant_id, kid, ciphertext FROM export_keys WHERE export_id = ?").bind(exp.id).first<{ tenant_id: string; kid: string; ciphertext: string }>();
    if (!escrowed || !c.env.PLATFORM_KEY) {
      return messagePage({ title: "No key to show", body: "We don't hold a key for this export.", status: 404, action: { href: "/account/export", label: "Back" } });
    }
    const tenant = { id: escrowed.tenant_id, slug: exp.slug };
    if (await hitInOrder(db, [[LIMITS.keyRevealPerAccount, session.account.id]], now)) {
      return messagePage({ title: "Try again tomorrow", body: "Your key has been shown several times today already.", status: 429, action: { href: "/account/export", label: "Back" } });
    }
    const key = await openEscrowedKey({ kid: escrowed.kid, ciphertext: escrowed.ciphertext }, tenant.id, c.env.PLATFORM_KEY);
    // Recorded before it is shown; and the inbox hears of it, like a new passkey.
    await audit(db, { accountId: session.account.id, tenantId: tenant.id, actor: "customer", action: "tenant.master_key_revealed", detail: { kid: escrowed.kid, export: exp.id }, now });
    const mailer = deps.mailer(c.env);
    if (mailer) {
      const sent = await mailer.send({
        to: session.account.email,
        ...keyRevealedEmail({ at: now, exportUrl: `${appOrigin(c.env.HOSTED_DOMAIN)}/account/export` }),
        category: "key_revealed",
        tenantId: tenant.id,
        replyTo: PLATFORM_REPLY_TO,
      });
      if (!sent.ok) log.error("export.key_notice_not_sent", { error: sent.error });
    }
    const res = renderPage({
      title: "Your key",
      homeHref: "/account",
      style: `.key + .hint { margin: 8px 0 20px; } .key { display: block; padding: 12px 14px; border: 1px solid var(--line); border-radius: 0.5rem; background: var(--canvas); font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.9375rem; overflow-wrap: anywhere; user-select: all; }`,
      main: html`<h1>Your key</h1>
<p class="lead">This is the <code>MASTER_KEY</code> of ${tenant.slug}. Copy it into your password manager now; it isn't shown again unless you ask.</p>
<code class="key">${key}</code>
<p class="hint">On your own install, set it with <code>npx wrangler secret put MASTER_KEY</code>, then rotate it once everything works (the steps file says how).</p>
<div class="stack"><a class="button secondary" href="/account/export">Back to your exports</a></div>`,
    });
    res.headers.set("cache-control", "no-store");
    res.headers.set("referrer-policy", "no-referrer");
    return res;
  });

  return app;
}
