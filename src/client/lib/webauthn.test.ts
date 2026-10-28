import { describe, expect, it } from "vitest";
import {
  strandedPasskeys,
  authenticationToJSON,
  base64urlToBytes,
  bytesToBase64url,
  hostMatchesRpId,
  passkeyErrorMessage,
  registrationToJSON,
  toCreationOptions,
  toRequestOptions,
} from "./webauthn";

describe("base64url", () => {
  it("round-trips bytes without padding", () => {
    const bytes = new Uint8Array([0, 251, 255, 1, 2]);
    const text = bytesToBase64url(bytes);
    expect(text).not.toMatch(/[=+/]/);
    expect([...base64urlToBytes(text)]).toEqual([...bytes]);
  });
});

describe("options conversion", () => {
  it("decodes the challenge, user id and excluded credential ids", () => {
    const opts = toCreationOptions({
      challenge: "AQID",
      rp: { id: "status.example.com", name: "OpenPing" },
      user: { id: "BAUG", name: "admin@example.com", displayName: "OpenPing admin" },
      pubKeyCredParams: [{ type: "public-key", alg: -7 }],
      excludeCredentials: [{ type: "public-key", id: "BwgJ", transports: ["internal"] }],
    });
    expect([...new Uint8Array(opts.challenge as ArrayBuffer)]).toEqual([1, 2, 3]);
    expect([...new Uint8Array(opts.user.id as ArrayBuffer)]).toEqual([4, 5, 6]);
    expect([...new Uint8Array(opts.excludeCredentials![0]!.id as ArrayBuffer)]).toEqual([7, 8, 9]);
    expect(opts.rp.id).toBe("status.example.com");

    const req = toRequestOptions({ challenge: "AQID", rpId: "status.example.com", allowCredentials: [] });
    expect([...new Uint8Array(req.challenge as ArrayBuffer)]).toEqual([1, 2, 3]);
    expect(req.allowCredentials).toEqual([]);
  });
});

describe("credential serialization", () => {
  const raw = new Uint8Array([1, 2, 3]).buffer;
  it("serializes a registration, with transports when the browser reports them", () => {
    const json = registrationToJSON({
      rawId: raw,
      response: {
        clientDataJSON: new Uint8Array([4]).buffer,
        attestationObject: new Uint8Array([5]).buffer,
        getTransports: () => ["internal"],
      },
    } as unknown as PublicKeyCredential);
    expect(json).toEqual({
      id: "AQID",
      rawId: "AQID",
      type: "public-key",
      response: { clientDataJSON: "BA", attestationObject: "BQ", transports: ["internal"] },
    });
  });

  it("serializes an assertion, with a null user handle when there is none", () => {
    const json = authenticationToJSON({
      rawId: raw,
      response: {
        clientDataJSON: new Uint8Array([4]).buffer,
        authenticatorData: new Uint8Array([5]).buffer,
        signature: new Uint8Array([6]).buffer,
        userHandle: null,
      },
    } as unknown as PublicKeyCredential);
    expect(json.response).toEqual({ clientDataJSON: "BA", authenticatorData: "BQ", signature: "Bg", userHandle: null });
  });
});

describe("hostMatchesRpId", () => {
  it("matches the RP ID and its subdomains only", () => {
    expect(hostMatchesRpId("openping.n8builds.dev", "openping.n8builds.dev")).toBe(true);
    expect(hostMatchesRpId("n8builds.dev", "openping.n8builds.dev")).toBe(true);
    expect(hostMatchesRpId("openping.n8builds.dev", "open-ping.someone.workers.dev")).toBe(false);
    expect(hostMatchesRpId("openping.n8builds.dev", "evilopenping.n8builds.dev")).toBe(false);
    expect(hostMatchesRpId(undefined, "localhost")).toBe(false);
  });
});

describe("passkeyErrorMessage", () => {
  it("explains cancelled ceremonies and server error codes", () => {
    expect(passkeyErrorMessage(new DOMException("x", "NotAllowedError"))).toMatch(/cancelled or timed out/);
    expect(passkeyErrorMessage(new Error("challenge_invalid"))).toMatch(/expired/);
    expect(passkeyErrorMessage(new Error("unknown_passkey"))).toMatch(/isn't registered/);
    expect(passkeyErrorMessage(new Error("whatever"))).toMatch(/went wrong/);
  });
});

describe("strandedPasskeys", () => {
  const keys = [{ rpId: "status.example.com" }, { rpId: "status.example.com" }, { rpId: "old.example.com" }];

  it("counts passkeys bound to a hostname other than the new address", () => {
    expect(strandedPasskeys("https://status.example.com/", keys)).toBe(1);
    expect(strandedPasskeys("https://new.example.com", keys)).toBe(3);
  });

  it("ignores the port, path and scheme, which passkeys don't depend on", () => {
    expect(strandedPasskeys("http://status.example.com:8443/app", keys.slice(0, 2))).toBe(0);
  });

  it("says nothing for an address that isn't a URL yet, or with no passkeys", () => {
    expect(strandedPasskeys("status.example", keys)).toBe(0);
    expect(strandedPasskeys("https://new.example.com", [])).toBe(0);
  });
});
