/** The platform Worker's bindings (platform/wrangler.jsonc). */
export interface PlatformEnv {
  /** The Hosted domain (decision D2); `app.` and `<slug>.` hang off it. */
  HOSTED_DOMAIN: string;
  /** Accounts, tenants, billing, keys, audit (migrations/). */
  PLATFORM_DB: D1Database;
  /** The dispatch namespace holding every customer's OpenPing. */
  TENANTS: DispatchNamespace;
  /** Due customers, one message each, for the scheduler's consumer (B4, src/scheduling.ts). */
  SCHEDULE_QUEUE: Queue<import("./scheduling").ScheduleMessage>;

  // --- Provisioning (B3, src/provisioning.ts) ---
  /** The dispatch namespace's name, for the Cloudflare API (the binding above is TENANTS). */
  DISPATCH_NAMESPACE?: string;
  /** Runs of provisioning, one message per tenant and retry (src/provisioning-queue.ts). */
  PROVISION_QUEUE?: Queue<import("./provisioning-queue").ProvisionMessage>;
  /** Tenant bundles written by the release runner (C1; layout in src/bundle.ts). */
  BUNDLES?: R2Bucket;
  /** Secret: the 32 hex character Cloudflare account id. A secret only so it stays out of this public repo's config. */
  CF_ACCOUNT_ID?: string;
  /** Secret: an API token with Workers Scripts Write and D1 Write on that account (owner action O5). */
  CF_API_TOKEN?: string;
  /** Secret: 32 random bytes, base64; encrypts each tenant's escrowed MASTER_KEY (decision D4, O6). */
  PLATFORM_KEY?: string;
  /** Var: base64url of the raw 32-byte Ed25519 hand-off public key, set on every tenant (contract, section 7). */
  HANDOFF_PUBLIC_KEY?: string;

  // --- Accounts and sign-in (B2, src/account-routes.ts) ---
  /** Var: "open" lets new accounts be created; anything else (the default) lets only existing ones sign in. */
  SIGN_UPS?: string;
  /** Secret: base64url PKCS#8 Ed25519 private key that signs hand-off tokens (contract, section 7; O6). */
  HANDOFF_SIGNING_KEY?: string;
  /** Secret: the platform's Resend API key, for sign-in codes. */
  RESEND_API_KEY?: string;
  /** Var: the From of the platform's mail, on a domain verified in Resend, e.g. "OpenPing Hosted <signin@<domain>>". */
  MAIL_FROM?: string;
  /** Var and secret: the platform's GitHub OAuth app (callback https://app.<domain>/auth/github/callback). */
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;

  // --- The owner's admin console (B6, src/admin/) ---
  /**
   * Var or secret: who the owner is, as platform account ids (`acc_...`) or
   * emails, separated by commas or spaces. Empty (the default) means nobody:
   * every /admin page answers 404.
   */
  PLATFORM_OWNERS?: string;
  /**
   * Var or secret: the credential ids of the owner's own passkeys, separated
   * by commas or spaces. Only a sign-in with one of these opens the console,
   * so a passkey someone adds through the owner's inbox gets them nothing.
   * The console's "Confirm it's you" page lists the owner's passkey ids to copy.
   */
  PLATFORM_OWNER_PASSKEYS?: string;
}
