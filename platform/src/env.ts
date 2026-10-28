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
}
