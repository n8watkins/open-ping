/**
 * Best-effort SSRF protection for outbound HTTP checks (PRD §19).
 *
 * Cloudflare Workers cannot perform DNS resolution at validation time, so this
 * guard is intentionally conservative and string/literal-based: it rejects
 * non-http(s) schemes, embedded credentials, loopback/`.local` hostnames, cloud
 * metadata endpoints, and IP literals that fall inside private/reserved ranges.
 * A determined attacker can still point a public DNS name at an internal address
 * (DNS rebinding); that residual risk is documented and accepted in the PRD.
 *
 * Pure functions only: no I/O, no Node APIs, relies on the global `URL`.
 */

export type SsrfResult = { ok: true; url: URL } | { ok: false; reason: string };

/** IPv4 CIDR ranges that must never be reached from a check. */
const BLOCKED_IPV4_CIDRS: ReadonlyArray<readonly [string, number]> = [
  ["0.0.0.0", 8], // "this" network
  ["10.0.0.0", 8], // RFC1918 private
  ["100.64.0.0", 10], // RFC6598 CGNAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local (incl. cloud metadata)
  ["172.16.0.0", 12], // RFC1918 private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.168.0.0", 16], // RFC1918 private
  ["198.18.0.0", 15], // benchmarking
];

/** Parse a dotted-quad IPv4 string into a uint32, or null if not a valid IPv4. */
function ipv4ToUint32(host: string): number | null {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  let result = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    result = result * 256 + n;
  }
  return result >>> 0;
}

/** True if `ipUint` falls within `baseStr`/`bits`. */
function cidrContains(ipUint: number, baseStr: string, bits: number): boolean {
  const base = ipv4ToUint32(baseStr);
  if (base === null) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return ((ipUint & mask) >>> 0) === ((base & mask) >>> 0);
}

/** True if `host` is a syntactically valid dotted-quad IPv4 literal. */
export function isIPv4(host: string): boolean {
  return ipv4ToUint32(host) !== null;
}

/** True if `host` is an IPv4 literal inside a blocked/private range. */
export function isBlockedIPv4(host: string): boolean {
  const ip = ipv4ToUint32(host);
  if (ip === null) return false;
  return BLOCKED_IPV4_CIDRS.some(([base, bits]) => cidrContains(ip, base, bits));
}

/**
 * Prefix/string-based IPv6 denylist. Accepts the literal with or without the
 * surrounding `[ ]` and any `%zone` suffix. Covers loopback (::1), unspecified
 * (::), ULA (fc00::/7), link-local (fe80::/10), and IPv4-mapped (::ffff:<v4>)
 * addresses that map onto a blocked IPv4 range.
 */
export function isBlockedIPv6(host: string): boolean {
  let h = host.toLowerCase();
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  const zone = h.indexOf("%");
  if (zone !== -1) h = h.slice(0, zone);

  if (h === "::1") return true; // loopback
  if (h === "::") return true; // unspecified
  if (h.startsWith("fc") || h.startsWith("fd")) return true; // fc00::/7 ULA
  if (/^fe[89ab]/.test(h)) return true; // fe80::/10 link-local

  // IPv4-mapped, dotted form: ::ffff:a.b.c.d
  const dotted = h.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (dotted) return isBlockedIPv4(dotted[1]);

  // IPv4-mapped, hex form (how WHATWG serializes it): ::ffff:wwww:xxxx
  const hex = h.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    const v4 = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
    return isBlockedIPv4(v4);
  }

  return false;
}

/**
 * Validate an outbound URL before it is fetched. Returns `{ ok: true, url }`
 * with the parsed URL on success, or `{ ok: false, reason }` with a short
 * machine-readable reason on rejection.
 */
export function assertSafeUrl(rawUrl: string): SsrfResult {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, reason: "invalid_url" };
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: "bad_scheme" };
  }

  if (url.username || url.password) {
    return { ok: false, reason: "embedded_credentials" };
  }

  const rawHost = url.hostname;
  if (!rawHost) {
    return { ok: false, reason: "invalid_host" };
  }
  const host = rawHost.toLowerCase();

  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local")
  ) {
    return { ok: false, reason: "loopback_host" };
  }

  // Cloud metadata: GCE name, or any encoding that normalizes to 169.254.169.254.
  const hostUint = ipv4ToUint32(host);
  if (
    host === "metadata.google.internal" ||
    (hostUint !== null && hostUint === ipv4ToUint32("169.254.169.254"))
  ) {
    return { ok: false, reason: "metadata_host" };
  }

  if (isIPv4(host) && isBlockedIPv4(host)) {
    return { ok: false, reason: "private_ipv4" };
  }

  // The WHATWG parser wraps IPv6 literals in brackets in `hostname`.
  if (rawHost.startsWith("[") && isBlockedIPv6(rawHost)) {
    return { ok: false, reason: "private_ipv6" };
  }

  return { ok: true, url };
}
