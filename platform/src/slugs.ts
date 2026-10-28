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
  // Machinery a platform grows: webhooks, uploads, sockets, metrics, sandboxes.
  "beta", "demo", "example", "files", "graphql", "health", "healthz", "hooks", "images", "img",
  "media", "metrics", "portal", "sandbox", "uploads", "webhook", "webhooks", "wss",
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
  // Hosts that mail clients, browsers and proxies look up by name on their own.
  "autoconfig", "autodiscover", "isatap", "mta-sts", "wpad", "well-known",
  // Names that belong to the owner, the product and its suppliers.
  "cloudflare", "github", "n8", "n8builds", "n8watkins", "openping", "open-ping", "resend",
  "stripe",
  // Brands people are most often phished with, so no status page poses as theirs.
  "amazon", "apple", "facebook", "google", "meta", "microsoft", "paypal",
  // Words that read as the platform speaking.
  "null", "official", "root", "system", "team", "undefined",
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

export type SlugAvailability = { ok: true; slug: string } | { ok: false; slug: string; reason: SlugProblem | "taken" };

/** One plain sentence per reason, for the sign-up form. */
export const SLUG_MESSAGES: Readonly<Record<SlugProblem | "taken", string>> = {
  length: `Use ${SLUG_MIN_LENGTH} to ${SLUG_MAX_LENGTH} characters.`,
  characters: "Use lowercase letters, digits and single dashes, starting with a letter.",
  reserved: "That name is reserved. Try another.",
  taken: "That name is already taken. Try another.",
};

/**
 * Can a new tenant have `input` (as typed)? Checks the rules, then the
 * platform database: an existing tenant, or a hold left by a removed one
 * (slug_holds), makes it taken. The UNIQUE constraint on tenants.slug is
 * still the final word when two sign-ups race for the same name.
 */
export async function checkSlugAvailability(db: D1Database, input: string, now: number): Promise<SlugAvailability> {
  const slug = normalizeSlug(input);
  const problem = slugProblem(slug);
  if (problem) return { ok: false, slug, reason: problem };
  const row = await db
    .prepare(
      `SELECT 1 AS hit FROM tenants WHERE slug = ?1
       UNION ALL SELECT 1 FROM slug_holds WHERE slug = ?1 AND held_until > ?2
       LIMIT 1`,
    )
    .bind(slug, now)
    .first<{ hit: number }>();
  return row ? { ok: false, slug, reason: "taken" } : { ok: true, slug };
}

/** How long a removed tenant's slug stays out of reach. */
export const SLUG_HOLD_MS = 90 * 86_400_000;

/** Keeps `slug` from new sign-ups until `now + SLUG_HOLD_MS` (or longer, if it is already held longer). */
export async function holdSlug(db: D1Database, slug: string, reason: "deleted" | "renamed" | "owner", now: number): Promise<void> {
  await db
    .prepare(
      `INSERT INTO slug_holds (slug, held_until, reason) VALUES (?1, ?2, ?3)
       ON CONFLICT(slug) DO UPDATE SET held_until = MAX(held_until, excluded.held_until), reason = excluded.reason`,
    )
    .bind(slug, now + SLUG_HOLD_MS, reason)
    .run();
}
