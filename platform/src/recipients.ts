/**
 * Who a customer's OpenPing may email (platform mail, build plan section 10:
 * per-tenant caps on email sends).
 *
 * Every tenant's mail goes out from the Hosted domain, so an address other
 * than the account's own email must first say yes: the first time a tenant
 * mails it, the platform sends it one confirmation email instead (a link to a
 * page with "Yes" and "No" buttons, so a mail scanner opening the link
 * confirms nothing), and refuses the tenant's email with a reason its channel
 * shows. Once confirmed, the address gets that tenant's mail; once declined,
 * it is never asked again. On every plan: a trial is where abuse would start,
 * and a paying customer confirms an address once.
 *
 * Confirmations are limited per tenant per day and per address (one email a
 * day at most), so a tenant can't use them to mail strangers either.
 */

import { Hono } from "hono";

import { randomToken, sha256hex } from "../../src/worker/lib/ids";
import { messagePage } from "./account-pages";
import { recipientConfirmEmail } from "./emails";
import type { PlatformEnv } from "./env";
import { appOrigin, tenantOrigin } from "./hosts";
import { PLATFORM_REPLY_TO, type Mailer } from "./mail";
import { html, renderPage } from "./ui";

/** A confirmation link works this long. */
export const CONFIRM_TTL_MS = 7 * 86_400_000;
/** An unconfirmed address is asked again at most this often. */
export const CONFIRM_RESEND_MS = 86_400_000;
/** Confirmation emails one tenant may cause per UTC day. */
export const CONFIRMS_PER_DAY = 10;

export type RecipientState = "own" | "confirmed" | "pending" | "declined" | "new";

/** Where an address stands for this tenant. The account's own email always may. */
export async function recipientState(db: D1Database, tenantId: string, accountEmail: string, address: string): Promise<RecipientState> {
  if (address === accountEmail.toLowerCase()) return "own";
  const row = await db
    .prepare("SELECT state FROM email_recipients WHERE tenant_id = ? AND address = ?")
    .bind(tenantId, address)
    .first<{ state: "pending" | "confirmed" | "declined" }>();
  return row?.state ?? "new";
}

/**
 * Asks `address` to confirm it wants this tenant's email: at most once a
 * day per address, and CONFIRMS_PER_DAY per tenant. Answers whether an email
 * went out.
 */
export async function requestConfirmation(
  input: { db: D1Database; mailer: Mailer; hostedDomain: string; now: number },
  tenant: { id: string; slug: string },
  address: string,
): Promise<boolean> {
  const { db, now } = input;
  const existing = await db
    .prepare("SELECT state, requested_at FROM email_recipients WHERE tenant_id = ? AND address = ?")
    .bind(tenant.id, address)
    .first<{ state: string; requested_at: number }>();
  if (existing && (existing.state !== "pending" || now - existing.requested_at < CONFIRM_RESEND_MS)) return false;
  const day = new Date(now).toISOString().slice(0, 10);
  const asked = await db
    .prepare("SELECT COUNT(*) AS n FROM email_recipients WHERE tenant_id = ? AND requested_day = ?")
    .bind(tenant.id, day)
    .first<{ n: number }>();
  if ((asked?.n ?? 0) >= CONFIRMS_PER_DAY) return false;
  const token = randomToken(32);
  await db
    .prepare(
      `INSERT INTO email_recipients (tenant_id, address, state, token_hash, requested_at, requested_day, expires_at)
       VALUES (?1, ?2, 'pending', ?3, ?4, ?5, ?6)
       ON CONFLICT (tenant_id, address) DO UPDATE SET token_hash = excluded.token_hash, requested_at = excluded.requested_at,
         requested_day = excluded.requested_day, expires_at = excluded.expires_at WHERE email_recipients.state = 'pending'`,
    )
    .bind(tenant.id, address, await sha256hex(token), now, day, now + CONFIRM_TTL_MS)
    .run();
  const sent = await input.mailer.send({
    to: address,
    ...recipientConfirmEmail({
      tenantUrl: tenantOrigin(tenant.slug, input.hostedDomain),
      confirmUrl: `${appOrigin(input.hostedDomain)}/email/confirm?t=${encodeURIComponent(token)}`,
    }),
    category: "recipient_confirm",
    tenantId: tenant.id,
    replyTo: PLATFORM_REPLY_TO,
  });
  if (!sent.ok) console.error("[mail] confirmation not sent", { tenant: tenant.id, error: sent.error });
  return sent.ok;
}

/** The plain sentence a refused recipient gets, which the tenant's channel shows. */
export function refusalMessage(state: RecipientState, address: string, asked: boolean): string {
  if (state === "declined") return `${address} asked not to get email from this OpenPing.`;
  return asked
    ? `${address} hasn't confirmed it wants email from this OpenPing yet; we've sent it a link to confirm.`
    : `${address} hasn't confirmed it wants email from this OpenPing yet; check its inbox for the link we sent.`;
}

async function pendingByToken(db: D1Database, token: string, now: number) {
  if (!token || token.length > 128) return null;
  return db
    .prepare(
      `SELECT r.tenant_id, r.address, t.slug FROM email_recipients r JOIN tenants t ON t.id = r.tenant_id
       WHERE r.token_hash = ? AND r.state = 'pending' AND r.expires_at > ?`,
    )
    .bind(await sha256hex(token), now)
    .first<{ tenant_id: string; address: string; slug: string }>();
}

const expired = () =>
  messagePage({ title: "This link has expired", body: "It was used already, or it's more than a week old. Nothing was changed.", status: 400 });

/** app.<domain>/email/confirm: the recipient says yes or no. */
export function recipientRoutes(deps: { now?: () => number } = {}): Hono<{ Bindings: PlatformEnv }> {
  const app = new Hono<{ Bindings: PlatformEnv }>();
  const now = deps.now ?? Date.now;

  app.get("/confirm", async (c) => {
    const token = c.req.query("t") ?? "";
    const row = await pendingByToken(c.env.PLATFORM_DB, token, now());
    if (!row) return expired();
    const res = renderPage({
      title: "Get email from this OpenPing?",
      main: html`<h1>Get email from this OpenPing?</h1>
<p class="lead">The OpenPing at <strong>${tenantOrigin(row.slug, c.env.HOSTED_DOMAIN).replace(/^https?:\/\//, "")}</strong> wants to send its alerts and reports to <strong>${row.address}</strong>.</p>
<form method="post" action="/email/confirm"><input type="hidden" name="t" value="${token}">
<div class="stack"><button class="button primary" type="submit" name="answer" value="yes">Yes, send them</button>
<button class="button secondary" type="submit" name="answer" value="no">No, never email me from it</button></div></form>
<p class="hint">You can stop them later by writing to support.</p>`,
    });
    res.headers.set("cache-control", "no-store");
    res.headers.set("referrer-policy", "no-referrer");
    return res;
  });

  app.post("/confirm", async (c) => {
    const from = c.req.header("origin");
    const own = new URL(c.req.url).origin;
    if (!(from && from !== "null" ? from === own : c.req.header("sec-fetch-site") === "same-origin")) {
      return c.json({ error: "forbidden", message: "This request didn't come from OpenPing Hosted." }, 403);
    }
    const body = (await c.req.parseBody().catch(() => ({}))) as Record<string, unknown>;
    const token = typeof body.t === "string" ? body.t : "";
    const yes = body.answer === "yes";
    const row = await pendingByToken(c.env.PLATFORM_DB, token, now());
    if (!row) return expired();
    await c.env.PLATFORM_DB.batch([
      c.env.PLATFORM_DB.prepare(
        "UPDATE email_recipients SET state = ?, token_hash = NULL, confirmed_at = ? WHERE tenant_id = ? AND address = ? AND state = 'pending'",
      ).bind(yes ? "confirmed" : "declined", now(), row.tenant_id, row.address),
      c.env.PLATFORM_DB.prepare(
        "INSERT INTO audit_events (at, account_id, tenant_id, actor, action, detail) VALUES (?, NULL, ?, 'system', ?, ?)",
      ).bind(now(), row.tenant_id, yes ? "email.recipient_confirmed" : "email.recipient_declined", JSON.stringify({ address: row.address })),
    ]);
    return messagePage(
      yes
        ? { title: "Confirmed", body: `${row.address} gets this OpenPing's email from now on. Its next alert goes out as usual.` }
        : { title: "You won't hear from it", body: `This OpenPing will never email ${row.address}.` },
    );
  });

  return app;
}
