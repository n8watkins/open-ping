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
  ["192.0.2.0", 24], // TEST-NET-1 documentation
  ["192.88.99.0", 24], // deprecated 6to4 relay anycast
  ["192.168.0.0", 16], // RFC1918 private
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // TEST-NET-2 documentation
  ["203.0.113.0", 24], // TEST-NET-3 documentation
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved/future use (incl. 255.255.255.255 broadcast)
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
  if (h.startsWith("ff")) return true; // ff00::/8 multicast
  if (h.startsWith("2001:db8:")) return true; // documentation prefix
  if (/^2001:(?:0{1,4}:|:)/.test(h)) return true; // Teredo transition range
  // fe80::/10 link-local (fe80–febf) plus deprecated fec0::/10 site-local
  // (fec0–feff); together they fill fe80::/9, none of which is publicly routable.
  if (/^fe[89a-f]/.test(h)) return true;

  // IPv4-mapped, dotted form: ::ffff:a.b.c.d
  // (Capture groups are non-null asserted: a successful match guarantees them.)
  const mappedDotted = h.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mappedDotted) return isBlockedIPv4(mappedDotted[1]!);

  // IPv4-mapped, hex form (how WHATWG serializes it): ::ffff:wwww:xxxx
  const mappedHex = h.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mappedHex) return isBlockedIPv4(hextetsToV4(mappedHex[1]!, mappedHex[2]!));

  // IPv4-compatible (deprecated): ::a.b.c.d / ::wwww:xxxx (high 96 bits zero).
  // `::` and `::1` are already handled above, so a remaining `::x:y` embeds a v4.
  const compatDotted = h.match(/^::(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (compatDotted) return isBlockedIPv4(compatDotted[1]!);
  const compatHex = h.match(/^::([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (compatHex) return isBlockedIPv4(hextetsToV4(compatHex[1]!, compatHex[2]!));
  // Single-hextet IPv4-compatible tail: `::x` (all high bits zero) embeds only
  // the low 16 bits, i.e. 0.0.(x>>8).(x&0xff) — always within 0.0.0.0/8 ("this"
  // network). `::` and `::1` are handled above, so any remaining `::x` is routed
  // through the IPv4 denylist rather than slipping past as "not an IP literal".
  const compatSingle = h.match(/^::([0-9a-f]{1,4})$/);
  if (compatSingle) {
    const x = parseInt(compatSingle[1]!, 16);
    return isBlockedIPv4(`0.0.${(x >> 8) & 0xff}.${x & 0xff}`);
  }

  // 6to4: 2002:<v4>::/16 — the two hextets after `2002:` are the embedded v4.
  const sixToFour = h.match(/^2002:([0-9a-f]{1,4}):([0-9a-f]{1,4})/);
  if (sixToFour) return isBlockedIPv4(hextetsToV4(sixToFour[1]!, sixToFour[2]!));

  // NAT64 well-known prefix: 64:ff9b::<v4> (dotted or hex tail).
  const nat64Dotted = h.match(/^64:ff9b::(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (nat64Dotted) return isBlockedIPv4(nat64Dotted[1]!);
  const nat64Hex = h.match(/^64:ff9b::([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (nat64Hex) return isBlockedIPv4(hextetsToV4(nat64Hex[1]!, nat64Hex[2]!));

  return false;
}

/** Convert two IPv6 hextets (hex strings) into a dotted-quad IPv4 literal. */
function hextetsToV4(hiHex: string, loHex: string): string {
  const hi = parseInt(hiHex, 16);
  const lo = parseInt(loHex, 16);
  return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
}

/** Host-level SSRF verdict: safe, or blocked with a machine-readable reason. */
export type HostResult = { ok: true } | { ok: false; reason: string };

/**
 * Host-only SSRF check, shared by `assertSafeUrl` (HTTP/DNS/domain URLs) and the
 * raw-socket TCP executor (which has a bare host, no URL). Rejects loopback /
 * `.local` / `.localhost` names, cloud-metadata endpoints, and IP literals that
 * fall inside private/reserved ranges. Accepts the host with or without the
 * `[ ]` brackets the WHATWG parser adds to IPv6 literals.
 */
export function assertSafeHost(host: string): HostResult {
  const rawHost = host.trim();
  if (!rawHost) {
    return { ok: false, reason: "invalid_host" };
  }
  // Strip a single trailing dot (FQDN root): "localhost." resolves the same as
  // "localhost" but would otherwise slip past the literal hostname checks below.
  const normalized = rawHost.toLowerCase().replace(/\.$/, "");

  if (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local")
  ) {
    return { ok: false, reason: "loopback_host" };
  }

  // Cloud metadata: GCE name, or any encoding that normalizes to 169.254.169.254.
  const hostUint = ipv4ToUint32(normalized);
  if (
    normalized === "metadata.google.internal" ||
    (hostUint !== null && hostUint === ipv4ToUint32("169.254.169.254"))
  ) {
    return { ok: false, reason: "metadata_host" };
  }

  if (
    normalized.endsWith(".internal") ||
    normalized.endsWith(".lan") ||
    normalized.endsWith(".home")
  ) {
    return { ok: false, reason: "private_hostname" };
  }

  if (isIPv4(normalized) && isBlockedIPv4(normalized)) {
    return { ok: false, reason: "private_ipv4" };
  }

  // IPv6 literal, bracketed (URL hostname) or bare (TCP host). `isBlockedIPv6`
  // handles both forms and strips a `%zone`; on a non-IPv6 name it returns false.
  if (isBlockedIPv6(rawHost)) {
    return { ok: false, reason: "private_ipv6" };
  }

  return { ok: true };
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

  const hostCheck = assertSafeHost(rawHost);
  if (!hostCheck.ok) return hostCheck;

  return { ok: true, url };
}
