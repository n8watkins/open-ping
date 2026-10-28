import { describe, expect, it } from "vitest";
import { DEPLOY_BUTTON_URL, randomSecret } from "./secrets";

describe("randomSecret", () => {
  it("makes a valid MASTER_KEY: 32 bytes, base64", () => {
    const secret = randomSecret();
    expect(secret).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    // What the Worker's isValidMasterKey checks (src/worker/lib/crypto.ts).
    expect(atob(secret)).toHaveLength(32);
  });

  it("is different every time", () => {
    expect(new Set(Array.from({ length: 20 }, randomSecret)).size).toBe(20);
  });
});

describe("DEPLOY_BUTTON_URL", () => {
  it("points the button at the public repository", () => {
    const url = new URL(DEPLOY_BUTTON_URL);
    expect(url.origin).toBe("https://deploy.workers.cloudflare.com");
    expect(url.searchParams.get("url")).toBe("https://github.com/n8watkins/open-ping");
  });
});
