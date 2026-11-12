import type { Env } from "../types";

/**
 * Cloudflare Turnstile on the Hosted waitlist form, checked on the server.
 *
 * Both keys are runtime Worker settings (TURNSTILE_SITE_KEY, a var or a secret,
 * and TURNSTILE_SECRET_KEY, a secret), so turning it on needs no rebuild. It
 * fails closed everywhere: with a key missing (one or both) every request is
 * refused, so a half-done or forgotten setup can never quietly leave the form
 * open. The only way to run without Turnstile is the explicit opt-out
 * `TURNSTILE=off` (docs/INSTALL.md), for self-hosted installs and local dev.
 * With the keys set, a missing token, a network error or anything but
 * `success: true` refuses the request, and so does a hostname outside
 * TURNSTILE_HOSTNAMES when that list is set.
 */

const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
/** A Turnstile token is far shorter than this; it bounds what we forward. */
const MAX_TOKEN_LENGTH = 2048;

type Keys = Pick<Env, "TURNSTILE" | "TURNSTILE_SITE_KEY" | "TURNSTILE_SECRET_KEY" | "TURNSTILE_HOSTNAMES">;

/** Whether the check runs: always, unless the install explicitly opted out with TURNSTILE=off. */
export function turnstileRequired(env: Keys): boolean {
  return env.TURNSTILE?.trim().toLowerCase() !== "off";
}

/** The site key the form renders its widget with; null when Turnstile is opted out or half set up. */
export function turnstileSiteKey(env: Keys): string | null {
  if (!turnstileRequired(env)) return null;
  const site = env.TURNSTILE_SITE_KEY?.trim();
  return site && env.TURNSTILE_SECRET_KEY?.trim() ? site : null;
}

/** True when the visitor passed, or the install opted out with TURNSTILE=off. */
export async function verifyTurnstile(env: Keys, token: string | undefined, ip: string | undefined): Promise<boolean> {
  if (!turnstileRequired(env)) return true;
  const secret = env.TURNSTILE_SECRET_KEY?.trim();
  if (!secret || !env.TURNSTILE_SITE_KEY?.trim()) {
    console.error(JSON.stringify({ event: "turnstile_not_configured", hint: "set TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY, or TURNSTILE=off to opt out" }));
    return false;
  }
  if (!token || token.length > MAX_TOKEN_LENGTH) return false;
  const body = new FormData();
  body.set("secret", secret);
  body.set("response", token);
  if (ip && ip !== "unknown") body.set("remoteip", ip);
  body.set("idempotency_key", crypto.randomUUID());
  try {
    const res = await fetch(SITEVERIFY, { method: "POST", body, signal: AbortSignal.timeout(8000) });
    if (!res.ok) return false;
    const result = (await res.json()) as { success?: unknown; hostname?: unknown };
    if (result.success !== true) return false;
    const allowed = (env.TURNSTILE_HOSTNAMES ?? "")
      .split(",")
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean);
    return allowed.length === 0 || (typeof result.hostname === "string" && allowed.includes(result.hostname.toLowerCase()));
  } catch {
    return false;
  }
}
