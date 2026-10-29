/**
 * Running inside the OpenPing Android app (apps/android, docs/ANDROID.md).
 *
 * The app shows this web app in a web view. It says so in the user agent
 * (`OpenPingApp/<version>`), and gives this install's pages, and no other
 * site's, a small message bridge: `window.OpenPingApp`, an Android
 * WebMessageListener. Messages are JSON strings (shared/native-app.ts).
 *
 * In a browser none of this exists and every function here is a no-op.
 */
import { isAppUserAgent, type AppBridgeReply, type AppBridgeRequest } from "../../shared/native-app";

/** The object Android's WebViewCompat.addWebMessageListener puts on window. */
interface WebMessageBridge {
  postMessage(message: string): void;
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
}

/** True in the OpenPing app's web view. */
export function isInApp(): boolean {
  return typeof navigator !== "undefined" && isAppUserAgent(navigator.userAgent);
}

function bridge(): WebMessageBridge | null {
  if (typeof window === "undefined") return null;
  const candidate = (window as Window & { OpenPingApp?: WebMessageBridge }).OpenPingApp;
  return candidate && typeof candidate.postMessage === "function" ? candidate : null;
}

/** True when the app can be asked things (its bridge is on this page). */
export function hasAppBridge(): boolean {
  return bridge() !== null;
}

const waiting = new Set<(reply: AppBridgeReply) => boolean>();
let listening = false;

function listen(b: WebMessageBridge) {
  if (listening) return;
  listening = true;
  b.addEventListener("message", (event) => {
    let reply: AppBridgeReply;
    try {
      reply = JSON.parse(String(event.data)) as AppBridgeReply;
    } catch {
      return;
    }
    for (const take of [...waiting]) if (take(reply)) waiting.delete(take);
  });
}

/** Tell the app something that needs no answer. False when there is no app to tell. */
export function tellApp(request: AppBridgeRequest): boolean {
  const b = bridge();
  if (!b) return false;
  b.postMessage(JSON.stringify(request));
  return true;
}

/**
 * Ask the app and wait for the first reply of one of `types`. Null without an
 * app, or when it doesn't answer in `timeoutMs` (a permission dialog can take a
 * while, so callers that show one wait longer).
 */
export function askApp<T extends AppBridgeReply["type"]>(
  request: AppBridgeRequest,
  types: readonly T[],
  timeoutMs = 10_000,
): Promise<Extract<AppBridgeReply, { type: T }> | null> {
  const b = bridge();
  if (!b) return Promise.resolve(null);
  listen(b);
  return new Promise((resolve) => {
    const take = (reply: AppBridgeReply) => {
      if (!(types as readonly string[]).includes(reply.type)) return false;
      clearTimeout(timer);
      resolve(reply as Extract<AppBridgeReply, { type: T }>);
      return true;
    };
    const timer = setTimeout(() => {
      waiting.delete(take);
      resolve(null);
    }, timeoutMs);
    waiting.add(take);
    b.postMessage(JSON.stringify(request));
  });
}

/**
 * Where a page goes after a sign-in that answered `next` (the passkey sign-in
 * does): only a path on this site, else the dashboard.
 */
export function safeNextPath(next: unknown): string {
  return typeof next === "string" && next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/\\")
    ? next
    : "/";
}
