import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import { decryptValue, encryptValue, isValidMasterKey, keyIdFor } from "../../src/worker/lib/crypto";
import { activeEscrowedKey, ensureMasterKey, escrowMasterKey, generateMasterKey, isValidPlatformKey, openEscrowedKey } from "../src/keys";

const PLATFORM_KEY = generateMasterKey();

beforeAll(async () => {
  await applyD1Migrations(env.PLATFORM_DB, env.TEST_MIGRATIONS);
  await env.PLATFORM_DB.batch([
    env.PLATFORM_DB.prepare("INSERT INTO accounts (id, email, created_at, updated_at) VALUES ('acc_keys', 'keys@example.com', 0, 0)"),
    env.PLATFORM_DB.prepare(
      "INSERT INTO tenants (id, account_id, slug, script_name, created_at, updated_at) VALUES ('keystenant000001', 'acc_keys', 'keysco', 't-keystenant000001', 0, 0)",
    ),
  ]);
});

describe("tenant MASTER_KEYs", () => {
  it("are what OpenPing accepts as a MASTER_KEY, and work with its own encryption", async () => {
    const key = generateMasterKey();
    expect(isValidMasterKey(key)).toBe(true);
    expect(generateMasterKey()).not.toBe(key);
    const sealed = await encryptValue({ MASTER_KEY: key } as never, "hello");
    expect(sealed.startsWith(`v2:${await keyIdFor(key)}:`)).toBe(true);
    expect(await decryptValue({ MASTER_KEY: key } as never, sealed)).toBe("hello");
  });

  it("escrow round-trips, with OpenPing's key id", async () => {
    const key = generateMasterKey();
    const escrowed = await escrowMasterKey(key, "tenanta000000001", PLATFORM_KEY);
    expect(escrowed.kid).toBe(await keyIdFor(key));
    expect(escrowed.ciphertext).toMatch(/^v1:[A-Za-z0-9_-]{16}:[A-Za-z0-9_-]+$/);
    expect(escrowed.ciphertext).not.toContain(key);
    expect(await openEscrowedKey(escrowed, "tenanta000000001", PLATFORM_KEY)).toBe(key);
  });

  it("won't open with another PLATFORM_KEY, for another tenant, under another key id, or after tampering", async () => {
    const key = generateMasterKey();
    const escrowed = await escrowMasterKey(key, "tenanta000000001", PLATFORM_KEY);
    await expect(openEscrowedKey(escrowed, "tenanta000000001", generateMasterKey())).rejects.toThrow(/does not decrypt/);
    await expect(openEscrowedKey(escrowed, "tenantb000000002", PLATFORM_KEY)).rejects.toThrow(/does not decrypt/);
    await expect(openEscrowedKey({ ...escrowed, kid: "00000000" }, "tenanta000000001", PLATFORM_KEY)).rejects.toThrow(/does not decrypt/);
    const flipped = escrowed.ciphertext.slice(0, -2) + (escrowed.ciphertext.endsWith("A") ? "BB" : "AA");
    await expect(openEscrowedKey({ ...escrowed, ciphertext: flipped }, "tenanta000000001", PLATFORM_KEY)).rejects.toThrow();
    await expect(openEscrowedKey({ ...escrowed, ciphertext: "v9:x:y" }, "tenanta000000001", PLATFORM_KEY)).rejects.toThrow(/format/);
  });

  it("needs a real PLATFORM_KEY", async () => {
    expect(isValidPlatformKey(undefined)).toBe(false);
    expect(isValidPlatformKey("short")).toBe(false);
    expect(isValidPlatformKey(PLATFORM_KEY)).toBe(true);
    await expect(escrowMasterKey(generateMasterKey(), "tenanta000000001", "short")).rejects.toThrow(/PLATFORM_KEY/);
  });

  it("generates and escrows a tenant's key once, then keeps answering the same one", async () => {
    const first = await ensureMasterKey(env.PLATFORM_DB, "keystenant000001", PLATFORM_KEY, 1);
    expect(first.created).toBe(true);
    const again = await ensureMasterKey(env.PLATFORM_DB, "keystenant000001", PLATFORM_KEY, 2);
    expect(again).toEqual({ masterKey: first.masterKey, kid: first.kid, created: false });
    expect((await activeEscrowedKey(env.PLATFORM_DB, "keystenant000001"))?.kid).toBe(first.kid);
  });
});
