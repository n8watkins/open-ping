import { describe, expect, it, vi } from "vitest";
import type { Env } from "../types";
import { generateMasterKey } from "../lib/crypto";
import { protectPushSecrets, rowToSubscription } from "./push";

const plaintext = {
  endpoint: "https://push.example.test/subscription/secret-token",
  p256dh: "browser-public-encryption-key",
  auth: "browser-auth-secret",
};

function envWithKey(): Env {
  return { MASTER_KEY: generateMasterKey() } as Env;
}

function row(values = plaintext) {
  return {
    id: "psub_1",
    endpoint: values.endpoint,
    endpoint_hash: null,
    p256dh: values.p256dh,
    auth: values.auth,
    label: "Laptop",
    user_agent: "Test Browser",
    platform: "Linux",
    created_at: 100,
    last_success_at: 200,
    last_failure_at: null,
    failures: 0,
    disabled: 0,
  };
}

describe("Web Push subscription secret storage", () => {
  it("encrypts the endpoint and browser key material at rest", async () => {
    const env = envWithKey();
    const protectedValues = await protectPushSecrets(env, plaintext);

    expect(protectedValues.endpoint).toMatch(/^v1:/);
    expect(protectedValues.p256dh).toMatch(/^v1:/);
    expect(protectedValues.auth).toMatch(/^v1:/);
    expect(protectedValues).not.toContain(plaintext.endpoint);
    expect(await rowToSubscription(env, row(protectedValues))).toMatchObject(plaintext);
  });

  it("keeps legacy plaintext rows readable", async () => {
    await expect(rowToSubscription({} as Env, row())).resolves.toMatchObject(
      plaintext,
    );
  });

  it("encrypts browser input even when it resembles stored ciphertext", async () => {
    const env = envWithKey();
    const crafted = {
      ...plaintext,
      auth: "v1:dGVzdA==:dGVzdA==",
    };
    const stored = await protectPushSecrets(env, crafted);

    expect(stored.auth).not.toBe(crafted.auth);
    expect(await rowToSubscription(env, row(stored))).toMatchObject(crafted);
  });

  it("fails closed when an encrypted row cannot be decrypted", async () => {
    const protectedValues = await protectPushSecrets(envWithKey(), plaintext);

    await expect(
      rowToSubscription(envWithKey(), row(protectedValues)),
    ).rejects.toThrow();
  });

  it("preserves plaintext compatibility without MASTER_KEY and warns", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const stored = await protectPushSecrets({} as Env, plaintext);

    expect(stored).toEqual(plaintext);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("Web Push subscription credentials"),
    );
    warn.mockRestore();
  });
});
