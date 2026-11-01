// keys.mjs reads and writes exactly what the platform and OpenPing do: each
// direction is checked against their own TypeScript (vitest compiles it).

import { describe, expect, it } from "vitest";
import { escrowMasterKey, generateMasterKey } from "../../platform/src/keys.ts";
import { decryptValue as appDecrypt, encryptValue as appEncrypt, keyIdFor as appKeyId } from "../../src/worker/lib/crypto.ts";
import { decryptConfig } from "../../src/worker/lib/secret-config.ts";
import { decryptValue, encryptValue, isValidKey, keyIdFor, openEscrowedKey, parseCiphertext, sealConfig } from "./keys.mjs";

const env = (masterKey) => ({ MASTER_KEY: masterKey });

describe("keys.mjs against the platform and OpenPing", () => {
  it("derives OpenPing's key id", async () => {
    const key = generateMasterKey();
    expect(await keyIdFor(key)).toBe(await appKeyId(key));
  });

  it("opens a key the platform escrowed, only for its tenant and with its PLATFORM_KEY", async () => {
    const platformKey = generateMasterKey();
    const masterKey = generateMasterKey();
    const escrowed = await escrowMasterKey(masterKey, "tenant0000000001", platformKey);
    expect(await openEscrowedKey(escrowed, "tenant0000000001", platformKey)).toBe(masterKey);
    await expect(openEscrowedKey(escrowed, "tenant0000000002", platformKey)).rejects.toThrow(/does not open/);
    await expect(openEscrowedKey(escrowed, "tenant0000000001", generateMasterKey())).rejects.toThrow(/does not open/);
    await expect(openEscrowedKey({ ...escrowed, kid: "00000000" }, "tenant0000000001", platformKey)).rejects.toThrow(/does not open/);
    await expect(openEscrowedKey({ kid: escrowed.kid, ciphertext: "v9:x:y" }, "tenant0000000001", platformKey)).rejects.toThrow(/unknown format/);
  });

  it("decrypts what OpenPing encrypts, and OpenPing decrypts what it encrypts", async () => {
    const key = generateMasterKey();
    const sealed = await appEncrypt(env(key), "hunter2");
    expect(await decryptValue(key, sealed)).toBe("hunter2");
    const ours = await encryptValue(key, "s3cret ünïcode");
    expect(parseCiphertext(ours)).toMatchObject({ version: "v2", kid: await appKeyId(key) });
    expect(await appDecrypt(env(key), ours)).toBe("s3cret ünïcode");
  });

  it("refuses a value sealed with another key, or tampered with", async () => {
    const key = generateMasterKey();
    const other = await appEncrypt(env(generateMasterKey()), "x");
    await expect(decryptValue(key, other)).rejects.toThrow(/another key/);
    const sealed = await appEncrypt(env(key), "x");
    const [v, kid, iv, ct] = sealed.split(":");
    const flipped = `${v}:${kid}:${iv}:${ct.startsWith("A") ? "B" : "A"}${ct.slice(1)}`;
    await expect(decryptValue(key, flipped)).rejects.toThrow(/does not decrypt/);
    await expect(decryptValue(key, "plain")).rejects.toThrow(/not a stored ciphertext/);
  });

  it("seals a monitor config the way createMonitor does, so OpenPing reads it back", async () => {
    const key = generateMasterKey();
    const config = { url: "https://echo.example.com/ok", method: "GET", headers: [] };
    const stored = await sealConfig(key, config);
    expect(Object.keys(stored)).toEqual(["__openping_sealed_config_v1"]);
    expect(await decryptConfig(env(key), stored)).toEqual(config);
  });

  it("knows a valid 32-byte base64 key", () => {
    expect(isValidKey(generateMasterKey())).toBe(true);
    expect(isValidKey("short")).toBe(false);
    expect(isValidKey(undefined)).toBe(false);
  });
});
