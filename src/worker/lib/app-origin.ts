import type { Env } from "../types";
import { getSetting } from "../db/settings";

/**
 * The install's configured public origin (APP_URL, else the wizard's app_url
 * setting), or null when neither is a usable origin: https, or http only for
 * localhost and 127.0.0.1, with no embedded credentials.
 */
export async function configuredOrigin(env: Env): Promise<string | null> {
  const configured = env.APP_URL ?? (await getSetting(env, "app_url"));
  if (!configured) return null;
  try {
    const url = new URL(configured);
    if (
      (url.protocol === "https:" ||
        (url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1"))) &&
      !url.username &&
      !url.password
    ) {
      return url.origin;
    }
  } catch {
    // Invalid legacy setting: fall back rather than emit it.
  }
  return null;
}

/**
 * The origin to build sign-in links, OAuth callbacks and the passkey relying
 * party from: the configured origin, else the request's own. The request
 * fallback derives from the Host header, so setup /complete requires a
 * configured origin and a finished install never depends on it.
 */
export async function appOrigin(c: { env: Env; req: { url: string } }): Promise<string> {
  return (await configuredOrigin(c.env)) ?? new URL(c.req.url).origin;
}
