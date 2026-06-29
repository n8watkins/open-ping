import { describe, it, expect } from "vitest";
import { generateMasterKey } from "./crypto";
import {
  secretValuePresent,
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

describe("encrypt/decrypt round-trip with a master key", () => {
  it("survives a round trip for a bearer token and a heartbeat secret", async () => {
    const env = envWithKey();

    const httpConfig = {
      url: "https://example.com",
      auth: { type: "bearer", token: "super-secret-token" },
    };
    const encHttp = await encryptConfig(env, "http", httpConfig);
    const encToken = (encHttp.auth as Record<string, unknown>).token as string;
    expect(encToken).not.toBe("super-secret-token");
    expect(encToken.startsWith("v1:")).toBe(true);
    expect(encHttp.url).toBe("https://example.com");

    const decHttp = await decryptConfig(env, encHttp);
    expect((decHttp.auth as Record<string, unknown>).token).toBe(
      "super-secret-token",
    );

    const hbConfig = { intervalSeconds: 3600, secret: "hb-secret" };
    const encHb = await encryptConfig(env, "heartbeat", hbConfig);
    expect(encHb.secret).not.toBe("hb-secret");
    expect((encHb.secret as string).startsWith("v1:")).toBe(true);

    const decHb = await decryptConfig(env, encHb);
    expect(decHb.secret).toBe("hb-secret");
  });

  it("is idempotent: already-encrypted values are not re-encrypted", async () => {
    const env = envWithKey();
    const once = await encryptConfig(env, "heartbeat", { secret: "s" });
    const twice = await encryptConfig(env, "heartbeat", once);
    expect(twice.secret).toBe(once.secret);
    expect((await decryptConfig(env, twice)).secret).toBe("s");
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
});
