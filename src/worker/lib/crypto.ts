import type { Env } from "../types";

/**
 * Authenticated encryption for sensitive values stored in D1 (PRD §18).
 *
 * AES-256-GCM via Web Crypto with a unique random 12-byte nonce per value. The
 * GCM tag is appended to the ciphertext by Web Crypto. Two stored formats exist:
 *
 * - `v2:<kid>:<iv>:<ct>` is written by every encryption. `kid` is the 8 hex
 *   character key id of the key that sealed the value (see {@link keyIdFor}),
 *   so a reader knows which key to use without trial decryption.
 * - `v1:<iv>:<ct>` is the original format with no key id. It is still read:
 *   first with `MASTER_KEY`, then with `MASTER_KEY_PREVIOUS`.
 *
 * Writes always use `MASTER_KEY`. The optional `MASTER_KEY_PREVIOUS` secret is
 * only ever used to read, which gives an online rotation its dual-key window:
 * set the old key as previous, the new key as current, re-encrypt everything
 * (lib/rekey.ts), verify nothing depends on the previous key, then remove it.
 *
 * Neither format uses AES-GCM additional data. Binding a value to its row
 * would need a stable identity at every write site, and some sites do not have
 * one (a push subscription is written before it is known which row it claims).
 */

export function b64encode(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function b64decode(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** True when a value is a base64-encoded 256-bit AES key. */
export function isValidMasterKey(value: string | undefined): boolean {
  if (!value) return false;
  try {
    return b64decode(value).byteLength === 32;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Stored format
// ---------------------------------------------------------------------------

const B64 = "[A-Za-z0-9+/=]+";
const V1_RE = new RegExp(`^v1:(${B64}):(${B64})$`);
const V2_RE = new RegExp(`^v2:([0-9a-f]{8}):(${B64}):(${B64})$`);

export type ParsedCiphertext =
  | { version: "v1"; iv: string; ct: string }
  | { version: "v2"; kid: string; iv: string; ct: string };

/**
 * Parse a STRUCTURALLY valid stored ciphertext, or null. A bare prefix sniff is
 * unsafe: a plaintext secret that happens to begin with "v1:" would be mistaken
 * for ciphertext and stored unencrypted, so every segment must have its shape.
 */
export function parseCiphertext(value: string): ParsedCiphertext | null {
  const v2 = V2_RE.exec(value);
  if (v2) return { version: "v2", kid: v2[1]!, iv: v2[2]!, ct: v2[3]! };
  const v1 = V1_RE.exec(value);
  if (v1) return { version: "v1", iv: v1[1]!, ct: v1[2]! };
  return null;
}

/** True for a structurally valid `v1:` or `v2:` stored ciphertext. */
export function isCiphertext(v: unknown): v is string {
  return typeof v === "string" && parseCiphertext(v) !== null;
}

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

/** Domain-separation label for the key id, so the id is not a reusable key hash. */
const KEY_ID_LABEL = "openping/master-key-id/v1";

export interface KeyEntry {
  /** Non-secret 8 hex character fingerprint stored in every `v2:` value. */
  kid: string;
  key: CryptoKey;
}

/**
 * Imported keys, cached per isolate by secret value. Importing (and deriving the
 * key id with an HMAC) on every call would repeat the same work for each value
 * in a list. The keys are non-extractable and the map stays tiny: an isolate
 * only ever sees its current and previous secret.
 */
const keyCache = new Map<string, Promise<KeyEntry>>();

async function importEntry(secret: string): Promise<KeyEntry> {
  const raw = b64decode(secret);
  if (raw.byteLength !== 32) {
    throw new Error("master key must be 32 bytes, base64-encoded");
  }
  const mac = await crypto.subtle.importKey(
    "raw",
    raw,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const tag = new Uint8Array(
    await crypto.subtle.sign("HMAC", mac, new TextEncoder().encode(KEY_ID_LABEL)),
  );
  const kid = Array.from(tag.slice(0, 4), (b) => b.toString(16).padStart(2, "0")).join("");
  const key = await crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
  return { kid, key };
}

function loadEntry(secret: string): Promise<KeyEntry> {
  let entry = keyCache.get(secret);
  if (!entry) {
    if (keyCache.size >= 4) keyCache.clear();
    entry = importEntry(secret);
    // Never cache a failure (a malformed secret is reported on every use).
    entry.catch(() => keyCache.delete(secret));
    keyCache.set(secret, entry);
  }
  return entry;
}

/** The key id of a base64 master key (throws for an invalid key). */
export async function keyIdFor(secret: string): Promise<string> {
  return (await loadEntry(secret)).kid;
}

export interface Keyring {
  /** `MASTER_KEY`: encrypts every write and is tried first on read. */
  current: KeyEntry | null;
  /** `MASTER_KEY_PREVIOUS`: read-only, for the rotation window. */
  previous: KeyEntry | null;
  /** True when `MASTER_KEY_PREVIOUS` is set but is not a valid 32-byte key. */
  previousInvalid: boolean;
}

let previousInvalidWarned = false;

/**
 * Resolve the configured keys. An invalid `MASTER_KEY` throws, exactly as
 * before rotation support. An invalid `MASTER_KEY_PREVIOUS` is ignored for
 * reads (with a warning) so a typo cannot take down values sealed under the
 * current key; the rotation status reports it and the re-encryption pass
 * refuses to run until it is fixed.
 */
export async function getKeyring(env: Env): Promise<Keyring> {
  let current: KeyEntry | null = null;
  if (env.MASTER_KEY) {
    try {
      current = await loadEntry(env.MASTER_KEY);
    } catch {
      throw new Error("MASTER_KEY must be 32 bytes, base64-encoded");
    }
  }
  let previous: KeyEntry | null = null;
  let previousInvalid = false;
  if (env.MASTER_KEY_PREVIOUS) {
    try {
      previous = await loadEntry(env.MASTER_KEY_PREVIOUS);
    } catch {
      previousInvalid = true;
      if (!previousInvalidWarned) {
        previousInvalidWarned = true;
        console.warn(
          "[openping] MASTER_KEY_PREVIOUS is set but is not a base64-encoded 32-byte key; it is ignored.",
        );
      }
    }
  }
  return { current, previous, previousInvalid };
}

// ---------------------------------------------------------------------------
// Encrypt / decrypt
// ---------------------------------------------------------------------------

export type DecryptErrorCode =
  /** Not a `v1:` or `v2:` value. */
  | "invalid_format"
  /** A `v2:` value whose key id matches neither configured key. */
  | "unknown_key"
  /** No configured key authenticates the value (wrong key or corrupt data). */
  | "decrypt_failed"
  /** No master key is configured at all. */
  | "no_key";

/** A value that could not be decrypted. The message never contains the value. */
export class DecryptError extends Error {
  readonly code: DecryptErrorCode;
  constructor(code: DecryptErrorCode) {
    super(`Cannot decrypt stored value: ${code}`);
    this.name = "DecryptError";
    this.code = code;
  }
}

export interface Decrypted {
  plaintext: string;
  /** Which configured key opened the value. */
  keyRole: "current" | "previous";
  version: "v1" | "v2";
}

async function tryKey(entry: KeyEntry, iv: string, ct: string): Promise<string | null> {
  try {
    const pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: b64decode(iv) },
      entry.key,
      b64decode(ct),
    );
    return new TextDecoder().decode(pt);
  } catch {
    return null;
  }
}

/** Decrypt with an already resolved keyring, reporting which key worked. */
export async function decryptWithKeyring(
  keyring: Keyring,
  stored: string,
): Promise<Decrypted> {
  const parsed = parseCiphertext(stored);
  if (!parsed) throw new DecryptError("invalid_format");

  const candidates: Array<["current" | "previous", KeyEntry]> = [];
  if (keyring.current) candidates.push(["current", keyring.current]);
  if (keyring.previous) candidates.push(["previous", keyring.previous]);
  if (candidates.length === 0) throw new DecryptError("no_key");

  // A v2 value names its key; only a v1 value needs trial decryption. Both
  // keys are still tried for v2 when their ids collide (1 in 2^32).
  const usable =
    parsed.version === "v2"
      ? candidates.filter(([, entry]) => entry.kid === parsed.kid)
      : candidates;
  if (usable.length === 0) throw new DecryptError("unknown_key");

  for (const [keyRole, entry] of usable) {
    const plaintext = await tryKey(entry, parsed.iv, parsed.ct);
    if (plaintext !== null) return { plaintext, keyRole, version: parsed.version };
  }
  throw new DecryptError("decrypt_failed");
}

/** Encrypt with an already resolved keyring (always the current key). */
export async function encryptWithKeyring(
  keyring: Keyring,
  plaintext: string,
): Promise<string> {
  const entry = keyring.current;
  if (!entry) throw new Error("MASTER_KEY secret is not configured");
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    entry.key,
    new TextEncoder().encode(plaintext),
  );
  return `v2:${entry.kid}:${b64encode(iv)}:${b64encode(ct)}`;
}

export async function encryptValue(env: Env, plaintext: string): Promise<string> {
  if (!env.MASTER_KEY) throw new Error("MASTER_KEY secret is not configured");
  return encryptWithKeyring(await getKeyring(env), plaintext);
}

/** Decrypt a stored value with `MASTER_KEY`, falling back to `MASTER_KEY_PREVIOUS`. */
export async function decryptValue(env: Env, stored: string): Promise<string> {
  return (await decryptWithKeyring(await getKeyring(env), stored)).plaintext;
}

/** Generate a fresh base64 master key (used by setup/docs). */
export function generateMasterKey(): string {
  return b64encode(crypto.getRandomValues(new Uint8Array(32)));
}
