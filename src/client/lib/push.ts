/**
 * Client-side Web Push + service worker helpers (PRD §14).
 *
 * The service worker itself lives at /public/sw.js (vanilla JS, served
 * statically). These helpers handle registration and the subscription
 * lifecycle from the React app.
 */

/** True when this browser supports service workers and the Push API. */
export function isPushSupported(): boolean {
  return "serviceWorker" in navigator && "PushManager" in window;
}

/**
 * Register the app-shell service worker. Returns null (and warns) when service
 * workers are unsupported or registration fails, so callers can degrade
 * gracefully.
 */
export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!("serviceWorker" in navigator)) {
    console.warn("[push] Service workers are not supported in this browser.");
    return null;
  }
  try {
    return await navigator.serviceWorker.register("/sw.js");
  } catch (err) {
    console.warn("[push] Service worker registration failed:", err);
    return null;
  }
}

/**
 * Convert a URL-safe base64 VAPID public key into the Uint8Array shape expected
 * by `pushManager.subscribe({ applicationServerKey })`.
 */
export function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const normalized = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = window.atob(normalized);
  const output = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) {
    output[i] = raw.charCodeAt(i);
  }
  return output;
}

/**
 * Standard (not URL-safe) base64 encoding of an ArrayBuffer. The p256dh and
 * auth subscription keys are conventionally sent to push servers as standard
 * base64.
 */
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return window.btoa(binary);
}

/** The currently active push subscription, if any. */
export async function getExistingSubscription(): Promise<PushSubscription | null> {
  if (!isPushSupported()) return null;
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}

/** Serializable subscription payload sent to the server to store. */
export interface PushSubscriptionPayload {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/**
 * Request notification permission and subscribe to push. Returns the
 * serializable subscription payload, or null when unsupported / denied.
 */
export async function subscribeToPush(
  vapidPublicKey: string,
): Promise<PushSubscriptionPayload | null> {
  if (!isPushSupported()) return null;

  const permission = await Notification.requestPermission();
  if (permission !== "granted") return null;

  const reg = await navigator.serviceWorker.ready;
  const subscription = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
  });

  const p256dh = subscription.getKey("p256dh");
  const auth = subscription.getKey("auth");
  if (!p256dh || !auth) return null;

  return {
    endpoint: subscription.endpoint,
    keys: {
      p256dh: arrayBufferToBase64(p256dh),
      auth: arrayBufferToBase64(auth),
    },
  };
}

/**
 * Unsubscribe from push. Returns true when an existing subscription was
 * removed, false when there was nothing to unsubscribe.
 */
export async function unsubscribePush(): Promise<boolean> {
  const subscription = await getExistingSubscription();
  if (!subscription) return false;
  return subscription.unsubscribe();
}
