/**
 * Which part of the platform a request is for, from its hostname alone.
 *
 *   app.<domain>        the platform's own pages (sign-up, account, billing)
 *   <domain>, www.<d>   redirected to app.<domain>
 *   <slug>.<domain>     a customer's OpenPing, dispatched to its user Worker
 *   anything else       not ours: a plain 404
 *
 * Only one label is allowed before the domain, so `a.b.<domain>` is not a
 * tenant (Universal SSL covers one level only, decision D2).
 */

export type HostRoute =
  | { kind: "app" }
  | { kind: "apex" }
  | { kind: "tenant"; slug: string }
  | { kind: "unknown" };

/** Lowercases and drops a trailing dot, so `App.Example.com.` and `app.example.com` match. */
export function normalizeHost(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/\.$/, "");
}

export function classifyHost(hostname: string, hostedDomain: string): HostRoute {
  const host = normalizeHost(hostname);
  const domain = normalizeHost(hostedDomain);
  if (!domain) return { kind: "unknown" };
  if (host === `app.${domain}`) return { kind: "app" };
  if (host === domain || host === `www.${domain}`) return { kind: "apex" };
  const suffix = `.${domain}`;
  if (!host.endsWith(suffix)) return { kind: "unknown" };
  const label = host.slice(0, -suffix.length);
  if (!label || label.includes(".")) return { kind: "unknown" };
  return { kind: "tenant", slug: label };
}

/** The platform's own origin, `https://app.<domain>`. */
export function appOrigin(hostedDomain: string): string {
  return `https://app.${normalizeHost(hostedDomain)}`;
}

/** A tenant's public origin, `https://<slug>.<domain>`. */
export function tenantOrigin(slug: string, hostedDomain: string): string {
  return `https://${slug}.${normalizeHost(hostedDomain)}`;
}

/**
 * The platform's origin as the browser sees it: `https://app.<domain>` in
 * production, the request's own origin in local development (plain http).
 */
export function requestAppOrigin(requestUrl: string, hostedDomain: string): string {
  const url = new URL(requestUrl);
  return url.protocol === "https:" ? appOrigin(hostedDomain) : url.origin;
}

/** A tenant's origin as the browser sees it, the same way as requestAppOrigin. */
export function requestTenantOrigin(requestUrl: string, slug: string, hostedDomain: string): string {
  const url = new URL(requestUrl);
  if (url.protocol === "https:") return tenantOrigin(slug, hostedDomain);
  return `${url.protocol}//${slug}.${url.host.replace(/^app\./, "")}`;
}
