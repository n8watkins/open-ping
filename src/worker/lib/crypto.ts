import type { Env } from "../types";

/**
 * Authenticated encryption for sensitive values stored in D1 (PRD §18).
 * AES-GCM via Web Crypto, 256-bit master key supplied as a Worker secret
 * (base64), unique 12-byte nonce per value. Stored format: `v1:<iv>:<ct>`
 * (both base64). The GCM tag is appended to the ciphertext by Web Crypto.
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

async function getKey(env: Env): Promise<CryptoKey> {
  if (!env.MASTER_KEY) throw new Error("MASTER_KEY secret is not configured");
  const raw = b64decode(env.MASTER_KEY);
  if (raw.byteLength !== 32) {
    throw new Error("MASTER_KEY must be 32 bytes, base64-encoded");
  }
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

export async function encryptValue(env: Env, plaintext: string): Promise<string> {
  const key = await getKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(plaintext),
  );
  return `v1:${b64encode(iv)}:${b64encode(ct)}`;
}

export async function decryptValue(env: Env, stored: string): Promise<string> {
  const [version, ivb64, ctb64] = stored.split(":");
  if (version !== "v1" || !ivb64 || !ctb64) {
    throw new Error("Unrecognized ciphertext format");
  }
  const key = await getKey(env);
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: b64decode(ivb64) },
    key,
    b64decode(ctb64),
  );
  return new TextDecoder().decode(pt);
}

/** Generate a fresh base64 master key (used by setup/docs). */
export function generateMasterKey(): string {
  return b64encode(crypto.getRandomValues(new Uint8Array(32)));
}
