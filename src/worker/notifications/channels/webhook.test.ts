import { describe, it, expect } from "vitest";
import { signPayload } from "./webhook";

describe("signPayload", () => {
  it("is deterministic for the same secret and body", async () => {
    const a = await signPayload("s3cret", '{"a":1}');
    const b = await signPayload("s3cret", '{"a":1}');
    expect(a).toBe(b);
  });

  it("yields a different signature for a different secret", async () => {
    const body = '{"a":1}';
    const a = await signPayload("secret-one", body);
    const b = await signPayload("secret-two", body);
    expect(a).not.toBe(b);
  });

  it("yields a different signature for a different body", async () => {
    const secret = "s3cret";
    const a = await signPayload(secret, '{"a":1}');
    const b = await signPayload(secret, '{"a":2}');
    expect(a).not.toBe(b);
  });

  it("outputs 64-char lowercase hex", async () => {
    const sig = await signPayload("s3cret", '{"a":1}');
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
  });

  it("matches a known HMAC-SHA256 vector", async () => {
    // Reference computed with Node crypto:
    //   createHmac("sha256", "my-secret").update('{"hello":"world"}').digest("hex")
    const sig = await signPayload("my-secret", '{"hello":"world"}');
    expect(sig).toBe(
      "a477339812d59f527176183f700b4f848b3e6e5bf3796ab25b6e0d0ccaeb96a4",
    );
  });
});
