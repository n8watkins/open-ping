import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../types";
import { randomToken, sha256hex } from "../lib/ids";
import { isAllowedEmail } from "../lib/admin";
import { createSession } from "../lib/sessions";
import { getSetting } from "../db/settings";
import { sendResendEmail } from "../notifications/channels/resend";

/**
 * Email magic-link authentication (PRD §13): the optional fallback to GitHub
 * OAuth for the single administrator. Mirrors routes/auth.ts in style.
 *
 * No-disclosure rule: POST /request ALWAYS responds { ok: true } whether or not
 * the address is allowlisted, the link was rate-limited, or Resend is even
 * configured — so the endpoint can never be probed to discover the admin email.
 *
 * As with sessions/OAuth state, only the SHA-256 of the raw token is persisted;
 * the raw token lives only in the emailed link.
 */
export const magicApi = new Hono<AppEnv>();
export const magicFlow = new Hono<AppEnv>();

type Ctx = Context<AppEnv>;

const TOKEN_TTL_MS = 1000 * 60 * 15; // 15 minutes
const COOLDOWN_MS = 1000 * 60; // 60s between sends to one address
const DEFAULT_FROM = "OpenPing <onboarding@resend.dev>";
const SUBJECT = "Your OpenPing sign-in link";

const requestSchema = z.object({ email: z.string().email() });

/**
 * Resolve the public base URL (env > settings > request origin), no trailing
 * slash. The request-origin fallback derives from the spoofable Host header;
 * setup /complete now requires app_url (env or settings) so a completed
 * deployment builds single-use magic links from a configured base, not the
 * caller-controlled Host.
 */
async function baseUrl(c: Ctx): Promise<string> {
  const configured = c.env.APP_URL ?? (await getSetting(c.env, "app_url"));
  const base = configured ?? new URL(c.req.url).origin;
  return base.replace(/\/$/, "");
}

// c.redirect (NOT Response.redirect) so any Set-Cookie on c.res survives — see
// the same note in routes/auth.ts.
function loginRedirect(c: Ctx, base: string, error?: string): Response {
  const url = error ? `${base}/login?error=${encodeURIComponent(error)}` : `${base}/login`;
  return c.redirect(url, 302);
}

/**
 * Pure rate-limit predicate: true if a previous token was created recently
 * enough that we should suppress issuing/sending another one.
 */
export function isWithinCooldown(
  lastCreatedAt: number | null,
  now: number,
  cooldownMs: number = COOLDOWN_MS,
): boolean {
  return lastCreatedAt != null && now - lastCreatedAt < cooldownMs;
}

/**
 * Pure single-use validity predicate for the row returned by the atomic
 * `DELETE ... RETURNING` consume in /verify: the token is usable only if a row
 * actually came back (i.e. THIS request won the consume race) and it has not
 * expired. A type guard so callers narrow the consumed row to non-null.
 */
export function isConsumedTokenValid<T extends { expires_at: number }>(
  row: T | null,
  now: number,
): row is T {
  return row !== null && row.expires_at > now;
}

function magicEmailBody(link: string): { html: string; text: string } {
  const html = `<!doctype html>
<html>
  <body style="font-family: -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; color: #111;">
    <p>Click the button below to sign in to OpenPing. This link expires in 15 minutes and can be used once.</p>
    <p>
      <a href="${link}"
         style="display:inline-block;padding:12px 20px;background:#2563eb;color:#fff;text-decoration:none;border-radius:6px;font-weight:600;">
        Sign in to OpenPing
      </a>
    </p>
    <p style="color:#555;font-size:13px;">If the button doesn't work, copy and paste this URL into your browser:<br>
      <a href="${link}">${link}</a>
    </p>
    <p style="color:#555;font-size:13px;">If you didn't request this, you can safely ignore this email.</p>
  </body>
</html>`;
  const text = [
    "Sign in to OpenPing.",
    "",
    "Open this link to sign in (expires in 15 minutes, single use):",
    link,
    "",
    "If you didn't request this, you can safely ignore this email.",
  ].join("\n");
  return { html, text };
}

// --- JSON API (mounted at /api/auth/magic) ---
magicApi.post("/request", async (c) => {
  const body = await c.req.json().catch(() => undefined);
  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "validation", issues: parsed.error.issues }, 400);
  }
  const email = parsed.data.email.trim().toLowerCase();

  // Everything past validation is best-effort and must never disclose whether
  // `email` is the administrator — neither by body (always { ok: true }) nor by
  // TIMING. The token issue + email send (which includes a network round-trip
  // for allowed addresses only) is deferred to ctx.waitUntil so the response
  // returns before that work runs, leaving no latency oracle to probe.
  const issueAndSend = async () => {
    if (!(await isAllowedEmail(c.env, email))) return;
    const data = JSON.stringify({ email });

    // Rate-limit: suppress if an unused link was issued for this address recently.
    const recent = await c.env.DB.prepare(
      `SELECT created_at FROM auth_tokens
         WHERE kind = 'magic_link' AND data = ? AND used_at IS NULL
         ORDER BY created_at DESC LIMIT 1`,
    )
      .bind(data)
      .first<{ created_at: number }>();

    if (!isWithinCooldown(recent?.created_at ?? null, Date.now())) {
      const raw = randomToken(32);
      const now = Date.now();
      await c.env.DB.prepare(
        `INSERT INTO auth_tokens (id, kind, data, created_at, expires_at)
         VALUES (?, 'magic_link', ?, ?, ?)`,
      )
        .bind(await sha256hex(raw), data, now, now + TOKEN_TTL_MS)
        .run();

      const base = await baseUrl(c);
      const link = `${base}/auth/magic/verify?token=${raw}`;
      const from = (await getSetting(c.env, "email_from")) || DEFAULT_FROM;
      const { html, text } = magicEmailBody(link);
      // Ignore the result: a not-configured / failed send must not leak either.
      await sendResendEmail(c.env, { from, to: email, subject: SUBJECT, html, text });
    }
  };

  const task = issueAndSend().catch(() => {});
  try {
    c.executionCtx.waitUntil(task);
  } catch {
    // No execution context (e.g. unit tests) — run inline as a fallback.
    await task;
  }

  return c.json({ ok: true });
});

// --- Browser redirect flow (mounted at /auth/magic) ---
magicFlow.get("/verify", async (c) => {
  const base = await baseUrl(c);
  const token = c.req.query("token");
  if (!token) return loginRedirect(c, base,"magic_invalid");

  const id = await sha256hex(token);
  // Single-use, atomically: DELETE ... RETURNING claims the row in one
  // statement, so two concurrent verifies of the same link can't both read it
  // as unused and each mint a session — only the request whose DELETE returns a
  // row proceeds. Consumption is the DELETE itself, so the legacy `used_at`
  // column it used to also check is dead and intentionally dropped here.
  const row = await c.env.DB.prepare(
    `DELETE FROM auth_tokens WHERE id = ? AND kind = 'magic_link' RETURNING data, expires_at`,
  )
    .bind(id)
    .first<{ data: string | null; expires_at: number }>();

  if (!isConsumedTokenValid(row, Date.now())) {
    return loginRedirect(c, base,"magic_invalid");
  }

  let email: string | undefined;
  try {
    email = (JSON.parse(row.data ?? "{}") as { email?: string }).email;
  } catch {
    email = undefined;
  }
  if (!email || !(await isAllowedEmail(c.env, email))) {
    return loginRedirect(c, base,"not_authorized");
  }

  // Rotate: a fresh session is issued on every login.
  await createSession(c, email, "email");
  return c.redirect(`${base}/`, 302);
});
