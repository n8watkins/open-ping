/**
 * Turning what someone types into an install's origin. The native side checks
 * the result again (Origins.java) before anything loads.
 */

export type AddressResult =
  | { ok: true; origin: string }
  | { ok: false; reason: "empty" | "not_https" | "invalid" };

/**
 * `openping.example.com`, `https://openping.example.com/login` and
 * ` OpenPing.Example.com/ ` all become `https://openping.example.com`.
 * Only https: an install's sessions and passkeys need it, and the app never
 * loads plain http.
 */
export function normalizeAddress(input: string): AddressResult {
  const text = input.trim();
  if (!text) return { ok: false, reason: "empty" };
  if (/^http:\/\//i.test(text)) return { ok: false, reason: "not_https" };
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return { ok: false, reason: "invalid" };
  }
  if (url.protocol !== "https:") return { ok: false, reason: "not_https" };
  if (url.username || url.password) return { ok: false, reason: "invalid" };
  const host = url.hostname;
  // A real address has a dot (or is an IPv6 literal); "localhost" and bare
  // names can't have a public certificate.
  if (!host || (!host.includes(".") && !host.startsWith("["))) return { ok: false, reason: "invalid" };
  if (host.startsWith(".") || host.endsWith(".") || host.includes("..")) return { ok: false, reason: "invalid" };
  return { ok: true, origin: url.origin };
}

/** A Hosted customer's address from their OpenPing's name (`acme` -> `https://acme.<domain>`). */
export function hostedOrigin(slug: string, hostedDomain: string): AddressResult {
  const name = slug.trim().toLowerCase().replace(new RegExp(`\\.${escapeRegExp(hostedDomain)}$`), "");
  if (!name) return { ok: false, reason: "empty" };
  // The platform's slugs: a letter, then letters, digits and hyphens, 2 to 30 (platform/src/slugs.ts).
  if (!/^[a-z][a-z0-9-]{1,29}$/.test(name)) return { ok: false, reason: "invalid" };
  return { ok: true, origin: `https://${name}.${hostedDomain}` };
}

/** The host to show for an origin: `openping.example.com`. */
export function hostOf(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
