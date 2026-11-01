// The two encryption formats the drills read and write, from the operator's
// machine, with Web Crypto only:
//
//   - an escrowed tenant MASTER_KEY: `v1:<iv>:<ct>` (base64url), AES-256-GCM
//     under PLATFORM_KEY with additional data binding it to its tenant and
//     key id (platform/src/keys.ts);
//   - a value OpenPing seals with its MASTER_KEY: `v2:<kid>:<iv>:<ct>` (or the
//     older `v1:<iv>:<ct>`), standard base64, AES-256-GCM, no additional data
//     (src/worker/lib/crypto.ts), and a monitor's whole config sealed as
//     `{"__openping_sealed_config_v1": "v2:..."}` (src/worker/lib/secret-config.ts).
//
// keys.test.mjs checks both directions against those TypeScript modules, so
// the formats can't drift apart.

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const ESCROW_VERSION = "v1";
const ESCROW_AAD_LABEL = "openping/escrowed-master-key/v1";
const KEY_ID_LABEL = "openping/master-key-id/v1";
export const SEALED_CONFIG_KEY = "__openping_sealed_config_v1";

const B64 = "[A-Za-z0-9+/=]+";
const V1_RE = new RegExp(`^v1:(${B64}):(${B64})$`);
const V2_RE = new RegExp(`^v2:([0-9a-f]{8}):(${B64}):(${B64})$`);

export function b64encode(bytes) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function b64decode(text) {
  const bin = atob(text);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function base64urlDecode(text) {
  if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) return null;
  const padded = text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4);
  try {
    return b64decode(padded);
  } catch {
    return null;
  }
}

/** A base64 32-byte key (MASTER_KEY or PLATFORM_KEY), or null. */
function rawKey(value) {
  if (typeof value !== "string" || !value) return null;
  try {
    const raw = b64decode(value);
    return raw.byteLength === 32 ? raw : null;
  } catch {
    return null;
  }
}

export const isValidKey = (value) => rawKey(value) !== null;

async function aesKey(secret, what) {
  const raw = rawKey(secret);
  if (!raw) throw new Error(`${what} must be 32 bytes, base64-encoded`);
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

/** The 8 hex character key id OpenPing writes into every `v2:` value. */
export async function keyIdFor(masterKey) {
  const raw = rawKey(masterKey);
  if (!raw) throw new Error("master key must be 32 bytes, base64-encoded");
  const mac = await crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const tag = new Uint8Array(await crypto.subtle.sign("HMAC", mac, encoder.encode(KEY_ID_LABEL)));
  return Array.from(tag.slice(0, 4), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Opens an escrowed key ({ kid, ciphertext } of escrowed_keys or export_keys). Throws when it doesn't open. */
export async function openEscrowedKey(escrowed, tenantId, platformKey) {
  const [version, ivPart, ctPart, ...rest] = String(escrowed?.ciphertext ?? "").split(":");
  const iv = ivPart ? base64urlDecode(ivPart) : null;
  const ct = ctPart ? base64urlDecode(ctPart) : null;
  if (version !== ESCROW_VERSION || rest.length || !iv || iv.length !== 12 || !ct) throw new Error("escrowed key: unknown format");
  const key = await aesKey(platformKey, "PLATFORM_KEY");
  let plain;
  try {
    plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: encoder.encode(`${ESCROW_AAD_LABEL}|${tenantId}|${escrowed.kid}`) }, key, ct);
  } catch {
    throw new Error("escrowed key: does not open with this PLATFORM_KEY for this tenant");
  }
  const masterKey = decoder.decode(plain);
  if (!isValidKey(masterKey) || (await keyIdFor(masterKey)) !== escrowed.kid) throw new Error("escrowed key: key id mismatch");
  return masterKey;
}

/** The parts of a stored ciphertext, or null for anything else. */
export function parseCiphertext(value) {
  if (typeof value !== "string") return null;
  const v2 = V2_RE.exec(value);
  if (v2) return { version: "v2", kid: v2[1], iv: v2[2], ct: v2[3] };
  const v1 = V1_RE.exec(value);
  if (v1) return { version: "v1", iv: v1[1], ct: v1[2] };
  return null;
}

/** Seals `plaintext` as OpenPing does: `v2:<kid>:<iv>:<ct>`. */
export async function encryptValue(masterKey, plaintext) {
  const key = await aesKey(masterKey, "MASTER_KEY");
  const kid = await keyIdFor(masterKey);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoder.encode(plaintext)));
  return `v2:${kid}:${b64encode(iv)}:${b64encode(ct)}`;
}

/** Opens a stored value with `masterKey`. Throws for another key's value, a wrong key or tampering. */
export async function decryptValue(masterKey, stored) {
  const parsed = parseCiphertext(stored);
  if (!parsed) throw new Error("not a stored ciphertext");
  if (parsed.version === "v2" && parsed.kid !== (await keyIdFor(masterKey))) throw new Error(`sealed with another key (${parsed.kid})`);
  const key = await aesKey(masterKey, "MASTER_KEY");
  try {
    return decoder.decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64decode(parsed.iv) }, key, b64decode(parsed.ct)));
  } catch {
    throw new Error("does not decrypt with this MASTER_KEY");
  }
}

/** A monitor's stored config: the whole document sealed as one value, as createMonitor writes it. */
export async function sealConfig(masterKey, config) {
  return { [SEALED_CONFIG_KEY]: await encryptValue(masterKey, JSON.stringify(config)) };
}
