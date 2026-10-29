/**
 * What OpenPing's web app and Worker share with the OpenPing Android app
 * (apps/android, docs/ANDROID.md).
 *
 * The app is a small native shell that shows an install's own web app in a
 * web view. Signing in happens in the phone's browser (a Custom Tab), where
 * passkeys, GitHub and email links all work on any domain, and comes back to
 * the app with a one-time code bound to a secret only the app holds (PKCE).
 */

/** The app's Android package name (applicationId). */
export const ANDROID_PACKAGE = "dev.n8builds.openping";

/**
 * Where a finished browser sign-in sends the code: the app's private-use
 * scheme (its package name, as RFC 8252 section 7.1 recommends), which only
 * the installed app opens. Fixed, so a sign-in can never be sent anywhere else.
 */
export const APP_REDIRECT_URI = `${ANDROID_PACKAGE}:/signed-in`;

/** The app adds this to the web view's user agent: `OpenPingApp/<version> (Android)`. */
export const APP_USER_AGENT_TOKEN = "OpenPingApp";

/** True for the app's web view (by its user agent). */
export function isAppUserAgent(userAgent: string | null | undefined): boolean {
  return !!userAgent && new RegExp(`\\b${APP_USER_AGENT_TOKEN}/`).test(userAgent);
}

/**
 * The phone in an Android user agent: "Pixel 8", or "Android 14" when the
 * browser hides the model (Chrome's reduced user agent says "K"); null for
 * anything that isn't Android.
 */
export function androidPhone(userAgent: string | null | undefined): string | null {
  const m = /Android ([\d.]+); ([^;)]+?)(?: Build\/[^;)]*)?[;)]/.exec(userAgent ?? "");
  if (!m) return null;
  const model = m[2]!.trim();
  return model === "K" ? `Android ${m[1]}` : model;
}

/** The sign-in hand-off's paths on every install (src/worker/routes/app-signin.ts). */
export const APP_SIGNIN_PATHS = {
  /** GET, in the browser: `?challenge=<S256 of the verifier>&state=<the app's>`. */
  start: "/auth/app/start",
  /** GET, in the browser, once signed in: the "Open the app" page. */
  finish: "/auth/app/finish",
  /** POST, from the app's web view: `code` and `verifier`, form-encoded. */
  exchange: "/auth/app/exchange",
} as const;

/** A PKCE S256 challenge or a verifier's hash: 43 base64url characters (32 bytes). */
export const PKCE_CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** A PKCE verifier (RFC 7636 section 4.1): 43 to 128 unreserved characters. */
export const PKCE_VERIFIER_PATTERN = /^[A-Za-z0-9._~-]{43,128}$/;

/** The app's own state value, echoed back unchanged: 16 to 128 base64url characters. */
export const APP_STATE_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

/** The message the app's web view bridge understands (window.OpenPingApp). */
export type AppBridgeRequest =
  /** Who are you: the app replies with `info`. */
  | { type: "hello" }
  /** Sign in to this install in the browser and come back. */
  | { type: "signin" }
  /** Show the app's list of installs. */
  | { type: "switch" }
  /** Ask for notification permission and an FCM token for this install. */
  | { type: "push.register" }
  /** The FCM token again, without asking anything (only when notifications are already allowed). */
  | { type: "push.refresh" };

export type AppBridgeReply =
  | {
      type: "info";
      /** The app's version name, for example "1.0.0". */
      version: string;
      /** Whether this build can receive push notifications (Firebase is configured). */
      push: boolean;
    }
  | {
      type: "push.token";
      token: string;
      /** The Firebase project this build of the app belongs to. */
      projectId: string;
      /** The phone, for the device list: "Pixel 8". */
      device?: string;
    }
  | { type: "push.error"; reason: "unavailable" | "denied" | "failed" };
