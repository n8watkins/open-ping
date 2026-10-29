import type { TenantProps } from "../shared/hosted-contract";
import type { RegionProbe } from "./region-probe";

/**
 * Cloudflare Worker runtime bindings. Secrets are optional at the type level so
 * the app can boot before first-run setup configures them; handlers must guard
 * for missing values and surface a clear "not configured" error.
 */
export interface Env {
  /** D1 - the only operational datastore. */
  DB: D1Database;
  /** Static asset server (built SPA). */
  ASSETS: Fetcher;

  // --- Worker secrets (set via `wrangler secret put` / dashboard) ---
  /** AES-GCM master key (base64) for encrypting sensitive D1 values. */
  MASTER_KEY?: string;

  /**
   * The master key being rotated away from (base64), read-only. Set it only for
   * a key rotation, and delete it once GET /api/admin/rekey/status reports that
   * nothing depends on it (docs/SECURITY.md, "Rotating MASTER_KEY").
   */
  MASTER_KEY_PREVIOUS?: string;

  /** One-time credential required for unauthenticated first-run setup. */
  SETUP_TOKEN?: string;

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
   * `Authorization: Bearer <API_TOKEN>` is treated as the admin (no cookie/CSRF -
   * a Bearer header isn't ambient, so there's no CSRF surface). Opt-in: unset =
   * no token auth. Rotate by changing the secret; treat it like a password.
   */
  API_TOKEN?: string;

  /**
   * The Cloudflare Workers plan this install runs on: "free" (the default) or
   * "paid". Sets how much one cron run may spend (lib/budget.ts); a wrangler.jsonc var.
   */
  WORKERS_PLAN?: string;

  /**
   * "true" only on the canonical install (openping.n8builds.dev), which collects
   * the OpenPing Hosted waitlist; every other install answers 404. A wrangler.jsonc var.
   */
  WAITLIST_ENABLED?: string;

  /**
   * What a signed-out visitor sees at `/`: "status" (the default) for this
   * install's own status page, or "landing" for OpenPing's marketing page,
   * which only the canonical install sets (lib/home-page.ts). A wrangler.jsonc var.
   */
  HOME_PAGE?: string;

  /**
   * The OpenPing Hosted sign-up page, set only on the canonical install once
   * Hosted opens. Unset (the default), the landing page offers the Hosted
   * waitlist; set, it offers the free trial and links here
   * (src/shared/hosted-offer.ts). A wrangler.jsonc var.
   */
  HOSTED_SIGNUP_URL?: string;

  /**
   * Where a failed check is confirmed from before it opens an incident: a
   * comma-separated list of Durable Object location hints, in order of
   * preference ("enam,weur"), or "off" (checks/region.ts). Unset means
   * off. A wrangler.jsonc var.
   */
  CONFIRM_REGIONS?: string;

  /**
   * The per-region re-checkers (worker/region-probe.ts). Optional, so an install
   * deployed without it confirms where the check ran, as before.
   */
  REGION_PROBE?: DurableObjectNamespace<RegionProbe>;

  /**
   * Workers Rate Limiting binding for the landing page's click counter
   * (routes/events.ts). Optional, so an install without it still works.
   */
  EVENT_LIMITER?: RateLimit;

  // --- OpenPing Hosted (docs/hosted/CONTRACT.md, section 2) ---
  /**
   * "1" when the platform runs this Worker as a customer's OpenPing in its
   * dispatch namespace; unset (or anything else) on a plain install, which
   * then behaves exactly as without these vars (lib/hosted.ts).
   */
  HOSTED_MODE?: string;
  /** The tenant id this Worker was provisioned for (hosted mode only). */
  TENANT_ID?: string;
  /** base64url of the raw Ed25519 public key that verifies sign-in hand-offs (hosted mode only). */
  HANDOFF_PUBLIC_KEY?: string;
  /**
   * Local development only: TenantInfo JSON that stands in for the platform's
   * props under `npm run dev`, where no dispatcher exists. Production builds
   * never read it (lib/hosted.ts, devTenantProps).
   */
  HOSTED_DEV_TENANT?: string;

  /**
   * Not a binding: in hosted mode the hosted gate sets it on this call's env to
   * the platform's mail sender (notifications/mail.ts), valid for this call only.
   */
  MAIL_TRANSPORT?: import("./notifications/mail").MailTransport;

  /** Web Push VAPID keypair (set during PWA setup). */
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;

  /**
   * The OpenPing Android app's signing-certificate SHA-256 fingerprints, comma
   * separated, to serve /.well-known/assetlinks.json (lib/android-app-links.ts).
   * Optional: the app signs in through the browser without it.
   */
  ANDROID_APP_LINKS?: string;

  /**
   * A Firebase service account's JSON key (a secret), to push alerts to the
   * OpenPing Android app through FCM (notifications/push/fcm.ts). Unset, the
   * app's notifications are off and nothing else changes.
   */
  FCM_SERVICE_ACCOUNT?: string;
}

/** Hono generics for this app. */
export type AppEnv = { Bindings: Env; Variables: AppVariables };

export interface AppVariables {
  /** Set by auth middleware on authenticated requests. */
  admin?: { id: string; login?: string; email?: string };
  /** The authenticated session row, set by requireAuth. */
  session?: SessionRow;
  /**
   * This call's props from the platform, in hosted mode only (set by the
   * hosted middleware in index.ts). Valid for this request only: never keep
   * it, or its `platform` stub, past the request.
   */
  hosted?: TenantProps;
}

/**
 * How a session signed in. "hosted" is the platform's sign-in hand-off for the
 * customer, "hosted_support" the same for the owner signing in to help.
 */
export type IdentityKind = "github" | "email" | "passkey" | "hosted" | "hosted_support";

/** A row in the `sessions` table. */
export interface SessionRow {
  id: string;
  identity: string;
  identity_kind: IdentityKind;
  csrf_secret: string;
  created_at: number;
  expires_at: number;
  last_seen_at: number | null;
  user_agent: string | null;
  ip: string | null;
  /** "app" for the Android app's sessions (migration 0025), else null. */
  via?: "app" | null;
}
