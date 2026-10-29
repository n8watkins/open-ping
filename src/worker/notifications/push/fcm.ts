import type { Env } from "../../types";
import { base64urlDecode, base64urlEncode, type SendWebPushResult } from "./webpush";
import { parseRetryAfter, SEND_TIMEOUT_MS } from "../channels/http";

/**
 * Push to the OpenPing Android app through Firebase Cloud Messaging, HTTP v1
 * API (docs/ANDROID.md, "Push notifications"). Android's web view has no Web
 * Push, so the app registers an FCM token with this install instead
 * (POST /api/push/fcm) and this sends to it.
 *
 * Off unless FCM_SERVICE_ACCOUNT holds a Firebase service account's JSON key:
 * an install without it is unchanged. The key signs a short JWT (RS256, Web
 * Crypto) that Google's token endpoint exchanges for an hour-long OAuth2
 * access token, kept in memory and reused until a few minutes before it ends.
 *
 * Checked against Google's documentation on 2026-10-29:
 * - send: POST https://fcm.googleapis.com/v1/projects/{project_id}/messages:send
 *   with scope https://www.googleapis.com/auth/firebase.messaging;
 * - token: POST https://oauth2.googleapis.com/token, grant_type
 *   urn:ietf:params:oauth:grant-type:jwt-bearer, the JWT valid at most an hour;
 * - errors: UNREGISTERED (404) means the token is gone, SENDER_ID_MISMATCH
 *   (403) that it belongs to another Firebase project, QUOTA_EXCEEDED (429),
 *   UNAVAILABLE (503) and INTERNAL (500) are worth a retry.
 */

export const FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const fcmSendUrl = (projectId: string) =>
  `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/messages:send`;

/** What this install needs from the service account key. */
export interface ServiceAccount {
  projectId: string;
  clientEmail: string;
  /** PKCS#8 PEM ("-----BEGIN PRIVATE KEY-----"). */
  privateKey: string;
  privateKeyId?: string;
}

/** The service account in FCM_SERVICE_ACCOUNT, or null when it is unset or unusable. */
export function serviceAccount(env: Pick<Env, "FCM_SERVICE_ACCOUNT">): ServiceAccount | null {
  const raw = env.FCM_SERVICE_ACCOUNT?.trim();
  if (!raw) return null;
  try {
    const json = JSON.parse(raw) as Record<string, unknown>;
    const { project_id, client_email, private_key, private_key_id } = json;
    if (
      json.type === "service_account" &&
      typeof project_id === "string" &&
      /^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(project_id) &&
      typeof client_email === "string" &&
      client_email.includes("@") &&
      typeof private_key === "string" &&
      private_key.includes("BEGIN PRIVATE KEY")
    ) {
      return {
        projectId: project_id,
        clientEmail: client_email,
        privateKey: private_key,
        privateKeyId: typeof private_key_id === "string" ? private_key_id : undefined,
      };
    }
  } catch {
    // Fall through.
  }
  console.error("[fcm] FCM_SERVICE_ACCOUNT is set but isn't a Firebase service account JSON key");
  return null;
}

/** The Firebase project this install sends through, or null when FCM is off. */
export function fcmProjectId(env: Pick<Env, "FCM_SERVICE_ACCOUNT">): string | null {
  return serviceAccount(env)?.projectId ?? null;
}

// --- The access token ----------------------------------------------------------

interface CachedToken {
  token: string;
  /** Epoch ms after which it isn't used any more. */
  useUntil: number;
}

const tokens = new Map<string, CachedToken>();
/** Stop using a token this long before Google says it ends. */
const TOKEN_MARGIN_MS = 5 * 60 * 1000;

/** Forget cached access tokens (tests, and after Google refuses one). */
export function forgetFcmTokens(): void {
  tokens.clear();
}

function pemToPkcs8(pem: string): ArrayBuffer {
  const body = pem.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, "").replace(/\s+/g, "");
  const bytes = base64urlDecode(body.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""));
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

const textBase64url = (value: unknown) => base64urlEncode(new TextEncoder().encode(JSON.stringify(value)));

/** The signed JWT the token endpoint takes (RFC 7523), valid for an hour from `now`. */
export async function signServiceAccountJwt(sa: ServiceAccount, now: number): Promise<string> {
  const iat = Math.floor(now / 1000);
  const header = { alg: "RS256", typ: "JWT", ...(sa.privateKeyId ? { kid: sa.privateKeyId } : {}) };
  const claims = { iss: sa.clientEmail, scope: FCM_SCOPE, aud: GOOGLE_TOKEN_URL, iat, exp: iat + 3600 };
  const input = `${textBase64url(header)}.${textBase64url(claims)}`;
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToPkcs8(sa.privateKey),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(input));
  return `${input}.${base64urlEncode(signature)}`;
}

/** An OAuth2 access token for FCM, from the cache or Google. Throws with a short reason. */
async function accessToken(sa: ServiceAccount, now: number): Promise<string> {
  const cached = tokens.get(sa.clientEmail);
  if (cached && cached.useUntil > now) return cached.token;
  const assertion = await signServiceAccountJwt(sa, now);
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString(),
    signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
  });
  const json = (await res.json().catch(() => ({}))) as { access_token?: unknown; expires_in?: unknown; error?: unknown };
  if (!res.ok || typeof json.access_token !== "string") {
    throw new Error(`fcm_auth_failed: ${typeof json.error === "string" ? json.error : res.status}`);
  }
  const lifetimeMs = (typeof json.expires_in === "number" ? json.expires_in : 3600) * 1000;
  tokens.set(sa.clientEmail, { token: json.access_token, useUntil: now + lifetimeMs - TOKEN_MARGIN_MS });
  return json.access_token;
}

// --- Sending -----------------------------------------------------------------------

/** What the app shows (AlertMessagingService.java): every value a string, as FCM's data must be. */
export interface FcmAlert {
  title: string;
  body: string;
  /** Where a tap goes, on this install. */
  url: string;
  /** This install's origin, so the app opens the right one. */
  origin: string;
  /** Alerts with the same tag replace each other (one incident, one notification). */
  tag: string;
}

/** The HTTP v1 message: data only, so the app builds the notification itself, foreground or not. */
export function fcmMessage(token: string, alert: FcmAlert) {
  return {
    message: {
      token,
      data: {
        kind: "alert",
        title: alert.title.slice(0, 200),
        body: alert.body.slice(0, 1000),
        url: alert.url,
        origin: alert.origin,
        tag: alert.tag.slice(0, 100),
      },
      // High priority wakes the phone for an alert that shows a notification;
      // an alert older than a day isn't news any more.
      android: { priority: "high", ttl: "86400s" },
    },
  };
}

type FcmErrorCode =
  | "UNREGISTERED"
  | "SENDER_ID_MISMATCH"
  | "INVALID_ARGUMENT"
  | "QUOTA_EXCEEDED"
  | "UNAVAILABLE"
  | "INTERNAL"
  | "THIRD_PARTY_AUTH_ERROR"
  | "UNSPECIFIED_ERROR";

/** FCM's own error code, from `error.details[].errorCode` (type FcmError). */
export function fcmErrorCode(body: unknown): FcmErrorCode | null {
  const details = (body as { error?: { details?: unknown } } | null)?.error?.details;
  if (!Array.isArray(details)) return null;
  for (const d of details) {
    const item = d as { "@type"?: unknown; errorCode?: unknown };
    if (typeof item["@type"] === "string" && item["@type"].endsWith("google.firebase.fcm.v1.FcmError")) {
      return typeof item.errorCode === "string" ? (item.errorCode as FcmErrorCode) : null;
    }
  }
  return null;
}

/**
 * Send one alert to one app token. Never throws. `expired` (UNREGISTERED) and
 * `invalid` (another project's token, or one FCM calls malformed) tell the
 * caller to forget the device; anything else is retried by the outbox.
 */
export async function sendFcm(
  sa: ServiceAccount,
  token: string,
  alert: FcmAlert,
  now: number = Date.now(),
): Promise<SendWebPushResult & { retryAfterMs?: number }> {
  let bearer: string;
  try {
    bearer = await accessToken(sa, now);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message.slice(0, 200) : "fcm_auth_failed" };
  }
  let res: Response;
  try {
    res = await fetch(fcmSendUrl(sa.projectId), {
      method: "POST",
      headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json; charset=UTF-8" },
      body: JSON.stringify(fcmMessage(token, alert)),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
  } catch (e) {
    return { ok: false, error: `fcm_unreachable: ${e instanceof Error ? e.message.slice(0, 120) : "network"}` };
  }
  if (res.ok) return { ok: true, status: res.status };

  const body = await res.json().catch(() => null);
  const code = fcmErrorCode(body);
  const status = res.status;
  if (status === 401) {
    // The access token was refused: the next try gets a fresh one.
    tokens.delete(sa.clientEmail);
    return { ok: false, status, error: "fcm_unauthorized" };
  }
  if (code === "UNREGISTERED" || status === 404) return { ok: false, status, error: "fcm_unregistered", expired: true };
  if (code === "SENDER_ID_MISMATCH") return { ok: false, status, error: "fcm_sender_mismatch", invalid: true };
  if (code === "INVALID_ARGUMENT") {
    // A bad token is the usual cause; only the token is the device's, so
    // treat it as gone only when FCM names that field.
    const named = JSON.stringify(body ?? {}).includes("message.token");
    return { ok: false, status, error: "fcm_invalid_argument", invalid: named };
  }
  return {
    ok: false,
    status,
    error: `fcm_${(code ?? `http_${status}`).toLowerCase()}`,
    retryAfterMs: parseRetryAfter(res.headers.get("retry-after"), now),
  };
}

/** A token as the app hands it over: FCM tokens are long and URL-safe. */
export function isFcmToken(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_:\-.]{20,4096}$/.test(value);
}
