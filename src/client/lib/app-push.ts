/**
 * Notifications in the OpenPing Android app (docs/ANDROID.md): the app's web
 * view has no Web Push, so the app hands this page a Firebase Cloud Messaging
 * token over its bridge (lib/native-app.ts) and the page registers it with
 * this install (POST /api/push/fcm), signed in like any other change.
 */
import { api, ApiError } from "./api";
import { askApp } from "./native-app";

/** Set once this phone's app was registered here, so a changed token is sent again (refreshAppPush). */
const REGISTERED_KEY = "openping:app-push";

function remember(on: boolean) {
  try {
    if (on) window.localStorage.setItem(REGISTERED_KEY, "1");
    else window.localStorage.removeItem(REGISTERED_KEY);
  } catch {
    // Storage off: the token just isn't refreshed on its own.
  }
}

function remembered(): boolean {
  try {
    return window.localStorage.getItem(REGISTERED_KEY) === "1";
  } catch {
    return false;
  }
}

export type AppPushResult = { ok: true } | { ok: false; message: string };

/** What went wrong, for the person: never a raw error code. */
export function appPushError(reason: string): string {
  switch (reason) {
    case "unavailable":
      return "This build of the OpenPing app can't receive notifications.";
    case "denied":
      return "Notifications for OpenPing are off on this phone. Turn them on in Android's settings for the app, then try again.";
    case "failed":
      return "The phone couldn't get a notification token. Check that Google Play services is up to date and try again.";
    case "no_answer":
      return "The app didn't answer. Update the OpenPing app and try again.";
    case "fcm_not_configured":
      return "This OpenPing can't send notifications to the app yet: its owner sets FCM_SERVICE_ACCOUNT first.";
    case "fcm_project_mismatch":
      return "This OpenPing sends through a different Firebase project than this app uses, so its notifications can't reach it.";
    default:
      return "Couldn't turn on notifications for this phone. Please try again.";
  }
}

async function register(csrf: string | undefined, interactive: boolean): Promise<AppPushResult> {
  // A permission dialog may be on screen for a while.
  const reply = await askApp(
    { type: interactive ? "push.register" : "push.refresh" },
    ["push.token", "push.error"],
    interactive ? 120_000 : 10_000,
  );
  if (!reply) return { ok: false, message: appPushError("no_answer") };
  if (reply.type === "push.error") return { ok: false, message: appPushError(reply.reason) };
  try {
    await api("/api/push/fcm", {
      method: "POST",
      csrf,
      json: { token: reply.token, projectId: reply.projectId, label: reply.device },
    });
  } catch (e) {
    const code = e instanceof ApiError ? (e.data as { error?: string } | null)?.error : undefined;
    return { ok: false, message: appPushError(code ?? "") };
  }
  remember(true);
  return { ok: true };
}

/** Ask the app for notifications on this phone and register them here. */
export function enableAppPush(csrf: string | undefined): Promise<AppPushResult> {
  return register(csrf, true);
}

/**
 * Send this phone's token again if it was registered here before: Firebase
 * changes tokens now and then. Asks nothing; does nothing in a browser.
 */
export async function refreshAppPush(csrf: string | undefined): Promise<void> {
  if (!remembered()) return;
  const result = await register(csrf, false);
  // Notifications were turned off on the phone: stop trying until they are turned on here again.
  if (!result.ok && result.message === appPushError("denied")) remember(false);
}
