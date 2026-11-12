import pkg from "../../../package.json";
import type { Env } from "../types";

/**
 * How OpenPing's checker names itself on every request it makes for a monitor:
 * the HTTP check (and its keyword / JSON assertions), the redirect hops, the
 * second-region re-check, the "Is it down?" tool, the DNS and certificate
 * checks' resolver lookups, the domain check's RDAP lookups and the site-icon
 * fetcher.
 *
 * A request with no User-Agent at all looks like a broken script, and firewalls
 * treat it so: a Cloudflare custom rule challenging nameless clients turned
 * every HTTP monitor on such a zone into a 403 (2026-11-11). Naming the checker
 * and linking to a page that explains it (/bot, routes/bot.ts) lets a site
 * owner recognise the traffic and allow it.
 *
 * A self-hoster can name their own install with the CHECKER_USER_AGENT var.
 * A monitor's own User-Agent header (set in its request headers) still wins
 * for that monitor.
 */

/** The page that explains the checker, on the project's own site. */
export const BOT_INFO_URL = "https://openping.n8builds.dev/bot";

export const DEFAULT_CHECKER_USER_AGENT = `OpenPing/${pkg.version} (+${BOT_INFO_URL})`;

/** Longest CHECKER_USER_AGENT accepted; longer ones fall back to the default. */
const MAX_LENGTH = 256;

/** Visible ASCII and spaces only: anything else could break or split the header. */
const VALID_HEADER_VALUE = /^[\x20-\x7e]+$/;

/**
 * The User-Agent this install's checker sends: CHECKER_USER_AGENT when it is a
 * usable header value, else the default. Never empty, so a check never goes out
 * nameless.
 */
export function checkerUserAgent(env?: Pick<Env, "CHECKER_USER_AGENT"> | null): string {
  const configured = env?.CHECKER_USER_AGENT?.trim();
  if (!configured) return DEFAULT_CHECKER_USER_AGENT;
  if (configured.length > MAX_LENGTH || !VALID_HEADER_VALUE.test(configured)) {
    console.warn("[user-agent] CHECKER_USER_AGENT is not a usable header value; using the default");
    return DEFAULT_CHECKER_USER_AGENT;
  }
  return configured;
}
