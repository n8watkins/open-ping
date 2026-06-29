import { describe, it, expect } from "vitest";
import {
  base64urlDecode,
  base64urlEncode,
  buildVapidJwt,
  generateVapidKeys,
  sendWebPush,
  type VapidKeys,
} from "./webpush";

const BASE64URL = /^[A-Za-z0-9_-]+$/;

describe("base64url helpers", () => {
  it("round-trips arbitrary bytes", () => {
    const bytes = crypto.getRandomValues(new Uint8Array(64));
    const encoded = base64urlEncode(bytes);
    const decoded = base64urlDecode(encoded);
    expect(Array.from(decoded)).toEqual(Array.from(bytes));
  });

  it("produces url-safe, unpadded output", () => {
    // 0xFF bytes force '+'/'/' in standard base64 so we can confirm the swap.
    const bytes = new Uint8Array([0xff, 0xff, 0xff, 0xfb, 0xef, 0xff]);
    const encoded = base64urlEncode(bytes);
    expect(encoded).toMatch(BASE64URL);
    expect(encoded).not.toContain("=");
    expect(encoded).not.toContain("+");
    expect(encoded).not.toContain("/");
  });

  it("round-trips an empty array", () => {
    expect(Array.from(base64urlDecode(base64urlEncode(new Uint8Array())))).toEqual(
      [],
    );
  });
});

describe("generateVapidKeys", () => {
  it("returns a 65-byte uncompressed public point and a private key", async () => {
    const keys = await generateVapidKeys();

    const rawPublic = base64urlDecode(keys.publicKey);
    expect(rawPublic.length).toBe(65);
    expect(rawPublic[0]).toBe(0x04); // uncompressed point marker

    expect(typeof keys.privateKey).toBe("string");
    expect(keys.privateKey.length).toBeGreaterThan(0);
    expect(keys.privateKey).toMatch(BASE64URL);
    // JWK `d` for P-256 is 32 bytes.
    expect(base64urlDecode(keys.privateKey).length).toBe(32);
  });

  it("generates a distinct keypair each call", async () => {
    const a = await generateVapidKeys();
    const b = await generateVapidKeys();
    expect(a.publicKey).not.toBe(b.publicKey);
    expect(a.privateKey).not.toBe(b.privateKey);
  });
});

describe("buildVapidJwt", () => {
  it("produces three dot-separated base64url segments", async () => {
    const generated = await generateVapidKeys();
    const vapid: VapidKeys = {
      ...generated,
      subject: "mailto:admin@example.com",
    };

    const jwt = await buildVapidJwt(vapid, "https://push.example.com");
    const segments = jwt.split(".");
    expect(segments).toHaveLength(3);
    for (const segment of segments) {
      expect(segment.length).toBeGreaterThan(0);
      expect(segment).toMatch(BASE64URL);
    }
  });

  it("encodes the expected header and claims", async () => {
    const generated = await generateVapidKeys();
    const vapid: VapidKeys = {
      ...generated,
      subject: "mailto:admin@example.com",
    };

    const [encHeader, encClaims] = (
      await buildVapidJwt(vapid, "https://push.example.com")
    ).split(".");

    const header = JSON.parse(
      new TextDecoder().decode(base64urlDecode(encHeader)),
    );
    expect(header).toEqual({ typ: "JWT", alg: "ES256" });

    const claims = JSON.parse(
      new TextDecoder().decode(base64urlDecode(encClaims)),
    );
    expect(claims.aud).toBe("https://push.example.com");
    expect(claims.sub).toBe("mailto:admin@example.com");
    expect(typeof claims.exp).toBe("number");
    expect(claims.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });
});

describe("sendWebPush validation (no network)", () => {
  // These paths return before any crypto or fetch, so a placeholder VAPID
  // identity is fine — it is never used here.
  const vapid: VapidKeys = {
    publicKey: "x",
    privateKey: "y",
    subject: "mailto:admin@example.com",
  };
  const okKeys = {
    p256dh: base64urlEncode(new Uint8Array(65)),
    auth: base64urlEncode(new Uint8Array(16)),
  };

  it("rejects an SSRF-unsafe endpoint as invalid (prunable), without fetching", async () => {
    for (const endpoint of [
      "http://localhost/push",
      "http://169.254.169.254/latest/meta-data",
      "http://10.0.0.5/push",
      "ftp://push.example.com/x",
    ]) {
      const r = await sendWebPush({
        subscription: { endpoint, ...okKeys },
        payload: "{}",
        vapid,
      });
      expect(r.ok).toBe(false);
      expect(r.invalid).toBe(true);
      expect(r.error).toMatch(/^invalid_subscription/);
    }
  });

  it("rejects malformed base64url keys as invalid, without throwing", async () => {
    const r = await sendWebPush({
      subscription: {
        endpoint: "https://push.example.com/abc",
        p256dh: "*not base64*",
        auth: "*nope*",
      },
      payload: "{}",
      vapid,
    });
    expect(r.ok).toBe(false);
    expect(r.invalid).toBe(true);
    expect(r.error).toBe("invalid_subscription");
  });

  it("rejects wrong-length keys as invalid", async () => {
    const r = await sendWebPush({
      subscription: {
        endpoint: "https://push.example.com/abc",
        p256dh: base64urlEncode(new Uint8Array(10)), // not the required 65 bytes
        auth: base64urlEncode(new Uint8Array(16)),
      },
      payload: "{}",
      vapid,
    });
    expect(r.ok).toBe(false);
    expect(r.invalid).toBe(true);
    expect(r.error).toBe("invalid_subscription");
  });
});
