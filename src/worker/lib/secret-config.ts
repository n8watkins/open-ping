import type { Env } from "../types";
import type { MonitorType } from "../../shared/states";
import { encryptValue, decryptValue } from "./crypto";

/**
 * Encryption-at-rest helpers for monitor configuration.
 *
 * New writes seal the entire config document because credentials can appear in
 * URLs, query parameters, custom headers, and request bodies in addition to the
 * explicitly modelled authentication fields. Reads also support the older
 * format where only known secret fields were encrypted.
 *
 * Encryption remains best-effort when `MASTER_KEY` is not configured so an
 * existing no-key deployment keeps working, but it emits an operational warning.
 */

/** Every known sensitive location, scanned when the type is unknown. */
const ALL_SECRET_PATHS: readonly string[] = ["secret", "auth.password", "auth.token"];

const CIPHERTEXT_PREFIX = "v1:";
const SEALED_CONFIG_KEY = "__openping_sealed_config_v1";

type SealedConfig = { [SEALED_CONFIG_KEY]: string };

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

/** Identify the intentionally narrow envelope used for whole-config encryption. */
function isSealedConfig(config: Record<string, unknown>): config is SealedConfig {
  const keys = Object.keys(config);
  return (
    keys.length === 1 &&
    keys[0] === SEALED_CONFIG_KEY &&
    isCiphertext(config[SEALED_CONFIG_KEY])
  );
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
    const next = cur[parts[i]!]; // i < parts.length - 1, so parts[i] exists
    if (next === null || typeof next !== "object") return;
    cur = next as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]!] = value; // split() yields ≥1 element
}

/**
 * Deep-clone and seal the complete config as one encrypted JSON document.
 * Existing sealed documents are returned unchanged, making the operation
 * idempotent. When `MASTER_KEY` is unset, the plaintext clone is returned.
 */
export async function encryptConfig(
  env: Env,
  _type: MonitorType,
  config: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const clone = structuredClone(config);
  if (!env.MASTER_KEY) {
    if (!encryptionDisabledWarned && Object.keys(clone).length > 0) {
      encryptionDisabledWarned = true;
      console.warn(
        "[openping] MASTER_KEY is not configured: encryption-at-rest is DISABLED. " +
          "Monitor configuration and other secrets may be stored in PLAINTEXT in D1. " +
          "Set the MASTER_KEY Worker secret to enable encryption.",
      );
    }
    return clone;
  }

  if (isSealedConfig(clone)) {
    return clone;
  }

  return {
    [SEALED_CONFIG_KEY]: await encryptValue(env, JSON.stringify(clone)),
  };
}

/**
 * Decrypt a sealed config document, then decrypt legacy field-level ciphertext.
 * Plaintext legacy rows remain readable. A failed decrypt does not throw outward
 * so a missing or rotated key does not make every monitor query fail.
 */
export async function decryptConfig(
  env: Env,
  config: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  let clone = structuredClone(config);

  if (isSealedConfig(clone)) {
    try {
      const plaintext = await decryptValue(env, clone[SEALED_CONFIG_KEY]);
      const parsed: unknown = JSON.parse(plaintext);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        return clone;
      }
      clone = parsed as Record<string, unknown>;
    } catch {
      return clone;
    }
  }

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
