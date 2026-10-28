import { describe, it, expect } from "vitest";
import {
  encryptValue,
  decryptValue,
  decryptWithKeyring,
  getKeyring,
  generateMasterKey,
  b64decode,
  b64encode,
  isValidMasterKey,
  keyIdFor,
  parseCiphertext,
  DecryptError,
} from "./crypto";
import type { Env } from "../types";

function envWithKey(key = generateMasterKey()): Env {
  return { MASTER_KEY: key } as unknown as Env;
}

describe("crypto", () => {
  it("round-trips plaintext", async () => {
    const env = envWithKey();
    const ct = await encryptValue(env, "hunter2");
    expect(ct).toMatch(/^v2:[0-9a-f]{8}:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/);
    expect(await decryptValue(env, ct)).toBe("hunter2");
  });

  it("produces unique ciphertexts via random nonce", async () => {
    const env = envWithKey();
    const a = await encryptValue(env, "same");
    const b = await encryptValue(env, "same");
    expect(a).not.toBe(b);
    expect(await decryptValue(env, a)).toBe("same");
  });

  it("fails to decrypt with a different key", async () => {
    const ct = await encryptValue(envWithKey(), "secret");
    await expect(decryptValue(envWithKey(), ct)).rejects.toThrow();
  });

  it("rejects a missing master key", async () => {
    await expect(encryptValue({} as Env, "x")).rejects.toThrow(/MASTER_KEY/);
  });

  it("generates 32-byte keys", () => {
    expect(b64decode(generateMasterKey()).byteLength).toBe(32);
    expect(isValidMasterKey(generateMasterKey())).toBe(true);
  });

  it("rejects missing, malformed, and incorrectly sized master keys", () => {
    expect(isValidMasterKey(undefined)).toBe(false);
    expect(isValidMasterKey("not base64")).toBe(false);
    expect(isValidMasterKey(btoa("too short"))).toBe(false);
  });
});

/** Seal a value in the original v1 format (no key id), as older releases did. */
async function encryptV1(key: string, plaintext: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", b64decode(key), { name: "AES-GCM" }, false, [
    "encrypt",
  ]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, k, new TextEncoder().encode(plaintext));
  return `v1:${b64encode(iv)}:${b64encode(ct)}`;
}

function rotatingEnv(current: string, previous?: string): Env {
  return { MASTER_KEY: current, MASTER_KEY_PREVIOUS: previous } as unknown as Env;
}

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return e instanceof DecryptError ? e.code : `other:${String(e)}`;
  }
  return "resolved";
}

describe("ciphertext formats", () => {
  it("parses v1 and v2 values and rejects anything else", () => {
    expect(parseCiphertext("v1:AAAA:BBBB")).toEqual({ version: "v1", iv: "AAAA", ct: "BBBB" });
    expect(parseCiphertext("v2:0a1b2c3d:AAAA:BBBB")).toEqual({
      version: "v2",
      kid: "0a1b2c3d",
      iv: "AAAA",
      ct: "BBBB",
    });
    for (const bad of [
      "",
      "v1:",
      "v1:AAAA",
      "v1:AAAA:BBBB:CCCC",
      "v2:AAAA:BBBB",
      "v2:0a1b2c3:AAAA:BBBB",
      "v2:0a1b2c3d:AAAA",
      "v2:0a1b2c3d:AA AA:BBBB",
      "v3:0a1b2c3d:AAAA:BBBB",
      "https://example.com/hook",
    ]) {
      expect(parseCiphertext(bad)).toBeNull();
    }
  });

  it("derives a stable, key-specific 8 hex character key id", async () => {
    const a = generateMasterKey();
    const b = generateMasterKey();
    const kidA = await keyIdFor(a);
    expect(kidA).toMatch(/^[0-9a-f]{8}$/);
    expect(await keyIdFor(a)).toBe(kidA);
    expect(await keyIdFor(b)).not.toBe(kidA);
    expect(await encryptValue(rotatingEnv(a), "x")).toMatch(new RegExp(`^v2:${kidA}:`));
  });

  it("still reads v1 values written by older releases", async () => {
    const key = generateMasterKey();
    expect(await decryptValue(rotatingEnv(key), await encryptV1(key, "legacy"))).toBe("legacy");
  });
});

describe("dual-key reads", () => {
  it("writes with MASTER_KEY even while a previous key is configured", async () => {
    const oldKey = generateMasterKey();
    const newKey = generateMasterKey();
    const ct = await encryptValue(rotatingEnv(newKey, oldKey), "fresh");
    expect(ct.startsWith(`v2:${await keyIdFor(newKey)}:`)).toBe(true);
    // Readable with the new key alone, so it never needs the previous one.
    expect(await decryptValue(rotatingEnv(newKey), ct)).toBe("fresh");
  });

  it("opens v2 values under the previous key by key id", async () => {
    const oldKey = generateMasterKey();
    const newKey = generateMasterKey();
    const ct = await encryptValue(rotatingEnv(oldKey), "old secret");
    const keyring = await getKeyring(rotatingEnv(newKey, oldKey));
    await expect(decryptWithKeyring(keyring, ct)).resolves.toEqual({
      plaintext: "old secret",
      keyRole: "previous",
      version: "v2",
    });
  });

  it("opens v1 values with MASTER_KEY, then falls back to MASTER_KEY_PREVIOUS", async () => {
    const oldKey = generateMasterKey();
    const newKey = generateMasterKey();
    const keyring = await getKeyring(rotatingEnv(newKey, oldKey));
    await expect(decryptWithKeyring(keyring, await encryptV1(newKey, "n"))).resolves.toMatchObject({
      plaintext: "n",
      keyRole: "current",
      version: "v1",
    });
    await expect(decryptWithKeyring(keyring, await encryptV1(oldKey, "o"))).resolves.toMatchObject({
      plaintext: "o",
      keyRole: "previous",
      version: "v1",
    });
  });

  it("reports a v2 key id that matches neither key without trying to decrypt", async () => {
    const stranger = await encryptValue(rotatingEnv(generateMasterKey()), "x");
    const env = rotatingEnv(generateMasterKey(), generateMasterKey());
    expect(await codeOf(decryptValue(env, stranger))).toBe("unknown_key");
  });

  it("fails closed when a value opens with neither key", async () => {
    const env = rotatingEnv(generateMasterKey(), generateMasterKey());
    expect(await codeOf(decryptValue(env, await encryptV1(generateMasterKey(), "x")))).toBe(
      "decrypt_failed",
    );
  });

  it("fails closed on a tampered value under a known key id", async () => {
    const key = generateMasterKey();
    const ct = await encryptValue(rotatingEnv(key), "integrity");
    const parts = ct.split(":");
    const body = b64decode(parts[3]!);
    body[0] = body[0]! ^ 0xff;
    parts[3] = b64encode(body);
    expect(await codeOf(decryptValue(rotatingEnv(key), parts.join(":")))).toBe("decrypt_failed");
  });

  it("rejects malformed values and a missing key", async () => {
    expect(await codeOf(decryptValue(rotatingEnv(generateMasterKey()), "plain"))).toBe(
      "invalid_format",
    );
    expect(await codeOf(decryptValue({} as Env, "v1:AAAA:BBBB"))).toBe("no_key");
  });

  it("ignores an invalid previous key for reads and flags it", async () => {
    const key = generateMasterKey();
    const ct = await encryptValue(rotatingEnv(key), "still fine");
    const env = rotatingEnv(key, "not-a-key");
    const keyring = await getKeyring(env);
    expect(keyring.previous).toBeNull();
    expect(keyring.previousInvalid).toBe(true);
    expect(await decryptValue(env, ct)).toBe("still fine");
  });
});
