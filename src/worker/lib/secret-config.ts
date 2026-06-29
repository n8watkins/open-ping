import type { Env } from "../types";
import { encryptValue, decryptValue } from "./crypto";

/**
 * Encryption-at-rest helpers for sensitive monitor config fields (PRD §18,
 * acceptance #30). These operate on a loose `Record<string, unknown>` config so
 * the same code serves both monitor types; the caller supplies the monitor
 * `type` where it matters.
 *
 * Sensitive locations:
 *   - http monitor:      `auth.password` (basic), `auth.token` (bearer)
 *   - heartbeat monitor: `secret`
 *
 * Encryption is BEST-EFFORT: when `env.MASTER_KEY` is not configured the config
 * is stored as plaintext, and decryption silently leaves non-ciphertext (or
 * undecryptable) values untouched. Stored ciphertext uses the `v1:` prefix
 * produced by `encryptValue` (see ./crypto).
 */

/** Sensitive paths to encrypt for a given monitor type. */
const SECRET_PATHS: Record<"http" | "heartbeat", readonly string[]> = {
  http: ["auth.password", "auth.token"],
  heartbeat: ["secret"],
};

/** Every known sensitive location, scanned when the type is unknown. */
const ALL_SECRET_PATHS: readonly string[] = ["secret", "auth.password", "auth.token"];

const CIPHERTEXT_PREFIX = "v1:";

/**
 * Guards the "encryption-at-rest disabled" warning so it is emitted at most once
 * per isolate. Best-effort encryption stays silent on the happy path, but a
 * deploy with no `MASTER_KEY` should not unknowingly persist secrets in cleartext
 * without leaving any operational signal.
 */
let encryptionDisabledWarned = false;

/**
 * True only for a STRUCTURALLY valid `v1:<iv>:<ct>` ciphertext (both segments
 * base64). A bare `startsWith("v1:")` prefix sniff is unsafe: a plaintext secret
 * the admin happens to begin with "v1:" would be mistaken for ciphertext and
 * skipped by the encryptor, silently stored in plaintext at rest. Requiring the
 * full two-segment base64 shape closes that collision so such values get
 * encrypted normally.
 */
export function isCiphertext(v: unknown): v is string {
  return typeof v === "string" && /^v1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/.test(v);
}

/** True for a non-empty string value (a secret worth protecting). */
export function secretValuePresent(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

/** Read a dotted path (e.g. `auth.token`); undefined if any segment is missing. */
function getPath(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split(".");
  let cur: unknown = obj;
  for (const part of parts) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/**
 * Write a dotted path. Does NOT create missing intermediate objects — if the
 * parent container is absent (e.g. no `auth` object), the write is a no-op.
 */
function setPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split(".");
  let cur: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const next = cur[parts[i]];
    if (next === null || typeof next !== "object") return;
    cur = next as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]] = value;
}

/**
 * Deep-clone `config`, encrypting each sensitive field that holds a non-empty
 * plaintext string. Idempotent: values already prefixed `v1:` are left as-is.
 * When `env.MASTER_KEY` is unset the clone is returned UNCHANGED (best-effort
 * encryption — values remain plaintext at rest).
 */
export async function encryptConfig(
  env: Env,
  type: "http" | "heartbeat",
  config: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const clone = structuredClone(config);
  if (!env.MASTER_KEY) {
    // Stay best-effort (no throw — that would break intentional no-key deploys),
    // but make the fail-open OBSERVABLE: if we were actually handed a plaintext
    // secret to persist, warn once that encryption-at-rest is off.
    if (
      !encryptionDisabledWarned &&
      SECRET_PATHS[type].some((path) => {
        const value = getPath(clone, path);
        return secretValuePresent(value) && !isCiphertext(value);
      })
    ) {
      encryptionDisabledWarned = true;
      console.warn(
        "[openping] MASTER_KEY is not configured: encryption-at-rest is DISABLED. " +
          "Monitor/channel/VAPID secrets are being stored in PLAINTEXT in D1. " +
          "Set the MASTER_KEY Worker secret to enable encryption.",
      );
    }
    return clone;
  }
  for (const path of SECRET_PATHS[type]) {
    const value = getPath(clone, path);
    if (secretValuePresent(value) && !isCiphertext(value)) {
      setPath(clone, path, await encryptValue(env, value));
    }
  }
  return clone;
}

/**
 * Deep-clone `config`, decrypting each sensitive field whose value is a `v1:`
 * ciphertext. Plaintext (non-`v1:`) values are left untouched, and a failed
 * decrypt never throws outward — the offending value is left as-is so the rest
 * of the config still resolves.
 */
export async function decryptConfig(
  env: Env,
  config: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const clone = structuredClone(config);
  for (const path of ALL_SECRET_PATHS) {
    const value = getPath(clone, path);
    if (typeof value === "string" && value.startsWith(CIPHERTEXT_PREFIX)) {
      try {
        setPath(clone, path, await decryptValue(env, value));
      } catch {
        // Leave the value as-is (missing/wrong key, corrupt ciphertext) and
        // continue scanning the remaining sensitive fields.
      }
    }
  }
  return clone;
}

/**
 * Deep-clone `config` with every sensitive field value blanked to `""` so API
 * responses never expose secrets. The editor treats an empty value as
 * "unchanged" (see `mergeSecrets`).
 */
export function redactConfig(config: Record<string, unknown>): Record<string, unknown> {
  const clone = structuredClone(config);
  for (const path of ALL_SECRET_PATHS) {
    if (typeof getPath(clone, path) === "string") {
      setPath(clone, path, "");
    }
  }
  return clone;
}

/**
 * Update-flow merge: deep-clone of `incoming`, but for each sensitive field
 * whose incoming value is empty/absent while the existing value is a non-empty
 * string, carry the existing value forward. This lets a redacted-then-
 * resubmitted config retain its stored secret.
 */
export function mergeSecrets(
  incoming: Record<string, unknown>,
  existing: Record<string, unknown>,
): Record<string, unknown> {
  const clone = structuredClone(incoming);
  for (const path of ALL_SECRET_PATHS) {
    if (!secretValuePresent(getPath(clone, path))) {
      const existingValue = getPath(existing, path);
      if (secretValuePresent(existingValue)) {
        setPath(clone, path, existingValue);
      }
    }
  }
  return clone;
}
