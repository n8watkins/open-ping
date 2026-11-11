import type { Env } from "../types";

/**
 * Cloudflare Turnstile on the Hosted waitlist form, checked on the server.
 *
 * Both keys are runtime Worker settings (TURNSTILE_SITE_KEY, a var or a secret,
 * and TURNSTILE_SECRET_KEY, a secret), so turning it on needs no rebuild. It is
 * skipped only when both are unset. With the secret set it fails closed: a
 * missing token, a network error or anything but `success: true` refuses the
 * request. With only one of the two set it is also on, and refuses everything,
 * so a half-done setup can't quietly leave the form open.
 */

const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
/** A Turnstile token is far shorter than this; it bounds what we forward. */
const MAX_TOKEN_LENGTH = 2048;

type Keys = Pick<Env, "TURNSTILE_SITE_KEY" | "TURNSTILE_SECRET_KEY">;

/** Whether either key is set, which switches the check on. */
export function turnstileRequired(env: Keys): boolean {
  return !!(env.TURNSTILE_SITE_KEY?.trim() || env.TURNSTILE_SECRET_KEY?.trim());
}

/** The site key the form renders its widget with; null when Turnstile is off or half set up. */
export function turnstileSiteKey(env: Keys): string | null {
  const site = env.TURNSTILE_SITE_KEY?.trim();
  return site && env.TURNSTILE_SECRET_KEY?.trim() ? site : null;
}

/** True when the visitor passed, or Turnstile is off. */
export async function verifyTurnstile(env: Keys, token: string | undefined, ip: string | undefined): Promise<boolean> {
  if (!turnstileRequired(env)) return true;
  const secret = env.TURNSTILE_SECRET_KEY?.trim();
  if (!secret || !env.TURNSTILE_SITE_KEY?.trim()) return false;
  if (!token || token.length > MAX_TOKEN_LENGTH) return false;
  const body = new FormData();
  body.set("secret", secret);
  body.set("response", token);
  if (ip && ip !== "unknown") body.set("remoteip", ip);
  body.set("idempotency_key", crypto.randomUUID());
  try {
    const res = await fetch(SITEVERIFY, { method: "POST", body, signal: AbortSignal.timeout(8000) });
    if (!res.ok) return false;
    const result = (await res.json()) as { success?: unknown };
    return result.success === true;
  } catch {
    return false;
  }
}
