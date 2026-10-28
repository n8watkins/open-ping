import { decodeCbor, decodeCborFirst, type CborMap, type CborValue } from "./cbor";

/**
 * WebAuthn (passkey) registration and assertion verification with Web Crypto
 * only: no dependency, and no I/O, so every check is unit-tested with real
 * signatures (src/worker/lib/webauthn.test.ts). Storage, challenges and
 * sessions live in routes/passkeys.ts.
 *
 * Policy, from WebAuthn Level 3 sections 7.1 and 7.2:
 * - The client data type, challenge and origin must match exactly.
 * - The RP ID hash in the authenticator data must be SHA-256 of our RP ID.
 * - User presence AND user verification are required (a passkey is the whole
 *   sign-in, so it must be a PIN, biometric or device unlock, not a tap).
 * - Algorithms: ES256 (-7) and RS256 (-257), the two every platform supports.
 * - Attestation is requested as "none" and never trusted: OpenPing doesn't
 *   restrict authenticator models, so an attestation statement, if a client
 *   sends one anyway, is ignored rather than verified.
 * - Signature counter: when either the stored or the new counter is non-zero,
 *   the new one must be larger, otherwise the credential may have been cloned.
 *   Synced passkeys always report 0, which is allowed.
 */

export const COSE_ALG_ES256 = -7;
export const COSE_ALG_RS256 = -257;
export const SUPPORTED_ALGS = [COSE_ALG_ES256, COSE_ALG_RS256] as const;

/** Authenticator data flag bits. */
const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_BE = 0x08;
const FLAG_BS = 0x10;
const FLAG_AT = 0x40;
const FLAG_ED = 0x80;

export type WebAuthnErrorCode =
  | "malformed"
  | "wrong_type"
  | "challenge_mismatch"
  | "origin_mismatch"
  | "cross_origin"
  | "rp_id_mismatch"
  | "user_not_present"
  | "user_not_verified"
  | "unsupported_algorithm"
  | "credential_id_mismatch"
  | "user_handle_mismatch"
  | "bad_signature"
  | "counter_regressed";

export class WebAuthnError extends Error {
  readonly code: WebAuthnErrorCode;
  constructor(code: WebAuthnErrorCode, message?: string) {
    super(message ?? code);
    this.name = "WebAuthnError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Encoding helpers
// ---------------------------------------------------------------------------

export function base64urlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Decode unpadded (or padded) base64url; throws WebAuthnError("malformed") on junk. */
export function base64urlDecode(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*={0,2}$/.test(value)) throw new WebAuthnError("malformed", "not base64url");
  const b64 = value.replace(/=+$/, "").replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  let bin: string;
  try {
    bin = atob(padded);
  } catch {
    throw new WebAuthnError("malformed", "not base64url");
  }
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", data));
}

/** Compare byte strings without an early exit (lengths are not secret here). */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Client data
// ---------------------------------------------------------------------------

export interface ClientData {
  type: string;
  challenge: string;
  origin: string;
  crossOrigin?: boolean;
}

/** Parse clientDataJSON (base64url) into its fields; malformed input throws. */
export function parseClientData(clientDataJSON: string): { data: ClientData; raw: Uint8Array } {
  const raw = base64urlDecode(clientDataJSON);
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(raw));
  } catch {
    throw new WebAuthnError("malformed", "clientDataJSON is not JSON");
  }
  const d = parsed as Partial<ClientData> | null;
  if (
    !d ||
    typeof d !== "object" ||
    typeof d.type !== "string" ||
    typeof d.challenge !== "string" ||
    typeof d.origin !== "string" ||
    (d.crossOrigin !== undefined && typeof d.crossOrigin !== "boolean")
  ) {
    throw new WebAuthnError("malformed", "clientDataJSON is missing fields");
  }
  return { data: d as ClientData, raw };
}

/** The challenge a response claims to answer, so the caller can look it up. */
export function challengeOf(clientDataJSON: string): string {
  return parseClientData(clientDataJSON).data.challenge;
}

function checkClientData(
  data: ClientData,
  type: "webauthn.create" | "webauthn.get",
  expected: { challenge: string; origin: string },
): void {
  if (data.type !== type) throw new WebAuthnError("wrong_type");
  if (!bytesEqual(new TextEncoder().encode(data.challenge), new TextEncoder().encode(expected.challenge))) {
    throw new WebAuthnError("challenge_mismatch");
  }
  if (data.origin !== expected.origin) throw new WebAuthnError("origin_mismatch");
  // OpenPing is never embedded in another site's frame for sign-in.
  if (data.crossOrigin === true) throw new WebAuthnError("cross_origin");
}

// ---------------------------------------------------------------------------
// Authenticator data
// ---------------------------------------------------------------------------

export interface AuthenticatorData {
  rpIdHash: Uint8Array;
  flags: number;
  userPresent: boolean;
  userVerified: boolean;
  backupEligible: boolean;
  backupState: boolean;
  signCount: number;
  attested?: {
    aaguid: Uint8Array;
    credentialId: Uint8Array;
    publicKey: Uint8Array;
  };
}

/** Parse authenticator data (WebAuthn section 6.1), bounds-checked throughout. */
export function parseAuthenticatorData(bytes: Uint8Array): AuthenticatorData {
  if (bytes.length < 37) throw new WebAuthnError("malformed", "authenticator data too short");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const flags = bytes[32]!;
  const out: AuthenticatorData = {
    rpIdHash: bytes.slice(0, 32),
    flags,
    userPresent: (flags & FLAG_UP) !== 0,
    userVerified: (flags & FLAG_UV) !== 0,
    backupEligible: (flags & FLAG_BE) !== 0,
    backupState: (flags & FLAG_BS) !== 0,
    signCount: view.getUint32(33),
  };
  let offset = 37;
  if (flags & FLAG_AT) {
    if (bytes.length < offset + 18) throw new WebAuthnError("malformed", "attested data too short");
    const aaguid = bytes.slice(offset, offset + 16);
    const idLen = view.getUint16(offset + 16);
    offset += 18;
    if (idLen === 0 || idLen > 1023 || bytes.length < offset + idLen) {
      throw new WebAuthnError("malformed", "bad credential id length");
    }
    const credentialId = bytes.slice(offset, offset + idLen);
    offset += idLen;
    let keyLength: number;
    try {
      keyLength = decodeCborFirst(bytes.subarray(offset)).length;
    } catch {
      throw new WebAuthnError("malformed", "bad credential public key");
    }
    out.attested = { aaguid, credentialId, publicKey: bytes.slice(offset, offset + keyLength) };
    offset += keyLength;
  }
  if (flags & FLAG_ED) {
    try {
      offset += decodeCborFirst(bytes.subarray(offset)).length;
    } catch {
      throw new WebAuthnError("malformed", "bad extensions");
    }
  }
  if (offset !== bytes.length) throw new WebAuthnError("malformed", "trailing authenticator data");
  return out;
}

async function checkAuthData(auth: AuthenticatorData, rpId: string): Promise<void> {
  const expected = await sha256(new TextEncoder().encode(rpId));
  if (!bytesEqual(auth.rpIdHash, expected)) throw new WebAuthnError("rp_id_mismatch");
  if (!auth.userPresent) throw new WebAuthnError("user_not_present");
  if (!auth.userVerified) throw new WebAuthnError("user_not_verified");
}

// ---------------------------------------------------------------------------
// COSE keys
// ---------------------------------------------------------------------------

export interface ImportedKey {
  alg: number;
  key: CryptoKey;
}

function mapGet(map: CborMap, label: number): CborValue {
  return map.get(label);
}

function bytesField(map: CborMap, label: number): Uint8Array {
  const v = mapGet(map, label);
  if (!(v instanceof Uint8Array)) throw new WebAuthnError("malformed", `COSE key field ${label} missing`);
  return v;
}

/**
 * Import a COSE_Key (RFC 9053) as a Web Crypto verification key. Only ES256 on
 * P-256 and RS256 (at least 2048-bit) are accepted.
 */
export async function importCoseKey(cose: Uint8Array): Promise<ImportedKey> {
  let decoded: CborValue;
  try {
    decoded = decodeCbor(cose);
  } catch {
    throw new WebAuthnError("malformed", "COSE key is not CBOR");
  }
  if (!(decoded instanceof Map)) throw new WebAuthnError("malformed", "COSE key is not a map");
  const kty = mapGet(decoded, 1);
  const alg = mapGet(decoded, 3);

  if (alg === COSE_ALG_ES256) {
    // kty 2 (EC2), crv 1 (P-256), x -2, y -3, 32 bytes each.
    if (kty !== 2 || mapGet(decoded, -1) !== 1) throw new WebAuthnError("unsupported_algorithm");
    const x = bytesField(decoded, -2);
    const y = bytesField(decoded, -3);
    if (x.length !== 32 || y.length !== 32) throw new WebAuthnError("malformed", "bad P-256 point");
    try {
      const key = await crypto.subtle.importKey(
        "jwk",
        { kty: "EC", crv: "P-256", x: base64urlEncode(x), y: base64urlEncode(y), ext: true },
        { name: "ECDSA", namedCurve: "P-256" },
        false,
        ["verify"],
      );
      return { alg, key };
    } catch {
      throw new WebAuthnError("malformed", "P-256 point is not on the curve");
    }
  }

  if (alg === COSE_ALG_RS256) {
    // kty 3 (RSA), n -1, e -2.
    if (kty !== 3) throw new WebAuthnError("unsupported_algorithm");
    const n = bytesField(decoded, -1);
    const e = bytesField(decoded, -2);
    if (n.length < 256 || n.length > 512 || e.length === 0 || e.length > 8) {
      throw new WebAuthnError("unsupported_algorithm", "RSA key size not allowed");
    }
    try {
      const key = await crypto.subtle.importKey(
        "jwk",
        { kty: "RSA", n: base64urlEncode(n), e: base64urlEncode(e), alg: "RS256", ext: true },
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["verify"],
      );
      return { alg, key };
    } catch {
      throw new WebAuthnError("malformed", "bad RSA key");
    }
  }

  throw new WebAuthnError("unsupported_algorithm");
}

/**
 * Convert an ASN.1 DER ECDSA signature (what authenticators send) into the
 * fixed-width r || s form Web Crypto verifies. Strict: one SEQUENCE of two
 * positive INTEGERs, short-form lengths, nothing after it.
 */
export function derToRawEcdsa(der: Uint8Array, size = 32): Uint8Array {
  const fail = () => new WebAuthnError("bad_signature", "malformed ECDSA signature");
  let o = 0;
  if (der[o++] !== 0x30) throw fail();
  const seqLen = der[o++];
  if (seqLen === undefined || seqLen > 0x7f || o + seqLen !== der.length) throw fail();
  const readInt = (): Uint8Array => {
    if (der[o++] !== 0x02) throw fail();
    const len = der[o++];
    if (len === undefined || len === 0 || len > size + 1 || o + len > der.length) throw fail();
    let int = der.subarray(o, o + len);
    o += len;
    if ((int[0]! & 0x80) !== 0) throw fail(); // negative
    if (int.length > 1 && int[0] === 0 && (int[1]! & 0x80) === 0) throw fail(); // non-minimal
    if (int[0] === 0 && int.length > 1) int = int.subarray(1);
    if (int.length > size) throw fail();
    const out = new Uint8Array(size);
    out.set(int, size - int.length);
    return out;
  };
  const r = readInt();
  const s = readInt();
  if (o !== der.length) throw fail();
  return concat(r, s);
}

async function verifySignature(
  imported: ImportedKey,
  signature: Uint8Array,
  data: Uint8Array,
): Promise<boolean> {
  if (imported.alg === COSE_ALG_ES256) {
    return crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      imported.key,
      derToRawEcdsa(signature),
      data,
    );
  }
  return crypto.subtle.verify({ name: "RSASSA-PKCS1-v1_5" }, imported.key, signature, data);
}

// ---------------------------------------------------------------------------
// Ceremonies
// ---------------------------------------------------------------------------

/** What the browser sends back from navigator.credentials.create(), base64url-encoded. */
export interface RegistrationResponseJSON {
  id: string;
  rawId: string;
  type: "public-key";
  response: {
    clientDataJSON: string;
    attestationObject: string;
    transports?: string[];
  };
}

/** What the browser sends back from navigator.credentials.get(), base64url-encoded. */
export interface AuthenticationResponseJSON {
  id: string;
  rawId: string;
  type: "public-key";
  response: {
    clientDataJSON: string;
    authenticatorData: string;
    signature: string;
    userHandle?: string | null;
  };
}

export interface Expected {
  challenge: string;
  origin: string;
  rpId: string;
}

export interface VerifiedRegistration {
  credentialId: string;
  /** The COSE public key, base64url. Public, so it is stored as is. */
  publicKey: string;
  alg: number;
  signCount: number;
  aaguid: string;
  backupEligible: boolean;
  backupState: boolean;
  attestationFormat: string;
}

/** Verify a registration (attestation) response. Throws WebAuthnError on any failure. */
export async function verifyRegistration(
  credential: RegistrationResponseJSON,
  expected: Expected,
): Promise<VerifiedRegistration> {
  if (credential.type !== "public-key") throw new WebAuthnError("malformed", "not a public-key credential");
  const { data } = parseClientData(credential.response.clientDataJSON);
  checkClientData(data, "webauthn.create", expected);

  let attestation: CborValue;
  try {
    attestation = decodeCbor(base64urlDecode(credential.response.attestationObject));
  } catch (e) {
    if (e instanceof WebAuthnError) throw e;
    throw new WebAuthnError("malformed", "attestationObject is not CBOR");
  }
  if (!(attestation instanceof Map)) throw new WebAuthnError("malformed", "attestationObject is not a map");
  const fmt = attestation.get("fmt");
  const attStmt = attestation.get("attStmt");
  const authDataBytes = attestation.get("authData");
  if (typeof fmt !== "string" || !(attStmt instanceof Map) || !(authDataBytes instanceof Uint8Array)) {
    throw new WebAuthnError("malformed", "attestationObject is missing fields");
  }
  // "none" must carry an empty statement. Any other format is accepted but its
  // statement is not trusted or used (we asked for "none").
  if (fmt === "none" && attStmt.size !== 0) {
    throw new WebAuthnError("malformed", "none attestation with a statement");
  }

  const auth = parseAuthenticatorData(authDataBytes);
  await checkAuthData(auth, expected.rpId);
  if (!auth.attested) throw new WebAuthnError("malformed", "no attested credential data");

  const rawId = base64urlDecode(credential.rawId);
  if (!bytesEqual(rawId, auth.attested.credentialId) || credential.id !== credential.rawId) {
    throw new WebAuthnError("credential_id_mismatch");
  }
  const imported = await importCoseKey(auth.attested.publicKey);

  return {
    credentialId: base64urlEncode(auth.attested.credentialId),
    publicKey: base64urlEncode(auth.attested.publicKey),
    alg: imported.alg,
    signCount: auth.signCount,
    aaguid: [...auth.attested.aaguid].map((b) => b.toString(16).padStart(2, "0")).join(""),
    backupEligible: auth.backupEligible,
    backupState: auth.backupState,
    attestationFormat: fmt,
  };
}

export interface StoredCredential {
  credentialId: string;
  publicKey: string;
  signCount: number;
}

export interface VerifiedAuthentication {
  /** The counter to store; unchanged (0) for authenticators without one. */
  signCount: number;
  backupState: boolean;
}

/**
 * Pure counter rule: allowed when both are zero (no counter) or the new value
 * is strictly larger than the stored one.
 */
export function counterAllows(stored: number, next: number): boolean {
  if (stored === 0 && next === 0) return true;
  return next > stored;
}

/** Verify an authentication (assertion) response against a stored credential. */
export async function verifyAuthentication(
  credential: AuthenticationResponseJSON,
  expected: Expected & { userHandle: string },
  stored: StoredCredential,
): Promise<VerifiedAuthentication> {
  if (credential.type !== "public-key") throw new WebAuthnError("malformed", "not a public-key credential");
  if (credential.id !== credential.rawId || credential.rawId !== stored.credentialId) {
    throw new WebAuthnError("credential_id_mismatch");
  }
  const { data, raw: clientDataRaw } = parseClientData(credential.response.clientDataJSON);
  checkClientData(data, "webauthn.get", expected);

  const authDataBytes = base64urlDecode(credential.response.authenticatorData);
  const auth = parseAuthenticatorData(authDataBytes);
  await checkAuthData(auth, expected.rpId);

  // A discoverable credential returns the user handle we gave it at
  // registration; when present it must be this install's admin handle.
  const handle = credential.response.userHandle;
  if (handle != null && handle !== "" && handle !== expected.userHandle) {
    throw new WebAuthnError("user_handle_mismatch");
  }

  const imported = await importCoseKey(base64urlDecode(stored.publicKey));
  const signed = concat(authDataBytes, await sha256(clientDataRaw));
  const signature = base64urlDecode(credential.response.signature);
  if (!(await verifySignature(imported, signature, signed))) throw new WebAuthnError("bad_signature");

  if (!counterAllows(stored.signCount, auth.signCount)) throw new WebAuthnError("counter_regressed");
  return { signCount: auth.signCount, backupState: auth.backupState };
}
