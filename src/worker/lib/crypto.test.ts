import { describe, it, expect } from "vitest";
import {
  encryptValue,
  decryptValue,
  generateMasterKey,
  b64decode,
  isValidMasterKey,
} from "./crypto";
import type { Env } from "../types";

function envWithKey(key = generateMasterKey()): Env {
  return { MASTER_KEY: key } as unknown as Env;
}

describe("crypto", () => {
  it("round-trips plaintext", async () => {
    const env = envWithKey();
    const ct = await encryptValue(env, "hunter2");
    expect(ct.startsWith("v1:")).toBe(true);
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
