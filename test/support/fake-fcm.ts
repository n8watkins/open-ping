/**
 * A stand-in for Google's OAuth2 token endpoint and the FCM HTTP v1 API, for
 * tests (never the real ones). It checks what the real ones check that we can
 * check: the service account JWT's signature and claims, the bearer token, and
 * the message shape; and it can answer with FCM's errors.
 */
import { FCM_SCOPE, GOOGLE_TOKEN_URL } from "../../src/worker/notifications/push/fcm";

export const FAKE_PROJECT = "openping-test-1234";

export interface FakeFcm {
  /** The FCM_SERVICE_ACCOUNT value to use. */
  serviceAccountJson: string;
  /** Every message FCM accepted, in order. */
  sent: Array<{ token: string; data: Record<string, string>; android: Record<string, unknown> }>;
  /** How many access tokens were handed out. */
  tokensIssued: number;
  /** Tokens FCM answers UNREGISTERED for. */
  unregistered: Set<string>;
  /** The next send answers this status and FcmError code once. */
  failNext: { status: number; code: string; retryAfter?: string } | null;
  fetch: typeof fetch;
}

function b64(bytes: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)));
}

function b64urlToBytes(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4));
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function createFakeFcm(
  next: typeof fetch = async () => {
    throw new Error("network_error");
  },
): Promise<FakeFcm> {
  const keys = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const pkcs8 = (await crypto.subtle.exportKey("pkcs8", keys.privateKey)) as ArrayBuffer;
  const pem = `-----BEGIN PRIVATE KEY-----\n${b64(pkcs8).replace(/(.{64})/g, "$1\n")}\n-----END PRIVATE KEY-----\n`;
  const clientEmail = `openping@${FAKE_PROJECT}.iam.gserviceaccount.com`;
  const issued = new Set<string>();

  const fake: FakeFcm = {
    serviceAccountJson: JSON.stringify({
      type: "service_account",
      project_id: FAKE_PROJECT,
      private_key_id: "key-1",
      private_key: pem,
      client_email: clientEmail,
      token_uri: GOOGLE_TOKEN_URL,
    }),
    sent: [],
    tokensIssued: 0,
    unregistered: new Set(),
    failNext: null,
    fetch: async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url === GOOGLE_TOKEN_URL) {
        const form = new URLSearchParams(String(init?.body ?? ""));
        if (form.get("grant_type") !== "urn:ietf:params:oauth:grant-type:jwt-bearer") {
          return Response.json({ error: "unsupported_grant_type" }, { status: 400 });
        }
        const [h, p, sig] = (form.get("assertion") ?? "").split(".");
        const ok = await crypto.subtle.verify(
          "RSASSA-PKCS1-v1_5",
          keys.publicKey,
          b64urlToBytes(sig ?? ""),
          new TextEncoder().encode(`${h}.${p}`),
        );
        const claims = JSON.parse(new TextDecoder().decode(b64urlToBytes(p ?? ""))) as Record<string, unknown>;
        const header = JSON.parse(new TextDecoder().decode(b64urlToBytes(h ?? ""))) as Record<string, unknown>;
        const now = Math.floor(Date.now() / 1000);
        if (
          !ok ||
          header.alg !== "RS256" ||
          claims.iss !== clientEmail ||
          claims.aud !== GOOGLE_TOKEN_URL ||
          claims.scope !== FCM_SCOPE ||
          typeof claims.exp !== "number" ||
          typeof claims.iat !== "number" ||
          claims.exp - claims.iat > 3600 ||
          Math.abs(claims.iat - now) > 300
        ) {
          return Response.json({ error: "invalid_grant" }, { status: 400 });
        }
        const token = `ya29.fake-${crypto.randomUUID()}`;
        issued.add(token);
        fake.tokensIssued++;
        return Response.json({ access_token: token, expires_in: 3599, token_type: "Bearer" });
      }
      if (url === `https://fcm.googleapis.com/v1/projects/${FAKE_PROJECT}/messages:send`) {
        const bearer = new Headers(init?.headers).get("authorization")?.replace(/^Bearer /, "") ?? "";
        if (!issued.has(bearer)) return Response.json({ error: { code: 401, status: "UNAUTHENTICATED" } }, { status: 401 });
        const { message } = JSON.parse(String(init?.body)) as {
          message: { token: string; data: Record<string, string>; android: Record<string, unknown> };
        };
        const fail = fake.failNext;
        fake.failNext = null;
        const error = (status: number, code: string, headers?: HeadersInit) =>
          Response.json(
            { error: { code: status, details: [{ "@type": "type.googleapis.com/google.firebase.fcm.v1.FcmError", errorCode: code }] } },
            { status, headers },
          );
        if (fail) return error(fail.status, fail.code, fail.retryAfter ? { "retry-after": fail.retryAfter } : undefined);
        if (fake.unregistered.has(message.token)) return error(404, "UNREGISTERED");
        if (Object.values(message.data).some((v) => typeof v !== "string")) return error(400, "INVALID_ARGUMENT");
        fake.sent.push(message);
        return Response.json({ name: `projects/${FAKE_PROJECT}/messages/${fake.sent.length}` });
      }
      return next(input, init);
    },
  };
  return fake;
}
