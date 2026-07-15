import { describe, it, expect } from "vitest";
import { encryptValue, generateMasterKey } from "./crypto";
import {
  secretValuePresent,
  isCiphertext,
  encryptConfig,
  decryptConfig,
  redactConfig,
  mergeSecrets,
} from "./secret-config";
import type { Env } from "../types";

function envWithKey(): Env {
  return { MASTER_KEY: generateMasterKey() } as unknown as Env;
}

const noKeyEnv = {} as unknown as Env;

describe("secretValuePresent", () => {
  it("is true only for non-empty strings", () => {
    expect(secretValuePresent("x")).toBe(true);
    expect(secretValuePresent("")).toBe(false);
    expect(secretValuePresent(undefined)).toBe(false);
    expect(secretValuePresent(123)).toBe(false);
  });
});

describe("isCiphertext (structural, not a prefix sniff)", () => {
  it("accepts only a well-formed v1:<iv>:<ct> shape", () => {
    expect(isCiphertext("v1:AAAA:BBBB")).toBe(true);
    expect(isCiphertext("v1:abc123+/=:def456+/=")).toBe(true);
  });
  it("rejects plaintext that merely starts with 'v1:'", () => {
    // The bug: such a value used to be mistaken for ciphertext and stored raw.
    expect(isCiphertext("v1:my-password")).toBe(false);
    expect(isCiphertext("v1:")).toBe(false);
    expect(isCiphertext("v1:onlyonesegment")).toBe(false);
    expect(isCiphertext("plain")).toBe(false);
    expect(isCiphertext(123)).toBe(false);
  });
});

describe("a plaintext secret beginning with 'v1:' is still encrypted at rest", () => {
  it("does not skip encryption for a colon-containing 'v1:'-prefixed value", async () => {
    const env = envWithKey();
    const hbConfig = { intervalSeconds: 3600, secret: "v1:looks-like-cipher" };
    const enc = await encryptConfig(env, "heartbeat", hbConfig);
    expect(JSON.stringify(enc)).not.toContain("looks-like-cipher");
    const dec = await decryptConfig(env, enc);
    expect(dec.secret).toBe("v1:looks-like-cipher");
  });
});

describe("encrypt/decrypt round-trip with a master key", () => {
  it("seals every HTTP config field and restores the complete document", async () => {
    const env = envWithKey();

    const httpConfig = {
      url: "https://api-user:api-pass@example.com/check?token=query-secret",
      method: "POST",
      headers: { Authorization: "custom-secret", "X-Api-Key": "header-secret" },
      body: '{"password":"body-secret"}',
      auth: { type: "bearer", token: "super-secret-token" },
    };
    const encHttp = await encryptConfig(env, "http", httpConfig);
    const stored = JSON.stringify(encHttp);
    expect(Object.keys(encHttp)).toEqual(["__openping_sealed_config_v1"]);
    expect(stored).not.toContain("api-pass");
    expect(stored).not.toContain("query-secret");
    expect(stored).not.toContain("header-secret");
    expect(stored).not.toContain("body-secret");
    expect(stored).not.toContain("super-secret-token");

    const decHttp = await decryptConfig(env, encHttp);
    expect(decHttp).toEqual(httpConfig);
  });

  it("seals and restores heartbeat configuration", async () => {
    const env = envWithKey();

    const hbConfig = { intervalSeconds: 3600, secret: "hb-secret" };
    const encHb = await encryptConfig(env, "heartbeat", hbConfig);
    expect(JSON.stringify(encHb)).not.toContain("hb-secret");

    const decHb = await decryptConfig(env, encHb);
    expect(decHb).toEqual(hbConfig);
  });

  it("is idempotent: already-encrypted values are not re-encrypted", async () => {
    const env = envWithKey();
    const once = await encryptConfig(env, "heartbeat", { secret: "s" });
    const twice = await encryptConfig(env, "heartbeat", once);
    expect(twice).toEqual(once);
    expect((await decryptConfig(env, twice)).secret).toBe("s");
  });

  it("leaves an envelope intact when the key is wrong", async () => {
    const stored = await encryptConfig(envWithKey(), "http", {
      url: "https://example.com?token=hidden",
    });

    await expect(decryptConfig(envWithKey(), stored)).resolves.toEqual(stored);
  });
});

describe("legacy config compatibility", () => {
  it("reads plaintext rows unchanged", async () => {
    const legacy = {
      url: "https://example.com",
      headers: { "X-Legacy": "plain" },
      auth: { type: "bearer", token: "plain-token" },
    };

    await expect(decryptConfig(envWithKey(), legacy)).resolves.toEqual(legacy);
  });

  it("decrypts rows with legacy field-level encryption", async () => {
    const env = envWithKey();
    const encryptedToken = await encryptValue(env, "legacy-token");
    const legacy = {
      url: "https://example.com",
      auth: { type: "bearer", token: encryptedToken },
    };

    await expect(decryptConfig(env, legacy)).resolves.toEqual({
      url: "https://example.com",
      auth: { type: "bearer", token: "legacy-token" },
    });
  });

  it("migrates legacy field encryption into a sealed document on write", async () => {
    const env = envWithKey();
    const encryptedToken = await encryptValue(env, "legacy-token");
    const stored = await encryptConfig(env, "http", {
      url: "https://example.com",
      auth: { type: "bearer", token: encryptedToken },
    });

    expect(Object.keys(stored)).toEqual(["__openping_sealed_config_v1"]);
    await expect(decryptConfig(env, stored)).resolves.toEqual({
      url: "https://example.com",
      auth: { type: "bearer", token: "legacy-token" },
    });
  });
});

describe("no master key (best-effort)", () => {
  it("returns plaintext config unchanged", async () => {
    const config = {
      url: "https://example.com",
      auth: { type: "bearer", token: "plain-token" },
    };
    const enc = await encryptConfig(noKeyEnv, "http", config);
    expect((enc.auth as Record<string, unknown>).token).toBe("plain-token");
  });
});

describe("redactConfig", () => {
  it("blanks token/password/secret but keeps non-secret fields", () => {
    const http = {
      url: "https://example.com",
      auth: { type: "basic", username: "admin", password: "p@ss" },
    };
    const red = redactConfig(http);
    expect((red.auth as Record<string, unknown>).password).toBe("");
    expect((red.auth as Record<string, unknown>).username).toBe("admin");
    expect(red.url).toBe("https://example.com");

    const hb = { intervalSeconds: 60, secret: "shh" };
    const redHb = redactConfig(hb);
    expect(redHb.secret).toBe("");
    expect(redHb.intervalSeconds).toBe(60);

    // Original config is not mutated (deep clone).
    expect((http.auth as Record<string, unknown>).password).toBe("p@ss");
  });
});

describe("mergeSecrets", () => {
  it("keeps the existing token when the incoming one is empty", () => {
    const existing = { auth: { type: "bearer", token: "existing-token" } };
    const incoming = { auth: { type: "bearer", token: "" } };
    const merged = mergeSecrets(incoming, existing);
    expect((merged.auth as Record<string, unknown>).token).toBe("existing-token");
  });

  it("uses the incoming token when it is non-empty", () => {
    const existing = { auth: { type: "bearer", token: "existing-token" } };
    const incoming = { auth: { type: "bearer", token: "new-token" } };
    const merged = mergeSecrets(incoming, existing);
    expect((merged.auth as Record<string, unknown>).token).toBe("new-token");
  });

  it("preserves a redacted token across decrypt, merge, reseal, and redact", async () => {
    const env = envWithKey();
    const stored = await encryptConfig(env, "http", {
      url: "https://old.example.com?credential=protected",
      auth: { type: "bearer", token: "existing-token" },
    });
    const existing = await decryptConfig(env, stored);
    const incoming = {
      url: "https://new.example.com",
      auth: { type: "bearer", token: "" },
    };

    const resealed = await encryptConfig(
      env,
      "http",
      mergeSecrets(incoming, existing),
    );
    const resolved = await decryptConfig(env, resealed);

    expect(resolved).toEqual({
      url: "https://new.example.com",
      auth: { type: "bearer", token: "existing-token" },
    });
    expect(redactConfig(resolved)).toEqual({
      url: "https://new.example.com",
      auth: { type: "bearer", token: "" },
    });
    expect(JSON.stringify(resealed)).not.toContain("existing-token");
  });
});
