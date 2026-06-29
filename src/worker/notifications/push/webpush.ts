/**
 * Hand-rolled Web Push for the Cloudflare Workers runtime (PRD §12).
 *
 * There is no Node `web-push` library available in Workers, so this module
 * implements the two relevant specs directly on top of Web Crypto
 * (`crypto.subtle`) and global `fetch`. NO Node APIs are used (no `Buffer`).
 *
 *   - RFC 8292 — VAPID: Voluntary Application Server Identification.
 *     A short-lived ES256 (ECDSA P-256 + SHA-256) JWT identifies this
 *     application server to the push service. Sent as
 *     `Authorization: vapid t=<jwt>, k=<base64url server public key>`.
 *
 *   - RFC 8291 — Message Encryption for Web Push (Content-Encoding:
 *     aes128gcm, layered on RFC 8188). The plaintext is encrypted with a
 *     per-message AES-128-GCM key derived via ECDH + HKDF from the
 *     subscription's `p256dh`/`auth` values and a fresh ephemeral server
 *     keypair.
 *
 * IMPORTANT: the encryption path has no published interop test vectors that we
 * can assert against in unit tests, so the ECDH/HKDF/AES-GCM pipeline below is
 * implemented strictly to the RFCs but MUST be validated against a real push
 * service / real device (Chrome FCM, Firefox autopush, Safari/APNs) before it
 * is trusted in production.
 */

// ---------------------------------------------------------------------------
// base64url helpers (no padding) — Uint8Array <-> base64url string.
// Style mirrors src/worker/lib/crypto.ts (btoa/atob, byte-at-a-time).
// ---------------------------------------------------------------------------

export function base64urlEncode(input: ArrayBuffer | Uint8Array): string {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64urlDecode(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
  const bin = atob(b64 + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ---------------------------------------------------------------------------
// Public types.
// ---------------------------------------------------------------------------

/** A browser `PushSubscription`, with keys as base64url strings. */
export interface WebPushSubscription {
  endpoint: string;
  p256dh: string; // client public key, base64url of a 65-byte P-256 point
  auth: string; // client auth secret, base64url of 16 bytes
}

/** VAPID application-server identity + keypair. */
export interface VapidKeys {
  /** base64url of the RAW uncompressed P-256 point (65 bytes, 0x04 prefix). */
  publicKey: string;
  /** base64url of the JWK `d` value (32 bytes) for the same keypair. */
  privateKey: string;
  /** Contact, e.g. "mailto:admin@example.com" or an https URL. */
  subject: string;
}

export interface SendWebPushResult {
  ok: boolean;
  status?: number;
  error?: string;
  /** True when the push service reports the subscription is gone (404/410). */
  expired?: boolean;
}

// ---------------------------------------------------------------------------
// Small byte utilities.
// ---------------------------------------------------------------------------

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** An HKDF/aes128gcm `info` value: the ASCII label followed by a 0x00 byte. */
function infoBytes(label: string): Uint8Array {
  return concatBytes(new TextEncoder().encode(label), new Uint8Array([0]));
}

/** HKDF-SHA256 (Extract + Expand) returning `length` bytes. */
async function hkdf(
  ikm: Uint8Array,
  salt: Uint8Array,
  info: Uint8Array,
  length: number,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt, info },
    key,
    length * 8,
  );
  return new Uint8Array(bits);
}

// ---------------------------------------------------------------------------
// VAPID key generation + JWT (RFC 8292).
// ---------------------------------------------------------------------------

/**
 * Generate an ECDSA P-256 keypair for VAPID.
 * - `publicKey`: base64url of the RAW uncompressed point (65 bytes).
 * - `privateKey`: base64url of the JWK `d` value (32 bytes).
 *
 * `VapidKeys` later carries both, so the private key can be re-imported via
 * JWK by reconstructing `x`/`y` from `publicKey` (see importVapidSigningKey).
 */
export async function generateVapidKeys(): Promise<{
  publicKey: string;
  privateKey: string;
}> {
  const pair = (await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const rawPublic = (await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer;
  const jwkPrivate = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey;
  if (!jwkPrivate.d) {
    throw new Error("Failed to export VAPID private key (missing JWK d)");
  }
  return {
    publicKey: base64urlEncode(rawPublic),
    privateKey: jwkPrivate.d, // JWK values are already base64url-encoded.
  };
}

/**
 * Re-import the VAPID private key for ES256 signing.
 *
 * Web Crypto's `importKey("jwk", ...)` for EC keys requires `x` and `y` even
 * for a private key, but we only persisted `d`. We recover `x`/`y` from the
 * stored raw public point (0x04 || X(32) || Y(32)) and combine them with `d`.
 */
async function importVapidSigningKey(vapid: VapidKeys): Promise<CryptoKey> {
  const rawPublic = base64urlDecode(vapid.publicKey);
  if (rawPublic.length !== 65 || rawPublic[0] !== 0x04) {
    throw new Error("VAPID publicKey must be a 65-byte uncompressed P-256 point");
  }
  const x = base64urlEncode(rawPublic.slice(1, 33));
  const y = base64urlEncode(rawPublic.slice(33, 65));
  return crypto.subtle.importKey(
    "jwk",
    { kty: "EC", crv: "P-256", x, y, d: vapid.privateKey, ext: true },
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
}

/**
 * Build a signed VAPID JWT (RFC 8292) for the given audience (the origin of
 * the push endpoint). Header `{typ:"JWT",alg:"ES256"}`, claims `{aud,exp,sub}`.
 * The ECDSA signature is raw r||s (64 bytes) — exactly what Web Crypto returns
 * — base64url-encoded. Returns `<header>.<payload>.<signature>`.
 *
 * Exported for unit testing of the token structure.
 */
export async function buildVapidJwt(
  vapid: VapidKeys,
  audience: string,
): Promise<string> {
  const header = { typ: "JWT", alg: "ES256" };
  const claims = {
    aud: audience,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: vapid.subject,
  };
  const encHeader = base64urlEncode(
    new TextEncoder().encode(JSON.stringify(header)),
  );
  const encClaims = base64urlEncode(
    new TextEncoder().encode(JSON.stringify(claims)),
  );
  const signingInput = `${encHeader}.${encClaims}`;

  const key = await importVapidSigningKey(vapid);
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${base64urlEncode(signature)}`;
}

// ---------------------------------------------------------------------------
// Payload encryption (RFC 8291, Content-Encoding: aes128gcm).
// ---------------------------------------------------------------------------

interface EncryptedPush {
  /** Full aes128gcm body: salt || rs || idlen || serverPub || ciphertext. */
  body: Uint8Array;
}

async function encryptPayload(
  payload: string,
  clientPublic: Uint8Array, // p256dh, 65 bytes
  authSecret: Uint8Array, // auth, 16 bytes
): Promise<EncryptedPush> {
  // 1) Ephemeral (application server) ECDH P-256 keypair.
  const serverPair = (await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  )) as CryptoKeyPair;
  const serverPublic = new Uint8Array(
    (await crypto.subtle.exportKey("raw", serverPair.publicKey)) as ArrayBuffer,
  );

  // 2) ECDH shared secret with the client's public key.
  const clientKey = await crypto.subtle.importKey(
    "raw",
    clientPublic,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const ecdhSecret = new Uint8Array(
    await crypto.subtle.deriveBits(
      // Runtime field is `public` per the Web Crypto spec; cast around the
      // workers-types typing which models the algorithm differently.
      { name: "ECDH", public: clientKey } as unknown as Parameters<
        typeof crypto.subtle.deriveBits
      >[0],
      serverPair.privateKey,
      256,
    ),
  );

  // 3) Combine ECDH secret with the auth secret (RFC 8291 §3.4):
  //    IKM = HKDF(salt=auth, ikm=ecdhSecret,
  //              info="WebPush: info" 0x00 || clientPub || serverPub, L=32)
  const keyInfo = concatBytes(
    infoBytes("WebPush: info"),
    clientPublic,
    serverPublic,
  );
  const ikm = await hkdf(ecdhSecret, authSecret, keyInfo, 32);

  // 4) Per RFC 8188, derive the content-encryption key and nonce from a fresh
  //    random 16-byte salt. The SAME salt is used for both derivations and is
  //    emitted in the aes128gcm header.
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(ikm, salt, infoBytes("Content-Encoding: aes128gcm"), 16);
  const nonce = await hkdf(ikm, salt, infoBytes("Content-Encoding: nonce"), 12);

  // 5) AES-128-GCM encrypt. Plaintext = utf8(payload) || 0x02 delimiter
  //    (single record, last record => delimiter byte 0x02, no extra padding).
  const plaintext = concatBytes(
    new TextEncoder().encode(payload),
    new Uint8Array([0x02]),
  );
  const aesKey = await crypto.subtle.importKey(
    "raw",
    cek,
    { name: "AES-GCM" },
    false,
    ["encrypt"],
  );
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aesKey, plaintext),
  );

  // 6) Assemble the aes128gcm body (RFC 8188 §2.1):
  //    salt(16) || rs(4, uint32 BE = 4096) || idlen(1 = 65) || keyid(serverPub)
  //    || ciphertext(+16-byte GCM tag, already appended by Web Crypto).
  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, 4096, false);
  const idlen = new Uint8Array([serverPublic.length]); // 65
  const body = concatBytes(salt, rs, idlen, serverPublic, ciphertext);
  return { body };
}

// ---------------------------------------------------------------------------
// Send.
// ---------------------------------------------------------------------------

const DEFAULT_TTL_SECONDS = 2_419_200; // 28 days.

export async function sendWebPush(opts: {
  subscription: WebPushSubscription;
  payload: string;
  vapid: VapidKeys;
  ttl?: number;
}): Promise<SendWebPushResult> {
  const { subscription, payload, vapid, ttl } = opts;

  const clientPublic = base64urlDecode(subscription.p256dh);
  const authSecret = base64urlDecode(subscription.auth);
  if (clientPublic.length !== 65 || authSecret.length !== 16) {
    return { ok: false, error: "invalid_subscription" };
  }

  let audience: string;
  try {
    audience = new URL(subscription.endpoint).origin;
  } catch {
    return { ok: false, error: "invalid_endpoint" };
  }

  let jwt: string;
  let body: Uint8Array;
  try {
    jwt = await buildVapidJwt(vapid, audience);
    ({ body } = await encryptPayload(payload, clientPublic, authSecret));
  } catch (err) {
    return {
      ok: false,
      error: `encrypt_error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const headers: Record<string, string> = {
    Authorization: `vapid t=${jwt}, k=${vapid.publicKey}`,
    "Content-Encoding": "aes128gcm",
    "Content-Type": "application/octet-stream",
    TTL: String(ttl ?? DEFAULT_TTL_SECONDS),
    "Content-Length": String(body.length),
  };

  let res: Response;
  try {
    res = await fetch(subscription.endpoint, {
      method: "POST",
      headers,
      body,
    });
  } catch {
    return { ok: false, error: "network_error" };
  }

  if (res.status === 200 || res.status === 201 || res.status === 202) {
    return { ok: true, status: res.status };
  }
  // 404 Not Found / 410 Gone: the subscription no longer exists and should be
  // pruned by the caller.
  if (res.status === 404 || res.status === 410) {
    return { ok: false, status: res.status, expired: true };
  }

  let detail = "";
  try {
    detail = (await res.text()).slice(0, 200);
  } catch {
    detail = "";
  }
  return {
    ok: false,
    status: res.status,
    error: detail ? `push_error: ${detail}` : "push_error",
  };
}
