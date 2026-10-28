/** The platform Worker's bindings (platform/wrangler.jsonc). */
export interface PlatformEnv {
  /** The Hosted domain (decision D2); `app.` and `<slug>.` hang off it. */
  HOSTED_DOMAIN: string;
  /** Accounts, tenants, billing, keys, audit (migrations/). */
  PLATFORM_DB: D1Database;
  /** The dispatch namespace holding every customer's OpenPing. */
  TENANTS: DispatchNamespace;
  /** Due customers for the scheduler's consumer (B4). */
  SCHEDULE_QUEUE: Queue;

  // --- Provisioning (B3, src/provisioning.ts) ---
  /** The dispatch namespace's name, for the Cloudflare API (the binding above is TENANTS). */
  DISPATCH_NAMESPACE?: string;
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
}
