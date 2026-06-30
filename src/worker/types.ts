/**
 * Cloudflare Worker runtime bindings. Secrets are optional at the type level so
 * the app can boot before first-run setup configures them; handlers must guard
 * for missing values and surface a clear "not configured" error.
 */
export interface Env {
  /** D1 — the only operational datastore. */
  DB: D1Database;
  /** Static asset server (built SPA). */
  ASSETS: Fetcher;

  // --- Worker secrets (set via `wrangler secret put` / dashboard) ---
  /** AES-GCM master key (base64) for encrypting sensitive D1 values. */
  MASTER_KEY?: string;

  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;

  RESEND_API_KEY?: string;

  /** Allowlisted administrator identities (bootstrap). */
  ADMIN_GITHUB_LOGIN?: string;
  ADMIN_EMAIL?: string;

  /** Public base URL of this installation, e.g. https://status.example.com */
  APP_URL?: string;

  /**
   * Optional admin API token for CLI/automation. When set, a request bearing
   * `Authorization: Bearer <API_TOKEN>` is treated as the admin (no cookie/CSRF —
   * a Bearer header isn't ambient, so there's no CSRF surface). Opt-in: unset =
   * no token auth. Rotate by changing the secret; treat it like a password.
   */
  API_TOKEN?: string;

  /** Web Push VAPID keypair (set during PWA setup). */
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;
}

/** Hono generics for this app. */
export type AppEnv = { Bindings: Env; Variables: AppVariables };

export interface AppVariables {
  /** Set by auth middleware on authenticated requests. */
  admin?: { id: string; login?: string; email?: string };
  /** The authenticated session row, set by requireAuth. */
  session?: SessionRow;
}

/** A row in the `sessions` table. */
export interface SessionRow {
  id: string;
  identity: string;
  identity_kind: "github" | "email";
  csrf_secret: string;
  created_at: number;
  expires_at: number;
  last_seen_at: number | null;
  user_agent: string | null;
  ip: string | null;
}
