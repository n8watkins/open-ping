/**
 * Slugs: the `<slug>` in `<slug>.<HOSTED_DOMAIN>`.
 *
 * A slug is one DNS label a customer picks at sign-up. The rules keep it a
 * valid hostname label, readable, and clear of names the platform or the
 * owner needs, or that would let a customer impersonate them.
 */

export const SLUG_MIN_LENGTH = 3;
export const SLUG_MAX_LENGTH = 30;

/** Lowercase letters, digits and single dashes; starts with a letter, ends with a letter or digit. */
const SLUG_PATTERN = /^[a-z](?:[a-z0-9]|-(?!-))*[a-z0-9]$/;

/**
 * Names no customer can have. Exact matches only; the prefix and substring
 * rules are in `slugProblem`. Kept sorted, one group per reason.
 */
export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  // The platform's own hosts, now and planned.
  "admin", "api", "app", "apps", "assets", "auth", "cdn", "console", "dashboard", "dev", "docs",
  "edge", "hosted", "internal", "my", "origin", "platform", "preview", "proxy", "static",
  "staging", "stage", "status", "test", "www",
  // Account, billing and sign-in pages a customer could be phished from.
  "account", "accounts", "billing", "checkout", "invoice", "invoices", "login", "logout",
  "oauth", "password", "pay", "payment", "payments", "register", "reset", "signin", "sign-in",
  "signout", "sign-out", "signup", "sign-up", "sso", "subscribe", "verify",
  // Mail and the role addresses RFC 2142 reserves, so no slug looks like one.
  "abuse", "email", "hostmaster", "imap", "mail", "mx", "noreply", "no-reply", "pop", "postmaster",
  "security", "smtp", "webmail", "webmaster",
  // Help and the company.
  "about", "blog", "contact", "help", "legal", "news", "privacy", "support", "terms",
  // DNS and infrastructure.
  "dns", "ftp", "localhost", "ns", "ns1", "ns2", "ns3", "ns4", "vpn",
  // Names that belong to the owner, the product and its suppliers.
  "cloudflare", "github", "n8", "n8builds", "n8watkins", "openping", "open-ping", "resend",
  "stripe",
  // Words that read as the platform speaking.
  "official", "root", "system", "team",
]);

export type SlugProblem = "length" | "characters" | "reserved";

/** Trims and lowercases what a customer typed. Validation happens on the result. */
export function normalizeSlug(input: string): string {
  return input.trim().toLowerCase();
}

/** Why `slug` (already normalized) can't be used, or null when it can. */
export function slugProblem(slug: string): SlugProblem | null {
  if (slug.length < SLUG_MIN_LENGTH || slug.length > SLUG_MAX_LENGTH) return "length";
  if (!SLUG_PATTERN.test(slug)) return "characters";
  if (RESERVED_SLUGS.has(slug)) return "reserved";
  // Anything that reads as the product or the platform's own machinery.
  if (slug.includes("openping") || slug.startsWith("t-") || slug.startsWith("tenant")) return "reserved";
  return null;
}

export function isValidSlug(slug: string): boolean {
  return slugProblem(slug) === null;
}
